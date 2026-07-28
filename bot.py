"""
Discord Bot mit Live-Daten-Übertragung an eine Website
========================================================

Der Bot sammelt Live-Statistiken von deinem Discord-Server
(Mitgliederzahl, Online-Status, Nachrichten pro Minute, aktive
Voice-User, letzte Nachrichten, ...) und stellt sie über einen
eingebauten Webserver bereit:

  - REST-Endpunkt:      GET  http://localhost:8000/api/stats
  - WebSocket (Live):   ws://localhost:8000/ws

Deine Website kann sich entweder per REST-Polling die aktuellen
Daten holen, oder sich per WebSocket verbinden und bekommt dann
in Echtzeit ein Update, sobald sich etwas ändert (neue Nachricht,
Member joined/left, Voice-Status geändert, ...).

Ein Beispiel-Frontend liegt in website/index.html.

Setup:
  1. pip install -r requirements.txt
  2. .env.example nach .env kopieren und deinen Bot-Token eintragen
  3. python bot.py
"""

import asyncio
import os
from collections import deque
from datetime import datetime, timezone

import discord
import uvicorn
from discord.ext import commands
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

TOKEN = os.getenv("DISCORD_TOKEN")
GUILD_ID = os.getenv("GUILD_ID")  # optional: nur diesen Server tracken
HOST = os.getenv("WEB_HOST", "0.0.0.0")
PORT = int(os.getenv("WEB_PORT", "80"))

if not TOKEN:
    raise SystemExit("Kein DISCORD_TOKEN gefunden. Bitte .env Datei anlegen (siehe .env.example).")

# ---------------------------------------------------------------------------
# Discord Bot Setup
# ---------------------------------------------------------------------------

intents = discord.Intents.default()
intents.members = True          # für Member-Join/Leave & Online-Status
intents.message_content = True  # für Nachrichten-Zähler
intents.presences = True        # für Online/Away/DND Status
intents.voice_states = True     # für Voice-Channel-Tracking

bot = commands.Bot(command_prefix="!", intents=intents)

# In-Memory "Live-State", der an die Website gesendet wird
live_state = {
    "guild_name": None,
    "member_count": 0,
    "online_count": 0,
    "voice_users": [],       # [{name, channel}]
    "messages_last_hour": 0,
    "recent_messages": deque(maxlen=15),  # [{author, content, channel, time}]
    "last_updated": None,
}

_message_timestamps: deque = deque()  # für messages_last_hour Zähler

# Alle verbundenen WebSocket-Clients der Website
connected_clients: set[WebSocket] = set()


def serialize_state() -> dict:
    """Wandelt live_state in ein JSON-fähiges dict um."""
    return {
        "guild_name": live_state["guild_name"],
        "member_count": live_state["member_count"],
        "online_count": live_state["online_count"],
        "voice_users": live_state["voice_users"],
        "messages_last_hour": live_state["messages_last_hour"],
        "recent_messages": list(live_state["recent_messages"]),
        "last_updated": live_state["last_updated"],
    }


async def broadcast_update():
    """Schickt den aktuellen Stand an alle verbundenen Website-Clients."""
    live_state["last_updated"] = datetime.now(timezone.utc).isoformat()
    payload = serialize_state()
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.add(ws)
    connected_clients.difference_update(dead)


def get_target_guild() -> discord.Guild | None:
    if GUILD_ID:
        return bot.get_guild(int(GUILD_ID))
    return bot.guilds[0] if bot.guilds else None


async def refresh_snapshot():
    """Aktualisiert Member-/Voice-Zahlen aus dem aktuellen Discord-Cache."""
    guild = get_target_guild()
    if guild is None:
        return

    live_state["guild_name"] = guild.name
    live_state["member_count"] = guild.member_count

    online = sum(
        1 for m in guild.members
        if m.status != discord.Status.offline and not m.bot
    )
    live_state["online_count"] = online

    voice_users = []
    for vc in guild.voice_channels:
        for member in vc.members:
            voice_users.append({"name": member.display_name, "channel": vc.name})
    live_state["voice_users"] = voice_users


# ---------------------------------------------------------------------------
# Discord Events
# ---------------------------------------------------------------------------

@bot.event
async def on_ready():
    print(f"✅ Eingeloggt als {bot.user} (ID: {bot.user.id})")
    await refresh_snapshot()
    await broadcast_update()
    periodic_refresh.start()


@bot.event
async def on_member_join(member: discord.Member):
    await refresh_snapshot()
    await broadcast_update()


@bot.event
async def on_member_remove(member: discord.Member):
    await refresh_snapshot()
    await broadcast_update()


@bot.event
async def on_presence_update(before, after):
    await refresh_snapshot()
    await broadcast_update()


@bot.event
async def on_voice_state_update(member, before, after):
    await refresh_snapshot()
    await broadcast_update()


@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    now = datetime.now(timezone.utc)
    _message_timestamps.append(now)

    # alte Timestamps (älter als 1h) rauswerfen
    one_hour_ago = now.timestamp() - 3600
    while _message_timestamps and _message_timestamps[0].timestamp() < one_hour_ago:
        _message_timestamps.popleft()

    live_state["messages_last_hour"] = len(_message_timestamps)
    live_state["recent_messages"].append({
        "author": message.author.display_name,
        "content": message.content[:200],
        "channel": getattr(message.channel, "name", "DM"),
        "time": now.isoformat(),
    })

    await broadcast_update()
    await bot.process_commands(message)


from discord.ext import tasks

@tasks.loop(seconds=30)
async def periodic_refresh():
    """Regelmäßiges Update, auch wenn gerade nichts passiert."""
    await refresh_snapshot()
    await broadcast_update()


# Beispiel-Befehl
@bot.command(name="stats")
async def stats_command(ctx):
    await ctx.send(
        f"📊 Live-Stats: {live_state['member_count']} Mitglieder, "
        f"{live_state['online_count']} online, "
        f"{live_state['messages_last_hour']} Nachrichten in der letzten Stunde."
    )


# ---------------------------------------------------------------------------
# Webserver (FastAPI) - liefert die Live-Daten an die Website
# ---------------------------------------------------------------------------

app = FastAPI(title="Discord Live Data API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # für Produktion: auf deine Domain einschränken
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/stats")
async def get_stats():
    """Einmalig aktuelle Daten abrufen (Polling)."""
    return serialize_state()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Live-Verbindung: schickt sofort den aktuellen Stand, danach jedes Update."""
    await websocket.accept()
    connected_clients.add(websocket)
    try:
        await websocket.send_json(serialize_state())
        while True:
            # Wir warten nur auf Disconnect, die Website muss nichts senden
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        connected_clients.discard(websocket)


# ---------------------------------------------------------------------------
# Bot + Webserver gemeinsam starten
# ---------------------------------------------------------------------------

async def main():
    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info")
    server = uvicorn.Server(config)

    async with bot:
        await asyncio.gather(
            bot.start(TOKEN),
            server.serve(),
        )


if __name__ == "__main__":
    asyncio.run(main())
