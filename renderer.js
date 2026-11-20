// MyEverything — Renderer: UI + PeerJS signalling + host capture + guest viewer
// Networking: PeerJS public cloud is used for SIGNALLING ONLY. The video/audio
// stream itself is peer-to-peer WebRTC (direct when possible). No TURN server
// is configured (no free credentials) — if both sides are behind strict NAT,
// P2P may fail; see README troubleshooting.
// Latency honesty: stats below are real values from RTCPeerConnection.getStats().
// Nothing here invents a latency number.
const { ipcRenderer, desktopCapturer } = require('electron');
const { Peer } = require('peerjs');

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), statsEl = $('stats'), warnEl = $('warn'), badgeEl = $('roleBadge');

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', !!isError);
}
function setBadge(text, cls) { badgeEl.textContent = text; badgeEl.className = 'badge ' + (cls || ''); }

const PEER_CONFIG = {
  host: '0.peerjs.com', port: 443, secure: true, path: '/',
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    sdpSemantics: 'unified-plan',
  },
};

const QUALITY = {
  race: { label: 'سباق — 720p / 60fps', width: 1280, height: 720, frameRate: 60 },
  hd:   { label: 'جودة عالية — 1080p / 30fps', width: 1920, height: 1080, frameRate: 30 },
  low:  { label: 'نت ضعيف — 480p / 30fps', width: 854, height: 480, frameRate: 30 },
};

let peer = null, role = null, roomCode = null;
let hostStream = null, micStream = null, activeCall = null, dataConn = null;
let statsTimer = null, lastStats = null;
let fullscreenOn = false;

function peerErrorArabic(err) {
  const t = (err && err.type) || '';
  if (t === 'peer-unavailable') return 'الغرفة مش موجودة أو المضيف لسه ما فتحش — اتأكد من الكود إن المضيف فاتح البرنامج.';
  if (t === 'network' || t === 'server-error') return 'مش قادر أوصل لسيرفر الإشارة — اتأكد من النت وحاول تاني.';
  if (t === 'browser-incompatible') return 'المتصفح الداخلي مش بيدعم WebRTC.';
  return 'حصلت مشكلة في الاتصال: ' + (err && err.message ? err.message : t);
}

function destroyPeer() {
  try { if (statsTimer) clearInterval(statsTimer); } catch (e) {}
  statsTimer = null;
  try { if (dataConn) dataConn.close(); } catch (e) {}
  try { if (activeCall) activeCall.close(); } catch (e) {}
  try { if (peer) peer.destroy(); } catch (e) {}
  peer = null; activeCall = null; dataConn = null;
  [hostStream, micStream].forEach((s) => { if (s) s.getTracks().forEach((t) => t.stop()); });
  hostStream = null; micStream = null;
}

// ---------- Stats: real RTT / bitrate / FPS from getStats(), every 2s ----------
function startStats(pc) {
  if (statsTimer) clearInterval(statsTimer);
  lastStats = null;
  statsTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const report = await pc.getStats();
      let rttMs = null, bitrateKbps = null, fps = null, dropped = null;
      let now = Date.now();
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') {
          rttMs = Math.round(r.currentRoundTripTime * 1000);
        }
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond);
          if (typeof r.framesDropped === 'number') dropped = r.framesDropped;
          if (lastStats && typeof r.bytesSent === 'number') {
            const dt = (now - lastStats.time) / 1000;
            if (dt > 0) bitrateKbps = Math.round(((r.bytesSent - lastStats.bytesSent) * 8) / 1000 / dt);
          }
          lastStats = { time: now, bytesSent: r.bytesSent || 0 };
        }
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond);
          if (typeof r.framesDropped === 'number') dropped = r.framesDropped;
          if (lastStats && typeof r.bytesReceived === 'number') {
            const dt = (now - lastStats.time) / 1000;
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
      const bad = rttMs !== null && rttMs > 250;
      warnEl.hidden = !bad;
    } catch (e) { /* stats are best-effort; stream keeps running */ }
  }, 2000);
}

// ---------- Host capture: the MyEverything window (game) + system audio ----------
async function acquireHostStream() {
  const q = QUALITY[$('quality').value] || QUALITY.race;
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
  const self = sources.find((s) => /MyEverything/i.test(s.name)) || sources.find((s) => s.name.toLowerCase().includes('screen')) || sources[0];
  if (!self) throw new Error('مفيش مصدر شاشة متاح للبث.');
  // Try video + system-audio loopback first; fall back to video-only.
  try {
    hostStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'desktop' } },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: self.id,
          minWidth: q.width, maxWidth: q.width,
          minHeight: q.height, maxHeight: q.height,
          minFrameRate: q.frameRate, maxFrameRate: q.frameRate,
        },
      },
    });
  } catch (e) {
    hostStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: self.id,
          minWidth: q.width, maxWidth: q.width,
          minHeight: q.height, maxHeight: q.height,
          minFrameRate: q.frameRate, maxFrameRate: q.frameRate,
        },
      },
    });
  }
  // Mic as an extra audio track (voice chat) when enabled.
  if ($('micOn').checked) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream.getAudioTracks().forEach((t) => hostStream.addTrack(t));
    } catch (e) { setStatus('المايك مش متاح — البث هيكمل من غير صوت مايك.', true); }
  }
  // Low-latency hint: keep the video track at the requested frame rate.
  hostStream.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch (e) {} });
  return hostStream;
}

async function replaceHostVideoTrack() {
  if (!activeCall || !activeCall.peerConnection) return;
  const sender = activeCall.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
  const track = hostStream && hostStream.getVideoTracks()[0];
  if (sender && track) { try { await sender.replaceTrack(track); } catch (e) {} }
}

// ---------- HOST ----------
async function startHosting() {
  if (peer) { setStatus('انت متصل أصلاً — دوس مغادرة الأول.', true); return; }
  roomCode = String(Math.floor(100000 + Math.random() * 900000));
  role = 'host';
  setStatus('بيجهز البث... افتح AirConsole واختار لعبة، والولي تدخل بالكود.');
  setBadge('مضيف', 'live');
  try {
    await acquireHostStream();
  } catch (e) {
    setStatus('فشل تجهيز البث: ' + (e.message || e), true);
    setBadge('مش متصل', '');
    role = null;
    return;
  }
  peer = new Peer('myeverything-' + roomCode, PEER_CONFIG);
  peer.on('open', () => {
    $('hostBox').hidden = false;
    $('roomCode').textContent = roomCode;
    $('btnLeave').hidden = false;
    $('homeHint').hidden = true;
    setStatus('الغرفة مفتوحة — الكود: ' + roomCode + '. ابعته للولي، وهي تدخل من جهازها.');
  });
  peer.on('call', (call) => {
    activeCall = call;
    call.answer(hostStream);
    call.on('stream', () => {}); // host does not need the guest stream for video; mic audio (if any) plays via the call
    call.on('close', () => { setStatus('الضيف خرج. الغرفة لسه مفتوحة بالكود ' + roomCode + '.'); activeCall = null; });
    call.on('error', (e) => setStatus(peerErrorArabic(e), true));
    startStats(call.peerConnection);
    setStatus('الولي دخلت الغرفة — البث شغال لحظياً.');
  });
  peer.on('connection', (conn) => {
    dataConn = conn;
    conn.on('data', (ev) => {
      // Guest remote input: forward to the BrowserView in the main process.
      if (ev && ev.type) ipcRenderer.send('remote-input', ev);
    });
    conn.on('open', () => setStatus('الضيف متصل وبيتحكم — لو عايز تمنع التحكم شيل علامة السماح.'));
  });
  peer.on('error', (e) => setStatus(peerErrorArabic(e), true));
}

// ---------- GUEST ----------
async function startJoining() {
  const code = $('joinCode').value.trim();
  if (!/^\d{6}$/.test(code)) { setStatus('اكتب كود الغرفة — 6 أرقام.', true); return; }
  if (peer) { setStatus('انت متصل أصلاً — دوس مغادرة الأول.', true); return; }
  role = 'guest';
  roomCode = code;
  setBadge('ضيف', 'guest');
  setStatus('بيتصل بالمضيف...');
  let mic = null;
  if ($('micOn').checked) {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); micStream = mic; }
    catch (e) { setStatus('المايك مش متاح — هتكمل من غير صوت مايك.', true); }
  }
  peer = new Peer(PEER_CONFIG);
  peer.on('open', () => {
    const conn = peer.connect('myeverything-' + code, { reliable: true });
    dataConn = conn;
    conn.on('open', () => setStatus('متصل بالمضيف — جاري استقبال البث...'));
    conn.on('error', (e) => setStatus(peerErrorArabic(e), true));
    const call = peer.call('myeverything-' + code, mic || new MediaStream());
    activeCall = call;
    call.on('stream', (remoteStream) => {
      const v = $('remoteVideo');
      v.srcObject = remoteStream;
      v.play().catch(() => {});
      $('viewerWrap').hidden = false;
      $('homeHint').hidden = true;
      $('btnLeave').hidden = false;
      setStatus('البث شغال — دي نفس شاشة المضيف لحظياً. موبايلك هو دراع AirConsole.');
    });
    call.on('close', () => { setStatus('المضيف قفل البث.', true); });
    call.on('error', (e) => setStatus(peerErrorArabic(e), true));
    startStats(call.peerConnection);
  });
  peer.on('error', (e) => setStatus(peerErrorArabic(e), true));
}

function leaveRoom() {
  destroyPeer();
  role = null; roomCode = null;
  $('viewerWrap').hidden = true;
  $('homeHint').hidden = false;
  $('hostBox').hidden = true;
  $('joinBox').hidden = true;
  $('btnLeave').hidden = true;
  const v = $('remoteVideo'); v.srcObject = null;
  statsEl.textContent = 'التأخير: — | السرعة: — | الصورة: —';
  warnEl.hidden = true;
  setBadge('مش متصل', '');
  setStatus('خرجت من الغرفة. استضيف غرفة أو انضم بكود تاني.');
}

// ---------- Viewer input: relative coords so any window size works ----------
function relPos(e) {
  const r = $('remoteVideo').getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}
function sendInput(ev) {
  if (role !== 'guest' || !dataConn || !dataConn.open) return;
  try { dataConn.send(ev); } catch (e) {}
}
(function bindViewerInput() {
  const v = $('remoteVideo');
  v.addEventListener('mousemove', (e) => sendInput({ type: 'mousemove', ...relPos(e) }));
  v.addEventListener('mousedown', (e) => sendInput({ type: 'mousedown', button: 'left', ...relPos(e) }));
  v.addEventListener('mouseup', (e) => sendInput({ type: 'mouseup', button: 'left', ...relPos(e) }));
  v.addEventListener('wheel', (e) => { e.preventDefault(); sendInput({ type: 'wheel', deltaY: e.deltaY, ...relPos(e) }); }, { passive: false });
  v.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fullscreenOn) { $('btnFullscreen').click(); return; }
    if (role === 'guest' && document.activeElement !== $('joinCode')) sendInput({ type: 'keydown', key: e.key });
  });
  window.addEventListener('keyup', (e) => { if (role === 'guest' && document.activeElement !== $('joinCode')) sendInput({ type: 'keyup', key: e.key }); });
})();

// ---------- Toolbar / navigation ----------
$('btnGo').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'go', $('address').value.trim());
  if (r && r.url) $('address').value = r.url;
});
$('address').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const r = await ipcRenderer.invoke('nav', 'go', $('address').value.trim());
    if (r && r.url) $('address').value = r.url;
  }
});
$('btnBack').addEventListener('click', () => ipcRenderer.invoke('nav', 'back'));
$('btnForward').addEventListener('click', () => ipcRenderer.invoke('nav', 'forward'));
$('btnReload').addEventListener('click', () => ipcRenderer.invoke('nav', 'reload'));
$('btnAirconsole').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'airconsole');
  $('address').value = 'https://www.airconsole.com';
  if (r && r.url) $('address').value = r.url;
});

$('btnHost').addEventListener('click', startHosting);
$('btnJoinShow').addEventListener('click', () => { $('joinBox').hidden = false; $('joinCode').focus(); });
$('btnJoinCancel').addEventListener('click', () => { $('joinBox').hidden = true; });
$('btnJoin').addEventListener('click', startJoining);
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') startJoining(); });
$('btnCopyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomCode || ''); setStatus('الكود اتنسخ: ' + roomCode); }
  catch (e) { setStatus('الكود: ' + roomCode + ' — انسخه يدوياً.', true); }
});
$('btnLeave').addEventListener('click', leaveRoom);

$('btnFullscreen').addEventListener('click', async () => {
  fullscreenOn = !fullscreenOn;
  await ipcRenderer.invoke('set-fullscreen-game', fullscreenOn);
  $('btnFullscreen').textContent = fullscreenOn ? 'ارجع للواجهة' : 'ملء الشاشة للعبة';
  $('toolbar').style.display = fullscreenOn ? 'none' : '';
  if (fullscreenOn) setStatus('وضع اللعبة بملء الشاشة — دوس Esc عشان ترجع للواجهة.');
  if (!fullscreenOn) { /* toolbar back; BrowserView bounds restored by main */ }
});
$('allowControl').addEventListener('change', (e) => ipcRenderer.invoke('set-allow-control', e.target.checked));
$('quality').addEventListener('change', async () => {
  if (role !== 'host' || !hostStream) { setStatus('الجودة اتغيرت — هتتطبق لما تستضيف غرفة.'); return; }
  const old = hostStream;
  try {
    await acquireHostStream();
    old.getTracks().forEach((t) => t.stop());
    await replaceHostVideoTrack();
    setStatus('الجودة اتغيرت لـ ' + (QUALITY[$('quality').value] || {}).label + '.');
  } catch (e) { setStatus('فشل تغيير الجودة: ' + (e.message || e), true); }
});
$('micOn').addEventListener('change', () => setStatus('إعداد المايك هيتطبق في الاتصال الجاي.'));
