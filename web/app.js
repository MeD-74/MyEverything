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
      controlWarnEl = $('controlWarn'), badgeEl = $('roleBadge');

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

  function startHosting() {
    if (peer) { setStatus('انت متصل أصلاً — دوس مغادرة الأول.', true); return; }
    roomCode = String(Math.floor(100000 + Math.random() * 900000));
    role = 'host';
    setStatus('اختار تبويب AirConsole من نافذة المشاركة، وعلّم على "Share tab audio" عشان صوت اللعبة يوصل.');
    setBadge('مضيف (ويب)', 'live');
    acquireHostStream().then(function () {
      peer = new Peer('ourbeam-' + roomCode, PEER_CONFIG);
      peer.on('open', function () {
        $('hostBox').hidden = false;
        $('roomCode').textContent = roomCode;
        $('btnLeave').hidden = false;
        $('homeHint').hidden = true;
        controlWarnEl.hidden = false;
        setStatus('الغرفة مفتوحة — الكود: ' + roomCode + '. ابعته للطرف التاني، وهو يدخل من جهازه (ديسكتوب أو ويب).');
      });
      peer.on('call', function (call) {
        activeCall = call;
        call.answer(hostStream);
        call.on('close', function () { setStatus('الضيف خرج. الغرفة لسه مفتوحة بالكود ' + roomCode + '.'); activeCall = null; });
        call.on('error', function (e) { setStatus(peerErrorArabic(e), true); });
        startStats(call.peerConnection);
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
      peer.on('error', function (e) { setStatus(peerErrorArabic(e), true); });
    }).catch(function (e) {
      role = null;
      setBadge('مش متصل', '');
      setStatus('فشل تجهيز البث: ' + (e && e.message ? e.message : e), true);
    });
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
      peer.on('open', function () {
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
    role = null; roomCode = null;
    $('viewerWrap').hidden = true;
    $('homeHint').hidden = false;
    $('hostBox').hidden = true;
    $('joinBox').hidden = true;
    $('btnLeave').hidden = true;
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

  $('btnHost').addEventListener('click', startHosting);
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
