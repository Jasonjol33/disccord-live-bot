# Discord Live-Daten-Bot

Ein Discord-Bot, der Live-Statistiken deines Servers erfasst (Mitgliederzahl,
Online-Status, Voice-Aktivität, Nachrichten) und diese in Echtzeit an eine
Website überträgt – per WebSocket (Push) oder REST (Polling).

## 1. Bot im Discord Developer Portal erstellen

1. Gehe zu https://discord.com/developers/applications → **New Application**
2. Reiter **Bot** → **Reset Token** → Token kopieren (geheim halten!)
3. Unter **Privileged Gateway Intents** aktivieren:
   - Server Members Intent
   - Message Content Intent
   - Presence Intent
4. Unter **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: mind. `Read Messages/View Channels`, `Send Messages`
   - Mit der generierten URL den Bot auf deinen Server einladen

## 2. Lokal einrichten

```bash
cd discord-live-bot
python -m venv venv
source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# .env öffnen und DISCORD_TOKEN eintragen
```

## 3. Starten

```bash
python bot.py
```

Der Bot loggt sich bei Discord ein **und** startet gleichzeitig einen
Webserver auf Port 8000.

## 4. Live-Daten abrufen

- **REST (einmalig/Polling):** `GET http://localhost:8000/api/stats`
- **WebSocket (Echtzeit):** `ws://localhost:8000/ws`

Öffne `website/index.html` im Browser (z. B. per Doppelklick oder
`python -m http.server` im `website`-Ordner) – sie verbindet sich automatisch
per WebSocket und zeigt die Live-Daten an.

## 5. Auf einem echten Server / eigener Domain betreiben

- Bot z. B. auf einem VPS mit `pm2`, `systemd` oder Docker laufen lassen
- Port 8000 hinter einen Reverse Proxy (nginx) mit HTTPS/WSS legen
- In `website/index.html` die `WS_URL` auf `wss://deine-domain.de/ws` ändern
- In `bot.py` bei `CORSMiddleware` die `allow_origins` auf deine echte
  Domain einschränken (statt `"*"`)

## Welche Daten werden übertragen?

```json
{
  "guild_name": "Mein Server",
  "member_count": 128,
  "online_count": 34,
  "voice_users": [{"name": "Max", "channel": "Lounge"}],
  "messages_last_hour": 57,
  "recent_messages": [
    {"author": "Max", "content": "hi!", "channel": "allgemein", "time": "2026-07-28T10:00:00Z"}
  ],
  "last_updated": "2026-07-28T10:00:03Z"
}
```

Du kannst `bot.py` leicht erweitern, um z. B. auch Boost-Level, bestimmte
Rollen-Zahlen oder eigene Events (Giveaways, Ticket-System) live zu senden –
einfach `live_state` erweitern und `broadcast_update()` an der passenden
Stelle aufrufen.
