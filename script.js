/* ==========================================================================
   NEXUS — Gaming Community — script.js
   Enthält: Partikel-Hintergrund, UI-Interaktionen, Rendering aller Bereiche,
   Countdown-Logik, Suche, Scroll-Reveal und die Discord-Webhook-Schnittstelle.
   ========================================================================== */

(() => {
  'use strict';

  /* ======================================================================
     1) DISCORD WEBHOOK SCHNITTSTELLE
     ----------------------------------------------------------------------
     Wichtig zum Verständnis: Ein Discord-Webhook ist von Discord aus gesehen
     ausgehend (Discord → externe URL). Eine Webseite kann also nicht direkt
     "auf einem Discord-Webhook lauschen". Für automatische Updates braucht
     man daher einen kleinen Backend-Relay (z.B. Cloudflare Worker / Node-
     Server), der:
       a) Discord-Bot-Events oder eingehende Webhooks entgegennimmt,
       b) sie zwischenspeichert (z.B. in einer DB/KV),
       c) sie über eine eigene REST-Route (ENDPOINTS.*) an diese Webseite
          ausliefert, die hier per fetch() abgefragt wird.
     Zusätzlich kann diese Seite selbst Nachrichten AN einen Discord-Webhook
     senden (z.B. "Neues Giveaway wurde erstellt"), dafür dient sendToDiscord().

     Ohne Backend läuft die Seite im DEMO-Modus mit lokalen Mock-Daten,
     damit sie sofort funktionsfähig ist. Sobald WEBHOOK_CONFIG.endpoints
     befüllt sind, übernimmt WebhookAPI automatisch die echten Daten.
     ====================================================================== */

  const WEBHOOK_CONFIG = {
    // URL eines eingehenden Discord-Webhooks, um Nachrichten AN den Server zu senden.
    // Beispiel: "https://discord.com/api/webhooks/XXXXXXXX/XXXXXXXXXXXXXXXXXXXXXXXXXX"
    outgoingWebhookUrl: '',

    // Eigene Backend-Endpunkte, die die von Discord empfangenen Daten bereitstellen.
    // Bleiben sie leer / nicht erreichbar, nutzt die Seite automatisch die Demo-Daten.
    // (Nur nötig für News/Events/Giveaways, die aus echten Discord-Nachrichten stammen sollen.)
    endpoints: {
      news: '',       // GET -> Array<{id,title,description,date,image,tag}>
      events: '',     // GET -> Array<{id,title,description,date,image,featured}>
      giveaways: ''   // GET -> Array<{id,title,prize,endsAt,entries,requirements[],winner}>
    },

    // Abfrageintervall für automatische Aktualisierung (ms)
    pollIntervalMs: 60000
  };

  /* ------------------------------------------------------------------------
     ECHTE LIVE-DATEN (funktionieren direkt auf GitHub Pages, ohne Backend)
     ------------------------------------------------------------------------
     1) DISCORD SERVER WIDGET
        Liefert echte Online-Mitglieder, Presence und Voice-Channel-Belegung.
        Einrichtung:
          a) Discord-Server-Einstellungen → Community/Übersicht → "Server-Widget aktivieren".
          b) Rechtsklick auf den Server → "Server-ID kopieren" (Entwicklermodus muss an sein,
             Discord-Einstellungen → Erweitert → Entwicklermodus) und unten eintragen.
        Einschränkung: Discords öffentliches Widget liefert nur ONLINE-Mitglieder + Presence,
        keine Gesamtmitgliederzahl (die braucht einen Bot mit Token — siehe Hinweis unten).
        Trage daher zusätzlich total_members als bekannten/manuell gepflegten Wert ein,
        oder lass es auf 0, um das Feld auszublenden.
     2) MINECRAFT SERVER STATUS
        Nutzt die kostenlose, CORS-fähige API von mcstatus.io — keine Anmeldung nötig.
     ------------------------------------------------------------------------ */
  const DISCORD_CONFIG = {
    guildId: '1291723519931056194', // z.B. '123456789012345678' — Server-Widget muss aktiviert sein
    // Code eines dauerhaften (nicht ablaufenden) Invite-Links, z.B. 'nexus-gaming' bei
    // discord.gg/nexus-gaming. Damit holt die Seite die ECHTE Gesamtmitgliederzahl
    // (online + offline) — ganz ohne Bot, über Discords öffentliche Invite-API.
    inviteCode: '',
    totalMembersManual: 0  // Fallback, falls kein inviteCode gesetzt ist (0 = ausblenden)
  };

  /**
   * Holt die echte Gesamtmitgliederzahl (approximativ, online + offline) über
   * Discords öffentliche Invite-API — funktioniert ohne Bot-Token, rein clientseitig.
   * https://discord.com/developers/docs/resources/invite#get-invite
   */
  async function fetchDiscordMemberTotal() {
    if (!DISCORD_CONFIG.inviteCode) return null;
    try {
      const res = await fetch(`https://discord.com/api/v10/invites/${DISCORD_CONFIG.inviteCode}?with_counts=true`);
      if (!res.ok) {
        liveDataIssues.push(`Discord: Mitgliederzahl nicht abrufbar (HTTP ${res.status}). Invite-Code "${DISCORD_CONFIG.inviteCode}" prüfen — er darf nicht abgelaufen sein.`);
        throw new Error('HTTP ' + res.status);
      }
      const data = await res.json();
      return {
        totalMembers: data.approximate_member_count ?? null,
        onlinePresence: data.approximate_presence_count ?? null
      };
    } catch (err) {
      console.warn('[Discord Invite] Mitgliederzahl konnte nicht geladen werden:', err.message);
      return null;
    }
  }

  const MINECRAFT_CONFIG = {
    address: '',    // z.B. 'play.deinserver.de' oder 'play.deinserver.de:25565'
    name: 'Minecraft SMP',
    icon: '⛏️'
  };

  // Sammelt Klartext-Fehlermeldungen für die sichtbare Diagnose-Leiste im UI,
  // damit man Probleme sieht, ohne die Browser-Konsole öffnen zu müssen.
  const liveDataIssues = [];

  /**
   * Holt echte Daten vom öffentlichen Discord-Server-Widget.
   * https://discord.com/developers/docs/resources/guild#get-guild-widget
   */
  async function fetchDiscordWidget() {
    if (!DISCORD_CONFIG.guildId) return null;
    try {
      const res = await fetch(`https://discord.com/api/guilds/${DISCORD_CONFIG.guildId}/widget.json`);
      if (!res.ok) {
        let detail = 'HTTP ' + res.status;
        try {
          const body = await res.json();
          if (body?.message) detail += ` — "${body.message}"`;
        } catch (_) { /* keine JSON-Fehlermeldung vorhanden */ }

        if (res.status === 403) {
          liveDataIssues.push(`Discord: Server-Widget ist noch nicht aktiviert (${detail}). Aktivieren unter Servereinstellungen → Widget → „Server-Widget aktivieren".`);
        } else if (res.status === 404) {
          liveDataIssues.push(`Discord: Server-ID "${DISCORD_CONFIG.guildId}" wurde nicht gefunden (${detail}). Bitte die ID in DISCORD_CONFIG.guildId prüfen.`);
        } else {
          liveDataIssues.push(`Discord: Widget nicht erreichbar (${detail}).`);
        }
        throw new Error(detail);
      }
      const data = await res.json();

      const inVoice = (data.members || []).filter(m => m.channel_id);
      const vcCounts = {};
      inVoice.forEach(m => { vcCounts[m.channel_id] = (vcCounts[m.channel_id] || 0) + 1; });

      // Alle vom Widget sichtbaren Voice-Channels anzeigen — auch leere ("offen", aber gerade niemand drin).
      const voiceChannels = (data.channels || [])
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(c => ({ name: c.name, count: vcCounts[c.id] || 0, open: true }));

      const onlineMembers = (data.members || []).map(m => ({
        name: m.username || m.name || 'Unbekannt',
        status: m.status || 'online', // 'online' | 'idle' | 'dnd'
        avatarUrl: m.avatar_url || null,
        inVoice: !!m.channel_id
      }));

      return {
        members: DISCORD_CONFIG.totalMembersManual || null,
        online: data.presence_count ?? onlineMembers.length,
        voiceActive: inVoice.length,
        voiceChannels,
        onlineMembers,
        // Discords Widget liefert keinen "Beigetreten am"-Zeitstempel für neue Mitglieder,
        // daher bleibt dieses Feld leer, solange kein Bot-Backend angebunden ist.
        newMembers: null,
        instantInvite: data.instant_invite || null
      };
    } catch (err) {
      console.warn('[Discord Widget] Konnte nicht geladen werden:', err.message);
      return null;
    }
  }

  /**
   * Holt echten Live-Status eines Minecraft-Servers (Java Edition) über mcstatus.io.
   */
  async function fetchMinecraftStatus() {
    if (!MINECRAFT_CONFIG.address) return null;
    try {
      const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(MINECRAFT_CONFIG.address)}`);
      if (!res.ok) {
        liveDataIssues.push(`Minecraft: Status nicht erreichbar (HTTP ${res.status}). Adresse "${MINECRAFT_CONFIG.address}" prüfen.`);
        throw new Error('HTTP ' + res.status);
      }
      const data = await res.json();
      return {
        id: 'minecraft-live',
        name: MINECRAFT_CONFIG.name,
        icon: MINECRAFT_CONFIG.icon,
        online: !!data.online,
        players: data.players?.online ?? 0,
        maxPlayers: data.players?.max ?? 0,
        ping: null // mcstatus.io liefert Serverabfrage-Latenz, keinen echten Client-Ping
      };
    } catch (err) {
      console.warn('[Minecraft Status] Konnte nicht geladen werden:', err.message);
      return null;
    }
  }

  function renderLiveDataIssues() {
    const banner = document.getElementById('debugBanner');
    if (!banner) return;
    if (liveDataIssues.length === 0) {
      banner.classList.remove('show');
      banner.innerHTML = '';
      return;
    }
    banner.innerHTML = `
      <div class="debug-banner-head">
        <strong>⚠ Live-Daten unvollständig geladen</strong>
        <button id="debugBannerClose" aria-label="Meldung schließen">×</button>
      </div>
      <ul>${liveDataIssues.map(msg => `<li>${escapeHtml(msg)}</li>`).join('')}</ul>
    `;
    banner.classList.add('show');
    document.getElementById('debugBannerClose').addEventListener('click', () => banner.classList.remove('show'));
  }

  /**
   * Sendet eine Nachricht an einen ausgehenden Discord-Webhook.
   * Nutzbar z.B. um Website-Aktionen im Discord-Server anzukündigen.
   * @param {string} content - Klartext-Nachricht
   * @param {object} [embed] - optionales Discord-Embed-Objekt
   */
  async function sendToDiscord(content, embed) {
    if (!WEBHOOK_CONFIG.outgoingWebhookUrl) {
      console.info('[Webhook] Kein outgoingWebhookUrl konfiguriert — Nachricht wird nur geloggt:', content);
      return { ok: false, demo: true };
    }
    try {
      const res = await fetch(WEBHOOK_CONFIG.outgoingWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          embeds: embed ? [embed] : undefined,
          username: 'NEXUS Website'
        })
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      console.error('[Webhook] Senden fehlgeschlagen:', err);
      return { ok: false, error: err };
    }
  }

  /**
   * Lädt Daten von einem konfigurierten Backend-Endpunkt.
   * Fällt automatisch auf die Demo-Daten zurück, wenn kein Endpunkt gesetzt
   * ist oder der Request fehlschlägt (z.B. weil noch kein Backend existiert).
   */
  async function fetchLive(key, fallbackData) {
    const url = WEBHOOK_CONFIG.endpoints[key];
    if (!url) return fallbackData;
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      console.warn(`[Webhook] Live-Daten für "${key}" nicht erreichbar, nutze Demo-Daten.`, err);
      return fallbackData;
    }
  }

  /**
   * Empfängt ein Webhook-Payload direkt (z.B. von einer eingebetteten
   * BroadcastChannel/postMessage-Bridge deines Backends) und aktualisiert
   * die betroffene Sektion sofort, ohne auf das nächste Polling zu warten.
   * Beispiel-Aufruf aus der Konsole:
   *   NEXUS.handleIncomingWebhook('news', { id:'n9', title:'Patch 4.2', ... })
   */
  function handleIncomingWebhook(section, payload) {
    switch (section) {
      case 'news': STATE.news.unshift(payload); renderNews(); break;
      case 'events': STATE.events.unshift(payload); renderEvents(); renderCalendar(); break;
      case 'giveaways': STATE.giveaways.unshift(payload); renderGiveaways(); break;
      case 'status': {
        const i = STATE.status.findIndex(s => s.id === payload.id);
        if (i > -1) STATE.status[i] = { ...STATE.status[i], ...payload }; else STATE.status.push(payload);
        renderStatus();
        break;
      }
      case 'community': STATE.community = { ...STATE.community, ...payload }; renderCommunity(); break;
      default: console.warn('Unbekannte Sektion für Webhook-Update:', section);
    }
    document.getElementById('lastSync').textContent = new Date().toLocaleTimeString('de-DE');
    showToast('Live-Update über Discord empfangen');
    buildSearchIndex();
  }

  /* ======================================================================
     2) DEMO-/FALLBACK-DATEN
     ====================================================================== */

  const DEMO = {
    news: [
      { id: 'n1', tag: 'Patch Notes', title: 'Update 4.2 „Solar Flare“ ist live', description: 'Neue Waffenklasse, überarbeitetes Ranked-Matchmaking und über 40 Bugfixes.', date: '2026-07-26', image: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?q=80&w=800&auto=format&fit=crop' },
      { id: 'n2', tag: 'Community', title: 'Neue Partner-Streamer aufgenommen', description: 'Drei neue Creator verstärken ab sofort unser offizielles Partnerprogramm.', date: '2026-07-24', image: 'https://images.unsplash.com/photo-1598550476439-6847785fcea6?q=80&w=800&auto=format&fit=crop' },
      { id: 'n3', tag: 'Ankündigung', title: 'Sommer-Turnierserie angekündigt', description: 'Vier Wochen, acht Spiele, ein Preispool von 5.000€. Anmeldung ab morgen.', date: '2026-07-21', image: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?q=80&w=800&auto=format&fit=crop' },
      { id: 'n4', tag: 'Server', title: 'Neue EU-Voice-Server aktiviert', description: 'Niedrigere Latenz für alle Mitglieder in Zentral- und Osteuropa.', date: '2026-07-18', image: 'https://images.unsplash.com/photo-1587202372775-e229f172b9d7?q=80&w=800&auto=format&fit=crop' }
    ],
    community: {
      members: 128400,
      online: 4827,
      voiceActive: 312,
      voiceChannels: [
        { name: 'Lobby #1', count: 24 },
        { name: 'Ranked Squad', count: 5 },
        { name: 'Chill & Chat', count: 18 },
        { name: 'Valorant Comp', count: 10 }
      ],
      newMembers: [
        { name: 'ShadowByte', time: 'vor 4 Min.' },
        { name: 'NovaKid', time: 'vor 12 Min.' },
        { name: 'PixelWolf', time: 'vor 27 Min.' },
        { name: 'QuantumRae', time: 'vor 41 Min.' },
        { name: 'GlitchFox', time: 'vor 1 Std.' }
      ]
    },
    events: [
      {
        id: 'e1', featured: true,
        title: 'NEXUS Summer Cup — Finals',
        description: 'Die letzten vier Teams kämpfen live um den Titel und den Hauptpreis.',
        date: '2026-08-02T18:00:00',
        image: 'https://images.unsplash.com/photo-1511512578047-dfb367046420?q=80&w=1200&auto=format&fit=crop'
      },
      { id: 'e2', title: 'Movie Night: Retro Arcade', description: 'Gemeinsames Zocken alter Klassiker im Voice-Channel.', date: '2026-07-30T20:00:00' },
      { id: 'e3', title: 'Community Game Night', description: 'Among Us, Jackbox & mehr — jeder ist willkommen.', date: '2026-08-05T19:00:00' },
      { id: 'e4', title: 'Valorant 5v5 Scrim', description: 'Offenes Scrim für alle Ranked-Spieler ab Gold.', date: '2026-08-08T17:30:00' }
    ],
    status: [
      { id: 's1', name: 'Valorant', icon: '🎯', online: true, players: 342, maxPlayers: 500, ping: 24 },
      { id: 's2', name: 'Minecraft SMP', icon: '⛏️', online: true, players: 87, maxPlayers: 150, ping: 41 },
      { id: 's3', name: 'CS2 Competitive', icon: '💣', online: true, players: 210, maxPlayers: 250, ping: 18 },
      { id: 's4', name: 'GTA RP', icon: '🚗', online: false, players: 0, maxPlayers: 200, ping: 0 },
      { id: 's5', name: 'League of Legends', icon: '⚔️', online: true, players: 156, maxPlayers: 400, ping: 63 },
      { id: 's6', name: 'Rust', icon: '🔧', online: true, players: 64, maxPlayers: 100, ping: 92 }
    ],
    giveaways: [
      {
        id: 'g1', title: 'Gaming-Headset Giveaway', prize: 'SteelSeries Arctis Nova Pro',
        endsAt: '2026-08-01T18:00:00', entries: 1284,
        requirements: ['Mitglied seit min. 7 Tagen', 'Im Voice-Channel aktiv gewesen', 'Reaktion auf Ankündigung'],
        winner: null
      },
      {
        id: 'g2', title: 'Steam-Guthaben Verlosung', prize: '50€ Steam-Guthaben',
        endsAt: '2026-08-10T12:00:00', entries: 642,
        requirements: ['Server-Regeln akzeptiert', 'Rolle @Gamer verifiziert'],
        winner: null
      },
      {
        id: 'g3', title: 'Nitro Classic (3 Monate)', prize: 'Discord Nitro Classic',
        endsAt: '2026-07-20T18:00:00', entries: 2310,
        requirements: ['Teilnahme über Reaction-Emoji'],
        winner: 'PixelWolf'
      }
    ]
  };

  const STATE = {
    news: [], community: {}, events: [], status: [], giveaways: []
  };

  /* ======================================================================
     3) INITIALISIERUNG / DATEN LADEN
     ====================================================================== */

  async function loadAllData() {
    liveDataIssues.length = 0;
    const [news, events, giveaways, discordWidget, minecraftLive, memberTotal] = await Promise.all([
      fetchLive('news', DEMO.news),
      fetchLive('events', DEMO.events),
      fetchLive('giveaways', DEMO.giveaways),
      fetchDiscordWidget(),
      fetchMinecraftStatus(),
      fetchDiscordMemberTotal()
    ]);
    STATE.news = news;
    STATE.events = events;
    STATE.giveaways = giveaways;

    // Community: echte Discord-Widget-Daten verwenden, falls konfiguriert — sonst Demo-Daten.
    if (discordWidget) {
      STATE.community = {
        ...DEMO.community,
        ...discordWidget,
        members: discordWidget.members || DEMO.community.members
        // newMembers bleibt bewusst null (kommt aus discordWidget) — renderCommunity()
        // zeigt dann stattdessen die echte Liste der Online-Mitglieder (onlineMembers) an.
      };
    } else {
      STATE.community = DEMO.community;
    }

    // Echte Gesamtmitgliederzahl (online + offline) über die Invite-API überschreiben,
    // falls verfügbar — das ist die genaueste Quelle ohne Bot.
    if (memberTotal?.totalMembers != null) {
      STATE.community.members = memberTotal.totalMembers;
    }

    // Serverstatus: echten Minecraft-Status voranstellen, falls konfiguriert.
    // Die restlichen Spiele bleiben Platzhalter, da es für sie keine öffentliche
    // Status-API gibt, ohne eigene Spiel-Server mit aktivierter Query zu betreiben.
    STATE.status = minecraftLive
      ? [minecraftLive, ...DEMO.status.filter(s => s.name !== MINECRAFT_CONFIG.name)]
      : DEMO.status;

    renderNews();
    renderCommunity();
    renderEvents();
    renderCalendar();
    renderStatus();
    renderGiveaways();
    buildSearchIndex();
    document.getElementById('lastSync').textContent = new Date().toLocaleTimeString('de-DE');
    renderLiveDataIssues();
  }

  function startAutoSync() {
    setInterval(loadAllData, WEBHOOK_CONFIG.pollIntervalMs);
  }

  /* ======================================================================
     4) RENDER: NEWS
     ====================================================================== */

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function renderNews() {
    const grid = document.getElementById('newsGrid');
    grid.innerHTML = STATE.news.map(n => `
      <article class="glass-card news-card reveal" data-search-title="${escapeHtml(n.title)}">
        <div class="news-card-img">
          <img src="${n.image}" alt="" loading="lazy">
          <span class="news-card-tag">${escapeHtml(n.tag)}</span>
        </div>
        <div class="news-card-body">
          <span class="news-card-date">${formatDate(n.date)}</span>
          <h3 class="news-card-title">${escapeHtml(n.title)}</h3>
          <p class="news-card-desc">${escapeHtml(n.description)}</p>
        </div>
      </article>
    `).join('');
    observeReveal();
  }

  /* ======================================================================
     5) RENDER: COMMUNITY
     ====================================================================== */

  function renderCommunity() {
    const c = STATE.community;
    if (c.instantInvite) {
      document.querySelectorAll('a.cta-btn, .community-header a.btn').forEach(a => { a.href = c.instantInvite; });
    }
    document.getElementById('metricMembers').textContent = c.members ? formatNumber(c.members) : '—';
    document.getElementById('metricOnline').textContent = formatNumber(c.online);
    document.getElementById('metricVoice').textContent = formatNumber(c.voiceActive);
    document.getElementById('heroOnlineCount').textContent = formatNumber(c.online);

    document.getElementById('vcList').innerHTML = (c.voiceChannels && c.voiceChannels.length)
      ? c.voiceChannels.map(vc => `
          <div class="vc-item">
            <span class="vc-name"><span class="status-dot ${vc.count > 0 ? 'status-online' : 'status-offline'}"></span>${escapeHtml(vc.name)}</span>
            <span class="vc-count">${vc.count > 0 ? vc.count + ' 🎧' : 'leer'}</span>
          </div>
        `).join('')
      : `<p class="muted" style="font-size:.85rem;">Keine Voice-Channels sichtbar.</p>`;

    const sideTitle = document.getElementById('communitySideTitle');
    const newMembersList = document.getElementById('newMembers');

    if (c.onlineMembers) {
      // Echte Live-Daten vom Discord-Widget: zeigt, wer gerade online ist.
      if (sideTitle) sideTitle.textContent = `Online jetzt (${c.onlineMembers.length})`;
      newMembersList.innerHTML = c.onlineMembers.length
        ? c.onlineMembers.slice(0, 30).map(m => `
            <li class="member-item">
              <span class="member-avatar" style="${m.avatarUrl ? `background:none;` : ''}">
                ${m.avatarUrl ? `<img src="${m.avatarUrl}" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : escapeHtml(m.name[0]?.toUpperCase() || '?')}
              </span>
              <span>
                <span class="member-name" style="display:block">${escapeHtml(m.name)}</span>
                <span class="member-time">${m.inVoice ? '🎧 im Voice-Channel' : statusLabel(m.status)}</span>
              </span>
            </li>
          `).join('')
        : `<li class="muted" style="font-size:.85rem; list-style:none;">Gerade ist niemand online.</li>`;
    } else if (c.newMembers === null) {
      if (sideTitle) sideTitle.textContent = 'Neue Mitglieder';
      newMembersList.innerHTML = `<li class="muted" style="font-size:.85rem; list-style:none;">
        Für neue Mitglieder wird ein Discord-Bot-Backend benötigt (das öffentliche Server-Widget liefert diese Daten nicht).
      </li>`;
    } else {
      if (sideTitle) sideTitle.textContent = 'Neue Mitglieder';
      newMembersList.innerHTML = (c.newMembers || []).map(m => `
        <li class="member-item">
          <span class="member-avatar">${escapeHtml(m.name[0].toUpperCase())}</span>
          <span>
            <span class="member-name" style="display:block">${escapeHtml(m.name)}</span>
            <span class="member-time">${escapeHtml(m.time)}</span>
          </span>
        </li>
      `).join('');
    }
  }

  function statusLabel(status) {
    if (status === 'idle') return '🌙 abwesend';
    if (status === 'dnd') return '⛔ nicht stören';
    return '🟢 online';
  }

  function formatNumber(n) {
    return new Intl.NumberFormat('de-DE').format(n || 0);
  }

  /* ======================================================================
     6) RENDER: EVENTS + COUNTDOWN + KALENDER
     ====================================================================== */

  let countdownTimers = [];

  function renderEvents() {
    const featured = STATE.events.find(e => e.featured) || STATE.events[0];
    const rest = STATE.events.filter(e => e !== featured);

    const featuredEl = document.getElementById('eventFeatured');
    if (featured) {
      featuredEl.innerHTML = `
        ${featured.image ? `<div class="event-featured-bg"><img src="${featured.image}" alt=""></div>` : ''}
        <div class="event-featured-content">
          <span class="event-badge">Nächstes Highlight</span>
          <h3>${escapeHtml(featured.title)}</h3>
          <p>${escapeHtml(featured.description)}</p>
          <div class="countdown" data-countdown="${featured.date}"></div>
        </div>
      `;
    }

    document.getElementById('eventList').innerHTML = rest.map(e => {
      const d = new Date(e.date);
      return `
        <div class="glass-card event-item reveal" data-search-title="${escapeHtml(e.title)}">
          <div class="event-item-date">
            <span class="d">${d.getDate()}</span>
            <span class="m">${d.toLocaleDateString('de-DE', { month: 'short' })}</span>
          </div>
          <div class="event-item-body">
            <h4>${escapeHtml(e.title)}</h4>
            <p>${escapeHtml(e.description)}</p>
          </div>
        </div>
      `;
    }).join('');

    observeReveal();
    setupCountdowns();
  }

  function setupCountdowns() {
    countdownTimers.forEach(id => clearInterval(id));
    countdownTimers = [];

    document.querySelectorAll('[data-countdown]').forEach(el => {
      const target = new Date(el.dataset.countdown).getTime();
      const tick = () => {
        const diff = target - Date.now();
        if (diff <= 0) {
          el.innerHTML = `<span class="cd-unit"><span class="cd-value">LIVE</span><span class="cd-label">jetzt</span></span>`;
          return;
        }
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        el.innerHTML = `
          <span class="cd-unit"><span class="cd-value">${pad(days)}</span><span class="cd-label">Tage</span></span>
          <span class="cd-unit"><span class="cd-value">${pad(hours)}</span><span class="cd-label">Std</span></span>
          <span class="cd-unit"><span class="cd-value">${pad(mins)}</span><span class="cd-label">Min</span></span>
          <span class="cd-unit"><span class="cd-value">${pad(secs)}</span><span class="cd-label">Sek</span></span>
        `;
      };
      tick();
      countdownTimers.push(setInterval(tick, 1000));
    });
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  let calCursor = new Date();

  function renderCalendar() {
    const grid = document.getElementById('calendarGrid');
    const label = document.getElementById('calMonthLabel');
    const year = calCursor.getFullYear();
    const month = calCursor.getMonth();

    label.textContent = calCursor.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

    const eventDays = new Set(
      STATE.events
        .map(e => new Date(e.date))
        .filter(d => d.getFullYear() === year && d.getMonth() === month)
        .map(d => d.getDate())
    );

    const dows = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
    let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');

    const firstDay = new Date(year, month, 1);
    let startOffset = firstDay.getDay() - 1;
    if (startOffset < 0) startOffset = 6;

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();

    for (let i = 0; i < startOffset; i++) html += `<div class="cal-day empty"></div>`;
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;
      const cls = ['cal-day'];
      if (eventDays.has(d)) cls.push('has-event');
      if (isToday) cls.push('today');
      html += `<div class="${cls.join(' ')}">${d}</div>`;
    }

    grid.innerHTML = html;
  }

  document.getElementById('calPrev').addEventListener('click', () => {
    calCursor.setMonth(calCursor.getMonth() - 1);
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calCursor.setMonth(calCursor.getMonth() + 1);
    renderCalendar();
  });

  /* ======================================================================
     7) RENDER: SERVERSTATUS
     ====================================================================== */

  function renderStatus() {
    const grid = document.getElementById('statusGrid');
    grid.innerHTML = STATE.status.map(s => {
      const pct = s.online && s.maxPlayers ? Math.min(100, Math.round((s.players / s.maxPlayers) * 100)) : 0;
      const hasPing = s.online && typeof s.ping === 'number';
      const pingClass = hasPing ? (s.ping <= 40 ? 'ping-good' : s.ping <= 80 ? 'ping-mid' : 'ping-bad') : '';
      const liveBadge = s.id === 'minecraft-live' ? '<span class="event-badge" style="margin-left:6px;padding:2px 8px;font-size:.6rem;">LIVE</span>' : '';
      return `
        <div class="glass-card status-card reveal" data-search-title="${escapeHtml(s.name)}">
          <div class="status-card-top">
            <span class="status-icon">${s.icon}</span>
            <h4>${escapeHtml(s.name)}${liveBadge}</h4>
            <span class="status-pill ${s.online ? 'online' : 'offline'}">
              <span class="status-dot ${s.online ? 'status-online' : 'status-offline'}"></span>
              ${s.online ? 'Online' : 'Offline'}
            </span>
          </div>
          <div class="status-metrics">
            <div><span>Spieler</span><span>${formatNumber(s.players)}${s.maxPlayers ? ' / ' + formatNumber(s.maxPlayers) : ''}</span></div>
            <div><span>Ping</span><span class="${pingClass}">${hasPing ? s.ping + ' ms' : '—'}</span></div>
          </div>
          <div class="status-bar"><div class="status-bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    }).join('');
    observeReveal();
  }

  /* ======================================================================
     8) RENDER: GEWINNSPIELE
     ====================================================================== */

  function renderGiveaways() {
    const grid = document.getElementById('giveawayGrid');
    grid.innerHTML = STATE.giveaways.map(g => {
      const ended = new Date(g.endsAt).getTime() <= Date.now();
      return `
        <div class="glass-card giveaway-card ${ended ? 'ended' : ''} reveal" data-search-title="${escapeHtml(g.title)}">
          <span class="gw-status ${ended ? 'ended' : 'active'}">${ended ? 'Beendet' : 'Aktiv'}</span>
          <h4>${escapeHtml(g.title)}</h4>
          <p class="gw-prize">🎁 ${escapeHtml(g.prize)}</p>
          <div class="gw-meta">
            <span>Teilnahmebedingungen:</span>
            <ul style="margin:0; padding-left:18px; color: var(--text-dim); font-family: var(--font-body); font-size:.82rem;">
              ${g.requirements.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
            </ul>
          </div>
          ${ended
            ? `<div class="gw-winner">🏆 Gewinner: <strong>${g.winner ? escapeHtml(g.winner) : 'wird gezogen…'}</strong></div>`
            : `<div class="gw-countdown" data-countdown="${g.endsAt}"></div>`
          }
          <span class="gw-entries">${formatNumber(g.entries)} Teilnahmen</span>
        </div>
      `;
    }).join('');
    observeReveal();
    setupCountdowns();
  }

  /* ======================================================================
     9) SUCHE
     ====================================================================== */

  let searchIndex = [];

  function buildSearchIndex() {
    searchIndex = [
      ...STATE.news.map(n => ({ type: 'News', title: n.title, href: '#news' })),
      ...STATE.events.map(e => ({ type: 'Event', title: e.title, href: '#events' })),
      ...STATE.status.map(s => ({ type: 'Server', title: s.name, href: '#status' })),
      ...STATE.giveaways.map(g => ({ type: 'Giveaway', title: g.title, href: '#giveaways' }))
    ];
  }

  const searchToggle = document.getElementById('searchToggle');
  const searchBox = document.getElementById('searchBox');
  const searchInput = document.getElementById('searchInput');
  const searchResults = document.getElementById('searchResults');

  searchToggle.addEventListener('click', () => {
    const open = searchBox.classList.toggle('open');
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) setTimeout(() => searchInput.focus(), 150);
  });

  document.addEventListener('click', (e) => {
    if (!searchBox.contains(e.target) && e.target !== searchToggle && !searchToggle.contains(e.target)) {
      searchBox.classList.remove('open');
      searchToggle.setAttribute('aria-expanded', 'false');
    }
  });

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchResults.innerHTML = ''; return; }
    const matches = searchIndex.filter(item => item.title.toLowerCase().includes(q)).slice(0, 8);
    searchResults.innerHTML = matches.length
      ? matches.map(m => `
          <a href="${m.href}">
            <span class="sr-cat">${m.type}</span>
            <span>${escapeHtml(m.title)}</span>
          </a>
        `).join('')
      : `<div class="search-empty">Keine Treffer für „${escapeHtml(searchInput.value)}“</div>`;
  });

  document.querySelectorAll('#searchResults').forEach(el => {
    el.addEventListener('click', () => {
      searchBox.classList.remove('open');
      searchInput.value = '';
      searchResults.innerHTML = '';
    });
  });

  /* ======================================================================
     10) NAVIGATION: Hamburger, Scroll-Style
     ====================================================================== */

  const nav = document.getElementById('nav');
  const hamburger = document.getElementById('hamburger');

  hamburger.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('menu-open');
    hamburger.setAttribute('aria-expanded', String(isOpen));
  });

  document.querySelectorAll('.mobile-menu a').forEach(a => {
    a.addEventListener('click', () => nav.classList.remove('menu-open'));
  });

  window.addEventListener('scroll', () => {
    nav.style.borderBottomColor = window.scrollY > 40 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.09)';
  }, { passive: true });

  /* ======================================================================
     11) HERO ZÄHLER-ANIMATION
     ====================================================================== */

  function animateCounters() {
    document.querySelectorAll('.hero-stat-value').forEach(el => {
      const target = parseInt(el.dataset.count, 10);
      const duration = 1600;
      const start = performance.now();
      function step(now) {
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = formatNumber(Math.floor(target * eased));
        if (progress < 1) requestAnimationFrame(step);
        else el.textContent = formatNumber(target);
      }
      requestAnimationFrame(step);
    });
  }

  /* ======================================================================
     12) SCROLL-REVEAL (IntersectionObserver)
     ====================================================================== */

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });

  function observeReveal() {
    document.querySelectorAll('.reveal:not(.in)').forEach(el => revealObserver.observe(el));
  }

  /* ======================================================================
     13) TOAST
     ====================================================================== */

  let toastTimer;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
  }

  /* ======================================================================
     14) PARTIKEL-HINTERGRUND (Canvas)
     ====================================================================== */

  function initParticles() {
    const canvas = document.getElementById('bg-canvas');
    const ctx = canvas.getContext('2d');
    let particles = [];
    let w, h;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    }

    function initParticleSet() {
      const count = Math.min(90, Math.floor((w * h) / 18000));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        r: Math.random() * 1.6 + 0.6,
        hue: Math.random() > 0.5 ? '79,157,255' : '168,85,247'
      }));
    }

    function step() {
      ctx.clearRect(0, 0, w, h);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.hue},0.55)`;
        ctx.fill();
      });
      // Verbindungslinien zwischen nahen Partikeln
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 120) {
            ctx.strokeStyle = `rgba(120,140,255,${0.12 * (1 - dist / 120)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      if (!reduceMotion) requestAnimationFrame(step);
    }

    resize();
    initParticleSet();
    window.addEventListener('resize', () => { resize(); initParticleSet(); });
    step();
    if (reduceMotion) step(); // ein statischer Frame
  }

  /* ======================================================================
     15) UTIL
     ====================================================================== */

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* ======================================================================
     16) START
     ====================================================================== */

  window.addEventListener('DOMContentLoaded', async () => {
    initParticles();
    await loadAllData();
    animateCounters();
    observeReveal();
    startAutoSync();

    const loader = document.getElementById('loader');
    setTimeout(() => loader.classList.add('hidden'), 500);
  });

  // Öffentliche Mini-API für externe Integrationen / Debugging in der Konsole
  window.NEXUS = { handleIncomingWebhook, sendToDiscord, reload: loadAllData };

})();
