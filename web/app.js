// OurBeam — Web version (static only, GitHub Pages ready)
// Same room protocol as the desktop app, so the two are interoperable:
//   - PeerJS public cloud for signalling only (0.peerjs.com:443)
//   - Host Peer ID: `ourbeam-XXXXXX` (random 6-digit code)
//   - Same Google STUN servers, same DataConnection control protocol:
//     {type:'mousemove'|'mousedown'|'mouseup'|'wheel'|'keydown'|'keyup',
//      x:0..1, y:0..1, deltaY, key, button}
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
    setStatus('مكتبة PeerJS مش متحمّلة — اتأكد إن ملف vendor/peerjs.min.js موجود جنب الصفحة.', true);
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
    race: { label: 'سباق — 720p / 60fps', width: 1280, height: 720, frameRate: 60 },
    hd:   { label: 'جودة عالية — 1080p / 30fps', width: 1920, height: 1080, frameRate: 30 },
    cinema: { label: 'سينما — 1080p / 60fps', width: 1920, height: 1080, frameRate: 60 },
    low:  { label: 'نت ضعيف — 480p / 30fps', width: 854, height: 480, frameRate: 30 }
  };

  var peer = null, role = null, roomCode = null;
  var hostStream = null, micStream = null, activeCall = null, dataConn = null;
  var statsTimer = null, lastStats = null;

  function peerErrorArabic(err) {
    var t = (err && err.type) || '';
    if (t === 'peer-unavailable') return 'الغرفة مش موجودة أو المضيف لسه ما فتحش — اتأكد من الكود إن المضيف فاتح البرنامج/الصفحة.';
    if (t === 'network' || t === 'server-error') return 'مش قادر أوصل لسيرفر الإشارة — اتأكد من النت وحاول تاني.';
    return 'حصلت مشكلة في الاتصال: ' + (err && err.message ? err.message : t);
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
    try { if (peer) peer.destroy(); } catch (e) {}
    peer = null; activeCall = null; dataConn = null;
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
          'التأخير: ' + (rttMs === null ? '—' : rttMs + 'ms') +
          ' | السرعة: ' + (bitrateKbps === null ? '—' : bitrateKbps + ' kbps') +
          ' | الصورة: ' + (fps === null ? '—' : fps + ' fps') +
          (dropped === null ? '' : ' | ساقط: ' + dropped);
        warnEl.hidden = !(rttMs !== null && rttMs > 250);
      }).catch(function () { /* stats are best-effort */ });
    }, 2000);
  }

  // Host: share a tab/window/screen with getDisplayMedia. Tab audio comes
  // through only if the user ticks "Share tab audio" in Chrome's picker.
  function acquireHostStream() {
    var q = QUALITY[$('quality').value] || QUALITY.race;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      return Promise.reject(new Error('المتصفح ده مش بيدعم مشاركة الشاشة — استخدم Chrome أو Edge.'));
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
          setStatus('مشاركة الشاشة اتقفلت — دوس "استضيف غرفة" تاني عشان تبث من جديد.', true);
        });
      }
      if ($('micOn').checked) {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (mic) {
          micStream = mic;
          mic.getAudioTracks().forEach(function (t) { hostStream.addTrack(t); });
          return hostStream;
        }).catch(function () {
          setStatus('المايك مش متاح — البث هيكمل من غير صوت مايك.', true);
          return hostStream;
        });
      }
      return hostStream;
    });
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
    $('myRole').textContent = asRole === 'host' ? 'مضيف' : 'ضيف';
  }

  function showHostCode(code) {
    $('hostBox').hidden = false;
    $('roomCode').textContent = code;
    $('btnLeave').hidden = false;
    $('btnLeave2').hidden = false;
    $('sideLeave').hidden = false;
    $('homeHint').hidden = true;
    $('btnRetryHost').hidden = true;
    setGuestState('مستني الضيف يدخل…', false);
    showParty('host');
  }

  function startHosting(keepCode) {
    if (peer) { setStatus('انت متصل أصلاً — دوس مغادرة الأول.', true); return; }
    if (hostStarting) return;
    hostStarting = true;
    roomCode = (keepCode && roomCode) ? roomCode : String(Math.floor(100000 + Math.random() * 900000));
    role = 'host';
    // 1) The code goes on screen RIGHT NOW.
    showHostCode(roomCode);
    setBadge('جاري الاتصال…', 'connecting');
    setStatus('الكود بتاعك: ' + roomCode + ' — جاري الاتصال بسيرفر الغرف… ابعته للطرف التاني من دلوقتي.');
    // 2) Create the peer (cheap) and open the share picker in the same gesture.
    peer = new Peer('ourbeam-' + roomCode, PEER_CONFIG);
    var opened = false;
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(function () {
      if (opened) return;
      hostStarting = false;
      setBadge('مش متصل', '');
      setStatus('سيرفر الغرف مش بيرد — اتأكد من النت ودوس "إعادة المحاولة". الكود لسه: ' + roomCode, true);
      $('btnRetryHost').hidden = false;
    }, 15000);
    peer.on('open', function () {
      opened = true;
      if (openTimer) clearTimeout(openTimer);
      hostStarting = false;
      setBadge('مضيف (ويب)', 'live');
      controlWarnEl.hidden = false;
      saveRecent(roomCode, 'host');
      setStatus('الغرفة مفتوحة — الكود: ' + roomCode + '. ابعته للطرف التاني، وهو يدخل من جهازه (ديسكتوب أو ويب).');
    });
    peer.on('call', function (call) {
      activeCall = call;
      call.answer(hostStream || new MediaStream());
      call.on('close', function () { setStatus('الضيف خرج. الغرفة لسه مفتوحة بالكود ' + roomCode + '.'); setGuestState('مستني الضيف يدخل…', false); activeCall = null; });
      call.on('error', function (e) { setStatus(peerErrorArabic(e), true); });
      startStats(call.peerConnection);
      setGuestState('الضيف متصل — البث شغال', true);
      setStatus('الضيف دخل الغرفة — البث شغال لحظياً. (التحكم من الضيف مش متاح في نسخة الويب كمضيف.)');
    });
    peer.on('connection', function (conn) {
      dataConn = conn;
      conn.on('data', function (ev) {
        // Web host CANNOT inject this into the shared tab — browser sandbox.
        // We acknowledge it and keep the warning visible; never pretend it worked.
        if (ev && ev.type) setStatus('الضيف بيحاول يتحكم، بس نسخة الويب كمضيف مش بتقدر تنفذ التحكم — المشاهدة والصوت شغالين. لو عايز تحكم كامل، المضيف يبقى نسخة الديسكتوب.');
      });
    });
    peer.on('error', function (e) {
      setStatus(peerErrorArabic(e), true);
      if (!opened) { setBadge('مش متصل', ''); $('btnRetryHost').hidden = false; }
    });
    peer.on('disconnected', function () {
      setStatus('الاتصال بسيرفر الغرف اتقطع — بيحاول يرجع…');
      try { peer.reconnect(); } catch (e) {}
    });
    // 3) Screen/tab capture (picker) — runs in parallel with signalling.
    setStatus('اختار تبويب AirConsole من نافذة المشاركة، وعلّم على "Share tab audio" عشان صوت اللعبة يوصل. الكود بتاعك: ' + roomCode);
    acquireHostStream().then(function () {
      setStatus('البث جاهز — الكود: ' + roomCode + '. ابعته للطرف التاني.');
    }).catch(function (e) {
      // Keep the room + code: the peer is alive, only capture failed.
      setStatus('الغرفة مفتوحة بالكود ' + roomCode + ' بس مشاركة الشاشة ما تمتش: ' + (e && e.message ? e.message : e) + ' — دوس "إعادة المحاولة".', true);
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

  function startJoining() {
    var code = $('joinCode').value.trim();
    if (!/^\d{6}$/.test(code)) { setStatus('اكتب كود الغرفة — 6 أرقام.', true); return; }
    if (peer) { setStatus('انت متصل أصلاً — دوس مغادرة الأول.', true); return; }
    role = 'guest';
    roomCode = code;
    setBadge('ضيف', 'guest');
    setStatus('بيتصل بالمضيف...');
    var micPromise = Promise.resolve(null);
    if ($('micOn').checked && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      micPromise = navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(function (m) {
        micStream = m; return m;
      }).catch(function () { setStatus('المايك مش متاح — هتكمل من غير صوت مايك.', true); return null; });
    }
    micPromise.then(function (mic) {
      peer = new Peer(PEER_CONFIG);
      var guestOpened = false;
      var guestTimer = setTimeout(function () {
        if (!guestOpened) setStatus('سيرفر الغرف مش بيرد — اتأكد من النت وحاول تاني.', true);
      }, 15000);
      peer.on('open', function () {
        guestOpened = true;
        clearTimeout(guestTimer);
        var conn = peer.connect('ourbeam-' + code, { reliable: true });
        dataConn = conn;
        conn.on('open', function () { setStatus('متصل بالمضيف — جاري استقبال البث...'); });
        conn.on('error', function (e) { setStatus(peerErrorArabic(e), true); });
        var call = peer.call('ourbeam-' + code, mic || new MediaStream());
        activeCall = call;
        call.on('stream', function (remoteStream) {
          var v = $('remoteVideo');
          v.srcObject = remoteStream;
          v.play().catch(function () {});
          $('viewerWrap').hidden = false;
          $('homeHint').hidden = true;
          $('btnLeave').hidden = false;
          $('btnLeave2').hidden = false;
          $('sideLeave').hidden = false;
          showParty('guest');
          saveRecent(code, 'guest');
          setStatus('البث شغال — دي نفس شاشة المضيف لحظياً. موبايلك هو دراع AirConsole.');
        });
        call.on('close', function () { setStatus('المضيف قفل البث.', true); });
        call.on('error', function (e) { setStatus(peerErrorArabic(e), true); });
        startStats(call.peerConnection);
      });
      peer.on('error', function (e) { setStatus(peerErrorArabic(e), true); });
    });
  }

  function leaveRoom() {
    destroyPeer();
    role = null; roomCode = null; hostStarting = false;
    micMuted = false; updateMicButtons();
    $('viewerWrap').hidden = true;
    $('homeHint').hidden = false;
    $('hostBox').hidden = true;
    $('joinBox').hidden = true;
    $('btnLeave').hidden = true;
    $('btnLeave2').hidden = true;
    $('sideLeave').hidden = true;
    $('party').hidden = true;
    $('btnRetryHost').hidden = true;
    setGuestState('مستني الضيف يدخل…', false);
    controlWarnEl.hidden = true;
    var v = $('remoteVideo'); v.srcObject = null;
    statsEl.textContent = 'التأخير: — | السرعة: — | الصورة: —';
    warnEl.hidden = true;
    setBadge('مش متصل', '');
    setStatus('خرجت من الغرفة. استضيف غرفة أو انضم بكود تاني.');
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
      if (role === 'guest' && document.activeElement !== $('joinCode')) sendInput({ type: 'keydown', key: e.key });
    });
    window.addEventListener('keyup', function (e) {
      if (role === 'guest' && document.activeElement !== $('joinCode')) sendInput({ type: 'keyup', key: e.key });
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
      navigator.clipboard.writeText(code).then(function () { setStatus('الكود اتنسخ: ' + code); })
        .catch(function () { setStatus('الكود: ' + code + ' — انسخه يدوياً.', true); });
    } else { setStatus('الكود: ' + code + ' — انسخه يدوياً.', true); }
  });
  $('btnLeave').addEventListener('click', leaveRoom);
  $('btnLeave2').addEventListener('click', leaveRoom);
  $('sideLeave').addEventListener('click', leaveRoom);
  $('btnOpenBrowser').addEventListener('click', function () { window.open('https://www.airconsole.com', '_blank'); });
  $('btnFullscreen2').addEventListener('click', function () {
    var el = $('viewerWrap').hidden ? document.documentElement : $('viewerWrap');
    if (document.fullscreenElement) { document.exitFullscreen().catch(function () {}); }
    else if (el.requestFullscreen) { el.requestFullscreen().catch(function () {}); }
  });
  $('sideFullscreen').addEventListener('click', function () { $('btnFullscreen2').click(); });
  $('btnCopyCode2').addEventListener('click', function () {
    var code = roomCode || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(function () { setStatus('الكود اتنسخ: ' + code); })
        .catch(function () { setStatus('الكود: ' + code + ' — انسخه يدوياً.', true); });
    } else { setStatus('الكود: ' + code + ' — انسخه يدوياً.', true); }
  });
  $('guestVolume').addEventListener('input', function (e) { $('remoteVideo').volume = e.target.value / 100; });

  // ---------- Mic mute (bottom bar + sidebar) ----------
  var micMuted = false;
  function updateMicButtons() {
    var b = $('btnMicMute'), s = $('sideMic');
    b.classList.toggle('muted', micMuted);
    s.classList.toggle('muted', micMuted);
    b.querySelector('span').textContent = micMuted ? 'المايك مكتوم' : 'المايك شغال';
  }
  function toggleMicMute() {
    micMuted = !micMuted;
    var apply = function (stream) { if (stream) stream.getAudioTracks().forEach(function (t) { t.enabled = !micMuted; }); };
    apply(micStream); apply(hostStream);
    updateMicButtons();
    setStatus(micMuted ? 'المايك مكتوم — الضيف مش هيسمعك.' : 'المايك شغال تاني.');
  }
  $('btnMicMute').addEventListener('click', toggleMicMute);
  $('sideMic').addEventListener('click', toggleMicMute);

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
      var whenText = when.toLocaleDateString('ar-EG') + ' ' + when.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
      row.innerHTML = '<span class="save-code" dir="ltr">' + item.code + '</span>' +
        '<span class="save-meta">' + (item.role === 'host' ? 'استضفتها' : 'انضميت ليها') + ' — ' + whenText + '</span>';
      var btn = document.createElement('button');
      btn.textContent = item.role === 'host' ? 'استضيف تاني' : 'انضم تاني';
      btn.addEventListener('click', function () {
        if (item.role === 'host') { roomCode = item.code; startHosting(true); }
        else { $('joinCode').value = item.code; $('joinBox').hidden = false; startJoining(); }
      });
      row.appendChild(btn);
      box.appendChild(row);
    });
  }
  renderRecent();
  $('quality').addEventListener('change', function () {
    if (role !== 'host' || !hostStream) { setStatus('الجودة اتغيرت — هتتطبق لما تستضيف غرفة.'); return; }
    var q = QUALITY[$('quality').value] || QUALITY.race;
    var vt = hostStream.getVideoTracks()[0];
    if (vt && vt.applyConstraints) {
      vt.applyConstraints({ width: q.width, height: q.height, frameRate: q.frameRate })
        .then(function () { setStatus('الجودة اتغيرت لـ ' + q.label + '.'); })
        .catch(function () { setStatus('المتصفح ما قدرش يطبق الجودة دي على البث الحالي — وقّف المشاركة وابدأ من جديد.', true); });
    }
  });
  $('micOn').addEventListener('change', function () { setStatus('إعداد المايك هيتطبق في الاتصال الجاي.'); });
})();
