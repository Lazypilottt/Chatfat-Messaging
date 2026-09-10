/* public/client.js — one IIFE: a state machine around one WebSocket, rendering
   only what the server sends.

   Two rules that are not negotiable and are asserted by the test suites:
     · Message text is written into the DOM as TEXT NODES only, never innerHTML.
       Any markup a user sends renders as literal text.
     · Optimistic rendering is not used. Nothing appears in the log until the
       server broadcasts it back, which is what keeps every client's order
       identical. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var C = window.CFCrypto;

  /* ══ elements ═══════════════════════════════════════════════════════════ */

  var el = {
    join: $('join'), joinForm: $('join-form'), joinName: $('join-name'), joinPw: $('join-pw'),
    joinNameLabel: $('join-name-label'), joinNameHint: $('join-name-hint'),
    joinPwField: $('join-pw-field'), joinPwRev: $('join-pw-rev'), joinSubmit: $('join-submit'),
    joinSwitch: $('join-switch'), joinSwitchBtn: $('join-switch-btn'), joinSwitchText: $('join-switch-text'),
    joinError: $('join-error'), joinTagline: $('join-tagline'), joinDot: $('join-dot'),
    joinState: $('join-state'), joinUrl: $('join-url'),

    lobby: $('lobby'), lobbyMe: $('lobby-me'), lobbyBlurb: $('lobby-blurb'), lobbyCount: $('lobby-count'),
    lobbyError: $('lobby-error'), lobbyEmpty: $('lobby-empty'), roomGrid: $('room-grid'),
    spotlightSlot: $('spotlight-slot'), allLabel: $('all-label'),
    createForm: $('create-form'), createName: $('create-name'), createLock: $('create-lock'),
    createToggle: $('create-toggle'), createLockbar: $('create-lockbar'), createPass: $('create-pass'),
    createPassRev: $('create-pass-rev'), createMeter: $('create-meter'),

    app: $('app'), appRoom: $('app-room'), side: $('side'), hamb: $('hamb'),
    roster: $('roster'), rosterCount: $('roster-count'), cmds: $('cmds'), cmdsTitle: $('cmds-title'),
    meAv: $('me-av'), meName: $('me-name'), meState: $('me-state'), sideFoot: $('side-foot'),
    keyChip: $('key-chip'), keyFp: $('key-fp'),
    share: $('share'), leave: $('leave'), spark: $('spark'), rtt: $('rtt'),
    pill: $('pill'), pillText: $('pill-text'),
    log: $('log'), jump: $('jump'), jumpN: $('jump-n'), ac: $('ac'),
    typing: $('typing'), replybar: $('replybar'), replyWho: $('reply-who'), replyText: $('reply-text'),
    replyCancel: $('reply-cancel'), composer: $('composer'), input: $('input'), count: $('count'),
    send: $('send'), toasts: $('toasts'),

    keymodal: $('keymodal'), kmRoom: $('km-room'), kmForm: $('km-form'), kmPass: $('km-pass'),
    kmRev: $('km-rev'), kmError: $('km-error'), kmRemember: $('km-remember'), kmLeave: $('km-leave'),
    kmUnlock: $('km-unlock'),
    lockmodal: $('lockmodal'), lmForm: $('lm-form'), lmPass: $('lm-pass'), lmRev: $('lm-rev'),
    lmMeter: $('lm-meter'), lmError: $('lm-error'), lmCancel: $('lm-cancel'), lmHeading: $('lm-heading'),
    lmLede: $('lm-lede')
  };

  /* ══ state ══════════════════════════════════════════════════════════════ */

  var state = {
    phase: 'idle', // idle|connecting|joining|lobby|ready|reconnecting|offline
    ws: null, me: null, wantName: '',
    auth: false, replays: false, encryption: true,
    authMode: 'login',
    config: { maxText: 2000, maxCiphertext: 12288, emoji: ['👍','❤️','😂','🎉','👀','🔥'],
              minBurn: 5, maxBurn: 300, editWindow: 300000, kdfIterations: 250000,
              historyPage: 50 },
    // Scrollback. `oldest` is the (ts, id) cursor of the topmost loaded
    // message; `done` starts true so a server that replays nothing never asks
    // for a page it will not be given.
    hist: { oldest: null, done: true, loading: false, error: false },
    room: null, roomMeta: null, wantRoom: null, pendingRoomHash: null,
    rooms: [], roster: [], typing: [],
    msgs: new Map(), polls: new Map(),
    queue: [], attempt: 0, retryTimer: null, rtt: [],
    replyTo: null, editing: null, last: null, lastDay: null, unread: 0, everJoined: false,
    // encryption
    // roomId -> Map<epoch, { key, epoch, fingerprint, raw, verifier }>.
    // A map PER EPOCH, not one key per room: rotation does not re-encrypt
    // history, so a member who held the old passphrase must go on reading the
    // messages sealed under it (SPEC §14.8).
    keys: new Map(),
    pendingKey: null,     // derived locally, held until the server confirms the lock
    sealed: false, myKeyPair: null, pubs: new Map(), bannerShown: new Set()
  };

  // No token key: the session is an HttpOnly cookie the page cannot read.
  var LS = { theme: 'sb-theme', name: 'sb-name', favs: 'ChatFat-favorites' };
  var UNGUARDED = { hello:1, welcome:1, error:1, rooms:1, 'room:joined':1, 'room:left':1, you:1, ping:1, rtt:1, keys:1 };
  var QUEUEABLE = { chat:1, dm:1, react:1, edit:1, unsend:1, 'poll:new':1, 'poll:vote':1 };
  var PROTOCOL_VERSION = 2;

  function ls(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {}
    return null;
  }

  /* ══ theme ══════════════════════════════════════════════════════════════ */

  function cycleTheme() {
    var now = ls(LS.theme);
    var next = now === 'dark' ? 'light' : now === 'light' ? null : 'dark';
    ls(LS.theme, next);
    if (next) document.documentElement.setAttribute('data-theme', next);
    else document.documentElement.removeAttribute('data-theme');
    toast('Theme: ' + (next || 'follows your system'));
  }
  Array.prototype.forEach.call(document.querySelectorAll('.theme-btn'), function (b) {
    b.addEventListener('click', cycleTheme);
  });

  /* ══ toasts ═════════════════════════════════════════════════════════════ */

  function toast(message, bad, code) {
    var node = document.createElement('div');
    node.className = 'cf-toast' + (bad ? ' bad' : '');
    node.appendChild(document.createTextNode(message));
    if (code) {
      var chip = document.createElement('span');
      chip.className = 'code';
      chip.textContent = code;
      node.appendChild(chip);
    }
    el.toasts.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 4200);
  }

  function showError(box, message) {
    if (!message) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = message;
    box.hidden = false;
  }

  /* ══ screens ════════════════════════════════════════════════════════════ */

  function screen(which) {
    el.join.hidden = which !== 'join';
    el.lobby.hidden = which !== 'lobby';
    el.app.hidden = which !== 'app';
  }

  var PILL = {
    connecting: ['connecting', 'warn'], joining: ['joining', 'warn'], lobby: ['lobby', 'warn'],
    ready: ['live', ''], reconnecting: ['reconnecting', 'bad'], offline: ['offline', 'bad'],
    idle: ['offline', 'bad']
  };

  function setPhase(phase) {
    state.phase = phase;
    var p = PILL[phase] || PILL.idle;
    el.pillText.textContent = p[0];
    el.pill.className = 'cf-pill' + (p[1] ? ' ' + p[1] : '');
    refreshComposer();
  }

  /* ══ the socket ═════════════════════════════════════════════════════════ */

  function wsUrl() {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  }

  function send(t, d) {
    var frame = { v: PROTOCOL_VERSION, t: t, d: d || {} };
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify(frame));
      return true;
    }
    // Only frames worth replaying are queued. Typing and presence go stale.
    if (QUEUEABLE[t]) state.queue.push(frame);
    return false;
  }

  function flushQueue() {
    if (!state.queue.length) return;
    var n = state.queue.length;
    var pending = state.queue;
    state.queue = [];
    for (var i = 0; i < pending.length; i++) state.ws.send(JSON.stringify(pending[i]));
    toast('Sent ' + n + ' queued message' + (n === 1 ? '' : 's') + '.');
  }

  function connect() {
    if (state.ws) { try { state.ws.close(); } catch (e) {} }
    setPhase(state.everJoined ? 'reconnecting' : 'connecting');
    setJoinStatus('Connecting…', 'warn');

    var ws = new WebSocket(wsUrl());
    state.ws = ws;

    ws.onopen = function () {
      state.attempt = 0;
      setPhase('joining');
      // publishKey() happens on 'welcome', not here: the server refuses any
      // frame but join/pong from a socket that has not named itself yet
      // (dispatch in src/transport/websocket.js), so sending it before join
      // completes would just get FORBIDDEN'd — this used to be exactly that
      // bug, silently, for the whisper key.
      // Identity came from the cookie at the upgrade; join carries nothing.
      if (state.auth) send('join', {});
      else send('join', { username: state.wantName });
    };

    ws.onmessage = function (event) {
      var frame;
      try { frame = JSON.parse(event.data); } catch (e) { return; }
      if (!frame || typeof frame.t !== 'string') return;
      // Frame guard: a message in flight during a fast room switch must not
      // land in the log of the room you just walked into.
      if (frame.room && frame.room !== state.room && !UNGUARDED[frame.t]) return;
      handle(frame.t, frame.d || {}, frame);
    };

    ws.onclose = function () {
      state.ws = null;
      if (state.phase === 'idle') return;
      setPhase(navigator.onLine === false ? 'offline' : 'reconnecting');
      scheduleRetry();
    };

    ws.onerror = function () { setJoinStatus('Can’t reach the server', 'bad'); };
  }

  function scheduleRetry() {
    if (state.retryTimer) return;
    // Jittered, so several machines coming back from the same network blip do
    // not stampede the server in lockstep.
    var wait = Math.min(30000, 500 * Math.pow(2, state.attempt)) + Math.floor(Math.random() * 500);
    state.attempt++;
    systemLine('Lost the connection — retrying in ' + Math.round(wait / 1000) + 's', 'warn');
    state.retryTimer = setTimeout(function () {
      state.retryTimer = null;
      connect();
    }, wait);
  }

  window.addEventListener('online', function () {
    if (state.phase === 'reconnecting' || state.phase === 'offline') {
      state.attempt = 0;
      if (state.retryTimer) { clearTimeout(state.retryTimer); state.retryTimer = null; }
      connect();
    }
  });
  window.addEventListener('offline', function () { if (state.ws) setPhase('offline'); });
  // A clean 1000 so a normal tab close is instant, rather than waiting out the reaper.
  window.addEventListener('beforeunload', function () {
    if (state.ws && state.ws.readyState === 1) { try { state.ws.close(1000); } catch (e) {} }
  });

  /* ══ startup ════════════════════════════════════════════════════════════ */

  function setJoinStatus(text, kind) {
    el.joinState.textContent = text;
    el.joinDot.className = 'cf-dot' + (kind === 'warn' ? ' cf-dot-warn' : kind === 'bad' ? ' cf-dot-bad' : kind === 'off' ? ' cf-dot-off' : '');
  }

  function paintJoinCard() {
    var busy = state.phase === 'connecting' || state.phase === 'joining';
    el.joinPwField.hidden = !state.auth;
    el.joinSwitch.hidden = !state.auth;
    if (state.auth) {
      el.joinSubmit.textContent = busy
        ? (state.authMode === 'register' ? 'Creating…' : 'Signing in…')
        : (state.authMode === 'register' ? 'Create account' : 'Sign in');
      el.joinSwitchText.textContent = state.authMode === 'register' ? 'Already have an account?' : 'No account yet?';
      el.joinSwitchBtn.textContent = state.authMode === 'register' ? 'Sign in' : 'Create one';
      el.joinTagline.textContent = 'This server keeps accounts. Sign in to pick up where you left off.';
      el.joinPw.autocomplete = state.authMode === 'register' ? 'new-password' : 'current-password';
      // Same input, different meaning: an email address when accounts are on,
      // a display name when they are off.
      el.joinNameLabel.textContent = 'Email';
      el.joinName.type = 'email';
      el.joinName.autocomplete = 'email';
      el.joinName.placeholder = 'you@example.com';
      el.joinName.removeAttribute('maxlength');
      el.joinNameHint.textContent = 'Used to sign in. Your display name is separate and you can change it later.';
    } else {
      el.joinSubmit.textContent = busy ? 'Connecting…' : 'Connect';
      el.joinTagline.textContent = 'Pick a name and start talking. Nothing here is stored.';
      el.joinNameLabel.textContent = 'Your name';
      el.joinName.type = 'text';
      el.joinName.autocomplete = 'username';
      el.joinName.placeholder = 'kavya';
      el.joinName.setAttribute('maxlength', '16');
      el.joinNameHint.textContent = '2–16 characters. Taken names are refused, so everyone is unambiguous.';
    }
    el.joinSubmit.disabled = busy;
  }

  async function boot() {
    el.joinUrl.textContent = wsUrl();
    state.wantName = ls(LS.name) || '';
    el.joinName.value = state.wantName;
    readHash();

    // Asked BEFORE a socket is opened, so the card never has to guess which
    // form to show, and the lobby blurb is never a lie.
    try {
      var res = await fetch('/healthz', { cache: 'no-store' });
      var health = await res.json();
      state.auth = health.auth !== 'disabled';
      state.replays = health.historyReplay > 0;
      state.encryption = !!health.encryption;
      setJoinStatus('Server reachable · accounts ' + (state.auth ? 'required' : 'off'), 'ok');
    } catch (e) {
      setJoinStatus('Can’t reach the server', 'bad');
    }

    el.lobbyBlurb.textContent = state.replays
      ? 'This server replays the tail of a conversation when you join, so you can see what you walked in on.'
      : 'You see what is said while you are in a room, and nothing else — this server replays no history when you join.';
    el.createLockbar.hidden = true;
    el.createLock.disabled = !state.encryption || !C.available;
    if (el.createLock.disabled) el.createLockbar.hidden = true;

    paintJoinCard();

    // Ask whether the cookie is still good BEFORE dialling. A rejected upgrade
    // arrives as a bare 1006 close, indistinguishable from the server being
    // down, and the reconnect loop would then retry forever behind a form the
    // user never sees.
    if (state.auth) {
      var signedIn = false;
      try {
        var s = await fetch('/api/auth/get-session', { credentials: 'same-origin', cache: 'no-store' });
        signedIn = s.ok && !!(await s.json().catch(function () { return null; }));
      } catch (e) {}
      if (signedIn) { setPhase('connecting'); paintJoinCard(); connect(); }
    }
  }

  /* ══ join screen ════════════════════════════════════════════════════════ */

  el.joinPwRev.addEventListener('click', function () { revealToggle(el.joinPw, el.joinPwRev); });

  function revealToggle(input, button) {
    var show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? 'Hide' : 'Show';
  }

  el.joinSwitchBtn.addEventListener('click', function () {
    state.authMode = state.authMode === 'register' ? 'login' : 'register';
    showError(el.joinError, '');
    paintJoinCard();
  });

  el.joinForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    showError(el.joinError, '');
    var name = el.joinName.value.trim();

    // Accounts off: the box is a display name, and any free one will do.
    if (!state.auth) {
      if (!/^[A-Za-z0-9 _.-]{2,16}$/.test(name)) {
        return showError(el.joinError, 'Names are 2–16 letters, numbers, spaces, _ . or -');
      }
      state.wantName = name;
      ls(LS.name, name);
      setPhase('connecting'); paintJoinCard(); connect();
      return;
    }

    // Accounts on: the box is an email address.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name)) {
      return showError(el.joinError, 'Enter your email address.');
    }
    if (el.joinPw.value.length < 8) {
      return showError(el.joinError, 'Passwords are at least 8 characters.');
    }
    ls(LS.name, name);
    setPhase('connecting');
    paintJoinCard();

    var registering = state.authMode === 'register';
    var route = registering ? '/api/auth/sign-up/email' : '/api/auth/sign-in/email';
    var payload = { email: name, password: el.joinPw.value };
    // Better Auth requires a display name at sign-up; default it to the local
    // part of the address, which /nick can change afterwards.
    if (registering) payload.name = name.split('@')[0].slice(0, 16);

    try {
      var res = await fetch(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The session arrives as an HttpOnly cookie. Nothing is stored in JS.
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        var body = await res.json().catch(function () { return {}; });
        setPhase('idle');
        paintJoinCard();
        return showError(el.joinError, body.message || 'That email and password did not work.');
      }
      connect();
    } catch (e) {
      setPhase('idle');
      paintJoinCard();
      showError(el.joinError, 'Could not reach the server.');
    }
  });

  /* ══ favourites ═════════════════════════════════════════════════════════ */

  function favourites() {
    try { return JSON.parse(ls(LS.favs) || '[]') || []; } catch (e) { return []; }
  }
  function toggleFavourite(id) {
    var list = favourites();
    var at = list.indexOf(id);
    if (at >= 0) list.splice(at, 1); else list.push(id);
    ls(LS.favs, JSON.stringify(list));
    renderRooms();
  }

  /* ══ lobby ══════════════════════════════════════════════════════════════ */

  function lockIcon(size) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'svg');
    svg.setAttribute('width', size); svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    var body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    body.setAttribute('x', '3'); body.setAttribute('y', '11');
    body.setAttribute('width', '18'); body.setAttribute('height', '11'); body.setAttribute('rx', '3');
    var shackle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shackle.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4');
    svg.appendChild(body); svg.appendChild(shackle);
    return svg;
  }

  function warnIcon() {
    var warn = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    warn.setAttribute('class', 'svg'); warn.setAttribute('width', '14'); warn.setAttribute('height', '14');
    warn.setAttribute('viewBox', '0 0 24 24');
    var tri = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tri.setAttribute('d', 'M12 4l9 16H3z');
    var bang = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    bang.setAttribute('d', 'M12 10v4M12 17h.01');
    warn.appendChild(tri); warn.appendChild(bang);
    return warn;
  }

  function peopleLabel(n) { return n === 0 ? 'empty' : n + ' ' + (n === 1 ? 'person' : 'people'); }

  function renderRooms() {
    var favs = favourites();
    var rooms = state.rooms;

    var heads = 0;
    for (var i = 0; i < rooms.length; i++) heads += rooms[i].count;
    el.lobbyCount.textContent = rooms.length + ' room' + (rooms.length === 1 ? '' : 's') + ' · ' + heads + ' ' + (heads === 1 ? 'person' : 'people');
    el.lobbyEmpty.hidden = rooms.length > 0;
    el.allLabel.hidden = rooms.length === 0;

    // Favourites sort to the top; the server's busiest-first order is kept inside each group.
    var sorted = rooms.slice().sort(function (a, b) {
      var fa = favs.indexOf(a.id) >= 0 ? 0 : 1, fb = favs.indexOf(b.id) >= 0 ? 0 : 1;
      return fa - fb;
    });

    // Spotlight: your first favourite, else the busiest room.
    el.spotlightSlot.textContent = '';
    var pick = null;
    for (var f = 0; f < rooms.length; f++) if (favs.indexOf(rooms[f].id) >= 0) { pick = rooms[f]; break; }
    var kicker = 'Your favourite';
    if (!pick && rooms.length) { pick = rooms[0]; kicker = pick.count ? 'Busiest right now' : 'Start here'; }
    if (pick) {
      var spot = document.createElement('button');
      spot.type = 'button';
      spot.className = 'cf-spotlight';
      var box = document.createElement('div');
      var k = document.createElement('div'); k.className = 'k'; k.textContent = kicker;
      var h = document.createElement('h3'); h.textContent = pick.name;
      var p = document.createElement('p');
      p.textContent = (pick.count ? pick.count + ' ' + (pick.count === 1 ? 'person' : 'people') + ' talking right now' : 'nobody here yet')
        + (pick.locked ? ' · encrypted' : '');
      box.appendChild(k); box.appendChild(h); box.appendChild(p);
      var go = document.createElement('span'); go.className = 'cf-btn'; go.textContent = 'Join →';
      spot.appendChild(box); spot.appendChild(go);
      spot.addEventListener('click', function () { joinRoom(pick.name); });
      el.spotlightSlot.appendChild(spot);
    }

    el.roomGrid.textContent = '';
    sorted.forEach(function (room) {
      var card = document.createElement('div');
      card.className = 'cf-room' + (room.locked ? ' locked' : '') + (state.room === room.id ? ' here' : '');
      card.tabIndex = 0;
      card.setAttribute('role', 'button');

      var top = document.createElement('div');
      top.className = 'cf-room-top';
      var dot = document.createElement('span');
      dot.className = 'cf-dot' + (room.count ? '' : ' cf-dot-off');
      top.appendChild(dot);
      top.appendChild(document.createTextNode(peopleLabel(room.count)));

      var star = document.createElement('button');
      star.type = 'button';
      var isFav = favs.indexOf(room.id) >= 0;
      star.className = 'cf-star' + (isFav ? ' on' : '');
      star.textContent = isFav ? '★' : '☆';
      star.setAttribute('aria-label', (isFav ? 'Unfavourite ' : 'Favourite ') + room.name);
      star.addEventListener('click', function (e) { e.stopPropagation(); toggleFavourite(room.id); });
      top.appendChild(star);

      var title = document.createElement('h4');
      if (room.locked) title.appendChild(lockIcon(14));
      title.appendChild(document.createTextNode(room.name));

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = state.room === room.id ? 'you are here'
        : room.permanent ? 'default room'
        : room.createdBy ? 'created by ' + room.createdBy : 'created here';

      var go2 = document.createElement('div');
      go2.className = 'go';
      go2.textContent = 'Join →';

      card.appendChild(top); card.appendChild(title); card.appendChild(meta); card.appendChild(go2);
      card.addEventListener('click', function () { joinRoom(room.name); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); joinRoom(room.name); }
      });
      el.roomGrid.appendChild(card);
    });
  }

  el.createLock.addEventListener('change', function () {
    el.createToggle.classList.toggle('on', el.createLock.checked);
    el.createLockbar.hidden = !el.createLock.checked;
    if (el.createLock.checked) el.createPass.focus();
  });
  el.createPassRev.addEventListener('click', function () { revealToggle(el.createPass, el.createPassRev); });
  el.createPass.addEventListener('input', function () { paintMeter(el.createMeter, el.createPass.value); });
  el.lmPass.addEventListener('input', function () { paintMeter(el.lmMeter, el.lmPass.value); });

  function paintMeter(meter, value) {
    var score = C.passphraseStrength(value);
    Array.prototype.forEach.call(meter.children, function (bar, i) { bar.classList.toggle('on', i < score); });
  }

  el.createForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    showError(el.lobbyError, '');
    var name = el.createName.value.trim().replace(/\s+/g, ' ');
    if (!/^[A-Za-z0-9 _-]{2,24}$/.test(name)) {
      return showError(el.lobbyError, 'Room names are 2–24 letters, numbers, spaces, _ or -');
    }

    if (!el.createLock.checked) {
      state.wantRoom = name.toLowerCase();
      send('room:create', { room: name });
      el.createName.value = '';
      return;
    }

    var pass = el.createPass.value;
    if (pass.length < 10) return showError(el.lobbyError, 'A room passphrase needs at least 10 characters.');

    var roomId = name.toLowerCase();
    var entry = await C.makeRoomKey(pass, roomId, 1, state.config.kdfIterations);
    holdKey(roomId, entry);
    state.wantRoom = roomId;
    send('room:create', {
      room: name,
      lock: {
        kdf: { alg: 'PBKDF2-SHA256', iterations: state.config.kdfIterations, salt: C.b64(await C.roomSalt(roomId)) },
        verifier: entry.verifier
      }
    });
    el.createName.value = '';
    el.createPass.value = '';
    el.createLock.checked = false;
    el.createToggle.classList.remove('on');
    el.createLockbar.hidden = true;
    paintMeter(el.createMeter, '');
  });

  function joinRoom(name) {
    state.wantRoom = String(name).toLowerCase();
    send('room:join', { room: name });
  }

  /* ══ room links ═════════════════════════════════════════════════════════ */

  function readHash() {
    var hash = location.hash.replace(/^#/, '');
    if (!hash) return;
    var name = hash.indexOf('room=') === 0 ? hash.slice(5) : hash;
    try { name = decodeURIComponent(name); } catch (e) {}
    if (/^[A-Za-z0-9 _-]{2,24}$/.test(name)) state.pendingRoomHash = name;
  }

  window.addEventListener('hashchange', function () {
    var before = state.pendingRoomHash;
    state.pendingRoomHash = null;
    readHash();
    if (state.pendingRoomHash && state.pendingRoomHash !== before && (state.phase === 'lobby' || state.phase === 'ready')) {
      var target = state.pendingRoomHash;
      state.pendingRoomHash = null;
      joinRoom(target);
    }
  });

  el.share.addEventListener('click', function () {
    if (!state.room) return;
    var link = location.origin + location.pathname + '#room=' + encodeURIComponent(state.room);
    var done = function () { toast('Room link copied.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { legacyCopy(link, done); });
    } else legacyCopy(link, done);
  });

  function legacyCopy(text, done) {
    var box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Could not copy the link.', true); }
    document.body.removeChild(box);
  }

  el.leave.addEventListener('click', function () { send('room:leave', {}); });
  el.hamb.addEventListener('click', function () {
    el.side.hidden = !el.side.hidden;
    el.hamb.setAttribute('aria-expanded', String(!el.side.hidden));
  });

  /* ══ rendering: helpers ═════════════════════════════════════════════════ */

  function initials(name) {
    var parts = String(name).trim().split(/[\s_.-]+/).filter(Boolean);
    if (!parts.length) return '··';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function avatar(name, colour, size) {
    var span = document.createElement('span');
    span.className = 'cf-av';
    span.textContent = initials(name);
    if (size) { span.style.width = size + 'px'; span.style.height = size + 'px'; span.style.fontSize = (size * 0.4) + 'px'; }
    span.style.setProperty('--uc', colour);
    return span;
  }

  function clock(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    var d = new Date(ts), now = new Date();
    var same = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (same(d, now)) return 'Today';
    var y = new Date(now.getTime() - 86400000);
    if (same(d, y)) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  }

  var URL_RE = /(https?:\/\/[^\s<]+)/g;
  var AT_RE = /(@[A-Za-z0-9_.-]{2,16})/g;

  // The linkifier. Walks the string and appends text nodes, anchors and mention
  // spans — no innerHTML anywhere on this path, ever.
  function renderText(target, text, mentions) {
    var mentionSet = {};
    (mentions || []).forEach(function (m) { mentionSet[m.toLowerCase()] = true; });

    String(text).split(URL_RE).forEach(function (chunk, i) {
      if (i % 2 === 1) {
        var a = document.createElement('a');
        a.href = chunk;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = chunk;
        target.appendChild(a);
        return;
      }
      chunk.split(AT_RE).forEach(function (piece, j) {
        if (j % 2 === 1 && mentionSet[piece.slice(1).toLowerCase()]) {
          var span = document.createElement('span');
          span.className = 'cf-mention';
          span.textContent = piece;
          target.appendChild(span);
        } else if (piece) {
          target.appendChild(document.createTextNode(piece));
        }
      });
    });
  }

  function atBottom() {
    return el.log.scrollHeight - el.log.scrollTop - el.log.clientHeight < 60;
  }

  function place(node, opts) {
    var stick = atBottom();
    el.log.appendChild(node);
    if (stick) {
      el.log.scrollTop = el.log.scrollHeight;
    } else if (opts && opts.counts) {
      state.unread++;
      el.jumpN.textContent = state.unread;
      el.jump.hidden = false;
    }
  }

  el.log.addEventListener('scroll', function () {
    if (atBottom()) { state.unread = 0; el.jump.hidden = true; }
  });
  el.jump.addEventListener('click', function () {
    el.log.scrollTop = el.log.scrollHeight;
    state.unread = 0;
    el.jump.hidden = true;
  });

  function maybeDay(ts) {
    var label = dayLabel(ts);
    if (label === state.lastDay) return;
    state.lastDay = label;
    var div = document.createElement('div');
    div.className = 'cf-day';
    div.textContent = label;
    el.log.appendChild(div);
  }

  function clearLog() {
    el.log.textContent = '';
    state.msgs.clear();
    state.polls.clear();
    state.last = null;
    state.lastDay = null;
    state.unread = 0;
    el.jump.hidden = true;
    state.hist = { oldest: null, done: true, loading: false, error: false };
  }

  // ══ scrollback ══════════════════════════════════════════════════════════
  // Prepending is not appending in reverse. Two things have to be handled that
  // the append path never sees: the scroll position, which must not move under
  // the reader's hands, and the day separators, whose correctness depends on
  // what comes BEFORE each message — and a prepend changes that for the first
  // message already on screen.

  // Removed and rebuilt wholesale rather than patched. A prepended page can
  // invalidate the separator above the previously-oldest message, and an
  // incremental fix has more cases than the whole rebuild has cost: the log
  // holds a few hundred nodes, not a few hundred thousand.
  function rebuildDays() {
    var stale = el.log.querySelectorAll('.cf-day');
    for (var i = 0; i < stale.length; i++) stale[i].remove();

    var seen = null;
    var nodes = el.log.querySelectorAll('[data-ts]');
    for (var j = 0; j < nodes.length; j++) {
      var label = dayLabel(Number(nodes[j].getAttribute('data-ts')));
      if (label === seen) continue;
      seen = label;
      var div = document.createElement('div');
      div.className = 'cf-day';
      div.textContent = label;
      nodes[j].parentNode.insertBefore(div, nodes[j]);
    }
    // The append path picks up from wherever the rebuild left off, so the next
    // live message does not re-emit a separator for the day already shown.
    state.lastDay = seen;
  }

  function historyTop() {
    var bar = document.getElementById('cf-histtop');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'cf-histtop';
    bar.className = 'cf-histtop';
    el.log.insertBefore(bar, el.log.firstChild);
    return bar;
  }

  function paintHistoryTop() {
    var h = state.hist;
    var bar = historyTop();
    if (h.loading) {
      bar.className = 'cf-histtop loading';
      bar.textContent = 'Loading earlier messages…';
      bar.hidden = false;
    } else if (h.error) {
      bar.className = 'cf-histtop error';
      bar.textContent = '';
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Could not load earlier messages — retry';
      retry.addEventListener('click', function () { state.hist.error = false; loadOlder(); });
      bar.appendChild(retry);
      bar.hidden = false;
    } else if (h.done && state.msgs.size) {
      bar.className = 'cf-histtop done';
      bar.textContent = 'Beginning of this room';
      bar.hidden = false;
    } else {
      bar.hidden = true;
    }
  }

  function loadOlder() {
    var h = state.hist;
    if (!state.room || h.loading || h.done || h.error) return;
    h.loading = true;
    paintHistoryTop();
    send('history:more', { before: h.oldest, limit: state.config.historyPage || 50 });
  }

  el.log.addEventListener('scroll', function () {
    // 240px of runway, so the page is already arriving by the time the reader
    // reaches the top rather than after they hit it and wait.
    if (el.log.scrollTop < 240) loadOlder();
  });

  function systemLine(text, kind, user, colour) {
    var div = document.createElement('div');
    div.className = 'cf-sys' + (kind ? ' ' + kind : '');
    if (colour !== undefined) div.style.setProperty('--uc', colour);
    if (kind === 'lock') div.appendChild(lockIcon(13));
    else {
      var dot = document.createElement('span');
      dot.className = 'cf-dot' + (kind === 'off' ? ' cf-dot-off' : '');
      if (kind === 'join') dot.style.background = 'var(--jack)';
      div.appendChild(dot);
    }
    if (user) {
      var b = document.createElement('b');
      b.textContent = user;
      div.appendChild(b);
      div.appendChild(document.createTextNode(' ' + text));
    } else {
      div.appendChild(document.createTextNode(text));
    }
    state.last = null; // never group onto a system line
    place(div, {});
    return div;
  }

  /* ══ rendering: messages ════════════════════════════════════════════════ */

  function grouped(data) {
    var prev = state.last;
    if (!prev) return false;
    if (prev.fromId !== data.fromId) return false;
    if (data.ts - prev.ts > 300000) return false;
    if (data.replyTo || prev.replyTo) return false;
    if (data.action || prev.action) return false;
    if (data.dm || prev.dm) return false;
    return true;
  }

  function badge(text, kind, withLock) {
    var span = document.createElement('span');
    span.className = 'cf-badge' + (kind ? ' ' + kind : '');
    if (withLock) span.appendChild(lockIcon(10));
    span.appendChild(document.createTextNode(text));
    return span;
  }

  function toolRail(data) {
    var rail = document.createElement('div');
    rail.className = 'cf-rail';
    state.config.emoji.forEach(function (emoji) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = emoji;
      b.setAttribute('aria-label', 'React with ' + emoji);
      b.addEventListener('click', function () { send('react', { id: data.id, emoji: emoji }); });
      rail.appendChild(b);
    });
    var sep = document.createElement('span'); sep.className = 'sep'; rail.appendChild(sep);

    var reply = document.createElement('button');
    reply.type = 'button'; reply.className = 't'; reply.textContent = 'Reply';
    reply.addEventListener('click', function () { startReply(data); });
    rail.appendChild(reply);

    if (state.me && data.fromId === state.me.id) {
      var edit = document.createElement('button');
      edit.type = 'button'; edit.className = 't'; edit.textContent = 'Edit';
      edit.addEventListener('click', function () { startEdit(data); });
      rail.appendChild(edit);

      var unsend = document.createElement('button');
      unsend.type = 'button'; unsend.className = 't'; unsend.textContent = 'Unsend';
      unsend.addEventListener('click', function () { send('unsend', { id: data.id }); });
      rail.appendChild(unsend);
    }
    return rail;
  }

  function quoteBlock(replyTo, plainText) {
    var q = document.createElement('button');
    q.type = 'button';
    q.className = 'cf-quote';
    q.style.setProperty('--uc', replyTo.colour);
    var b = document.createElement('b');
    b.textContent = replyTo.from;
    var s = document.createElement('span');
    // In a locked room the server sends no quote text — it has none. The client
    // renders it from its own decrypted copy of the parent, or says so plainly.
    s.textContent = plainText || replyTo.text || '🔒 earlier message';
    q.appendChild(b); q.appendChild(s);
    q.addEventListener('click', function () {
      var parent = state.msgs.get(replyTo.id);
      if (!parent) return toast('That message is no longer on screen.');
      parent.node.scrollIntoView({ block: 'center', behavior: 'smooth' });
      parent.node.classList.add('flash');
      setTimeout(function () { parent.node.classList.remove('flash'); }, 900);
    });
    return q;
  }

  function reactionsRow(data) {
    var row = document.createElement('div');
    row.className = 'cf-reacts';
    var any = false;
    Object.keys(data.reactions || {}).forEach(function (emoji) {
      var users = data.reactions[emoji];
      if (!users || !users.length) return;
      any = true;
      var chip = document.createElement('button');
      chip.type = 'button';
      var mine = state.me && users.indexOf(state.me.name) >= 0;
      chip.className = 'cf-react' + (mine ? ' on' : '');
      chip.textContent = emoji + ' ' + users.length;
      chip.title = users.join(', ');
      chip.addEventListener('click', function () { send('react', { id: data.id, emoji: emoji }); });
      row.appendChild(chip);
    });
    row.hidden = !any;
    return row;
  }

  // One message row. `plain` is the decrypted payload when the message was
  // encrypted, or null.
  //
  // `isGrouped` is decided ONCE, when the row first arrives, and passed back in
  // on every repaint. Re-deriving it here would compare the message against
  // state.last — which, for the newest message, is the message itself — and a
  // reaction, an edit or a decryption would silently strip its own header.
  function buildMessage(data, plain, isGrouped, sigFailed) {
    var row = document.createElement('div');
    row.className = 'cf-msg';
    row.style.setProperty('--uc', data.colour);
    // Read by rebuildDays(), which needs each row's timestamp without having to
    // look the message back up in state.msgs.
    row.setAttribute('data-ts', String(data.ts));

    var text = plain ? plain.text : data.text;
    var mentions = plain ? (plain.mentions || []) : (data.mentions || []);
    var action = plain ? !!plain.action : !!data.action;

    if (isGrouped) row.classList.add('grouped');
    if (action) row.classList.add('action');
    if (data.unsent) row.classList.add('tomb');
    if (data.enc) row.classList.add('enc');
    if (state.me && data.fromId === state.me.id && !action && !data.unsent) row.classList.add('me');
    if (state.me && mentions.some(function (m) { return m.toLowerCase() === state.me.name.toLowerCase(); })) {
      row.classList.add('mine-mention');
    }

    var gutter = document.createElement('div');
    gutter.className = 'gutter';
    if (isGrouped) {
      var mini = document.createElement('span');
      mini.className = 'ministamp';
      mini.textContent = clock(data.ts);
      gutter.appendChild(mini);
    } else {
      gutter.appendChild(avatar(data.from, data.colour));
    }

    var stack = document.createElement('div');
    stack.className = 'stack';

    if (!isGrouped) {
      var head = document.createElement('div');
      head.className = 'cf-head';
      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = data.from;
      var time = document.createElement('time');
      time.dateTime = new Date(data.ts).toISOString();
      time.textContent = clock(data.ts);
      head.appendChild(nm); head.appendChild(time);
      if (data.dm) head.appendChild(badge(data.dmOut ? 'to ' + data.to : 'private → you', data.enc ? 'seal' : 'pv', !!data.enc));
      if (data.expiresAt) head.appendChild(badge('burns', 'burn'));
      if (data.editedAt) head.appendChild(badge('edited'));
      stack.appendChild(head);
    }

    if (data.replyTo) {
      var parentEntry = state.msgs.get(data.replyTo.id);
      var parentText = parentEntry && parentEntry.plain ? parentEntry.plain.text
        : plain && plain.replyText ? plain.replyText : '';
      stack.appendChild(quoteBlock(data.replyTo, parentText ? parentText.slice(0, 140) : ''));
    }

    // The three encrypted states, plus the two integrity failures (in-transit
    // vs at-rest), plus plain text.
    var body;
    if (data.tampered) {
      // Requirement 4: the SERVER detected this on read — the stored row no
      // longer matches its own authentication tag, which means it was altered
      // directly in the database, not in transit. Different wording from the
      // E2E case below on purpose: this is not "your key is wrong", it is
      // "something is wrong with the row itself".
      body = document.createElement('div');
      body.className = 'cf-fail';
      body.appendChild(warnIcon());
      body.appendChild(document.createTextNode(
        'This message failed its integrity check in storage — it appears to have been altered directly in the database.'));
    } else if (sigFailed) {
      // Requirement 6, the client-independent half: THIS BROWSER re-verified
      // the sender's signature itself, against the sender's own published
      // public key — not taking the server's word for it — and it did not
      // check out. Unlike `tampered` above (a stored row, caught on read),
      // this can also catch a LIVE broadcast altered in transit, which is a
      // gap the server's own send-time verification cannot close for itself.
      body = document.createElement('div');
      body.className = 'cf-fail';
      body.appendChild(warnIcon());
      body.appendChild(document.createTextNode('This message failed its integrity check — it was altered in transit.'));
    } else if (data.unsent) {
      body = document.createElement('div');
      body.className = 'cf-text';
      body.textContent = 'This message was unsent.';
    } else if (data.enc && plain === undefined) {
      body = document.createElement('div');
      body.className = 'cf-text';
      var skel = document.createElement('span');
      skel.className = 'cf-skel';
      body.appendChild(skel);
    } else if (data.enc && plain === null) {
      body = document.createElement('div');
      body.className = 'cf-locked-text';
      body.appendChild(lockIcon(13));
      body.appendChild(document.createTextNode('Encrypted message — sent under key ' + data.enc.kid + ', which you don’t hold'));
    } else if (data.enc && plain === false) {
      body = document.createElement('div');
      body.className = 'cf-fail';
      body.appendChild(warnIcon());
      body.appendChild(document.createTextNode('This message failed its integrity check — it was altered in transit.'));
    } else {
      body = document.createElement('div');
      body.className = 'cf-text';
      if (data.enc) {
        var mark = document.createElement('span');
        mark.className = 'cf-lockmark';
        mark.appendChild(lockIcon(12));
        body.appendChild(mark);
      }
      renderText(body, action ? data.from + ' ' + text : text, mentions);
    }
    stack.appendChild(body);

    if (data.expiresAt) {
      var fuse = document.createElement('div');
      fuse.className = 'cf-fuse';
      fuse.dataset.expires = data.expiresAt;
      stack.appendChild(fuse);
    }

    if (!data.dm) stack.appendChild(reactionsRow(data));

    row.appendChild(gutter);
    row.appendChild(stack);
    if (!data.dm && !data.unsent) row.appendChild(toolRail(data));
    return row;
  }

  function renderMessage(data, plain, atTop) {
    var existing = state.msgs.get(data.id);
    if (existing && existing.node.parentNode) {
      var replacement = buildMessage(data, existing.plain, existing.grouped, existing.sigFailed);
      existing.node.parentNode.replaceChild(replacement, existing.node);
      existing.data = data;
      existing.node = replacement;
      return replacement;
    }
    // A prepended message is never grouped with the one after it and never
    // counts as unread — it is older than everything on screen, and the reader
    // asked for it. It also must not advance state.last, which tracks the
    // NEWEST message for grouping the next live one.
    if (atTop) {
      var oldNode = buildMessage(data, plain, false, false);
      state.msgs.set(data.id, { data: data, node: oldNode, plain: plain, grouped: false, sigFailed: false });
      var anchor = document.getElementById('cf-histtop');
      el.log.insertBefore(oldNode, anchor ? anchor.nextSibling : el.log.firstChild);
      verifySigInto(data.id);
      return oldNode;
    }

    maybeDay(data.ts);
    var isGrouped = grouped(data);
    var node = buildMessage(data, plain, isGrouped, false);
    state.msgs.set(data.id, { data: data, node: node, plain: plain, grouped: isGrouped, sigFailed: false });
    var mine = state.me && data.fromId === state.me.id;
    place(node, { counts: !mine });
    state.last = data;
    notifyIfMentioned(data, plain);
    verifySigInto(data.id);
    return node;
  }

  function repaint(id) {
    var entry = state.msgs.get(id);
    if (!entry) return;
    var node = buildMessage(entry.data, entry.plain, entry.grouped, entry.sigFailed);
    if (entry.node.parentNode) entry.node.parentNode.replaceChild(node, entry.node);
    entry.node = node;
  }

  function notifyIfMentioned(data, plain) {
    if (!state.me) return;
    var mentions = plain ? (plain.mentions || []) : (data.mentions || []);
    var hit = mentions.some(function (m) { return m.toLowerCase() === state.me.name.toLowerCase(); });
    if (!hit || !document.hidden) return;
    document.title = '(' + (++mentionCount) + ') ChatFat';
    if (window.Notification && Notification.permission === 'granted') {
      try { new Notification(data.from + ' mentioned you in ' + state.room); } catch (e) {}
    }
  }
  var mentionCount = 0;
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { mentionCount = 0; document.title = 'ChatFat'; }
  });

  /* ══ burn countdown ═════════════════════════════════════════════════════ */

  setInterval(function () {
    var fuses = el.log.querySelectorAll('.cf-fuse');
    var now = Date.now();
    for (var i = 0; i < fuses.length; i++) {
      var left = Math.ceil((Number(fuses[i].dataset.expires) - now) / 1000);
      fuses[i].textContent = left > 0 ? '⏱ burns in ' + left + 's' : '⏱ burning…';
    }
  }, 500);

  /* ══ polls ══════════════════════════════════════════════════════════════ */

  function renderPoll(poll, plain) {
    var card = document.createElement('div');
    card.className = 'cf-poll' + (poll.closed ? ' closed' : '');

    var k = document.createElement('div');
    k.className = 'k';
    k.textContent = 'Live poll · ' + poll.by + (poll.closed ? ' · closed' : '');
    card.appendChild(k);

    var q = document.createElement('h4');
    q.textContent = plain ? plain.q : poll.enc ? '🔒 Encrypted poll' : poll.q;
    card.appendChild(q);

    var labels = plain ? plain.options : poll.enc ? poll.options.map(function (_, i) { return 'Option ' + (i + 1); }) : poll.options;
    var mine = state.me ? poll.voters[state.me.name] : undefined;

    labels.forEach(function (label, index) {
      var opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'cf-opt' + (mine === index ? ' chosen' : '');
      var row = document.createElement('div');
      row.className = 'row';
      row.appendChild(document.createTextNode(label));
      var b = document.createElement('b');
      b.textContent = poll.tally[index];
      row.appendChild(b);
      var bar = document.createElement('div');
      bar.className = 'cf-bar';
      var fill = document.createElement('i');
      fill.style.width = (poll.total ? Math.round((poll.tally[index] / poll.total) * 100) : 0) + '%';
      bar.appendChild(fill);
      opt.appendChild(row); opt.appendChild(bar);
      if (!poll.closed) opt.addEventListener('click', function () { send('poll:vote', { id: poll.id, choice: index }); });
      card.appendChild(opt);
    });

    var foot = document.createElement('div');
    foot.className = 'foot';
    foot.textContent = poll.total + ' vote' + (poll.total === 1 ? '' : 's')
      + (mine !== undefined ? ' · you chose ' + labels[mine] : '')
      + (poll.closed ? ' · closed by the author' : '');
    if (!poll.closed && state.me && poll.by === state.me.name) {
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'cf-btn cf-btn-ghost';
      close.style.marginLeft = 'auto';
      close.textContent = 'Close poll';
      close.addEventListener('click', function () { send('poll:close', { id: poll.id }); });
      foot.appendChild(close);
    }
    card.appendChild(foot);
    return card;
  }

  async function upsertPoll(poll) {
    var plain = null;
    if (poll.enc) {
      var entry = keyAt(state.room, poll.enc.kid);
      var out = await C.decryptRoom(entry, state.room, poll.enc);
      plain = out.ok ? out.payload : null;
    }
    var node = renderPoll(poll, plain);
    var existing = state.polls.get(poll.id);
    if (existing && existing.node.parentNode) {
      existing.node.parentNode.replaceChild(node, existing.node);
      state.polls.set(poll.id, { data: poll, node: node });
    } else {
      state.polls.set(poll.id, { data: poll, node: node });
      state.last = null;
      place(node, { counts: true });
    }
  }

  /* ══ roster & typing ════════════════════════════════════════════════════ */

  function renderRoster() {
    el.roster.textContent = '';
    el.rosterCount.textContent = state.roster.length;
    state.pubs.clear();

    state.roster.forEach(function (user) {
      if (user.pub) state.pubs.set(user.name.toLowerCase(), user.pub);
      var row = document.createElement('div');
      row.className = 'cf-user'
        + (state.me && user.id === state.me.id ? ' self' : '')
        + (user.state === 'away' ? ' away' : '')
        + (state.typing.indexOf(user.name) >= 0 ? ' typing-now' : '');
      row.style.setProperty('--uc', user.colour);
      row.appendChild(avatar(user.name, user.colour));

      var nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = user.name;
      row.appendChild(nm);

      if (state.me && user.id === state.me.id) row.appendChild(tag('you'));
      else if (user.state === 'away') row.appendChild(tag('away'));

      var rtt = document.createElement('span');
      rtt.className = 'rtt';
      rtt.textContent = user.rtt === null || user.rtt === undefined ? '—' : user.rtt + 'ms';
      row.appendChild(rtt);
      el.roster.appendChild(row);
    });
  }

  function tag(text) {
    var s = document.createElement('span');
    s.className = 'tag';
    s.textContent = text;
    return s;
  }

  function renderTyping() {
    var names = state.typing.filter(function (n) { return !state.me || n !== state.me.name; });
    el.typing.textContent = names.length === 0 ? ''
      : names.length === 1 ? names[0] + ' is typing…'
      : names.length === 2 ? names[0] + ' and ' + names[1] + ' are typing…'
      : 'several people are typing…';
  }

  /* ══ the connection meter ═══════════════════════════════════════════════ */

  function drawSpark() {
    var canvas = el.spark;
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (state.rtt.length < 2) return;
    var max = Math.max.apply(null, state.rtt) || 1;
    ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--brass').trim() || '#b2622d';
    ctx.lineWidth = 3.2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    state.rtt.forEach(function (value, i) {
      var x = (i / (state.rtt.length - 1)) * (w - 6) + 3;
      var y = h - 4 - (value / max) * (h - 10);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  /* ══ composer ═══════════════════════════════════════════════════════════ */

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(144, el.input.scrollHeight) + 'px';
  }

  function refreshComposer() {
    var locked = state.phase !== 'ready';
    var room = state.room;
    var needsKey = room && roomIsLocked(room) && !currentKey(room);

    el.composer.classList.toggle('locked', locked || needsKey);
    el.composer.classList.toggle('sealed', !!(room && roomIsLocked(room) && !needsKey));
    el.input.disabled = !!needsKey;
    el.send.disabled = !!needsKey;

    el.input.placeholder = needsKey ? 'Unlock this room to send messages.'
      : state.phase === 'reconnecting' || state.phase === 'offline'
        ? 'Reconnecting — anything you type will be sent when the line is back…'
      : room && roomIsLocked(room) ? 'Encrypted message to ' + roomName(room) + '…'
      : room ? 'Message ' + roomName(room) + '…'
      : 'Message…';
  }

  function roomIsLocked(id) {
    for (var i = 0; i < state.rooms.length; i++) if (state.rooms[i].id === id) return !!state.rooms[i].locked;
    return !!(state.roomMeta && state.roomMeta.locked);
  }
  function roomName(id) {
    return state.roomMeta && state.roomMeta.id === id ? state.roomMeta.name : id;
  }

  var typingSentAt = 0;
  el.input.addEventListener('input', function () {
    autosize();
    var len = el.input.value.length;
    var max = state.config.maxText;
    el.count.hidden = len < max - 200;
    el.count.textContent = len;
    el.count.classList.toggle('over', len > max);
    var now = Date.now();
    if (el.input.value && now - typingSentAt > 1500) { typingSentAt = now; send('typing', { on: true }); }
    updateAutocomplete();
  });

  el.input.addEventListener('keydown', function (event) {
    if (!el.ac.hidden) {
      if (event.key === 'ArrowDown') { event.preventDefault(); moveAc(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveAc(-1); return; }
      if (event.key === 'Tab' || (event.key === 'Enter' && acItems.length)) { event.preventDefault(); acceptAc(); return; }
      if (event.key === 'Escape') { event.preventDefault(); closeAc(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); el.composer.requestSubmit(); }
    if (event.key === 'Escape') { cancelReply(); cancelEdit(); }
  });

  el.composer.addEventListener('submit', function (event) {
    event.preventDefault();
    var raw = el.input.value;
    var text = raw.trim();
    // Sent BEFORE the command branch can return, or a /command leaves a
    // phantom "…is typing" behind it.
    typingSentAt = 0;
    send('typing', { on: false });
    closeAc();
    if (!text) return;

    el.input.value = '';
    autosize();
    el.count.hidden = true;

    if (text.indexOf('//') === 0) return sendChat(text.slice(1));
    if (text[0] === '/') return runCommand(text);
    sendChat(text);
  });

  /* ══ sending ════════════════════════════════════════════════════════════ */

  // Guarantees FIFO delivery for signed frames. Signing is async (WebCrypto),
  // so two sends fired close together — fast typing plus Enter, or a
  // double-submit — could otherwise have their signatures resolve, and
  // therefore reach the server, in a different order than they were composed
  // in: a message reordering itself relative to its own sender's other
  // messages. Chaining forces each signature to be computed strictly after
  // the previous send's, so the synchronous send() right after it always
  // fires in call order too.
  var signChain = Promise.resolve();
  function signInOrder(fields) {
    var result = signChain.then(function () { return C.signMessage(fields); });
    signChain = result.catch(function () {}); // one failure must not wedge every send after it
    return result;
  }

  async function sendChat(text, options) {
    options = options || {};
    if (text.length > state.config.maxText) return toast('That message is too long.', true, 'TOO_LONG');
    // Requirement 5: no signing key, no send — the server enforces this too,
    // but failing here gives a message that actually explains why, instead of
    // a generic error frame.
    if (!C.available) return toast('This browser has no WebCrypto, so messages cannot be signed. Nothing was sent.', true);

    var locked = state.room && roomIsLocked(state.room);

    if (!locked) {
      // Requirement 6: signed over exactly {room, from, text, enc:null} —
      // identically to what src/transport/handlers.js reconstructs and
      // verifies server-side before this is accepted.
      var signed = await signInOrder({ room: state.room, from: state.me.name, text: text, enc: null });
      var frame = { text: text, action: !!options.action, sig: signed.sig };
      if (state.replyTo) frame.replyTo = state.replyTo.id;
      if (options.ttl) frame.ttl = options.ttl;
      send('chat', frame);
      cancelReply();
      return;
    }

    var entry = currentKey(state.room);
    if (!entry) return toast('Unlock this room first.', true);

    // Mentions are parsed from OUR plaintext and travel INSIDE the ciphertext:
    // the server cannot resolve them because it cannot read the message. That
    // makes mention highlighting client-trusted here, which is fine — everyone
    // in the room already shares the key.
    var mentions = [];
    var re = /@([A-Za-z0-9_.-]{2,16})/g, m;
    while ((m = re.exec(text))) {
      for (var i = 0; i < state.roster.length; i++) {
        if (state.roster[i].name.toLowerCase() === m[1].toLowerCase()) mentions.push(state.roster[i].name);
      }
    }

    var inner = { text: text, mentions: mentions, action: !!options.action };
    if (state.replyTo) {
      var parent = state.msgs.get(state.replyTo.id);
      if (parent && parent.plain) inner.replyText = String(parent.plain.text).slice(0, 140);
    }
    var envelope = await C.encryptRoom(entry, state.room, inner);
    // Signed over {room, from, text:'', enc}: the server never sees this
    // message's real text, only the envelope, so that is what gets signed —
    // same shape the server reconstructs for a locked-room chat frame.
    var signedEnc = await signInOrder({ room: state.room, from: state.me.name, text: '', enc: envelope });
    var out = { enc: envelope, sig: signedEnc.sig };
    if (state.replyTo) out.replyTo = state.replyTo.id;
    if (options.ttl) out.ttl = options.ttl;
    send('chat', out);
    cancelReply();
  }

  async function sendWhisper(to, text) {
    if (!state.sealed) return send('dm', { to: to, text: text });
    var pub = state.pubs.get(String(to).toLowerCase());
    if (!pub) {
      // Refuse rather than silently downgrade to plaintext.
      return toast('Sealed whispers are on, and ' + to + ' has published no key. Nothing was sent.', true);
    }
    if (!state.myKeyPair) return toast('No key pair yet — try again in a moment.', true);
    var envelope = await C.sealWhisper(state.myKeyPair, pub, state.me.name, to, text);
    send('dm', { to: to, enc: envelope });
  }

  function startReply(data) {
    var entry = state.msgs.get(data.id);
    var text = entry && entry.plain ? entry.plain.text : data.text;
    state.replyTo = { id: data.id, from: data.from, colour: data.colour, text: text || '🔒 earlier message' };
    el.replybar.hidden = false;
    el.replybar.style.setProperty('--uc', data.colour);
    el.replyWho.textContent = 'Replying to ' + data.from;
    el.replyText.textContent = state.replyTo.text;
    el.input.focus();
  }
  function cancelReply() {
    state.replyTo = null;
    el.replybar.hidden = true;
  }
  el.replyCancel.addEventListener('click', cancelReply);

  function startEdit(data) {
    var entry = state.msgs.get(data.id);
    if (!entry) return;
    cancelEdit();
    var current = entry.plain ? entry.plain.text : data.text;

    var box = document.createElement('div');
    box.className = 'cf-editbox';
    var area = document.createElement('textarea');
    area.value = current;
    var row = document.createElement('div');
    row.className = 'row';
    var save = document.createElement('button');
    save.type = 'button'; save.className = 'cf-btn cf-btn-primary'; save.style.padding = '6px 14px';
    save.textContent = 'Save';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'cf-btn cf-btn-secondary'; cancel.style.padding = '6px 14px';
    cancel.textContent = 'Cancel';
    var hint = document.createElement('span');
    hint.textContent = 'Enter saves · Esc cancels';
    row.appendChild(save); row.appendChild(cancel); row.appendChild(hint);
    box.appendChild(area); box.appendChild(row);

    var body = entry.node.querySelector('.cf-text, .cf-locked-text, .cf-fail');
    if (!body) return;
    body.hidden = true;
    body.parentNode.insertBefore(box, body.nextSibling);
    state.editing = { id: data.id, box: box, body: body };
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);

    var commit = async function () {
      var next = area.value.trim();
      if (!next) return cancelEdit();
      if (!C.available) { toast('This browser has no WebCrypto, so the edit cannot be signed. Nothing was sent.', true); return cancelEdit(); }
      // The signed `from` is the message's ORIGINAL author name (data.from),
      // not necessarily state.me.name — a /nick between the original send and
      // this edit must not change what the server checks the signature
      // against (src/transport/handlers.js verifies against message.from).
      if (state.room && roomIsLocked(state.room)) {
        var key = currentKey(state.room);
        if (!key) return toast('Unlock this room first.', true);
        var mine = state.msgs.get(data.id);
        var inner = { text: next, mentions: (mine && mine.plain && mine.plain.mentions) || [], action: !!(mine && mine.plain && mine.plain.action) };
        var envelope = await C.encryptRoom(key, state.room, inner);
        var signed = await signInOrder({ room: state.room, from: data.from, text: '', enc: envelope });
        send('edit', { id: data.id, enc: envelope, sig: signed.sig });
      } else {
        var signedPlain = await signInOrder({ room: state.room, from: data.from, text: next, enc: null });
        send('edit', { id: data.id, text: next, sig: signedPlain.sig });
      }
      cancelEdit();
    };
    save.addEventListener('click', commit);
    cancel.addEventListener('click', cancelEdit);
    area.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
    });
  }

  function cancelEdit() {
    if (!state.editing) return;
    if (state.editing.box.parentNode) state.editing.box.parentNode.removeChild(state.editing.box);
    state.editing.body.hidden = false;
    state.editing = null;
  }

  /* ══ slash autocomplete ═════════════════════════════════════════════════ */

  var COMMANDS = [
    { cmd: '/help', args: '', desc: 'list every command', bare: true },
    { cmd: '/rooms', args: '', desc: 'list the rooms on this server', bare: true },
    { cmd: '/join', args: '<room>', desc: 'switch to another room' },
    { cmd: '/leave', args: '', desc: 'leave this room, back to the lobby', bare: true },
    { cmd: '/users', args: '', desc: 'who is in the room right now', bare: true },
    { cmd: '/w', args: '<user> <message>', desc: 'private message' },
    { cmd: '/me', args: '<action>', desc: 'emote' },
    { cmd: '/poll', args: 'q? a | b | c', desc: 'open a live poll' },
    { cmd: '/burn', args: '<seconds> <message>', desc: 'self-destructing message' },
    { cmd: '/nick', args: '<name>', desc: 'change your display name' },
    { cmd: '/ping', args: '', desc: 'show round-trip time', bare: true },
    { cmd: '/clear', args: '', desc: 'clear your own view of the log', bare: true },
    { cmd: '/theme', args: '', desc: 'switch light / dark / system', bare: true },
    { cmd: '/quit', args: '', desc: 'leave', bare: true },
    { cmd: '/lock', args: '<passphrase>', desc: 'encrypt this room' },
    { cmd: '/unlock', args: '<passphrase>', desc: 'supply the key for this room' },
    { cmd: '/key', args: '', desc: 'show the key fingerprint', bare: true },
    { cmd: '/forget', args: '', desc: 'drop the stored key for this room', bare: true },
    { cmd: '/seal', args: '', desc: 'toggle sealed whispers', bare: true }
  ];

  var acItems = [], acIndex = 0;

  function updateAutocomplete() {
    var value = el.input.value;
    if (value[0] !== '/' || value.indexOf(' ') >= 0 || value.indexOf('//') === 0) return closeAc();
    var needle = value.slice(1).toLowerCase();
    acItems = COMMANDS.filter(function (c) { return c.cmd.slice(1).indexOf(needle) === 0; });
    if (!acItems.length) return closeAc();
    acIndex = 0;
    paintAc();
  }

  function paintAc() {
    el.ac.textContent = '';
    acItems.forEach(function (item, i) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'cf-ac-row' + (i === acIndex ? ' sel' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === acIndex));
      var code = document.createElement('code');
      code.textContent = item.cmd + (item.args ? ' ' + item.args : '');
      row.appendChild(code);
      row.appendChild(document.createTextNode(item.desc));
      row.addEventListener('mousedown', function (e) { e.preventDefault(); acIndex = i; acceptAc(); });
      el.ac.appendChild(row);
    });
    el.ac.hidden = false;
  }

  function moveAc(delta) {
    acIndex = (acIndex + delta + acItems.length) % acItems.length;
    paintAc();
  }

  function acceptAc() {
    var item = acItems[acIndex];
    if (!item) return closeAc();
    closeAc();
    if (item.bare) { el.input.value = item.cmd; el.composer.requestSubmit(); return; }
    el.input.value = item.cmd + ' ';
    el.input.focus();
  }

  function closeAc() { el.ac.hidden = true; acItems = []; }

  /* ══ commands ═══════════════════════════════════════════════════════════ */

  async function runCommand(line) {
    var space = line.indexOf(' ');
    var cmd = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    var rest = space < 0 ? '' : line.slice(space + 1).trim();

    switch (cmd) {
      case '/help':
        COMMANDS.forEach(function (c) { systemLine(c.cmd + (c.args ? ' ' + c.args : '') + ' — ' + c.desc); });
        return;
      case '/rooms':
        systemLine(state.rooms.map(function (r) { return r.name + ' (' + r.count + ')' + (r.locked ? ' 🔒' : ''); }).join(' · ') || 'no rooms yet');
        return;
      case '/join': return rest ? joinRoom(rest) : systemLine('Usage: /join <room>', 'warn');
      case '/leave': case '/quit': return send('room:leave', {});
      case '/users':
        systemLine(state.roster.map(function (u) { return u.name; }).join(', ') || 'nobody here');
        return;
      case '/w': case '/whisper': case '/msg': {
        var at = rest.indexOf(' ');
        if (at < 1) return systemLine('Usage: /w <user> <message>', 'warn');
        return sendWhisper(rest.slice(0, at), rest.slice(at + 1));
      }
      case '/me': return rest ? sendChat(rest, { action: true }) : null;
      case '/poll': {
        var q = rest.indexOf('?');
        if (q < 0) return systemLine('Usage: /poll Question? a | b | c', 'warn');
        var question = rest.slice(0, q + 1).trim();
        var options = rest.slice(q + 1).split('|').map(function (s) { return s.trim(); }).filter(Boolean);
        if (options.length < 2 || options.length > 5) return systemLine('A poll needs 2–5 options.', 'warn');
        if (state.room && roomIsLocked(state.room)) {
          var key = currentKey(state.room);
          if (!key) return toast('Unlock this room first.', true);
          return send('poll:new', { count: options.length, enc: await C.encryptRoom(key, state.room, { q: question, options: options }) });
        }
        return send('poll:new', { q: question, options: options });
      }
      case '/burn': {
        var sp = rest.indexOf(' ');
        var secs = parseInt(rest.slice(0, sp < 0 ? rest.length : sp), 10);
        var body = sp < 0 ? '' : rest.slice(sp + 1).trim();
        if (!Number.isFinite(secs) || !body) return systemLine('Usage: /burn <seconds> <message>', 'warn');
        return sendChat(body, { ttl: secs });
      }
      case '/nick': return rest ? send('nick', { username: rest }) : systemLine('Usage: /nick <name>', 'warn');
      case '/ping': return systemLine('Round-trip time: ' + (state.rtt.length ? state.rtt[state.rtt.length - 1] + ' ms' : 'not measured yet'));
      case '/clear': return clearLog();
      case '/theme': return cycleTheme();
      case '/lock': return openLockModal(rest);
      case '/unlock':
        if (!state.room || !roomIsLocked(state.room)) return systemLine('This room is not encrypted.', 'warn');
        if (!rest) { openKeyModal(); return; }
        return tryUnlock(rest, false);
      case '/key': {
        var held = currentKey(state.room);
        if (!held) return systemLine('You hold no key for this room.', 'lock');
        var older = (state.keys.get(state.room) || new Map()).size - 1;
        return systemLine('Key fingerprint for this room: ' + held.fingerprint
          + ' — compare it out loud with another member.'
          + (older > 0 ? ' You also still hold ' + older + ' earlier key' + (older === 1 ? '' : 's') + ', so older messages stay readable.' : ''), 'lock');
      }
      case '/forget': {
        if (!state.room) return;
        C.forget(state.room);
        dropKeys(state.room);
        paintKeyChip();
        refreshComposer();
        return systemLine('Dropped the key for this room from this browser.', 'lock');
      }
      case '/seal':
        state.sealed = !state.sealed;
        paintCommandsPanel();
        return systemLine('Sealed whispers are now ' + (state.sealed ? 'on — whispers are encrypted to the recipient’s key' : 'off'), 'lock');
      default:
        return systemLine('Unknown command “' + cmd + '”. Try /help', 'warn');
    }
  }

  /* ══ encryption: the key ring ═══════════════════════════════════════════ */

  // One ring per room, one entry per key epoch. Nothing is ever evicted on
  // rotation — an envelope names the epoch it was sealed under (`kid`), and the
  // ring is what lets an old message stay readable after a new passphrase.
  function ring(roomId) {
    var r = state.keys.get(roomId);
    if (!r) { r = new Map(); state.keys.set(roomId, r); }
    return r;
  }
  function holdKey(roomId, entry) { ring(roomId).set(entry.epoch, entry); }
  function keyAt(roomId, epoch) {
    var r = state.keys.get(roomId);
    return (r && r.get(epoch)) || null;
  }
  function currentEpoch(roomId) {
    return state.roomMeta && state.roomMeta.id === roomId ? state.roomMeta.keyEpoch : 0;
  }
  // The key you would SEND under. Holding an old epoch does not unlock the room.
  function currentKey(roomId) { return keyAt(roomId, currentEpoch(roomId)); }
  function dropKeys(roomId) { state.keys.delete(roomId); }

  /* ══ encryption: modals and the key pipeline ════════════════════════════ */

  function paintKeyChip() {
    var locked = state.room && roomIsLocked(state.room);
    el.keyChip.hidden = !locked;
    if (!locked) return;
    var entry = currentKey(state.room);
    el.keyFp.textContent = entry ? entry.fingerprint : 'locked';
    el.meState.textContent = entry ? 'key held' : 'no key';
    el.meState.className = 'st' + (entry ? ' keyed' : '');
  }

  function paintCommandsPanel() {
    var locked = state.room && roomIsLocked(state.room);
    el.cmdsTitle.textContent = locked ? 'Encryption' : 'Commands';
    el.cmds.textContent = '';
    var rows = locked
      ? [['/key', 'show fingerprint'], ['/forget', 'drop this key'],
         ['/seal', 'sealed whispers ' + (state.sealed ? 'on' : 'off')], ['/lock', 'rotate the passphrase']]
      : [['/poll', 'ask the room'], ['/burn 30', 'self-destructing'], ['/w name', 'private message'],
         ['/lock', 'encrypt this room'], ['/help', 'everything else']];
    rows.forEach(function (row) {
      var li = document.createElement('li');
      var code = document.createElement('code');
      code.textContent = row[0];
      li.appendChild(code);
      li.appendChild(document.createTextNode(row[1]));
      el.cmds.appendChild(li);
    });
  }

  function openKeyModal() {
    el.kmRoom.textContent = roomName(state.room);
    el.kmPass.value = '';
    el.kmPass.type = 'password';
    el.kmRev.textContent = 'Show';
    showError(el.kmError, '');
    el.keymodal.hidden = false;
    setTimeout(function () { el.kmPass.focus(); }, 0);
  }
  function closeKeyModal() { el.keymodal.hidden = true; }

  el.kmRev.addEventListener('click', function () { revealToggle(el.kmPass, el.kmRev); });
  el.kmLeave.addEventListener('click', function () { closeKeyModal(); send('room:leave', {}); });
  el.kmForm.addEventListener('submit', function (event) {
    event.preventDefault();
    tryUnlock(el.kmPass.value, el.kmRemember.checked);
  });

  async function tryUnlock(passphrase, remember) {
    var meta = state.roomMeta;
    if (!meta || !meta.locked) return;
    el.kmUnlock.disabled = true;
    try {
      var entry = await C.makeRoomKey(passphrase, meta.id, meta.keyEpoch, (meta.kdf && meta.kdf.iterations) || state.config.kdfIterations);
      if (entry.verifier !== meta.verifier) {
        showError(el.kmError, 'That passphrase doesn’t match this room.');
        return;
      }
      holdKey(meta.id, entry);
      if (remember) C.remember(meta.id, meta.keyEpoch, entry.raw);
      closeKeyModal();
      paintKeyChip();
      paintCommandsPanel();
      refreshComposer();
      systemLine('Unlocked · key ' + entry.fingerprint, 'lock');
      redecryptAll();
    } finally {
      el.kmUnlock.disabled = false;
    }
  }

  function openLockModal(prefill) {
    if (!state.room) return systemLine('Join a room before locking it.', 'warn');
    if (!state.encryption) return toast('This server does not allow encrypted rooms.', true, 'ENCRYPTION_DISABLED');
    var rotating = roomIsLocked(state.room);
    el.lmHeading.textContent = rotating ? 'Rotate the passphrase' : 'Lock this room';
    el.lmLede.textContent = rotating
      ? 'Rotating the key protects new messages. Anyone who already had the old passphrase can still read older ones — rotation does not re-encrypt history.'
      : 'Everyone who wants to read this room from now on needs this passphrase. It is never sent to the server. A locked room can never be turned back into a plaintext one.';
    el.lmPass.value = prefill || '';
    el.lmPass.type = 'password';
    el.lmRev.textContent = 'Show';
    paintMeter(el.lmMeter, el.lmPass.value);
    showError(el.lmError, '');
    el.lockmodal.hidden = false;
    setTimeout(function () { el.lmPass.focus(); }, 0);
  }

  el.lmRev.addEventListener('click', function () { revealToggle(el.lmPass, el.lmRev); });
  el.lmCancel.addEventListener('click', function () { el.lockmodal.hidden = true; });
  el.lmForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    var pass = el.lmPass.value;
    if (pass.length < 10) return showError(el.lmError, 'A room passphrase needs at least 10 characters.');
    var epoch = (state.roomMeta && state.roomMeta.keyEpoch ? state.roomMeta.keyEpoch : 0) + 1;
    var entry = await C.makeRoomKey(pass, state.room, epoch, state.config.kdfIterations);
    state.pendingKey = entry;
    send('room:lock', {
      kdf: { alg: 'PBKDF2-SHA256', iterations: state.config.kdfIterations, salt: C.b64(await C.roomSalt(state.room)) },
      verifier: entry.verifier
    });
    el.lockmodal.hidden = true;
    el.lmPass.value = '';
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    if (!el.lockmodal.hidden) el.lockmodal.hidden = true;
    // The key modal is dismissible only by unlocking or leaving.
  });

  // Try the stored key for this room, if the box was ever ticked.
  async function restoreKey(meta) {
    var stored = C.recall(meta.id, meta.keyEpoch);
    if (!stored) return false;
    var entry = await C.fromRawKey(stored, meta.id, meta.keyEpoch);
    if (entry.verifier !== meta.verifier) { C.forget(meta.id); return false; }
    holdKey(meta.id, entry);
    return true;
  }

  // Decryption is per-message and asynchronous: the row renders with the
  // skeleton first and is patched when the plaintext arrives.
  async function decryptInto(id) {
    var entry = state.msgs.get(id);
    if (!entry || !entry.data.enc) return;
    var key = keyAt(state.room, entry.data.enc.kid);
    var out = await C.decryptRoom(key, state.room, entry.data.enc);
    entry.plain = out.ok ? out.payload : out.reason === 'integrity' ? false : null;
    repaint(id);
  }

  function redecryptAll() {
    state.msgs.forEach(function (entry, id) { if (entry.data.enc) decryptInto(id); });
    state.polls.forEach(function (entry) { upsertPoll(entry.data); });
  }

  // Requirement 6, verified independently by THIS browser — see the comment
  // on the sigFailed branch in buildMessage. `data.text`/`data.enc` here are
  // exactly what the server sent and exactly what it verified against — for a
  // locked room that's the ciphertext envelope (text is always '' from the
  // server), not the decrypted plaintext, matching what was actually signed.
  async function verifySigInto(id) {
    var entry = state.msgs.get(id);
    if (!entry || !entry.data.sig || !entry.data.sigPub || entry.data.dm) return;
    if (entry.data.tampered) return; // the server already told us — do not re-flag with different wording
    var ok = await C.verifySignature(entry.data.sigPub, entry.data.sig, {
      room: state.room, from: entry.data.from, text: entry.data.text, enc: entry.data.enc || null,
    });
    if (ok) return; // already renders as sigFailed:false by default — nothing to repaint
    entry.sigFailed = true;
    repaint(id);
  }

  // Resolves once both this browser's whisper (ECDH) and signing (ECDSA)
  // keypairs exist — generating or loading from IndexedDB at most once per
  // page, however many times this is called. Cached, not re-run per call.
  var keysPromise = null;
  function ensureKeys() {
    if (keysPromise) return keysPromise;
    keysPromise = (async function () {
      if (!C.available) return null;
      if (!state.myKeyPair) {
        try { state.myKeyPair = await C.newKeyPair(); } catch (e) {}
      }
      try { return await C.signingKeyPair(); } catch (e) { return null; }
    })();
    return keysPromise;
  }

  // Publishes both public keys to THIS connection. Unlike ensureKeys() above,
  // this is NOT cached — it must run again on every reconnect, because the
  // server's session (and therefore session.sigPub — see src/transport/
  // handlers.js) is brand new each time, even though the keys themselves are
  // the same ones reused from IndexedDB.
  function publishKeys() {
    return ensureKeys().then(function (sig) {
      state.sigPub = sig ? sig.pubB64 : null;
      var payload = {};
      if (state.myKeyPair) payload.pub = state.myKeyPair.pubB64;
      if (sig) payload.sigPub = sig.pubB64;
      if (payload.pub || payload.sigPub) send('key:publish', payload);
    });
  }

  function encryptionBanner() {
    if (state.bannerShown.has(state.room)) return;
    state.bannerShown.add(state.room);
    var box = document.createElement('div');
    box.className = 'cf-encbanner';
    box.appendChild(lockIcon(15));
    var text = document.createElement('div');
    var b = document.createElement('b');
    b.textContent = 'Messages here are encrypted in your browser.';
    text.appendChild(b);
    text.appendChild(document.createTextNode(' The server relays them but cannot read them — it still sees who is here, when you type, and how often.'));
    box.appendChild(text);
    el.log.appendChild(box);
  }

  /* ══ frame handling ═════════════════════════════════════════════════════ */

  async function handle(t, d) {
    switch (t) {
      case 'hello':
        state.auth = !!d.auth;
        state.encryption = !!d.encryption;
        paintJoinCard();
        return;

      case 'welcome':
        state.me = d.you;
        state.rooms = d.rooms || [];
        if (d.config) for (var k in d.config) state.config[k] = d.config[k];
        ls(LS.name, state.me.name);
        el.lobbyMe.textContent = state.me.name;
        paintMe();
        // Awaited, and BEFORE flushQueue(): the server refuses any chat/edit
        // frame from a session with no signing key published yet (requirement
        // 5), so the publish has to actually reach the server — not just be
        // requested — before any queued message is released to it.
        await publishKeys();
        flushQueue();
        // Walk straight back into the room we were in before the line dropped.
        if (state.wantRoom) { send('room:join', { room: state.wantRoom }); setPhase('joining'); }
        else if (state.pendingRoomHash) { var target = state.pendingRoomHash; state.pendingRoomHash = null; joinRoom(target); setPhase('joining'); }
        else { setPhase('lobby'); screen('lobby'); renderRooms(); }
        if (window.Notification && Notification.permission === 'default') {
          try { Notification.requestPermission(); } catch (e) {}
        }
        return;

      case 'rooms':
        state.rooms = d.rooms || [];
        if (!el.lobby.hidden) renderRooms();
        paintKeyChip();
        return;

      case 'room:joined': {
        state.room = d.room.id;
        state.roomMeta = d.room;
        state.wantRoom = d.room.id;
        state.everJoined = true;
        state.roster = d.roster || [];
        state.typing = d.typing || [];
        clearLog();
        screen('app');
        setPhase('ready');
        el.appRoom.textContent = '/ ' + d.room.name;
        history.replaceState(null, '', location.pathname + '#room=' + encodeURIComponent(d.room.id));
        renderRoster();
        renderTyping();
        paintCommandsPanel();
        paintKeyChip();

        if (d.room.locked) {
          encryptionBanner();
          if (state.pendingKey && state.pendingKey.epoch === d.room.keyEpoch) {
            holdKey(d.room.id, state.pendingKey);
            state.pendingKey = null;
          }
          // Only the CURRENT epoch decides whether the room is unlocked for you.
          // Any older epochs on the ring stay — they are what keep the backlog
          // readable, and dropping them would be a silent loss.
          if (!currentKey(d.room.id)) await restoreKey(d.room);
          paintKeyChip();
          // The join is ALLOWED server-side — the server has no key and could
          // verify nothing, so gating entry there would be theatre. The gate is
          // the composer, and this modal in front of it.
          if (!currentKey(d.room.id)) openKeyModal();
        } else {
          closeKeyModal();
        }
        refreshComposer();

        if (d.history === undefined) {
          systemLine('You see what is said from here on — this server replays nothing.', '');
        } else if (d.history.length === 0) {
          // Absent and empty are different states and the product says so: a
          // server that does not replay, versus a room nobody has used.
          systemLine('Nothing has been said in here yet.', '');
          state.hist.done = true;
        } else {
          for (var i = 0; i < d.history.length; i++) {
            renderMessage(d.history[i], d.history[i].enc ? undefined : null);
            if (d.history[i].enc) decryptInto(d.history[i].id);
          }
          // A full first page means there is probably more behind it; a short
          // one means we already have the whole room.
          state.hist.oldest = { ts: d.history[0].ts, id: d.history[0].id };
          state.hist.done = d.history.length < (state.config.historyReplay || d.history.length);
        }
        paintHistoryTop();
        el.log.scrollTop = el.log.scrollHeight;
        return;
      }

      case 'history:page': {
        // Ignore a page that arrived after the reader moved on.
        if (d.room !== state.room) return;
        state.hist.loading = false;
        state.hist.error = false;
        if (d.done) state.hist.done = true;

        if (d.messages && d.messages.length) {
          // The anchor. Everything between these two lines changes the
          // document's height above the viewport, and without restoring the
          // delta the reader is thrown backwards by exactly one page — the
          // classic scrollback bug.
          var beforeH = el.log.scrollHeight;
          var beforeTop = el.log.scrollTop;

          // Reverse order: each message is inserted directly under the loading
          // bar, so inserting oldest-last leaves them in ascending order.
          for (var j = d.messages.length - 1; j >= 0; j--) {
            var m = d.messages[j];
            renderMessage(m, m.enc ? undefined : null, true);
            if (m.enc) decryptInto(m.id);
          }
          state.hist.oldest = { ts: d.messages[0].ts, id: d.messages[0].id };
          rebuildDays();

          paintHistoryTop();
          el.log.scrollTop = beforeTop + (el.log.scrollHeight - beforeH);
        } else {
          paintHistoryTop();
        }
        return;
      }

      case 'room:left':
        state.room = null;
        state.roomMeta = null;
        state.wantRoom = null;
        state.rooms = d.rooms || state.rooms;
        closeKeyModal();
        screen('lobby');
        setPhase('lobby');
        history.replaceState(null, '', location.pathname);
        renderRooms();
        return;

      case 'room:locked':
        if (state.roomMeta) {
          state.roomMeta.locked = true;
          state.roomMeta.kdf = d.kdf;
          state.roomMeta.verifier = d.verifier;
          state.roomMeta.keyEpoch = d.keyEpoch;
        }
        if (state.pendingKey && state.pendingKey.verifier === d.verifier) {
          holdKey(state.room, state.pendingKey);
          state.pendingKey = null;
        }
        encryptionBanner();
        paintKeyChip();
        paintCommandsPanel();
        refreshComposer();
        if (!currentKey(state.room)) {
          // Rotation, and you were not the one who rotated. Say what that means
          // rather than just re-prompting: the old messages are still yours.
          systemLine('The passphrase for this room was rotated by ' + d.by
            + '. New messages need the new one; anything sent before stays readable.', 'lock');
          openKeyModal();
        }
        return;

      case 'you':
        state.me = d;
        ls(LS.name, d.name);
        el.lobbyMe.textContent = d.name;
        paintMe();
        return;

      case 'system': {
        if (d.event === 'join') systemLine('joined the room', 'join', d.user, d.colour);
        else if (d.event === 'leave') systemLine('left the room' + (d.reason ? ' — ' + d.reason : ''), 'off', d.user, d.colour);
        else if (d.event === 'rename') systemLine('is now ' + d.user, '', d.was, d.colour);
        else if (d.event === 'lock') systemLine('locked this room', 'lock', d.user, d.colour);
        return;
      }

      case 'roster':
        state.roster = d.users || [];
        renderRoster();
        return;

      case 'keys':
        (d.users || []).forEach(function (u) { state.pubs.set(u.name.toLowerCase(), u.pub); });
        return;

      case 'typing':
        state.typing = d.users || [];
        renderTyping();
        renderRoster();
        return;

      case 'chat':
        renderMessage(d, d.enc ? undefined : null);
        if (d.enc) decryptInto(d.id);
        return;

      case 'dm': {
        var out = state.me && d.from === state.me.name;
        var row = {
          id: d.id, ts: d.ts, from: d.from, fromId: 'dm', colour: d.colour, to: d.to,
          text: d.text, mentions: [], reactions: {}, action: false, unsent: false,
          replyTo: null, editedAt: null, dm: true, dmOut: out, enc: d.enc || null
        };
        renderMessage(row, d.enc ? undefined : null);
        if (d.enc && state.myKeyPair) {
          C.unsealWhisper(state.myKeyPair, d.enc, d.from, d.to, out ? 'self' : 'to').then(function (result) {
            var entry = state.msgs.get(row.id);
            if (!entry) return;
            entry.plain = result.ok ? result.payload : result.reason === 'integrity' ? false : null;
            repaint(row.id);
          });
        }
        return;
      }

      case 'edited': {
        var target = state.msgs.get(d.id);
        if (!target) return;
        target.data.text = d.text;
        target.data.mentions = d.mentions || [];
        target.data.editedAt = d.editedAt;
        target.data.enc = d.enc || null;
        target.data.sig = d.sig || null;
        target.data.sigPub = d.sigPub || null;
        target.data.tampered = false; // fresh content from a live edit, not a DB read
        target.sigFailed = false; // re-checked below against the NEW content, not carried over from the old
        if (d.enc) { target.plain = undefined; repaint(d.id); decryptInto(d.id); }
        else repaint(d.id);
        verifySigInto(d.id);
        return;
      }

      case 'unsent': {
        var tomb = state.msgs.get(d.id);
        if (!tomb) return;
        tomb.data.unsent = true;
        tomb.data.text = '';
        tomb.data.enc = null;
        tomb.data.reactions = {};
        delete tomb.data.expiresAt;
        tomb.plain = null;
        repaint(d.id);
        return;
      }

      case 'expired': {
        var gone = state.msgs.get(d.id);
        if (!gone) return;
        gone.node.classList.add('burning');
        setTimeout(function () {
          if (gone.node.parentNode) gone.node.parentNode.removeChild(gone.node);
          state.msgs.delete(d.id);
        }, 480);
        return;
      }

      case 'react': {
        var reacted = state.msgs.get(d.id);
        if (!reacted) return;
        if (d.users && d.users.length) reacted.data.reactions[d.emoji] = d.users;
        else delete reacted.data.reactions[d.emoji];
        repaint(d.id);
        return;
      }

      case 'poll:state':
        upsertPoll(d);
        return;

      case 'ping':
        send('pong', { t: d.t });
        return;

      case 'rtt':
        if (typeof d.rtt === 'number') {
          state.rtt.push(d.rtt);
          if (state.rtt.length > 24) state.rtt.shift();
          el.rtt.textContent = d.rtt + ' ms';
          drawSpark();
        }
        return;

      case 'error':
        return onError(d);
    }
  }

  function onError(d) {
    // A refused history page must clear the in-flight flag, or the scroll
    // listener sees loading:true forever and scrollback dies silently. The
    // retry is offered in the bar rather than fired automatically — an
    // automatic retry against a rate limit is how you earn a longer one.
    if (state.hist && state.hist.loading) {
      state.hist.loading = false;
      state.hist.error = true;
      paintHistoryTop();
    }
    if (d.code === 'UNAUTHORIZED') {
      // The token is worthless. Drop it, close cleanly, show the form. Never retry.
      fetch('/api/auth/sign-out', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
      state.phase = 'idle';
      if (state.ws) { try { state.ws.close(1000); } catch (e) {} }
      state.ws = null;
      screen('join');
      paintJoinCard();
      showError(el.joinError, d.message || 'Sign in again.');
      setJoinStatus('Signed out', 'off');
      return;
    }
    if (d.code === 'NAME_TAKEN' && !state.me) {
      state.phase = 'idle';
      screen('join');
      paintJoinCard();
      return showError(el.joinError, d.message);
    }
    if (!el.lobby.hidden) showError(el.lobbyError, d.message);
    toast(d.message || 'That did not work.', true, d.code);
  }

  function paintMe() {
    if (!state.me) return;
    el.meName.textContent = state.me.name;
    el.meName.style.setProperty('--uc', state.me.colour);
    el.sideFoot.style.setProperty('--uc', state.me.colour);
    el.meAv.textContent = initials(state.me.name);
    el.meAv.style.setProperty('--uc', state.me.colour);
  }

  /* ══ presence ═══════════════════════════════════════════════════════════ */

  document.addEventListener('visibilitychange', function () {
    if (state.phase === 'ready') send('presence', { state: document.hidden ? 'away' : 'active' });
  });

  // Aesthetics & subtle frontend polish (non-invasive)
  ;(function () {
    try {
      var css = `
/* ChatFat - small aesthetic polish injected by client.js */
/* Toasts */
.cf-toast { opacity: 0; transform: translateY(8px); transition: opacity .28s ease, transform .28s ease, box-shadow .28s ease; border-radius: 8px; padding: 10px 12px; margin: 6px 0; display: inline-block; background: var(--bg); box-shadow: 0 6px 18px rgba(12,20,30,0.06); border: 1px solid rgba(0,0,0,0.04); }
.cf-toast.bad { background: linear-gradient(90deg, rgba(255,240,240,0.98), rgba(255,245,245,0.98)); border-color: rgba(220,40,40,0.12); }
.cf-toast .code { margin-left: 10px; opacity: .85; font-weight: 600; }
.cf-toast.cf-toast-show { opacity: 1; transform: none; }

/* Message entry animation */
.cf-msg { transition: transform .32s cubic-bezier(.2,.9,.2,1), opacity .28s ease; }
.cf-msg.incoming { transform: translateY(8px); opacity: 0; }
.cf-msg.incoming.play { transform: none; opacity: 1; }

/* Avatar hover */
.gutter .av, .cf-user .av { transition: box-shadow .26s ease, transform .2s ease; border-radius: 6px; }
.gutter .av:hover, .cf-user .av:hover { transform: translateY(-3px); box-shadow: 0 12px 30px rgba(9,18,30,0.08); }

/* Composer and buttons */
.cf-btn, .cf-ac-row button { transition: transform .12s ease, box-shadow .12s ease; }
.cf-btn:hover { transform: translateY(-1px); }

/* Counter */
#count { transition: color .18s ease, transform .18s ease; }
#count.over { color: var(--danger, #c33); transform: scale(1.03); }

/* Small pill transition */
.cf-pill { transition: background-color .2s ease, color .2s ease, box-shadow .2s ease; }

/* Subtle scrollbar for modern browsers */
.el-log-scroll::-webkit-scrollbar, .cf-log::-webkit-scrollbar { height: 10px; width: 10px; }
.el-log-scroll::-webkit-scrollbar-thumb, .cf-log::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.08); border-radius: 10px; }
`;
      var style = document.createElement('style');
      style.setAttribute('data-chatfat-aesthetic', '1');
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);

      // Animate newly added toasts and message rows
      var logEl = el.log || document.getElementById('log');
      var toastsEl = el.toasts || document.getElementById('toasts');
      if (toastsEl) {
        new MutationObserver(function (records) {
          records.forEach(function (rec) {
            rec.addedNodes && rec.addedNodes.forEach(function (n) {
              if (n.nodeType !== 1) return;
              if (n.classList.contains('cf-toast')) {
                // trigger css transition
                requestAnimationFrame(function () { n.classList.add('cf-toast-show'); });
                // make clickable to dismiss quickly
                n.style.cursor = 'pointer';
              }
            });
          });
        }).observe(toastsEl, { childList: true });

        toastsEl.addEventListener('click', function (ev) {
          var t = ev.target.closest && ev.target.closest('.cf-toast');
          if (t && t.parentNode) t.parentNode.removeChild(t);
        });
      }

      if (logEl) {
        // When a message is inserted, add an incoming class then play the animation
        var msgObserver = new MutationObserver(function (records) {
          records.forEach(function (rec) {
            rec.addedNodes && rec.addedNodes.forEach(function (n) {
              if (n.nodeType !== 1) return;
              if (n.classList && n.classList.contains('cf-msg')) {
                n.classList.add('incoming');
                // play in next frame to allow transition from starting state
                requestAnimationFrame(function () { n.classList.add('play'); });
                // clean up after animation
                setTimeout(function () { n.classList.remove('incoming'); n.classList.remove('play'); }, 800);
              }
              // also animate polls/cards consistently
              if (n.classList && (n.classList.contains('cf-poll') || n.classList.contains('cf-sys'))) {
                n.style.opacity = '0';
                requestAnimationFrame(function () { n.style.transition = 'opacity .32s ease'; n.style.opacity = '1'; });
              }
            });
          });
        });
        msgObserver.observe(logEl, { childList: true });
      }

      // Gentle accessibility tweak: expose remaining chars via aria-live on the count
      try { var ct = el.count; if (ct) ct.setAttribute('aria-live', 'polite'); } catch (e) {}

    } catch (e) { /* never break the main app for the enhancements */ }
  })();

  boot();
})();
