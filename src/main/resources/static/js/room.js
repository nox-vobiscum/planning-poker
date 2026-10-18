/* room.js — UI + WS glue for Planning Poker (liveness-hardened)
   - 15s heartbeat pings (ping)
   - Watchdog reconnects if we see no inbound frames for >20s
   - Wake-ups on visibilitychange / focus / online / pageshow (poke + resync)
   - Exponential backoff reconnect w/ jitter
   - English inline comments & "Spectator" wording
   - WebSocket admission is authoritative for both new joins and resumes
   - Specials revamp (host-defined extras, "❓" always included)
*/
(() => {
  'use strict';

  /*** ---------- Small DOM helpers ---------- ***/
  const TAG = '[ROOM]';
  const $ = (s) => document.querySelector(s);
  const setText = (sel, v) => {
    const el = typeof sel === 'string' ? $(sel) : sel;
    if (el) el.textContent = (v != null ? v : '');
  };

  /*** ---------- i18n (lightweight) ---------- ***/
  const MSG = Object.create(null);
  function t(key, fallback) {
    try {
      if (key && Object.prototype.hasOwnProperty.call(MSG, key)) return MSG[key];
      const meta = document.head && document.head.querySelector('meta[name="msg.' + key + '"]');
      if (meta && typeof meta.content === 'string' && meta.content.length) return meta.content;
    } catch {}
    return fallback;
  }
  async function preloadMessages() {
    const lang = isDe() ? 'de' : 'en';
    try {
      const res = await fetch('/i18n/messages?lang=' + encodeURIComponent(lang), { credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data === 'object') Object.assign(MSG, data);
      }
    } catch {}
  }

  /*** ---------- Constants ---------- ***/
  // Base question is ALWAYS in the deck (at the end)
  const QUESTION = '❓';

  // Mapping from palette IDs -> Emojis
  const SPECIALS_ICON_BY_ID = Object.freeze({
    coffee     : '☕',
    speech     : '💬',
    telescope  : '🔭',
    waiting    : '⏳',
    dependency : '🔗',
    risk       : '⚠️',
    relevance  : '🎯'
  });
  const SPECIALS_ORDER = Object.freeze(['coffee','speech','telescope','waiting','dependency','risk','relevance']);
  const SPECIALS_IDS_SET = new Set(SPECIALS_ORDER);
    // Do NOT include QUESTION here => it stays in the main row
  const ALL_SPECIALS_EMOJI = new Set(Object.values(SPECIALS_ICON_BY_ID));


  const INFINITY_ = '♾️';
  const INFINITY_ALT = '∞';

  // Liveness knobs (tuned for iOS tab sleeps)
  const HEARTBEAT_MS = 15000;
  const WATCHDOG_STALE_MS = 20000;
  const WATCHDOG_TICK_MS  = 5000;
  const RECO_BASE_MS = 800;
  const RECO_MAX_MS  = 12000;

  // script dataset / URL params
  const scriptEl = document.querySelector('script[src*="/js/room.js"]') || document.querySelector('script[src*="room.liveness.js"]');
  const ds = (scriptEl && scriptEl.dataset) || {};
  const url = new URL(location.href);

  // Allow disabling specific specials via data-attribute (e.g., data-disabled-specials="☕,💬")
  const DISABLED_SPECIALS = new Set(
    String(ds.disabledSpecials || '')
      .split(',').map(function (s) { return s.trim(); }).filter(Boolean)
  );

  /*** ---------- Client state ---------- ***/
  const state = {
    _chipAnimShown: false,

    roomCode: ds.room || url.searchParams.get('roomCode') || 'demo',
    youName:  ds.participant || url.searchParams.get('participantName') || 'Guest',
    ws: null,
    connected: false,

    isHost: false,
    _hostKnown: false,
    votesRevealed: false,
    cards: [],
    participants: [],
    averageVote: null,
    medianVote: null,
    range: null,
    consensus: false,
    outliers: [],

    sequenceId: null,
    topicVisible: true,
    topicLabel: '',
    topicUrl: null,

    autoRevealEnabled: false,

    // client-only toggles
    hardMode: false,

    // EXTRAS toggle (ON = extras shown); QUESTION is always shown regardless
    allowSpecials: false,

    // host-selected specials (IDs like 'coffee', 'telescope', ...)
    specialsSelected: [],

    selfSpectator: false, // local mirror for immediate UI response to participation toggle

    // topic edit
    topicEditing: false,

    // UI helpers
    _optimisticVote: null,
    hardRedirect: null,

    // short pending guard for local sequence changes
    _pendingSeq: null,
    _pendingSeqUntil: 0
  };

  let identityCredential = window.PPIdentity.read(state.roomCode);
  let identityBlocked = false;
  let exitRequested = window.PPIdentity.exitPending(state.roomCode, identityCredential);
  // Canonicalize URL params (no reload) for shareable links
  function canonicalizeRoomUrl() {
    try {
      const desiredQs = new URLSearchParams({
        roomCode: state.roomCode || '',
        participantName: state.youName || ''
      }).toString();
      const current = location.search.replace(/^\?/, '');
      if (current !== desiredQs) {
        const newUrl = location.pathname + '?' + desiredQs + (location.hash || '');
        history.replaceState(null, '', newUrl);
      }
    } catch {}
  }
  canonicalizeRoomUrl();

  /*** ---------- Helpers ---------- ***/
  function normalizeSeq(id) {
    if (!id) return 'fib.scrum';
    const s = String(id).toLowerCase().trim();
    if (s === 'fib-enh') return 'fib.enh';
    if (s === 'fib-math') return 'fib.math';
    if (s === 't-shirt')  return 'tshirt';
    return s;
  }

  function isDe() {
    return (document.documentElement.lang || 'en').toLowerCase().startsWith('de');
  }
  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/gameSocket';
  }
  function syncHostClass() {
    document.body.classList.toggle('is-host', !!state.isHost);
  }

  /*** ---------- Specials helpers ---------- ***/
  function idsToEmojis(ids) {
    if (!Array.isArray(ids)) return [];
    const uniq = Array.from(new Set(ids.filter(function (id) { return SPECIALS_IDS_SET.has(id); })));
    return uniq.map(function (id) { return SPECIALS_ICON_BY_ID[id]; }).filter(Boolean);
  }
  function emojisToIds(emojis) {
    if (!Array.isArray(emojis)) return [];
    const mapEmojiToId = new Map(Object.entries(SPECIALS_ICON_BY_ID).map(function (kv) { return [kv[1], kv[0]]; }));
    return Array.from(new Set(
      emojis.map(function (e) { return mapEmojiToId.get(e); }).filter(Boolean)
    ));
  }
  function canonicalizeIds(ids) {
    const set = new Set(ids.filter(function (id) { return SPECIALS_IDS_SET.has(id); }));
    return SPECIALS_ORDER.filter(function (id) { return set.has(id); });
  }
  function tipForSpecialEmoji(emoji) {
    // Fallbacks in both languages (i18n keys may not exist yet)
    switch (emoji) {
      case QUESTION: return t('card.tip.question',
        'I still have questions about this requirement.'
        );
      case '☕': return t('card.tip.coffee', 'I need a short break…');
      case '💬': return t('card.tip.speech',
        'We need a separate meeting before we can estimate.'
      );
      case '🔭': return t('card.tip.telescope',
        'We need a spike/exploration task first.'
      );
      case '⏳': return t('card.tip.waiting',
        'We can estimate only after a prerequisite is met.'
      );
      case '🔗': return t('card.tip.dependency',
        'This estimate depends on another task’s outcome.'
      );
      case '⚠️': return t('card.tip.risk',
        'There are risks that significantly affect the estimate.'
      );
      case '🎯': return t('card.tip.relevance',
        'First confirm alignment with goals/vision.'
      );
      default: return '';
    }
  }

  /*** ---------- Deck bootstrap & number formatting ---------- ***/
  // Build a deck from sequence + extras (QUESTION is always included at the end)
  function defaultDeck(seqId, allowExtras, extras) {
    if (seqId == null) seqId = 'fib.scrum';
    if (typeof allowExtras !== 'boolean') allowExtras = false; // default OFF
    if (!Array.isArray(extras)) extras = [];
    // Core numeric deck
    const base = ['0', '1/2', '1', '2', '3', '5', '8', '13', '20', '40', '100'];
    const withInfinity = base.concat([INFINITY_]); // only visible in fib.enh
    const core = (seqId === 'fib.enh') ? withInfinity : base;

    // Extras: filter disabled & dedupe & keep stable order by SPECIALS_ORDER
    const extrasEmoji = allowExtras ? idsToEmojis(canonicalizeIds(extras)) : [];
    const filteredExtras = extrasEmoji.filter(function (e) { return !DISABLED_SPECIALS.has(String(e)); });

    // QUESTION is always present (last)
    return core.concat(filteredExtras).concat([QUESTION]);
  }

  function ensureBootstrapDeck() {
    if (!Array.isArray(state.cards) || state.cards.length === 0) {
      state.sequenceId = normalizeSeq(state.sequenceId || 'fib.scrum');
      let deck = defaultDeck(state.sequenceId, state.allowSpecials, state.specialsSelected);
      if (state.sequenceId !== 'fib.enh') {
        deck = deck.filter(function (c) { return c !== INFINITY_ && c !== INFINITY_ALT; });
      }
      deck = deck.filter(function (c) { return !DISABLED_SPECIALS.has(String(c)); });
      // ensure QUESTION last
      deck = deck.filter(function (c) { return c !== QUESTION; });
      deck.push(QUESTION);
      state.cards = deck;
    }
  }

  function fmtNumber(n){
    try {
      return new Intl.NumberFormat(isDe() ? 'de' : 'en', { maximumFractionDigits: 2 }).format(n);
    } catch { return String(n); }
  }
  function fmtStat(val){
    if (val == null || val === '') return null;
    const s = String(val).trim();
    if (s === '∞' || s === INFINITY_) return s;
    if (s === '½' || s === '1/2') return isDe() ? '0,5' : '0.5';
    const x = Number(s.replace(',', '.'));
    return Number.isFinite(x) ? fmtNumber(x) : s;
  }
  function fmtRange(s){
    if (s == null || s === '') return null;
    const parts = String(s).split(/[-–—]/);
    if (parts.length === 2) return fmtStat(parts[0].trim()) + '–' + fmtStat(parts[1].trim());
    return String(s);
  }

  /*** ---------- WebSocket + liveness ---------- ***/
  let hbTimer = null;
  let wdTimer = null;
  let rcTimer = null;
  let rcAttempts = 0;
  let lastInboundAt = 0;
  let navigationHandoff = null;
  const NAVIGATION_HANDOFF_TIMEOUT_MS = 450;

  function send(line) { if (state.connected && state.ws && state.ws.readyState === 1) state.ws.send(line); }

  function finishNavigationHandoff() {
    if (!navigationHandoff) return;
    const pending = navigationHandoff;
    navigationHandoff = null;
    clearTimeout(pending.timer);
    pending.navigate();
  }

  function releaseForNavigation(navigate) {
    if (navigationHandoff || exitRequested) return;
    const socket = state.ws;
    if (!state.connected || !socket || socket.readyState !== WebSocket.OPEN) {
      navigate();
      return;
    }
    navigationHandoff = {
      navigate: navigate,
      timer: setTimeout(finishNavigationHandoff, NAVIGATION_HANDOFF_TIMEOUT_MS)
    };
    try { socket.send('releaseForNavigation'); }
    catch { finishNavigationHandoff(); }
  }

  function releaseNavigationBestEffort() {
    if (exitRequested || navigationHandoff || !state.connected) return;
    const socket = state.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try { socket.send('releaseForNavigation'); } catch {}
  }

  function startHeartbeat() {
    stopHeartbeat();
    hbTimer = setInterval(function () {
      if (state.ws && state.ws.readyState === 1) {
        try { state.ws.send('ping'); } catch {}
      }
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null; } }

  function startWatchdog() {
    stopWatchdog();
    wdTimer = setInterval(function () {
      const ws = state.ws;
      if (ws && ws.readyState === 1) {
        const age = Date.now() - lastInboundAt;
        if (age > WATCHDOG_STALE_MS) {
          console.warn(TAG, 'watchdog: stale socket → reconnect');
          try { ws.close(4002, 'stale'); } catch {}
          scheduleReconnect('watchdog-stale');
        }
      } else {
        scheduleReconnect('watchdog-closed');
      }
    }, WATCHDOG_TICK_MS);
  }
  function stopWatchdog() { if (wdTimer) { clearInterval(wdTimer); wdTimer = null; } }

  function scheduleReconnect(reason) {
    if (state.hardRedirect || identityBlocked) return;
    if (rcTimer) return;
    const attempt = rcAttempts++;
    const base = Math.min(RECO_MAX_MS, RECO_BASE_MS * Math.pow(2, attempt));
    const jitter = base * (0.3 * Math.random());
    const delay = Math.max(300, base - (base * 0.15) + jitter);
    console.warn(TAG, 'scheduleReconnect', { reason: reason, attempt: attempt, delay: delay });
    rcTimer = setTimeout(function () {
      rcTimer = null;
      connectWS();
    }, delay);
  }
  function resetReconnectBackoff() {
    rcAttempts = 0;
    if (rcTimer) { clearTimeout(rcTimer); rcTimer = null; }
  }

  function pokeServerAndSync() {
    try { if (state.ws && state.ws.readyState === 1) state.ws.send('ping'); } catch {}
    try { send('requestSync'); } catch {}
    setTimeout(function () { try { send('requestSync'); } catch {} }, 200);
  }

  function wake(reason) {
    if (reason == null) reason = 'wake';
    if (state.hardRedirect || identityBlocked) return;
    if (navigator && 'onLine' in navigator && !navigator.onLine) {
      console.info(TAG, 'wake: offline — will wait for "online"');
      return;
    }
    const ws = state.ws;
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.info(TAG, 'wake:', reason, '→ connection already in progress');
      return;
    }
    if (ws && ws.readyState === 1) {
      console.info(TAG, 'wake:', reason, '→ poke + resync');
      pokeServerAndSync();
    } else {
      console.info(TAG, 'wake:', reason, '→ reconnect now');
      try { if (ws) ws.close(4003, 'wake-reconnect'); } catch {}
      resetReconnectBackoff();
      connectWS();
    }
  }

  // Single, final version of connectWS (handles text + JSON)
  function connectWS() {
    if (identityBlocked) return;
    const u = wsUrl();

    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) {
      try { state.ws.close(4004, 'reconnect'); } catch {}
    }

    console.info(TAG, 'connect →', u);

    let s;
    try { s = new WebSocket(u); }
    catch (e) { console.error(TAG, e); scheduleReconnect('ctor'); return; }

    state.ws = s;
    try { window.__ppWs = s; } catch {}

    s.onopen = function () {
      if (state.ws !== s) return;
      lastInboundAt = Date.now();
      const request = identityCredential
        ? { version: 2, type: 'resume', roomCode: state.roomCode, ...identityCredential }
        : { version: 2, type: 'newJoin', roomCode: state.roomCode, participantName: state.youName };
      s.send(JSON.stringify(request));
    };
    s.onclose = function (ev) {
      if (state.ws !== s) return;
      state.connected = false;
      stopHeartbeat();
      stopWatchdog();

      if (exitRequested && ev.code === 4400) { completeExit(); return; }
      if (state.hardRedirect) { location.href = state.hardRedirect; return; }
      if (identityBlocked) return;

      if (ev.code === 4000 || ev.code === 4001) {
        window.PPRoomReturn?.clear(state.roomCode, state.youName);
        try { sessionStorage.setItem('pp-flash', ev.code === 4001 ? 'kicked' : 'roomClosed'); } catch {}
        location.replace('/');
        return;
      }

      if ([4005, 4401, 4406, 4409].includes(ev.code)) {
        identityBlocked = true;
        showToast(isDe() ? 'Teilnahme konnte nicht fortgesetzt werden. Bitte neu beitreten.' : 'Unable to resume participation. Please join again.');
        return;
      }
      console.warn(TAG, 'onclose', ev.code, ev.reason || '');
      scheduleReconnect('close');
    };

    s.onerror = function (e) {
      console.warn(TAG, 'ws error', e);
    };

    s.onmessage = function (ev) {
      if (state.ws !== s) return;
      lastInboundAt = Date.now();

      if (ev.data === 'pong') return;
      // Handle proofs before the generic message/debug path; never retain them there.
      try {
        const identity = JSON.parse(ev.data);
        if (identity.type === 'identityGrant') {
          const storage = window.PPIdentity.save(state.roomCode, identity);
          identityCredential = window.PPIdentity.read(state.roomCode);
          if (storage !== 'localStorage') showIdentityStorageNotice(storage);
          s.send('identityAck');
          return;
        }
        if (identity.type === 'identityReady') {
          state.connected = true;
          if (identity.yourName) {
            state.youName = identity.yourName;
            setText('#youName', state.youName);
            canonicalizeRoomUrl();
          }
          resetReconnectBackoff(); startHeartbeat(); startWatchdog();
          send('requestSync');
          if (exitRequested) send('intentionalLeave');
          return;
        }
        if (identity.type === 'identityChallenge') {
          s.send('identityPong:' + identity.nonce);
          return;
        }
        if (identity.type === 'navigationReleased') {
          state.connected = false;
          finishNavigationHandoff();
          return;
        }
        if (identity.type === 'identityError') {
          state.connected = false;
          if (identity.reason === 'expired' && identityCredential) return;
          if (exitRequested && identity.reason === 'invalid') { completeExit(); return; }
          identityBlocked = true;
          stopHeartbeat(); stopWatchdog();
          if (identity.reason === 'invalid' || identity.reason === 'nameTaken') {
            if (identity.reason === 'invalid') {
              window.PPIdentity.clearExit(state.roomCode, identityCredential);
              window.PPIdentity.clear(state.roomCode, identityCredential);
            }
            window.PPRoomReturn?.clear(state.roomCode);
            const reason = identity.reason === 'invalid' ? '&rejoin=invalid' : '&nameTaken=1';
            state.hardRedirect = '/invite?roomCode=' + encodeURIComponent(state.roomCode) +
              '&participantName=' + encodeURIComponent(state.youName) + reason;
            location.replace(state.hardRedirect);
            return;
          }
          const active = identity.reason === 'activeElsewhere';
          showToast(active
            ? (isDe() ? 'Diese Teilnahme ist bereits in einem anderen Fenster aktiv.' : 'This participation is already active in another window.')
            : (isDe() ? 'Teilnahme nicht möglich. Bitte neu beitreten oder die Seite neu laden.' : 'Unable to join. Please join again or reload the page.'));
          return;
        }
        if (identity.type === 'exited') {
          completeExit();
          return;
        }
        if (identity.type === 'kicked' || identity.type === 'roomClosed') {
          window.PPIdentity.clearExit(state.roomCode, identityCredential);
          window.PPIdentity.clear(state.roomCode, identityCredential);
        }
      } catch { /* Non-JSON game frames continue below. */ }

      // Legacy plain-text roster frames first
      if (typeof ev.data === 'string') {
        if (ev.data.indexOf('participantJoined:') === 0) {
          const name = ev.data.slice('participantJoined:'.length).trim();
          if (name) { addParticipantLocal(name); try { renderParticipants(); } catch {} }
          return;
        }
        if (ev.data.indexOf('participantLeft:') === 0) {
          const name = ev.data.slice('participantLeft:'.length).trim();
          if (name) { removeParticipantLocal(name); try { renderParticipants(); } catch {} }
          return;
        }
      }

      // Small JSON messages (compat)
      try {
        if (typeof ev.data === 'string' && ev.data.charAt(0) === '{') {
          const msg = JSON.parse(ev.data);
          switch (msg && msg.type) {
            case 'participantJoined': {
              const name = (msg.name || '').trim();
              if (name) { addParticipantLocal(name); try { if (renderParticipants) renderParticipants(); } catch {} }
              return;
            }
            case 'participantLeft': {
              const name = (msg.name || '').trim();
              if (name) { removeParticipantLocal(name); try { if (renderParticipants) renderParticipants(); } catch {} }
              return;
            }
            case 'kicked': {
              window.PPRoomReturn?.clear(state.roomCode, state.youName);
              if (msg.redirect) {
                try { window.location.assign(msg.redirect); } catch { window.location.href = msg.redirect; }
              }
              return;
            }
          }
        }
      } catch { /* ignore and fall through */ }

      // Full JSON room-state messages
      try {
        const msg = JSON.parse(ev.data);
        try {
          window.__ppVU = window.__ppVU || [];
          window.__ppVU.push(msg);
        } catch {}
        handleMessage(msg);
      } catch (e) {
        console.warn(TAG, 'Bad message', e);
      }
    };
  }

  /*** ---------- Messages ---------- ***/
  function handleMessage(m) {
    switch (m.type) {
      case 'you': {
        if (m.yourName && m.yourName !== state.youName) { state.youName = m.yourName; setText('#youName', state.youName); }
        window.PPRoomReturn?.remember(state.roomCode, state.youName);
        break;
      }
      case 'roomClosed': {
        window.PPRoomReturn?.clear(state.roomCode, state.youName);
        state.hardRedirect = m.redirect || '/';
        try { if (state.ws) state.ws.close(4000, 'Room closed'); } catch {}
        break;
      }
      case 'kicked': {
        window.PPRoomReturn?.clear(state.roomCode, state.youName);
        state.hardRedirect = m.redirect || '/';
        try { if (state.ws) state.ws.close(4001, 'Kicked'); } catch {}
        break;
      }
      case 'participantJoined': {
        addParticipantLocal((m.name || '').trim());
        try { if (renderParticipants) renderParticipants(); } catch {}
        break;
      }
      case 'participantLeft': {
        removeParticipantLocal((m.name || '').trim());
        try { if (renderParticipants) renderParticipants(); } catch {}
        break;
      }
      case 'participantRenamed': {
        const from = m.from || '', to = m.to || '';
        if (from !== state.youName) showToast(isDe() ? (from + ' heißt jetzt ' + to) : (from + ' is now ' + to));
        break;
      }
      case 'hostTransferred': {
        const from = m.from || '', to = m.to || '';
        const msg = (state.youName === to)
          ? (isDe() ? 'Host gewechselt. Du bist jetzt Host!' : 'Host changed. You are now host!')
          : (isDe() ? ('Host-Rolle wurde an ' + to + ' übertragen') : ('Host role transferred to ' + to));
        showToast(msg);
        break;
      }
      case 'voteUpdate': {
        applyVoteUpdate(m);
        break;
      }
      case 'specialsChanged': {
        // Optional explicit event from server (enabled + selected IDs)
        if (typeof m.enabled === 'boolean') state.allowSpecials = !!m.enabled;
        if (Array.isArray(m.selected)) state.specialsSelected = canonicalizeIds(m.selected);
        rebuildDeckFromState();
        break;
      }
      default: break;
    }
  }

  /*** ---------- Apply room state ---------- ***/
  function rebuildDeckFromState() {
    const seqId = state.sequenceId || 'fib.scrum';
    let deck = defaultDeck(seqId, state.allowSpecials, state.specialsSelected);
    if (seqId !== 'fib.enh') deck = deck.filter(function (c) { return c !== INFINITY_ && c !== INFINITY_ALT; });
    deck = deck.filter(function (c) { return !DISABLED_SPECIALS.has(String(c)); });
    // QUESTION at end
    deck = deck.filter(function (c) { return c !== QUESTION; });
    deck.push(QUESTION);
    state.cards = deck;

    renderCards();
    renderResultBar();
    syncSequenceInMenu();
    syncSpecialsPaletteFromState(); // keep palette checkboxes + visibility in sync
  }

  function applyVoteUpdate(m) {
    try {
      const has = function (obj, k) { return Object.prototype.hasOwnProperty.call(obj || {}, k); };

      // sequence id (guard against reverting a very recent local change)
      if (has(m, 'sequenceId')) {
        const incoming = normalizeSeq(m.sequenceId);
        const now = Date.now();
        if (state._pendingSeq && now < state._pendingSeqUntil) {
          // Ignore mismatching old server snapshot during short pending window
          if (incoming === state._pendingSeq) {
            state.sequenceId = incoming;       // server confirms our choice
            state._pendingSeq = null;
            state._pendingSeqUntil = 0;
          }
        } else {
          state.sequenceId = incoming;
        }
      } else if (!state.sequenceId) {
        state.sequenceId = 'fib.scrum';
      }

      // mirror into menu radios immediately
      updateAllSeqRadiosChecked(state.sequenceId);

      // specials / deck
      let extrasFromServerEmoji = null;
      let extrasEnabledFromServer = null;

      // Accept either array of emojis (['☕','💬']) or array of IDs (['coffee','speech'])
      if (has(m, 'specials') && Array.isArray(m.specials)) {
        const arr = m.specials.slice();
        const looksLikeIds = arr.every(function (x) { return typeof x === 'string' && SPECIALS_IDS_SET.has(x); });
        extrasFromServerEmoji = looksLikeIds ? idsToEmojis(arr) : arr;
        // NOTE: A non-empty specials list does NOT imply "enabled".
        // The server must send an explicit boolean (allowSpecials / specialsEnabled / specialsOff).
        state.specialsSelected = canonicalizeIds(looksLikeIds ? arr : emojisToIds(arr));
      }

      // Legacy/alt booleans
      if (has(m, 'allowSpecials'))  extrasEnabledFromServer = !!m.allowSpecials;
      if (has(m, 'specialsOff'))    extrasEnabledFromServer = !m.specialsOff;
      if (has(m, 'specialsEnabled'))extrasEnabledFromServer = !!m.specialsEnabled;

      if (extrasEnabledFromServer !== null) state.allowSpecials = extrasEnabledFromServer;

      const seqId = state.sequenceId || 'fib.scrum';

      // If server provides full cards array, adopt it; otherwise build from sequence + specials
      let deck;
      if (has(m, 'cards') && Array.isArray(m.cards)) {
        deck = m.cards.slice();
      } else {
        const ids = state.specialsSelected;
        deck = defaultDeck(seqId, state.allowSpecials, ids);
        // If server supplied explicit extras (emoji), prefer those (still always include QUESTION)
        if (extrasFromServerEmoji) {
          deck = deck.filter(function (c) { return c !== QUESTION; }); // drop question, will be re-appended
          const base = defaultDeck(seqId, false, []); // no extras + QUESTION
          deck = base.filter(function (c) { return c !== QUESTION; }).concat(extrasFromServerEmoji).concat([QUESTION]);
        }
      }

      // Infinity only for enh
      if (seqId !== 'fib.enh') deck = deck.filter(function (c) { return c !== INFINITY_ && c !== INFINITY_ALT; });

      // Honor local disabled specials
      deck = deck.filter(function (c) { return !DISABLED_SPECIALS.has(String(c)); });

      // Safety: ensure QUESTION last
      deck = deck.filter(function (c) { return c !== QUESTION; });
      deck.push(QUESTION);

      // Safety
      if (!deck.length) {
        deck = defaultDeck(seqId, state.allowSpecials, state.specialsSelected);
        if (seqId !== 'fib.enh') deck = deck.filter(function (c) { return c !== INFINITY_ && c !== INFINITY_ALT; });
      }
      state.cards = deck;

      // core flags / stats
      if (has(m, 'votesRevealed') || has(m, 'cardsRevealed') || has(m, 'revealed')) {
        state.votesRevealed = !!(has(m, 'votesRevealed') ? m.votesRevealed
                              : has(m, 'cardsRevealed')   ? m.cardsRevealed
                              : m.revealed);
      }

      if (has(m, 'averageVote') || has(m, 'average'))  state.averageVote = has(m, 'averageVote') ? m.averageVote : m.average;
      if (has(m, 'medianVote') || has(m, 'median'))    state.medianVote  = has(m, 'medianVote')  ? m.medianVote  : m.median;
      if (has(m, 'range'))                              state.range       = m.range;
      else if (has(m, 'min') || has(m, 'max')) {
        const min = (m.min != null ? m.min : null), max = (m.max != null ? m.max : null);
        state.range = (min != null && max != null) ? (min + '–' + max) : null;
      }

      if (has(m, 'consensus'))          state.consensus = !!m.consensus;
      if (has(m, 'outliers') && Array.isArray(m.outliers)) state.outliers = m.outliers.slice();
      if (has(m, 'autoRevealEnabled'))  state.autoRevealEnabled = !!m.autoRevealEnabled;

      // topic (protect user edits)
      if (!state.topicEditing) {
        if (has(m, 'topicVisible')) state.topicVisible = !!m.topicVisible;
        if (has(m, 'topicLabel'))   state.topicLabel   = m.topicLabel || '';
        if (has(m, 'topicUrl'))     state.topicUrl     = m.topicUrl || null;
      } else {
        state._topicIncomingWhileEditing = { label: m.topicLabel, url: m.topicUrl };
      }

      // participants; only mark host-known if authoritative data is present
      let hostInfoUpdated = false;

      if (has(m, 'participants') && Array.isArray(m.participants)) {
        const prevByName = {};
        (state.participants || []).forEach(function (p) { if (p && p.name) prevByName[p.name] = p; });
        const next = [];

        for (let i = 0; i < m.participants.length; i++) {
          const p = m.participants[i];
          if (!p) continue;
          const prev = prevByName[p.name] || null;

          const name = (p.name || (prev && prev.name) || '').trim();
          if (!name) continue;

          const vote = has(p, 'vote') ? (p.vote != null ? p.vote : null) : (prev ? (prev.vote != null ? prev.vote : null) : null);

          const spectator =
            has(p, 'spectator')     ? !!p.spectator :
            has(p, 'participating') ? (p.participating === false) :
            !!(prev && prev.spectator);

          const participating =
            has(p, 'participating') ? (p.participating !== false) :
            (!spectator && (prev ? (prev.participating !== false) : true));

          next.push({
            name: name,
            vote: vote,
            spectator: spectator,
            participating: participating,
            disconnected: has(p,'disconnected') ? !!p.disconnected : !!(prev && prev.disconnected),
            away:         has(p,'away')         ? !!p.away         : !!(prev && prev.away),
            isHost:       has(p,'isHost')       ? !!p.isHost       : !!(prev && prev.isHost)
          });
        }

        if (next.length) state.participants = next;

        const meNow = state.participants.find(function (p) { return p && p.name === state.youName; });
        if (meNow && typeof meNow.isHost === 'boolean') {
          state.isHost = !!meNow.isHost;
          state.selfSpectator = !!(meNow.spectator === true || meNow.participating === false);
          hostInfoUpdated = true;
        }
      }

      // optional flat isHost on message
      if (!hostInfoUpdated && has(m, 'isHost')) {
        state.isHost = !!m.isHost;
        hostInfoUpdated = true;
      }

      if (hostInfoUpdated) {
        state._hostKnown = true;
      }

      const me = state.participants.find(function (p) { return p && p.name === state.youName; });
      if (me && me.vote != null) state._optimisticVote = null;

      syncHostClass();
      renderParticipants();
      renderCards();
      renderResultBar();
      renderTopic();
      renderAutoReveal();

      try { (state.participants || []).forEach(function (p) { if (p && !p.disconnected) markAlive(p.name); }); } catch {}

      requestAnimationFrame(function () { syncMenuFromState(); syncSequenceInMenu(); syncSpecialsPaletteFromState(); });
      if (!document.documentElement.hasAttribute('data-ready')) {
        document.documentElement.setAttribute('data-ready', '1');
      }
    } catch (e) {
      console.error('[ROOM] applyVoteUpdate failed', e);
    }

    // Safety: ensure we show "self" locally if server sends an empty list initially
    if (Array.isArray(state.participants) &&
        !state.participants.some(function (p) { return p && p.name === state.youName; })) {
      state.participants.unshift({
        name: state.youName || 'You',
        vote: null, disconnected:false, away:false,
        isHost: !!state.isHost, participating:true, spectator:false
      });
    }
  }

  /*** ---------- Participants ---------- ***/
  function isSpectator(p) { return !!(p && (p.spectator === true || p.participating === false)); }

  function participantsRoot() {
    return document.querySelector('#liveParticipantList, #participantsList, #participantList, ul#participants, .participants-list, #participants ul, [data-participants-list]');
  }

  let participantMenu = null;
  let participantActionsBound = false;

  function canManageParticipant(p) {
    const me = (state.participants || []).find(item => item && item.name === state.youName);
    return !!(state.isHost && me && me.isHost &&
      p && p.name !== state.youName && !p.isHost);
  }

  function closeParticipantMenu(restoreFocus = true) {
    if (!participantMenu) return;
    const { trigger, menu } = participantMenu;
    participantMenu = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    menu.remove();
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  function positionParticipantMenu() {
    if (!participantMenu) return;
    const { menu } = participantMenu;
    menu.classList.remove('opens-up');
    if (menu.getBoundingClientRect().bottom > window.innerHeight - 12) menu.classList.add('opens-up');
  }

  function participantActionIcon(action) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('participant-action-icon');
    svg.dataset.icon = action;
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', action === 'host' ? '#pp-icon-host'
      : action === 'spectator' ? '#pp-icon-spectator' : '#pp-icon-exit');
    svg.appendChild(use);
    return svg;
  }

  function participantStatusIcon(kind) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('pp-status-icon');
    svg.dataset.icon = kind;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#pp-icon-' + kind);
    svg.appendChild(use);
    return svg;
  }

  function openParticipantMenu(trigger) {
    if (participantMenu?.trigger === trigger) { closeParticipantMenu(); return; }
    closeParticipantMenu(false);
    const p = (state.participants || []).find(item => item && item.name === trigger.dataset.name);
    if (!canManageParticipant(p)) return;
    const menu = document.createElement('div');
    menu.className = 'participant-action-menu';
    menu.id = 'participantActionMenu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', trigger.getAttribute('aria-label'));
    const actions = [
      ['host', t('action.makeHost', isDe() ? 'Zum Host machen' : 'Make host')],
      ['spectator', isSpectator(p)
        ? t('action.makeParticipant', isDe() ? 'Wieder mitschätzen lassen' : 'Restore participation')
        : t('action.makeSpectator', isDe() ? 'Zum Zuschauer machen' : 'Make spectator')],
      ['kick', t('action.kick', isDe() ? 'Aus dem Raum entfernen' : 'Remove from room')]
    ];
    actions.forEach(([action, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'row-action ' + action;
      button.dataset.action = action;
      button.dataset.name = p.name;
      button.setAttribute('role', 'menuitem');
      button.tabIndex = -1;
      button.appendChild(participantActionIcon(action));
      const text = document.createElement('span');
      text.textContent = label;
      button.appendChild(text);
      menu.appendChild(button);
    });
    trigger.closest('.participant-row').appendChild(menu);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', menu.id);
    participantMenu = { trigger, menu };
    positionParticipantMenu();
    menu.firstElementChild.focus({ preventScroll: true });
  }

  function executeParticipantAction(button) {
    // Native click is the sole execution path for mouse, touch, Enter and Space.
    if (!participantMenu || !participantMenu.menu.contains(button)) return;
    const p = (state.participants || []).find(item => item && item.name === button.dataset.name);
    const action = button.dataset.action;
    closeParticipantMenu();
    if (!canManageParticipant(p)) return;
    const name = p.name;
    if (action === 'host') {
      if (confirm(isDe() ? `Host-Rolle an ${name} übertragen?` : `Transfer host role to ${name}?`)) {
        send('makeHost:' + encodeURIComponent(name));
      }
    } else if (action === 'kick') {
      if (confirm(isDe() ? `${name} wirklich entfernen?` : `Remove ${name}?`)) {
        send('kick:' + encodeURIComponent(name));
      }
    } else if (action === 'spectator') {
      const newSpectator = !isSpectator(p);
      p.spectator = newSpectator;
      p.participating = !newSpectator;
      if (newSpectator) p.vote = null;
      renderParticipants();
      renderCards();
      syncMenuFromState();
      send('setSpectator:' + encodeURIComponent(name) + ':' + newSpectator);
    }
  }

  function bindParticipantActions() {
    if (participantActionsBound) return;
    participantActionsBound = true;
    document.addEventListener('click', event => {
      const trigger = event.target.closest?.('#liveParticipantList .participant-more');
      if (trigger) { openParticipantMenu(trigger); return; }
      const action = event.target.closest?.('#liveParticipantList .participant-action-menu .row-action');
      if (action) { executeParticipantAction(action); return; }
      if (participantMenu && !participantMenu.menu.contains(event.target)) closeParticipantMenu(false);
    });
    document.addEventListener('keydown', event => {
      const trigger = event.target.closest?.('#liveParticipantList .participant-more');
      if (trigger && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        if (!participantMenu || participantMenu.trigger !== trigger) openParticipantMenu(trigger);
        if (event.key === 'ArrowUp') participantMenu?.menu.lastElementChild.focus();
        return;
      }
      if (!participantMenu) return;
      if (event.key === 'Escape') { event.preventDefault(); closeParticipantMenu(); return; }
      if (event.key === 'Tab') { closeParticipantMenu(); return; }
      if (!participantMenu.menu.contains(event.target)) return;
      const items = Array.from(participantMenu.menu.querySelectorAll('button'));
      const current = items.indexOf(document.activeElement);
      const target = { ArrowDown: (current + 1) % items.length, ArrowUp: (current + items.length - 1) % items.length, Home: 0, End: items.length - 1 }[event.key];
      if (target !== undefined) { event.preventDefault(); items[target].focus(); }
    });
    document.addEventListener('focusin', event => {
      if (participantMenu && !participantMenu.menu.contains(event.target) && event.target !== participantMenu.trigger) closeParticipantMenu(false);
    });
    window.addEventListener('resize', positionParticipantMenu, { passive: true });
    window.addEventListener('scroll', positionParticipantMenu, { passive: true, capture: true });
  }

  function renderParticipants() {
    const ul = participantsRoot();
    if (!ul) return;

    try {
      const list = (state.participants || [])
        .map(function (p) { return (typeof p === 'string' ? { name: p } : p); })
        .filter(function (p) { return p && p.name; });

      const frag = document.createDocumentFragment();

      list.forEach(function (p) {
        if (!p || !p.name) return;

        const li = document.createElement('li');
        li.className = 'participant-row';

        const isInactive = !!p.disconnected || !!p.away;
        if (isInactive) li.classList.add('disconnected');
        if (p.isHost) li.classList.add('is-host');
        if (isSpectator(p)) li.classList.add('spectator');

        const left = document.createElement('span');
        left.className = 'participant-icon';
        left.setAttribute('aria-hidden', 'true');
        left.appendChild(participantStatusIcon('person'));
        li.appendChild(left);

        const identity = document.createElement('span');
        identity.className = 'participant-identity';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        identity.appendChild(name);

        if (p.isHost) {
          const crown = document.createElement('span');
          crown.className = 'participant-role participant-role-host';
          crown.setAttribute('aria-hidden', 'true');
          crown.setAttribute('title', t('label.host', 'Host'));
          crown.appendChild(participantStatusIcon('host'));
          identity.appendChild(crown);

          const sr = document.createElement('span');
          sr.className = 'host-label sr-only';
          sr.textContent = t('label.host', 'Host');
          identity.appendChild(sr);
        }

        if (isSpectator(p)) {
          const spectator = document.createElement('span');
          spectator.className = 'participant-role participant-role-spectator mini-chip spectator';
          spectator.setAttribute('aria-hidden', 'true');
          spectator.setAttribute('title', t('label.spectator', isDe() ? 'Zuschauer' : 'Spectator'));
          spectator.appendChild(participantStatusIcon('spectator'));
          identity.appendChild(spectator);

          const sr = document.createElement('span');
          sr.className = 'spectator-label sr-only';
          sr.textContent = t('label.spectator', isDe() ? 'Zuschauer' : 'Spectator');
          identity.appendChild(sr);
        }

        if (isInactive) {
          const inactive = document.createElement('span');
          inactive.className = 'participant-role participant-role-inactive';
          inactive.setAttribute('aria-hidden', 'true');
          inactive.setAttribute('title', t('label.inactive', isDe() ? 'Inaktiv' : 'Inactive'));
          inactive.appendChild(participantStatusIcon('inactive'));
          identity.appendChild(inactive);

          const sr = document.createElement('span');
          sr.className = 'inactive-label sr-only';
          sr.textContent = t('label.inactive', isDe() ? 'Inaktiv' : 'Inactive');
          identity.appendChild(sr);
        }

        li.appendChild(identity);

        const right = document.createElement('div');
        right.className = 'row-right';

        if (!state.votesRevealed) {
          if (isSpectator(p)) {
            var spectatorSlot = document.createElement('span');
            spectatorSlot.className = 'mini-chip spectator-slot';
            spectatorSlot.textContent = '–';
            spectatorSlot.setAttribute('aria-hidden', 'true');
            right.appendChild(spectatorSlot);
          } else if (!p.disconnected && p.vote != null && String(p.vote) !== '') {
            var ok = document.createElement('span');
            ok.className = 'mini-chip done';
            ok.textContent = '✓';
            right.appendChild(ok);
          } else {
            var dash = document.createElement('span');
            dash.className = isInactive ? 'mini-chip' : 'mini-chip pending';
            dash.textContent = isInactive ? '–' : '⏳';
            right.appendChild(dash);
          }
        } else {
          if (isSpectator(p)) {
            var spectatorSlot2 = document.createElement('span');
            spectatorSlot2.className = 'mini-chip spectator-slot';
            spectatorSlot2.textContent = '–';
            spectatorSlot2.setAttribute('aria-hidden', 'true');
            right.appendChild(spectatorSlot2);
          } else if (isInactive) {
            var dash2 = document.createElement('span');
            dash2.className = 'mini-chip';
            dash2.textContent = '–';
            right.appendChild(dash2);
          } else {
            var chip = document.createElement('span');
            var noVote = (p.vote == null || p.vote === '');
            var display = noVote ? '–' : String(p.vote);

            if (noVote) {
              chip.className = 'mini-chip';
              chip.textContent = '–';
              right.appendChild(chip);
            } else {
              chip.className = 'vote-chip';
              chip.textContent = display;

              var isInfinity = (display === INFINITY_ || display === INFINITY_ALT);
              var isSpecial = (display === QUESTION) || ALL_SPECIALS_EMOJI.has(display); // treat "?" as special for styling

              if (!isInfinity && isSpecial) chip.classList.add('special');

              if (!isSpecial) {
                var hue = heatHueForLabel(display);
                if (hue != null) {
                  chip.classList.add('heat');
                  chip.style.setProperty('--chip-heat-h', String(hue));
                }
              }

              if (Array.isArray(state.outliers) && state.outliers.indexOf(p.name) !== -1) chip.classList.add('outlier');

              right.appendChild(chip);
            }
          }
        }

        if (canManageParticipant(p)) {
          const trigger = document.createElement('button');
          trigger.type = 'button';
          trigger.className = 'participant-more';
          trigger.dataset.name = p.name;
          trigger.textContent = '…';
          trigger.setAttribute('aria-label', t('action.participantMenu', 'Participant actions') + ': ' + p.name);
          trigger.setAttribute('aria-haspopup', 'menu');
          trigger.setAttribute('aria-expanded', 'false');
          right.appendChild(trigger);
        }
        li.appendChild(right);





        frag.appendChild(li);
      });

      const activeName = document.activeElement?.closest('.participant-row')?.querySelector('.participant-more')?.dataset.name;
      const restoreFocus = !!activeName && !!document.activeElement?.closest('.participant-more, .participant-action-menu');
      closeParticipantMenu(false);
      ul.replaceChildren(frag);
      if (restoreFocus) {
        const next = Array.from(ul.querySelectorAll('.participant-more')).find(button => button.dataset.name === activeName);
        (next || document.getElementById('menuButton'))?.focus({ preventScroll: true });
      }
      const count = document.getElementById('participantCount');
      if (count) count.textContent = String(ul.querySelectorAll('.participant-row').length);
    } catch (e) {
      console.error('[ROOM] renderParticipants failed', e);
    }
  }

  /*** ---------- Heat hue helpers ---------- ***/
  function parseVoteNumber(label) {
    if (label == null) return null;
    const s = String(label).trim();
    if (s === '♾️' || s === '♾' || s === '∞') return Infinity;
    if (s === '½' || s === '1/2') return 0.5;
    const num = Number(s.replace(',', '.'));
    return Number.isFinite(num) ? num : null;
  }
  function numericDeckFromState() {
    const nums = (state.cards || [])
      .map(parseVoteNumber)
      .filter(function (v) { return v !== null && v !== undefined && !Number.isNaN(v); });
    const uniq = Array.from(new Set(nums)).sort(function (a, b) { return (a === b ? 0 : a < b ? -1 : 1); });
    return uniq;
  }
  const PIVOT_BY_SEQUENCE = { 'fib.enh': 13, 'fib.scrum': 13, 'fib.math': 13, 'pow2': 32 };
  function heatHueForLabel(label) {
    const deck = numericDeckFromState();
    if (!deck.length) return null;
    const v = parseVoteNumber(label);
    if (v == null) return null;

    let idx = deck.findIndex(function (x) { return Object.is(x, v); });
    if (idx < 0) { idx = deck.findIndex(function (x) { return x > v; }); if (idx < 0) idx = deck.length - 1; }

    const max = Math.max(1, deck.length - 1);
    let t = idx / max;

    const pivRaw = PIVOT_BY_SEQUENCE[state.sequenceId || ''];
    const pivotLabel = (typeof pivRaw !== 'undefined') ? pivRaw : null;
    let gamma = 1.25;
    if (pivotLabel != null) {
      const pivIdx = deck.findIndex(function (x) { return Object.is(x, pivotLabel); });
      if (pivIdx > 0) {
        const frac = Math.min(0.999, Math.max(0.001, (pivIdx / max)));
        const g = Math.log(0.5) / Math.log(frac);
        if (Number.isFinite(g) && g > 0) gamma = g;
      }
    }

    t = Math.pow(t, gamma);
    const hue = 120 - (t * 120);
    return Math.round(Math.max(0, Math.min(120, hue)));
  }

  /*** ---------- Cards ---------- ***/
  function mySelectedValue() {
    const me = state.participants.find(function (pp) { return pp.name === state.youName; });
    if (me && me.vote != null && me.vote !== '') return String(me.vote);
    if (state._optimisticVote != null) return String(state._optimisticVote);
    return null;
  }
  function allEligibleVoted() {
    const elig = state.participants.filter(function (p) { return p && !isSpectator(p) && !p.disconnected; });
    if (!elig.length) return false;
    return elig.every(function (p) { return p.vote != null && String(p.vote) !== ''; });
  }

  function msg(key, en, de) {
    const fallback = isDe() ? (de != null ? de : en) : en;
    return t(key, fallback);
  }

  function renderCards() {
    const grid = $('#cardGrid'); if (!grid) return;
    const focusedValue = grid.contains(document.activeElement) ? document.activeElement.dataset.value : null;
    grid.innerHTML = '';

    const me = state.participants.find(function (pp) { return pp.name === state.youName; });
    const isSpectatorMe = state.selfSpectator || !!(me && isSpectator(me));
    const disabled = state.votesRevealed || isSpectatorMe;

    const deckSpecialsFromState = (state.cards || [])
      .filter(function (v) { return ALL_SPECIALS_EMOJI.has(v) && !DISABLED_SPECIALS.has(String(v)); });
    const deckNumbers = (state.cards || [])
      .filter(function (v) { return !ALL_SPECIALS_EMOJI.has(v) && !DISABLED_SPECIALS.has(String(v)); });

    const specials = deckSpecialsFromState;

    const selectedVal = mySelectedValue();

    function addCardButton(val) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const label = String(val);
      btn.textContent = label;
      btn.dataset.value = label;
      btn.setAttribute('aria-pressed', String(selectedVal != null && String(selectedVal) === label));

      if (ALL_SPECIALS_EMOJI.has(label)) {
        const tip = tipForSpecialEmoji(label);
        if (tip) { btn.setAttribute('title', tip); btn.setAttribute('aria-label', tip); }
      }

      if (label === INFINITY_ || label === INFINITY_ALT) btn.classList.add('card-infinity');
      if (disabled) btn.disabled = true;
      if (selectedVal != null && String(selectedVal) === label) btn.classList.add('selected');

      grid.appendChild(btn);
    }

    deckNumbers.forEach(addCardButton);

    if (specials.length) {
      const br = document.createElement('div');
      br.className = 'grid-break';
      br.setAttribute('aria-hidden', 'true');
      grid.appendChild(br);
      specials.forEach(addCardButton);
    }

    // Restore focus only after the whole deck is laid out; focusing a partial
    // grid can move the scroll anchor while subsequent cards are inserted.
    if (focusedValue != null && !disabled) {
      Array.from(grid.querySelectorAll('button')).find(btn => btn.dataset.value === focusedValue)?.focus({ preventScroll: true });
    }

    const revealBtn = $('#revealButton');
    const resetBtn  = $('#resetButton');
    const hardGateOK = !state.hardMode || allEligibleVoted();

    // Optimistic: until host is known, do not hide the reveal button.
    const showReveal = (!state.votesRevealed && (state.isHost || !state._hostKnown));
    const showReset  = ( state.votesRevealed && state.isHost);

    if (revealBtn) {
      revealBtn.hidden   = !showReveal;
      revealBtn.disabled = !hardGateOK;

      if (!hardGateOK) {
        const gateMsg = t('reveal.gate', isDe()
          ? 'Es haben noch nicht alle ihre Schätzung abgegeben'
          : 'Not everyone has voted yet');
        revealBtn.setAttribute('title', gateMsg);
        revealBtn.setAttribute('aria-disabled', 'true');
        revealBtn.setAttribute('aria-label', gateMsg);
      } else {
        revealBtn.removeAttribute('title');
        revealBtn.removeAttribute('aria-disabled');
      }
    }

    if (resetBtn) {
      resetBtn.hidden = !showReset;
    }
  } // end renderCards()

  // Keep the result announcement localized and outside the hidden visual row.
  function announceResultForSR() {
    const sink = document.getElementById('resultAnnounce');
    if (!sink) return;

    if (!state.votesRevealed) { sink.textContent = ''; return; }

    const toS = function (v) { return (v == null || v === '' ? null : String(v)); };
    const avg    = toS(fmtStat(state.averageVote));
    const median = toS(fmtStat(state.medianVote));
    let   range  = toS(fmtRange(state.range));

    let msg = '';
    if (state.consensus && avg) {
      msg = t('label.consensus', 'Consensus') + ' ' + avg;
    } else {
      const parts = [];
      if (avg)    parts.push(t('label.average', 'Average:') + ' ' + avg);
      if (median) parts.push(t('label.median', 'Median:') + ' ' + median);
      if (range)  parts.push(t('label.range', 'Range:') + ' ' + range);
      msg = parts.join(', ');
    }
    sink.textContent = msg;
  }

  /*** ---------- Result bar ---------- ***/
  function renderResultBar() {
    document.body.classList.toggle('votes-revealed', !!state.votesRevealed);

    const row = $('#resultRow');
    if (row) {
      if (state.votesRevealed) row.classList.remove('is-hidden');
      else                     row.classList.add('is-hidden');
    }

    if (state.votesRevealed) {
      if (state._chipAnimShown) document.body.classList.add('no-chip-anim');
      else { document.body.classList.remove('no-chip-anim'); state._chipAnimShown = true; }
    } else {
      document.body.classList.remove('no-chip-anim');
      state._chipAnimShown = false;
    }

    const hasInfinity = !!(
      state.votesRevealed &&
      Array.isArray(state.participants) &&
      state.participants.some(function (p) { return p && !isSpectator(p) && (p.vote === INFINITY_ || p.vote === INFINITY_ALT); })
    );

    const toStr  = function (v) { return (v == null || v === '' ? null : String(v)); };
    const withInf = function (base) { return (base != null ? base + (hasInfinity ? ' +♾️' : '') : (hasInfinity ? '♾️' : null)); };

    const avgWrap    = document.querySelector('#resultLabel .label-average');
    const consEl     = document.querySelector('#resultLabel .label-consensus');
    const medianWrap = $('#medianWrap');
    const rangeWrap  = $('#rangeWrap');
    const rangeSep   = $('#rangeSep');
    const avgEl      = $('#averageVote');
    const medianSep  = document.getElementById('medianSep') || document.querySelector('#resultRow .sep');

    const CONS_LABEL = t('label.consensus', isDe() ? '🎉 Konsens' : '🎉 Consensus');

    if (avgEl) {
      const avgTxt = withInf(toStr(fmtStat(state.averageVote)));
      avgEl.textContent = (avgTxt != null ? avgTxt : (state.votesRevealed ? 'N/A' : ''));
    }

    if (row) {
      if (state.consensus) {
        row.classList.add('consensus');
        if (avgWrap)  avgWrap.hidden = true;
        if (consEl) { consEl.hidden = false; consEl.textContent = CONS_LABEL; }
        if (medianSep) { medianSep.hidden = true; medianSep.setAttribute('aria-hidden', 'true'); }
        if (medianWrap) medianWrap.hidden = true;
        if (rangeSep)  rangeSep.hidden  = true;
        if (rangeWrap) rangeWrap.hidden = true;
        announceResultForSR();
        return;
      } else {
        row.classList.remove('consensus');
        if (avgWrap) avgWrap.hidden = false;
        if (consEl)  consEl.hidden  = true;
      }
    }

    let showMedian = false;
    if (medianWrap) {
      showMedian = state.votesRevealed && toStr(state.medianVote) != null;
      medianWrap.hidden = !showMedian;
      if (showMedian) setText('#medianVote', withInf(toStr(fmtStat(state.medianVote))));
    }
    if (medianSep) {
      medianSep.hidden = !showMedian;
      medianSep.setAttribute('aria-hidden', String(!showMedian));
    }

    if (rangeWrap && rangeSep) {
      const showRange = state.votesRevealed && toStr(state.range) != null;
      rangeWrap.hidden = !showRange;
      rangeSep.hidden  = !showRange;
      if (showRange) setText('#rangeVote', withInf(toStr(fmtRange(state.range))));
    }

    announceResultForSR();
  }

  /*** ---------- Topic row (robust, delegated, optimistic) ---------- ***/
  function clientParseTopic(input) {
    const MAX_LABEL = 140;
    const s = String(input || '').trim();
    if (!s) return { label: null, url: null };

    const isUrl = s.indexOf('http://') === 0 || s.indexOf('https://') === 0;
    const jiraKeyMatch = s.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    const label = jiraKeyMatch ? jiraKeyMatch[1] : (s.length > MAX_LABEL ? (s.slice(0, MAX_LABEL) + '…') : s);
    const url2 = isUrl ? s : null;
    return { label: label, url: url2 };
  }

  function beginTopicEdit() {
    if (!state.isHost) return;
    state.topicEditing = true;
    if (state._topicDraft == null) state._topicDraft = state.topicLabel || '';
    renderTopic();
  }

  function ensureTopicDelegates() {
    const row = document.querySelector('#topicRow');
    if (!row || row.__topicDelegatesBound) return;
    row.__topicDelegatesBound = true;

    const act = function (id) {
      if (!state.isHost) return;

      const doClear = function () {
        state.topicLabel = '';
        state.topicUrl = null;
        state.topicEditing = false;
        state._topicDraft = null;
        renderTopic();
        try { send('topicSave:' + encodeURIComponent('')); } catch {}
      };
      const doSave = function () {
        const input = row.querySelector('#topicDisplay');
        const raw = (input && input.tagName === 'INPUT') ? input.value : (state._topicDraft != null ? state._topicDraft : '');
        const parsed = clientParseTopic(raw);
        state.topicLabel = parsed.label;
        state.topicUrl = parsed.url;
        state.topicEditing = false;
        state._topicDraft = null;
        renderTopic();
        try { send('topicSave:' + encodeURIComponent(raw)); } catch {}
      };
      const doCancel = function () {
        state.topicEditing = false;
        state._topicDraft = null;
        renderTopic();
      };

      if (id === 'topicEditBtn')   return beginTopicEdit();
      if (id === 'topicClearBtn')  return doClear();
      if (id === 'topicSaveBtn')   return doSave();
      if (id === 'topicCancelEditBtn') return doCancel();
    };

    row.addEventListener('click', function (e) {
      const btn = e.target && e.target.closest &&
        e.target.closest('#topicEditBtn,#topicClearBtn,#topicSaveBtn,#topicCancelEditBtn');
      if (!btn) return;
      if (e.preventDefault) e.preventDefault();
      act(btn.id);
    });
  }

  function renderTopic() {
    const row = $('#topicRow'); if (!row) return;
    row.style.display = state.topicVisible ? '' : 'none';
    row.setAttribute('data-visible', state.topicVisible ? '1' : '0');
    if (state.topicVisible) {
      row.removeAttribute('hidden');
      row.classList.remove('is-hidden');
    } else {
      row.setAttribute('hidden', '');
      row.classList.add('is-hidden');
    }

    // Ensure actions container
    let actions = row.querySelector('.topic-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'topic-actions';
      row.appendChild(actions);
    }

    // Ensure a single delegate is bound
    ensureTopicDelegates();

    const ticketLink = row.querySelector('#topicTicketLink');

    // Render read-only content without injecting markup.
    const renderDisplayContent = function (el) {
      el.textContent = state.topicLabel || '–';
      const full = [state.topicLabel || '', state.topicUrl || ''].filter(Boolean).join(' — ');
      el.setAttribute('title', wrapForTitle(full, 44));
      if (ticketLink) {
        ticketLink.textContent = t('topic.openLink', 'Open ticket');
        if (state.topicUrl) {
          ticketLink.href = state.topicUrl;
          ticketLink.title = state.topicUrl;
          ticketLink.hidden = false;
        } else {
          ticketLink.removeAttribute('href');
          ticketLink.removeAttribute('title');
          ticketLink.hidden = true;
        }
      }
    };

    let displayEl = row.querySelector('#topicDisplay');

    // Non-host: read-only
    if (!state.isHost) {
      if (!displayEl || displayEl.tagName !== 'SPAN') {
        const span = document.createElement('span');
        span.id = 'topicDisplay';
        span.className = 'topic-text';
        if (displayEl) displayEl.replaceWith(span);
        else row.insertBefore(span, row.firstChild ? row.firstChild.nextSibling : null);
        displayEl = span;
      }
      renderDisplayContent(displayEl);

      actions.innerHTML = '';
      return;
    }

    // Host: not editing
    if (!state.topicEditing) {
      if (!displayEl || displayEl.tagName !== 'SPAN') {
        const span = document.createElement('span');
        span.id = 'topicDisplay';
        span.className = 'topic-text';
        if (displayEl) displayEl.replaceWith(span);
        else row.insertBefore(span, row.firstChild ? row.firstChild.nextSibling : null);
        displayEl = span;
      }
      renderDisplayContent(displayEl);

      const titleEdit  = t('button.editTopic',  'Edit');
      const titleClear = t('button.clearTopic', 'Clear');

      actions.innerHTML =
        '<button id="topicEditBtn" class="icon-button neutral" type="button"' +
                 ' title="' + escapeHtml(titleEdit) + '" aria-label="' + escapeHtml(titleEdit) + '"><svg class="pp-status-icon" aria-hidden="true"><use href="#pp-icon-edit"></use></svg></button>' +
        ' <button id="topicClearBtn" class="icon-button neutral" type="button"' +
                 ' title="' + escapeHtml(titleClear) + '" aria-label="' + escapeHtml(titleClear) + '"><svg class="pp-status-icon" aria-hidden="true"><use href="#pp-icon-delete"></use></svg></button>';

      return;
    }

    // Host: editing
    if (!displayEl || displayEl.tagName !== 'INPUT') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'topic-inline-input';
      inp.id = 'topicDisplay';
      inp.setAttribute('aria-label', t('label.topic', 'Ticket/Story'));
      inp.placeholder = t('topic.placeholder', 'Paste JIRA link or type key');
      inp.value = state._topicDraft != null ? state._topicDraft : (state.topicLabel || '');
      inp.addEventListener('input', function () { state._topicDraft = inp.value; });
      if (displayEl) displayEl.replaceWith(inp);
      else row.insertBefore(inp, row.firstChild ? row.firstChild.nextSibling : null);
      displayEl = inp;
      setTimeout(function () { try { displayEl.focus(); displayEl.select(); } catch {} }, 0);
    }
    if (ticketLink) ticketLink.hidden = true;

    const titleSave   = t('button.saveTopic', 'Save');
    const titleCancel = t('button.cancel',    'Cancel');

    actions.innerHTML =
      '<button id="topicSaveBtn" class="icon-button neutral" type="button"' +
               ' title="' + escapeHtml(titleSave) + '" aria-label="' + escapeHtml(titleSave) + '"><svg class="pp-status-icon" aria-hidden="true"><use href="#pp-icon-confirm"></use></svg></button>' +
      ' <button id="topicCancelEditBtn" class="icon-button neutral" type="button"' +
               ' title="' + escapeHtml(titleCancel) + '" aria-label="' + escapeHtml(titleCancel) + '"><svg class="pp-status-icon" aria-hidden="true"><use href="#pp-icon-cancel"></use></svg></button>';

    displayEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter')  { if (e.preventDefault) e.preventDefault(); const b = $('#topicSaveBtn');   if (b) b.click(); }
      if (e.key === 'Escape') { if (e.preventDefault) e.preventDefault(); const b = $('#topicCancelEditBtn'); if (b) b.click(); }
    }, { passive: false });
  }

  /*** ---------- Auto-reveal badge ---------- ***/
  function renderAutoReveal() {
    const preSt  = document.querySelector('.pre-vote #arStatus');
    const menuSt = document.querySelector('#appMenuOverlay #menuArStatus');
    const statusText = state.autoRevealEnabled ? (isDe() ? 'An' : 'On') : (isDe() ? 'Aus' : 'Off');
    if (preSt)  preSt.textContent  = statusText;
    if (menuSt) menuSt.textContent = statusText;
  }

  /*** ---------- Menu sync ---------- ***/
  function setRowDisabled(inputId, disabled) {
    const input = document.getElementById(inputId);
    const row = input ? input.closest('.menu-item.switch') : null;
    if (input) {
      input.disabled = !!disabled;
      input.setAttribute('aria-disabled', String(!!disabled));
    }
    if (row) row.classList.toggle('disabled', !!disabled);
  }

  // --- sequence radio helpers ---
  function seqVariants(id) {
    const s = normalizeSeq(id || 'fib.scrum');
    return [s, s.replace('.', '-')];
  }
  function updateAllSeqRadiosChecked(seqIdRaw) {
    const vars = new Set(seqVariants(seqIdRaw));
    const radios = document.querySelectorAll('input[type="radio"][name="menu-seq"]');
    radios.forEach(function (r) {
      const v = String(r.value || '').toLowerCase().trim();
      const checked = vars.has(v);
      if (r.checked !== checked) r.checked = checked;
      r.setAttribute('aria-checked', checked ? 'true' : 'false');
    });
  }
  function syncSequenceRadiosAndMenu() {
    const radios = document.querySelectorAll('input[type="radio"][name="menu-seq"]');
    const shouldDisable = state._hostKnown ? !state.isHost : false;

    radios.forEach(function (r) {
      r.disabled = !!shouldDisable;
      r.setAttribute('aria-disabled', String(!!shouldDisable));
      const lab = r.closest('label');
      if (lab) lab.classList.toggle('disabled', !!shouldDisable);
    });

    updateAllSeqRadiosChecked(state.sequenceId || 'fib.scrum');
  }

  function domSelectedSeq() {
    const el = document.querySelector('input[type="radio"][name="menu-seq"]:checked');
    return el ? normalizeSeq(el.value) : null;
  }
  function reconcileSeqFromDOM() {
    const sel = domSelectedSeq();
    if (!sel) return;
    if (state._hostKnown && !state.isHost) {
      updateAllSeqRadiosChecked(state.sequenceId || 'fib.scrum');
      return;
    }
    if (sel !== (state.sequenceId || 'fib.scrum')) {
      applyLocalSequence(sel);
      notifySequence(sel);
    } else {
      updateAllSeqRadiosChecked(sel);
    }
  }

  function syncMenuFromState() {
    const hostClose = $('#closeRoomBtn');
    const guestLeave = $('#menuLeaveRoomBtn');
    if (hostClose) hostClose.classList.toggle('hidden', !state._hostKnown || !state.isHost);
    if (guestLeave) guestLeave.classList.toggle('hidden', !state._hostKnown || state.isHost);

    // Disable guest controls once host info is known
    setRowDisabled('menuAutoRevealToggle', !state.isHost && state._hostKnown);
    setRowDisabled('menuTopicToggle',      !state.isHost && state._hostKnown);
    setRowDisabled('menuSpecialsToggle',   !state.isHost && state._hostKnown);
    setRowDisabled('menuHardModeToggle',   !state.isHost && state._hostKnown);

    const mTgl = $('#menuTopicToggle'); const mSt = $('#menuTopicStatus');
    if (mTgl) { mTgl.checked = !!state.topicVisible; mTgl.setAttribute('aria-checked', String(!!state.topicVisible)); }
    if (mSt)  mSt.textContent = state.topicVisible ? (isDe() ? 'An' : 'On') : (isDe() ? 'Aus' : 'Off');

    const me = state.participants.find(function (p) { return p.name === state.youName; });
    const spectatorMe = state.selfSpectator || !!(me && isSpectator(me));

    const mPTgl = $('#menuParticipationToggle');
    const mPSt  = $('#menuPartStatus');
    if (mPTgl) { mPTgl.checked = !spectatorMe; mPTgl.setAttribute('aria-checked', String(!spectatorMe)); }
    if (mPSt)  mPSt.textContent = !spectatorMe
      ? t('menu.participation.estimating', isDe() ? 'Ich schätze mit' : "I'm estimating")
      : t('menu.participation.spectator',  isDe() ? 'Zuschauer:in'   : 'Spectator');

    const mARTgl = $('#menuAutoRevealToggle');
    if (mARTgl) { mARTgl.checked = !!state.autoRevealEnabled; mARTgl.setAttribute('aria-checked', String(!!state.autoRevealEnabled)); }

    const mSPTgl = $('#menuSpecialsToggle'); const mSPSt = $('#menuSpecialsStatus');
    if (mSPTgl) { mSPTgl.checked = !!state.allowSpecials; mSPTgl.setAttribute('aria-checked', String(!!state.allowSpecials)); }
    if (mSPSt) mSPSt.textContent = state.allowSpecials ? (isDe() ? 'An' : 'On') : (isDe() ? 'Aus' : 'Off');

    const mHRTgl = $('#menuHardModeToggle'); const mHRSt = $('#menuHardStatus');
    if (mHRTgl) { mHRTgl.checked = !!state.hardMode; mHRTgl.setAttribute('aria-checked', String(!!state.hardMode)); }
    if (mHRSt)  mHRSt.textContent = state.hardMode ? (isDe() ? 'An' : 'On') : (isDe() ? 'Aus' : 'Off');

    // Also keep palette visibility/disabled state aligned
    syncSpecialsPaletteFromState();
  }
  function syncSequenceInMenu() {
    syncSequenceRadiosAndMenu();
  }

  // ---------- Specials palette (binds to menu.html DOM) ----------
      function specialsPaletteRoot() {
        return document.getElementById('rowSpecialsPick') || null;
      }

      function syncSpecialsPaletteFromState() {
      const root = specialsPaletteRoot();
      if (!root) return;

      // Visibility: only via [hidden]/[aria-hidden] (no inline display hacks)
      const on = !!state.allowSpecials;
      root.hidden = !on;
      root.setAttribute('aria-hidden', String(!on));

      // Enable/disable palette for guests (keep focusability; block interaction)
      const disabled = !on || (state._hostKnown && !state.isHost);
      root.classList.toggle('disabled', !!disabled);
      try { root.style.pointerEvents = disabled ? 'none' : ''; } catch {}

      // Reflect selected specials onto <button.spc> (class ".on" + aria-pressed)
      const wrap = root.querySelector('.specials-icons') || root;
      const selected = new Set(canonicalizeIds(state.specialsSelected || []));
      SPECIALS_ORDER.forEach(function (id) {
        const btn = wrap.querySelector('.spc[data-id="' + id + '"]');
        if (!btn) return;
        const pressed = selected.has(id);
        btn.classList.toggle('on', pressed);
        btn.setAttribute('aria-pressed', String(pressed));
      });
    }


  function wireSpecialsPalette(){ /* handled by specials-bridge.js */ }


  document.addEventListener('pp:menu-open', function () {
    wireSequenceRadios();
    wireMenuTogglesDom();
    wireSpecialsPalette();
    syncMenuFromState();
    syncSequenceInMenu();
    syncSpecialsPaletteFromState();
    queueMicrotask(reconcileSeqFromDOM);
  });

  // Wire real DOM switches to our app events (idempotent)
  function wireMenuTogglesDom() {
    const byId = function (id) { return document.getElementById(id); };

    const bindSwitch = function (id, handler) {
      const el = byId(id);
      if (!el || el.__bound) return;
      el.__bound = true;
      el.addEventListener('change', function () {
        const checked = !!el.checked;
        el.setAttribute('aria-checked', String(checked));
        handler(checked, el);
      }, { passive: true });
    };

    // Participation: user-controlled, not host-gated
    bindSwitch('menuParticipationToggle', function (on /*= estimating*/, _el) {
      document.dispatchEvent(new CustomEvent('pp:participation-toggle', { detail: { estimating: on } }));
    });

    // Host-only switches: revert UI immediately if a guest tries to toggle
    const hostGuard = function (next, el) {
      if (state._hostKnown && !state.isHost) {
        const cur = !!el.checked;
        el.checked = !cur;
        el.setAttribute('aria-checked', String(!cur));
        return;
      }
      next();
    };

    bindSwitch('menuAutoRevealToggle', function (on, el) { hostGuard(function () {
      document.dispatchEvent(new CustomEvent('pp:auto-reveal-toggle', { detail: { on: on } }));
    }, el); });

    bindSwitch('menuTopicToggle', function (on, el) { hostGuard(function () {
      document.dispatchEvent(new CustomEvent('pp:topic-toggle', { detail: { on: on } }));
    }, el); });

    bindSwitch('menuSpecialsToggle', function (on, el) { hostGuard(function () {
      // Update visibility immediately for snappy UI
      state.allowSpecials = on;
      syncSpecialsPaletteFromState();
      document.dispatchEvent(new CustomEvent('pp:specials-toggle', { detail: { on: on } }));
    }, el); });

    bindSwitch('menuHardModeToggle', function (on, el) { hostGuard(function () {
      document.dispatchEvent(new CustomEvent('pp:hard-mode-toggle', { detail: { on: on } }));
    }, el); });
  }


  /*** ---------- Global actions ---------- ***/
  function revealCards() {
    if (state.hardMode && !allEligibleVoted()) {
      showToast(t('reveal.gate', isDe() ? 'Erst aufdecken, wenn alle gewählt haben.' : 'Reveal only after everyone voted.'));
      return;
    }
    send('revealCards');
  }
  function resetRoom() { send('resetRoom'); }
  window.revealCards = revealCards;
  window.resetRoom   = resetRoom;

  /*** ---------- Toast & copy helpers ---------- ***/
  function showToast(msg, ms) {
    if (ms == null) ms = 2600;
    try {
      const tEl = document.createElement('div');
      tEl.className = 'toast';
      tEl.setAttribute('role', 'status');
      tEl.textContent = msg;
      document.body.appendChild(tEl);
      // force reflow
      // eslint-disable-next-line no-unused-expressions
      tEl.offsetHeight;
      setTimeout(function () { tEl.remove(); }, ms + 600);
    } catch {}
  }

  function showIdentityStorageNotice(storage) {
    const sessionOnly = storage === 'sessionStorage';
    showToast(isDe()
      ? (sessionOnly
          ? 'Die Teilnahme kann nur in dieser Browsersitzung wiederhergestellt werden.'
          : 'Die Teilnahme kann nach einem Neuladen nicht wiederhergestellt werden.')
      : (sessionOnly
          ? 'Participation can only be restored in this browser session.'
          : 'Participation cannot be restored after reloading.'), 6500);
  }

  function completeExit() {
    identityBlocked = true;
    window.PPIdentity.clearExit(state.roomCode, identityCredential);
    window.PPIdentity.clear(state.roomCode, identityCredential);
    window.PPRoomReturn?.clear(state.roomCode, state.youName);
    location.assign('/');
  }
  function inviteUrl() { return location.origin + '/invite?roomCode=' + encodeURIComponent(state.roomCode); }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
  }
  function bindCopyLink() {
    const candidates = ['#copyRoomLink','#copyRoomLinkBtn','#copyRoomBtn','.room-with-actions .icon-button','.main-info .icon-button']
      .map(function (sel) { return $(sel); }).filter(Boolean);
    const btn = candidates[0]; if (!btn) return;

    const okMsg   = t('copy.ok',   isDe() ? 'Link kopiert' : 'Link copied');
    const failMsg = t('copy.fail', isDe() ? 'Kopieren fehlgeschlagen' : 'Copy failed');

    async function handle() {
      const ok = await copyText(inviteUrl());
      const prev = btn.getAttribute('title');
      btn.setAttribute('title', ok ? okMsg : failMsg);
      btn.setAttribute('aria-label', ok ? okMsg : failMsg);
      showToast(ok ? okMsg : failMsg);
      if (prev != null) setTimeout(function () { btn.setAttribute('title', prev); }, 2200);
      else setTimeout(function () { btn.removeAttribute('title'); }, 2200);
    }
    btn.addEventListener('click', function (e) { if (e.preventDefault) e.preventDefault(); handle(); });
    btn.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { if (e.preventDefault) e.preventDefault(); handle(); } });
  }

  /*** ---------- Menu & lifecycle events ---------- ***/

  // Helper that applies the local UI state for a sequence change
  function applyLocalSequence(id) {
    const seq = normalizeSeq(id);
    if (!seq) return;

    // short window to ignore old server snapshot
    const now = Date.now();
    state._pendingSeq = seq;
    state._pendingSeqUntil = now + 1200;

    state.sequenceId = seq;
    state.votesRevealed = false;
    state._optimisticVote = null;

    rebuildDeckFromState();
    syncMenuFromState();
  }

  // Send with limited backward-compat payloads + fast server echo
  function notifySequence(id) {
    const norm = normalizeSeq(id);
    const val = encodeURIComponent(norm);
    const payloads = [
      'sequence:' + val,     // primary
      'seq:' + val,          // compat
      'setSequence:' + val,  // compat
    ];
    for (let i = 0; i < payloads.length; i++) {
      try { send(payloads[i]); } catch {}
    }
    try { pokeServerAndSync(); } catch {}
    setTimeout(function () { try { pokeServerAndSync(); } catch {} }, 120);
  }

  function wireSequenceRadios() {
    const root = document.getElementById('menuSeqChoice');
    if (!root || root.__seqBound) return;
    root.__seqBound = true;

    // regular change
    root.addEventListener('change', function (e) {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.name !== 'menu-seq') return;

      const id = normalizeSeq(t.value);
      if (!id) return;

      if (state._hostKnown && !state.isHost) {
        updateAllSeqRadiosChecked(state.sequenceId || 'fib.scrum');
        return;
      }

      applyLocalSequence(id);
      updateAllSeqRadiosChecked(id);
      notifySequence(id);
    });

    // also react to input (some UIs dispatch both)
    root.addEventListener('input', function (e) {
      const t = e.target;
      if (!(t instanceof HTMLInputElement)) return;
      if (t.name !== 'menu-seq') return;
      queueMicrotask(reconcileSeqFromDOM);
    });
  }

  // Global capture fallback for radios, resilient to DOM swaps/re-mounts
  document.addEventListener('change', function (e) {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;

    // Guest-bounce for menu checkboxes (toggles) — EXCEPT participation (user-controlled)
    if (t.type === 'checkbox' && t.closest('#appMenuOverlay')) {
      if (t.id !== 'menuParticipationToggle' && state._hostKnown && !state.isHost) {
        const before = t.checked;
        queueMicrotask(function () {
          t.checked = !before;
          t.setAttribute('aria-checked', String(t.checked));
          const row = t.closest('.menu-item.switch');
          if (row) row.classList.add('disabled');
        });
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        return;
      }
    }

    // sequence radios
    if (t.type === 'radio' && t.name === 'menu-seq') {
      const id = normalizeSeq(t.value);
      if (!id) return;

      if (state._hostKnown && !state.isHost) {
        updateAllSeqRadiosChecked(state.sequenceId || 'fib.scrum');
        if (e.preventDefault) e.preventDefault();
        return;
      }

      applyLocalSequence(id);
      notifySequence(id);
    }
  }, true); // capture: true


  // Also reconcile on raw input events (covers .check() etc.)
  document.addEventListener('input', function (e) {
    const t = e.target;
    if (!(t instanceof HTMLInputElement)) return;
    if (t.type === 'radio' && t.name === 'menu-seq') {
      queueMicrotask(reconcileSeqFromDOM);
    }
  }, true);

  // Observe attribute-level changes to `checked` to catch non-event flips
  (function observeSeqRadiosChecked() {
    const mo = new MutationObserver(function (muts) {
      for (let i = 0; i < muts.length; i++) {
        const m = muts[i];
        if (m.type === 'attributes' && m.attributeName === 'checked') {
          const el = m.target;
          if (el instanceof HTMLInputElement && el.name === 'menu-seq') {
            queueMicrotask(reconcileSeqFromDOM);
          }
        } else if (m.type === 'childList' && m.addedNodes && m.addedNodes.length) {
          for (let j = 0; j < m.addedNodes.length; j++) {
            const node = m.addedNodes[j];
            if (!(node instanceof Element)) continue;
            const hasChecked =
              (node.matches && node.matches('input[type="radio"][name="menu-seq"]:checked')) ||
              (node.querySelector && node.querySelector('input[type="radio"][name="menu-seq"]:checked'));
            if (hasChecked) queueMicrotask(reconcileSeqFromDOM);
          }
        }
      }
    });
    mo.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['checked']
    });
  })();

  function wireMenuEvents() {
    const leaveRoom = function () {
      if (exitRequested) return;
      if (!state.connected) {
        showToast(isDe() ? 'Zum endgültigen Verlassen ist eine Verbindung erforderlich.' : 'A connection is required to end participation.');
        return;
      }
      exitRequested = true;
      const exitStorage = window.PPIdentity.markExit(state.roomCode, identityCredential);
      if (exitStorage !== 'localStorage') showIdentityStorageNotice(exitStorage);
      send('intentionalLeave');
    };
    $('#leaveRoomBtn')?.addEventListener('click', leaveRoom);
    $('#menuLeaveRoomBtn')?.addEventListener('click', leaveRoom);

    // Single, final close-room confirmation
    document.addEventListener('pp:close-room', function () {
      if (!state.isHost) return;
      const msg2 = t('confirm.closeRoom', 'Close this room for everyone?');
      if (confirm(msg2)) send('closeRoom');
    });

    // Programmatic sequence changes (optimistic)
    if (!window.__ppSeqBridgeBound) {
      document.addEventListener('pp:sequence-change', function (ev) {
        const d = ev && ev.detail ? ev.detail : {};
        const id = normalizeSeq(d.id || d.sequenceId);
        if (!id) return;
        if (state._hostKnown && !state.isHost) return;
        applyLocalSequence(id);
        notifySequence(id);
      });
    }

    document.addEventListener('pp:auto-reveal-toggle', function (ev) {
      if (!state.isHost) return;
      const on = !!(ev && ev.detail && ev.detail.on);
      send('autoReveal:' + on);
    });

    document.addEventListener('pp:topic-toggle', function (ev) {
      if (!state.isHost) return;
      const on = !!(ev && ev.detail && ev.detail.on);

      if (!on) state.topicEditing = false;

      state.topicVisible = on;
      renderTopic();
      syncMenuFromState();
      send('topicVisible:' + on);
    });

    document.addEventListener('pp:participation-toggle', function (ev) {
      const estimating = !!(ev && ev.detail && ev.detail.estimating);
      state.selfSpectator = !estimating;

      const me = state.participants.find(function (p) { return p && p.name === state.youName; });
      if (me) {
        me.spectator = !estimating;
        me.participating = estimating;
        if (!estimating) me.vote = null; // clear vote when switching to spectator locally as well
      }

      renderParticipants();
      renderCards();
      syncMenuFromState();

      send('participation:' + estimating);
    });

    document.addEventListener('pp:specials-toggle', function () {
      if (!state.isHost) return;
      queueMicrotask(function () {
        const el = document.getElementById('menuSpecialsToggle');
        const on = el ? !!el.checked : !state.allowSpecials;
        state.allowSpecials = on;
        syncSpecialsPaletteFromState();
        rebuildDeckFromState();
        try { send('specials:' + on); } catch {}
      });
    });

    // NEW: palette selection → send IDs + rebuild local deck
    document.addEventListener('pp:specials-set', function (ev) {
      if (!state.isHost) return;
      const ids = canonicalizeIds(((ev && ev.detail && ev.detail.ids) || []));
      state.specialsSelected = ids;
      rebuildDeckFromState();
      try {
        send('specials:set:' + encodeURIComponent(ids.join(',')));
      } catch {}
      pokeServerAndSync();
    });

    document.addEventListener('pp:hard-mode-toggle', function (ev) {
      if (!state.isHost) return;
      const on = !!(ev && ev.detail && ev.detail.on);
      state.hardMode = on;
      syncMenuFromState();
      renderCards();
    });
  }

  // Presence guard (suppress join/leave toasts for self + rapid flaps)
  const PRESENCE_KEY = function (n) { return 'pp-presence:' + encodeURIComponent(n); };
  function markAlive(name) { if (!name) return; try { localStorage.setItem(PRESENCE_KEY(name), String(Date.now())); } catch {} }

  // Wrap long tooltips by injecting \n
  function wrapForTitle(text, max) {
    if (max == null) max = 44;
    const words = String(text || '').trim().split(/\s+/);
    const out = []; let line = '';
    for (let wi = 0; wi < words.length; wi++) {
      let w = words[wi];
      if (w.length > max) {
        w = w.replace(/[\/\-_\.]/g, function (m) { return m + '\n'; });
      }
      const chunks = w.split('\n');
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        if (!chunk) continue;
        const need = (line ? line.length + 1 : 0) + chunk.length;
        if (need > max) { if (line) out.push(line); line = chunk; }
        else { line += (line ? ' ' : '') + chunk; }
      }
    }
    if (line) out.push(line);
    return out.join('\n');
  }

  // Event-delegation (robust, no global capture)
  let _cardGridBound = false;

  function bindDelegatedHandlers() {
    // Cards
    const grid = document.querySelector('#cardGrid');
    if (grid && !_cardGridBound) {
      const onPick = function (btn) {
        if (!btn || btn.disabled) return;
        const label = btn.dataset.value || btn.textContent || '';
        if (!label) return;
        if (mySelectedValue() === String(label) || state._optimisticVote === String(label)) return;
        state._optimisticVote = String(label);
        try { grid.querySelectorAll('button').forEach(function (b) { b.classList.remove('selected'); }); } catch (e) {}
        btn.classList.add('selected');
        try { send('vote:' + state.youName + ':' + label); } catch (e) {}
      };

      grid.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        const btn = (e.target && e.target.closest) ? e.target.closest('#cardGrid button') : null;
        if (btn) onPick(btn);
      }, false);

      grid.addEventListener('click', function (e) {
        const btn = (e.target && e.target.closest) ? e.target.closest('#cardGrid button') : null;
        if (btn) onPick(btn);
      }, false);

      _cardGridBound = true;
    }

    bindParticipantActions();
  }

  function wireOnce() {
    bindCopyLink();
    wireMenuEvents();
    wireSequenceRadios();
    wireMenuTogglesDom();
    wireSpecialsPalette();
    bindDelegatedHandlers();

    const row = $('#topicRow');
    if (row) {
      row.addEventListener('click', function (e) {
        if (!state.isHost || state.topicEditing) return;
        if (state.topicLabel) return;
        if (e.target.closest && e.target.closest('button,a,input')) return;
        beginTopicEdit();
      });
    }

    // Lifecycle wake-ups
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') wake('visibility');
    }, true);
    // Element focus (including restored card focus) must not trigger a resync loop.
    window.addEventListener('focus', function (event) {
      if (event.target === window) wake('focus');
    });
    window.addEventListener('online', function () { wake('online'); }, true);
    window.addEventListener('pageshow', function () { wake('pageshow'); }, true);
    window.addEventListener('pagehide', releaseNavigationBestEffort, true);
    document.addEventListener('click', function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey ||
          event.shiftKey || event.altKey) return;
      const target = event.target;
      const link = target instanceof Element ? target.closest('a[href]') : null;
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin ||
          (destination.pathname === location.pathname && destination.search === location.search && destination.hash)) return;
      event.preventDefault();
      releaseForNavigation(function () { location.assign(destination.href); });
    }, true);

    startWatchdog();

    if (!state.hardRedirect && !state.connected && (!state.ws || state.ws.readyState !== 1)) connectWS();

    syncSequenceInMenu();
    syncSpecialsPaletteFromState();
  }

  /*** ---------- Misc helpers ---------- ***/
  function addParticipantLocal(name) {
    if (!name) return;

    if (state && state.participants && typeof state.participants.add === 'function') {
      state.participants.add(name);
      return;
    }

    if (Array.isArray(state && state.participants)) {
      const has = state.participants.some(function (p) {
        return (typeof p === 'string') ? (p === name) : (p && p.name === name);
      });
      if (!has) {
        state.participants.push({
          name: name,
          vote: null,
          disconnected: false,
          away: false,
          isHost: false,
          participating: true,
          spectator: false
        });
      }
      return;
    }

    if (state && state.participantsByName && typeof state.participantsByName.set === 'function') {
      if (!state.participantsByName.has(name)) state.participantsByName.set(name, { name: name });
    } else if (state && state.participantsByName && typeof state.participantsByName === 'object') {
      state.participantsByName[name] = state.participantsByName[name] || { name: name };
    }
    if (state && state.room && state.room.participants && typeof state.room.participants.add === 'function') {
      state.room.participants.add(name);
    } else if (state && state.room && Array.isArray(state.room.participants)) {
      if (state.room.participants.indexOf(name) === -1) state.room.participants.push(name);
    }
  }

  function removeParticipantLocal(name) {
    if (!name) return;

    if (state && state.participants && typeof state.participants.delete === 'function') {
      state.participants.delete(name);
    } else if (Array.isArray(state && state.participants)) {
      const idx = state.participants.findIndex(function (p) {
        return (typeof p === 'string') ? (p === name) : (p && p.name === name);
      });
      if (idx !== -1) state.participants.splice(idx, 1);
    }

    if (state && state.participantsByName && typeof state.participantsByName.delete === 'function') {
      state.participantsByName.delete(name);
    } else if (state && state.participantsByName && typeof state.participantsByName === 'object') {
      delete state.participantsByName[name];
    }

    if (state && state.room && state.room.participants && typeof state.room.participants.delete === 'function') {
      state.room.participants.delete(name);
    } else if (state && state.room && Array.isArray(state.room.participants)) {
      const j = state.room.participants.findIndex(function (p) {
        return (typeof p === 'string') ? (p === name) : (p && p.name === name);
      });
      if (j !== -1) state.room.participants.splice(j, 1);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); });
  }

  function rerenderAll() {
    renderParticipants();
    renderCards();
    renderResultBar();
    renderTopic();
    renderAutoReveal();
    syncMenuFromState();
    syncSequenceInMenu();
    syncSpecialsPaletteFromState();
  }

  async function onLangChange() {
    await preloadMessages();
    rerenderAll();
  }

  new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'attributes' && m.attributeName === 'lang') {
        onLangChange();
        break;
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });

  document.addEventListener('pp:lang-changed', onLangChange);
  
  /*** ---------- Boot ---------- ***/
  function seedSelfPlaceholder() {
    state.participants = [{
      name: state.youName || 'You',
      vote: null,
      disconnected: false,
      away: false,
      isHost: !!state.isHost,
      participating: true,
      spectator: false
    }];
    try { renderParticipants(); } catch {}
  }

  async function boot() {
    preloadMessages();

    if (state.hardRedirect || identityBlocked) return;

    syncHostClass();
    ensureBootstrapDeck();     // make cards available immediately on first paint
    seedSelfPlaceholder();
    try {
      if (!document.documentElement.hasAttribute('data-ready')) {
        document.documentElement.setAttribute('data-ready', '1');
      }
    } catch {}

    renderCards();             // allow immediate voting before first server sync
    wireOnce();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }


})();

// normalize missing allowSpecials to false (room default OFF)
function __normalizeAllowSpecials(obj){
  try{
    if (obj && typeof obj.allowSpecials === 'undefined') obj.allowSpecials = false;
  }catch(e){}
  return obj;
}
