// OurBeam — Web version (static only, GitHub Pages ready)
// Same room protocol as the desktop app, so the two are interoperable:
//   - PeerJS public cloud for signalling only (0.peerjs.com:443)
//   - Host Peer ID: `ourbeam-XXXXXX` (random 6-digit code)
//   - Same Google STUN servers, same DataConnection control protocol:
//     {type:'mousemove'|'mousedown'|'mouseup'|'wheel'|'keydown'|'keyup',
//      x:0..1, y:0..1, deltaY, key, button}
//     plus {type:'hello', name} — each side sends its display name on connect.
//   - Same MediaConnection for video+audio stream, same getStats() stats bar.
// Compatibility truth (see README):
//   - Desktop host -> web guest: FULL (watch + remote control works, the
//     desktop app injects input with sendInputEvent).
//   - Web guest -> desktop host: FULL (same as above, guest is just a viewer).
//   - Web host -> any guest: WATCH + VOICE ONLY. A web page cannot inject
//     mouse/keyboard into another tab (browser sandbox), so guest control
//     messages are received but cannot be applied. The UI warns about this.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $('status'), statsEl = $('stats'), warnEl = $('warn'),
      controlWarnEl = $('controlWarn'), badgeEl = $('roleBadge'),
      guestStateEl = $('guestState');
  var hostStarting = false, openTimer = null;

  function setStatus(msg, isError) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('error', !!isError);
  }
  function setBadge(text, cls) { badgeEl.textContent = text; badgeEl.className = 'badge ' + (cls || ''); }

  if (typeof Peer === 'undefined') {
    setStatus('PeerJS library did not load — make sure vendor/peerjs.min.js is next to this page.', true);
    return;
  }

  var PEER_CONFIG = {
    host: '0.peerjs.com', port: 443, secure: true, path: '/',
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      sdpSemantics: 'unified-plan'
    }
  };

  var QUALITY = {
    race: { label: 'Race — 720p / 60fps', width: 1280, height: 720, frameRate: 60 },
    hd:   { label: 'High quality — 1080p / 30fps', width: 1920, height: 1080, frameRate: 30 },
    cinema: { label: 'Cinema — 1080p / 60fps', width: 1920, height: 1080, frameRate: 60 },
    low:  { label: 'Weak connection — 480p / 30fps', width: 854, height: 480, frameRate: 30 }
  };

  var peer = null, role = null, roomCode = null;
  var hostStream = null, micStream = null, activeCall = null, dataConn = null;
  // The host-initiated media call that carries the screen video to the guest.
  // (The guest's own outbound call is audio-only: its offer has no video
  // m-line, so no video can ever flow back on it — see ensureGuestCall.)
  var videoCall = null;
  var statsTimer = null, lastStats = null;

  // ---------- Names: each side sets its display name; it is exchanged with
  // the peer over the data connection so the party panel shows real names. ----------
  var NAME_KEY = 'ourbeam-name';
  var myName = '', peerName = '', peerOnline = false;
  try { myName = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}
  $('myName').value = myName;
  function displayName(name, fallback) { var n = (name || '').trim(); return n || fallback; }
  function renderParty() {
    var hostName = role === 'host' ? displayName(myName, 'Host') : displayName(peerName, 'Host');
    $('roomTitle').textContent = hostName + "'s Room";
    $('onlineCount').textContent = '● ' + (peerOnline ? 2 : 1) + ' online';
    $('memberMeName').textContent = displayName(myName, 'You') + ' (you)';
    $('myRole').textContent = role === 'host' ? 'Host' : 'Guest';
    $('memberPeerName').textContent = peerOnline ? displayName(peerName, 'Guest') : 'Guest';
  }
  function setPeerName(name) { peerName = name || ''; peerOnline = true; renderParty(); }
  function clearPeer() { peerName = ''; peerOnline = false; renderParty(); }
  function sendHello() {
    if (dataConn && dataConn.open) { try { dataConn.send({ type: 'hello', name: myName }); } catch (e) {} }
  }
  $('myName').addEventListener('input', function (e) {
    myName = e.target.value;
    try { localStorage.setItem(NAME_KEY, myName); } catch (err) {}
    renderParty();
    sendHello();
  });

  function peerErrorEnglish(err) {
    var t = (err && err.type) || '';
    if (t === 'peer-unavailable') return 'Room not found or the host has not opened it yet — check the code and make sure the host has the app/page open.';
    if (t === 'network' || t === 'server-error') return 'Cannot reach the room server — check your internet and try again.';
    return 'Connection problem: ' + (err && err.message ? err.message : t);
  }

  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
  }
  function destroyPeer() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    if (openTimer) clearTimeout(openTimer);
    openTimer = null;
    try { if (dataConn) dataConn.close(); } catch (e) {}
    try { if (activeCall) activeCall.close(); } catch (e) {}
    try { if (videoCall) videoCall.close(); } catch (e) {}
    try { if (peer) peer.destroy(); } catch (e) {}
    peer = null; activeCall = null; dataConn = null; videoCall = null;
    stopTracks(hostStream); stopTracks(micStream);
    hostStream = null; micStream = null;
  }

  // Real stats from getStats(), every 2s — same as desktop, nothing invented.
  function startStats(pc) {
    if (statsTimer) clearInterval(statsTimer);
    lastStats = null;
    statsTimer = setInterval(function () {
      if (!pc) return;
      pc.getStats().then(function (report) {
        var rttMs = null, bitrateKbps = null, fps = null, dropped = null;
        var now = Date.now();
        report.forEach(function (r) {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') {
            rttMs = Math.round(r.currentRoundTripTime * 1000);
          }
          if (r.type === 'outbound-rtp' && r.kind === 'video') {
            if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond);
            if (typeof r.framesDropped === 'number') dropped = r.framesDropped;
            if (lastStats && typeof r.bytesSent === 'number') {
              var dt = (now - lastStats.time) / 1000;
              if (dt > 0) bitrateKbps = Math.round(((r.bytesSent - lastStats.bytesSent) * 8) / 1000 / dt);
            }
            lastStats = { time: now, bytesSent: r.bytesSent || 0 };
          }
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond);
            if (typeof r.framesDropped === 'number') dropped = r.framesDropped;
            if (lastStats && typeof r.bytesReceived === 'number') {
              var dt = (now - lastStats.time) / 1000;
              if (dt > 0) bitrateKbps = Math.round(((r.bytesReceived - lastStats.bytesReceived) * 8) / 1000 / dt);
            }
            lastStats = { time: now, bytesReceived: r.bytesReceived || 0 };
          }
        });
        statsEl.textContent =
          'Delay: ' + (rttMs === null ? '—' : rttMs + 'ms') +
          ' | Speed: ' + (bitrateKbps === null ? '—' : bitrateKbps + ' kbps') +
          ' | FPS: ' + (fps === null ? '—' : fps + ' fps') +
          (dropped === null ? '' : ' | Dropped: ' + dropped);
        warnEl.hidden = !(rttMs !== null && rttMs > 250);
      }).catch(function () { /* stats are best-effort */ });
    }, 2000);
  }

  // Host: share a tab/window/screen with getDisplayMedia. Tab audio comes
  // through only if the user ticks "Share tab audio" in Chrome's picker.
  function acquireHostStream() {
    var q = QUALITY[$('quality').value] || QUALITY.race;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('This browser does not support screen sharing — use Chrome or Edge.'));
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } },
      audio: true
    }).then(function (stream) {
      hostStream = stream;
      var vt = stream.getVideoTracks()[0];
      if (vt) {
        try { vt.contentHint = 'motion'; } catch (e) {}
        // Best-effort: ask for the chosen quality on the captured track.
        if (vt.applyConstraints) {
          vt.applyConstraints({ width: q.width, height: q.height, frameRate: q.frameRate }).catch(function () {});
        }
        vt.addEventListener('ended', function () {
          setStatus('Screen sharing stopped — click "Host Room" again to stream again.', true);
        });
      }
      if ($('micOn').checked) {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (mic) {
          micStream = mic;
          mic.getAudioTracks().forEach(function (t) { hostStream.addTrack(t); });
          return hostStream;
        }).catch(function () {
          setStatus('Mic not available — streaming without mic audio.', true);
          return hostStream;
        });
      }
      return hostStream;
    });
  }

  // The screen video can ONLY travel on a call the HOST places: the guest's
  // outbound call offers no video m-line (it carries mic audio at most), so
  // answering it can never send video back — SDP answers can't add media
  // sections the offer didn't have. The guest therefore gets the screen on
  // this host-initiated call, and accepts it via its peer.on('call') handler.
  function bindHostCall(call) {
    call.on('close', function () { setStatus('Guest left. The room is still open with code ' + roomCode + '.'); setGuestState('Waiting for guest…', false); clearPeer(); if (activeCall === call) activeCall = null; if (videoCall === call) videoCall = null; });
    call.on('error', function (e) { setStatus(peerErrorEnglish(e), true); });
    startStats(call.peerConnection);
    setGuestState('Guest connected — streaming live', true);
    setStatus('Guest joined the room — streaming live. (Guest control is not available with a web host.)');
  }
  function hostHasLiveVideo() {
    try {
      var pc = videoCall && videoCall.peerConnection;
      return !!(pc && pc.getSenders().some(function (s) { return s.track && s.track.kind === 'video' && s.track.readyState === 'live'; }));
    } catch (e) { return false; }
  }
  // (Re)place the host-initiated video call to the guest once the screen
  // stream exists and the guest is reachable. Called when the stream becomes
  // ready, when the guest's mic call arrives, and when the data connection
  // opens — whichever comes last wins.
  function ensureGuestCall() {
    if (role !== 'host' || !hostStream || !peer) return;
    if (videoCall && hostHasLiveVideo()) return;
    var guestId = (videoCall && videoCall.peer) || (activeCall && activeCall.peer) || (dataConn && dataConn.peer);
    if (!guestId) return;
    try { if (videoCall) videoCall.close(); } catch (e) {}
    videoCall = null;
    try {
      var call = peer.call(guestId, hostStream);
      videoCall = call;
      activeCall = call;
      bindHostCall(call);
    } catch (e) {}
  }

  // The room code is shown IMMEDIATELY when hosting starts — it must never
  // depend on the network (PeerJS signalling) or on the share picker.
  // getDisplayMedia stays in this click handler (it needs the user gesture),
  // but the code is already on screen before the picker even opens.
  function setGuestState(text, online) {
    guestStateEl.textContent = text;
    var g2 = $('guestState2'), dot = $('guestDot');
    if (g2) g2.textContent = text;
    if (dot) dot.classList.toggle('online', !!online);
  }

  function showParty(asRole) {
    $('party').hidden = false;
    $('partyCode').textContent = roomCode || '------';
    renderParty();
  }

  function showHostCode(code) {
    $('hostBox').hidden = false;
    $('roomCode').textContent = code;
    $('btnLeave').hidden = false;
    $('btnLeave2').hidden = false;
    $('homeHint').hidden = true;
    $('btnRetryHost').hidden = true;
    setGuestState('Waiting for guest…', false);
    showParty('host');
  }

  function startHosting(keepCode) {
    if (peer) { setStatus('You are already connected — leave the room first.', true); return; }
    if (hostStarting) return;
    hostStarting = true;
    roomCode = (keepCode && roomCode) ? roomCode : String(Math.floor(100000 + Math.random() * 900000));
    role = 'host';
    // 1) The code goes on screen RIGHT NOW.
    showHostCode(roomCode);
    setBadge('Connecting…', 'connecting');
    setStatus('Your code: ' + roomCode + ' — connecting to the room server… send it to the other person now.');
    // 2) Create the peer (cheap) and open the share picker in the same gesture.
    peer = new Peer('ourbeam-' + roomCode, PEER_CONFIG);
    var opened = false;
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(function () {
      if (opened) return;
      hostStarting = false;
      setBadge('Not connected', '');
      setStatus('Room server is not responding — check your internet and click "Retry". Your code is still: ' + roomCode, true);
      $('btnRetryHost').hidden = false;
    }, 15000);
    peer.on('open', function () {
      opened = true;
      if (openTimer) clearTimeout(openTimer);
      hostStarting = false;
      setBadge('Host (web)', 'live');
      controlWarnEl.hidden = false;
      saveRecent(roomCode, 'host');
      setStatus('Room is open — code: ' + roomCode + '. Send it to the other person, they can join from their device (desktop or web).');
    });
    peer.on('call', function (call) {
      activeCall = call;
      // This is the guest's mic call (audio only). Answer at once — the
      // screen video goes out on the host-initiated call (ensureGuestCall),
      // because this call's offer has no video m-line to answer with.
      call.answer(hostStream || micStream || new MediaStream());
      bindHostCall(call);
      ensureGuestCall();
    });
    peer.on('connection', function (conn) {
      dataConn = conn;
      conn.on('data', function (ev) {
        if (!ev || !ev.type) return;
        if (ev.type === 'hello') { setPeerName(ev.name); setGuestState(displayName(ev.name, 'Guest') + ' is connected', true); return; }
        // Web host CANNOT inject this into the shared tab — browser sandbox.
        // We acknowledge it and keep the warning visible; never pretend it worked.
        setStatus('The guest is trying to control, but the web host cannot apply control — watching and voice still work. For full control, the host should use the desktop app.');
      });
      conn.on('open', function () { sendHello(); ensureGuestCall(); });
    });
    peer.on('error', function (e) {
      setStatus(peerErrorEnglish(e), true);
      if (!opened) { setBadge('Not connected', ''); $('btnRetryHost').hidden = false; }
    });
    peer.on('disconnected', function () {
      setStatus('Connection to the room server dropped — reconnecting…');
      try { peer.reconnect(); } catch (e) {}
    });
    // 3) Screen/tab capture (picker) — runs in parallel with signalling.
    setStatus('Pick the AirConsole tab in the share window, and tick "Share tab audio" so the game sound comes through. Your code: ' + roomCode);
    acquireHostStream().then(function () {
      setStatus('Stream is ready — code: ' + roomCode + '. Send it to the other person.');
      ensureGuestCall();
    }).catch(function (e) {
      // Keep the room + code: the peer is alive, only capture failed.
      setStatus('Room is open with code ' + roomCode + ' but screen sharing did not start: ' + (e && e.message ? e.message : e) + ' — click "Retry".', true);
      $('btnRetryHost').hidden = false;
    });
  }

  function retryHosting() {
    $('btnRetryHost').hidden = true;
    destroyPeer();
    hostStarting = false;
    role = null;
    startHosting(true); // same code, shown again immediately
  }

  // One handler for any incoming media call — the outbound call to the host
  // and host-initiated (re-)calls after the stream becomes ready.
  function attachGuestStream(call) {
    call.on('stream', function (remoteStream) {
      var v = $('remoteVideo');
      v.srcObject = remoteStream;
      v.play().catch(function () {});
      // The guest's own outbound call carries audio only (mic) — the screen
      // video arrives on the host's call. Only open the viewer for video.
      if (!remoteStream.getVideoTracks().length) return;
      $('viewerWrap').hidden = false;
      $('homeHint').hidden = true;
      $('btnLeave').hidden = false;
      $('btnLeave2').hidden = false;
      showParty('guest');
      saveRecent(roomCode, 'guest');
      setStatus('Stream is live — this is the host\'s screen in real time. Your phone is the AirConsole controller.');
    });
    call.on('close', function () { setStatus('The host closed the stream.', true); });
    call.on('error', function (e) { setStatus(peerErrorEnglish(e), true); });
    startStats(call.peerConnection);
  }

  function startJoining() {
    var code = $('joinCode').value.trim();
    if (!/^\d{6}$/.test(code)) { setStatus('Type the room code — 6 digits.', true); return; }
    if (peer) { setStatus('You are already connected — leave the room first.', true); return; }
    role = 'guest';
    roomCode = code;
    setBadge('Guest', 'guest');
    setStatus('Connecting to the host...');
    var micPromise = Promise.resolve(null);
    if ($('micOn').checked && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      micPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (m) {
        micStream = m; return m;
      }).catch(function () { setStatus('Mic not available — continuing without mic audio.', true); return null; });
    }
    micPromise.then(function (mic) {
      peer = new Peer(PEER_CONFIG);
      var guestOpened = false;
      var guestTimer = setTimeout(function () {
        if (!guestOpened) setStatus('Room server is not responding — check your internet and try again.', true);
      }, 15000);
      peer.on('open', function () {
        guestOpened = true;
        clearTimeout(guestTimer);
        var conn = peer.connect('ourbeam-' + code, { reliable: true });
        dataConn = conn;
        conn.on('open', function () { sendHello(); setStatus('Connected to the host — receiving the stream...'); });
        conn.on('data', function (ev) {
          if (ev && ev.type === 'hello') { setPeerName(ev.name); setGuestState(displayName(ev.name, 'Host') + ' is streaming', true); }
        });
        conn.on('error', function (e) { setStatus(peerErrorEnglish(e), true); });
        var call = peer.call('ourbeam-' + code, mic || new MediaStream());
        activeCall = call;
        attachGuestStream(call);
      });
      // The host may call the guest (again) once its screen stream is ready.
      peer.on('call', function (incoming) {
        incoming.answer(micStream || mic || new MediaStream());
        activeCall = incoming;
        attachGuestStream(incoming);
      });
      peer.on('error', function (e) { setStatus(peerErrorEnglish(e), true); });
    });
  }

  function leaveRoom() {
    destroyPeer();
    role = null; roomCode = null; hostStarting = false;
    clearPeer();
    micMuted = false; updateMicButtons();
    $('viewerWrap').hidden = true;
    $('homeHint').hidden = false;
    $('hostBox').hidden = true;
    $('joinBox').hidden = true;
    $('btnLeave').hidden = true;
    $('btnLeave2').hidden = true;
    $('party').hidden = true;
    $('btnRetryHost').hidden = true;
    setGuestState('Waiting for guest…', false);
    controlWarnEl.hidden = true;
    var v = $('remoteVideo'); v.srcObject = null;
    statsEl.textContent = 'Delay: — | Speed: — | FPS: —';
    warnEl.hidden = true;
    setBadge('Not connected', '');
    setStatus('You left the room. Host a room or join with another code.');
  }

  // Guest input: same relative-coords protocol as desktop.
  function relPos(e) {
    var r = $('remoteVideo').getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
    };
  }
  function sendInput(ev) {
    if (role !== 'guest' || !dataConn || !dataConn.open) return;
    try { dataConn.send(ev); } catch (e) {}
  }
  (function bindViewerInput() {
    var v = $('remoteVideo');
    v.addEventListener('mousemove', function (e) { var p = relPos(e); sendInput({ type: 'mousemove', x: p.x, y: p.y }); });
    v.addEventListener('mousedown', function (e) { var p = relPos(e); sendInput({ type: 'mousedown', button: 'left', x: p.x, y: p.y }); });
    v.addEventListener('mouseup', function (e) { var p = relPos(e); sendInput({ type: 'mouseup', button: 'left', x: p.x, y: p.y }); });
    v.addEventListener('wheel', function (e) { e.preventDefault(); var p = relPos(e); sendInput({ type: 'wheel', deltaY: e.deltaY, x: p.x, y: p.y }); }, { passive: false });
    v.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', function (e) {
      if (role === 'guest' && document.activeElement !== $('joinCode') && document.activeElement !== $('myName')) sendInput({ type: 'keydown', key: e.key });
    });
    window.addEventListener('keyup', function (e) {
      if (role === 'guest' && document.activeElement !== $('joinCode') && document.activeElement !== $('myName')) sendInput({ type: 'keyup', key: e.key });
    });
  })();

  $('btnHost').addEventListener('click', function () { startHosting(); });
  $('btnHostHome').addEventListener('click', function () { startHosting(); });
  $('btnJoinHome').addEventListener('click', function () { $('joinBox').hidden = false; $('joinCode').focus(); });
  $('btnRetryHost').addEventListener('click', retryHosting);
  $('btnJoinShow').addEventListener('click', function () { $('joinBox').hidden = false; $('joinCode').focus(); });
  $('btnJoinCancel').addEventListener('click', function () { $('joinBox').hidden = true; });
  $('btnJoin').addEventListener('click', startJoining);
  $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') startJoining(); });
  $('btnCopyCode').addEventListener('click', function () {
    var code = roomCode || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { setStatus('Code copied: ' + code); })
        .catch(function () { setStatus('Code: ' + code + ' — copy it manually.', true); });
    } else { setStatus('Code: ' + code + ' — copy it manually.', true); }
  });
  $('btnLeave').addEventListener('click', leaveRoom);
  $('btnLeave2').addEventListener('click', leaveRoom);
  $('btnOpenBrowser').addEventListener('click', function () { window.open('https://www.airconsole.com', '_blank'); });
  $('btnFullscreen2').addEventListener('click', function () {
    var el = $('viewerWrap').hidden ? document.documentElement : $('viewerWrap');
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    else if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
  });
  $('btnCopyCode2').addEventListener('click', function () {
    var code = roomCode || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { setStatus('Code copied: ' + code); })
        .catch(function () { setStatus('Code: ' + code + ' — copy it manually.', true); });
    } else { setStatus('Code: ' + code + ' — copy it manually.', true); }
  });
  $('guestVolume').addEventListener('input', function (e) { $('remoteVideo').volume = e.target.value / 100; });

  // ---------- Mic mute (bottom bar) ----------
  var micMuted = false;
  function updateMicButtons() {
    var b = $('btnMicMute');
    b.classList.toggle('muted', micMuted);
    b.querySelector('span').textContent = micMuted ? 'Mic muted' : 'Mic on';
  }
  function toggleMicMute() {
    micMuted = !micMuted;
    var apply = function (stream) { if (stream) stream.getAudioTracks().forEach(function (t) { t.enabled = !micMuted; }); };
    apply(micStream); apply(hostStream);
    updateMicButtons();
    setStatus(micMuted ? 'Mic muted — the guest cannot hear you.' : 'Mic is on again.');
  }
  $('btnMicMute').addEventListener('click', toggleMicMute);

  // ---------- LOAD SAVE: recent rooms (localStorage) ----------
  var RECENT_KEY = 'ourbeam-recent';
  function loadRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveRecent(code, r) {
    if (!code) return;
    var list = loadRecent().filter(function (x) { return x.code !== code; });
    list.unshift({ code: code, role: r, ts: Date.now() });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch (e) {}
    renderRecent();
  }
  function renderRecent() {
    var list = loadRecent();
    var box = $('recentList');
    box.innerHTML = '';
    $('noRecent').hidden = list.length > 0;
    list.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'save-row';
      var when = new Date(item.ts);
      var whenText = when.toLocaleDateString('en-GB') + ' ' + when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      row.innerHTML = '<span class="save-code" dir="ltr">' + item.code + '</span>' +
        '<span class="save-meta">' + (item.role === 'host' ? 'Hosted' : 'Joined') + ' — ' + whenText + '</span>';
      var btn = document.createElement('button');
      btn.textContent = item.role === 'host' ? 'Host again' : 'Join again';
      btn.addEventListener('click', function () {
        if (item.role === 'host') { roomCode = item.code; startHosting(true); }
        else { $('joinCode').value = item.code; $('joinBox').hidden = false; startJoining(); }
      });
      row.appendChild(btn);
      box.appendChild(row);
    });
  }
  renderRecent();
  renderParty();
  $('quality').addEventListener('change', function () {
    if (role !== 'host' || !hostStream) { setStatus('Quality changed — it will apply when you host a room.'); return; }
    var q = QUALITY[$('quality').value] || QUALITY.race;
    var vt = hostStream.getVideoTracks()[0];
    if (vt && vt.applyConstraints) {
      vt.applyConstraints({ width: q.width, height: q.height, frameRate: q.frameRate })
        .then(function () { setStatus('Quality changed to ' + q.label + '.'); })
        .catch(function () { setStatus('The browser could not apply this quality to the current stream — stop sharing and start again.', true); });
    }
  });
  $('micOn').addEventListener('change', function () { setStatus('Mic setting will apply on the next connection.'); });
})();
