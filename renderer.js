// OurBeam — Renderer: UI + PeerJS signalling + host capture + guest viewer
// Networking: PeerJS public cloud is used for SIGNALLING ONLY. The video/audio
// stream itself is peer-to-peer WebRTC (direct when possible). No TURN server
// is configured (no free credentials) — if both sides are behind strict NAT,
// P2P may fail; see README troubleshooting.
// Latency honesty: stats below are real values from RTCPeerConnection.getStats().
// Nothing here invents a latency number.
const { ipcRenderer, desktopCapturer } = require('electron');
const { Peer } = require('peerjs');

const $ = (id) => document.getElementById(id);
const statusEl = $('status'), statsEl = $('stats'), warnEl = $('warn'), badgeEl = $('roleBadge'),
      guestStateEl = $('guestState');
let hostStarting = false, openTimer = null;

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
  try { if (openTimer) clearTimeout(openTimer); } catch (e) {}
  openTimer = null;
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

// ---------- Host capture: the OurBeam window (game) + system audio ----------
async function acquireHostStream() {
  const q = QUALITY[$('quality').value] || QUALITY.race;
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
  const self = sources.find((s) => /OurBeam/i.test(s.name)) || sources.find((s) => s.name.toLowerCase().includes('screen')) || sources[0];
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
// The room code is shown IMMEDIATELY when hosting starts — it must never
// depend on the network (PeerJS signalling) or on screen capture succeeding.
// Signalling and capture happen after the code is already on screen.
function setGuestState(text, online) {
  guestStateEl.textContent = text;
  const g2 = $('guestState2'), dot = $('guestDot');
  if (g2) g2.textContent = text;
  if (dot) dot.classList.toggle('online', !!online);
}

function showParty(asRole) {
  $('party').hidden = false;
  $('partyCode').textContent = roomCode || '------';
  $('myRole').textContent = asRole === 'host' ? 'مضيف' : 'ضيف';
  reportViewBounds();
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

async function startHosting(keepCode) {
  if (peer) { setStatus('انت متصل أصلاً — دوس مغادرة الأول.', true); return; }
  if (hostStarting) return;
  hostStarting = true;
  roomCode = (keepCode && roomCode) ? roomCode : String(Math.floor(100000 + Math.random() * 900000));
  role = 'host';
  // 1) The code goes on screen RIGHT NOW, before any network or capture.
  showHostCode(roomCode);
  setBadge('جاري الاتصال…', 'connecting');
  setStatus('الكود بتاعك: ' + roomCode + ' — جاري الاتصال بسيرفر الغرف… ابعته للولي من دلوقتي.');
  // 2) Create the peer FIRST (cheap), then capture the screen.
  peer = new Peer('ourbeam-' + roomCode, PEER_CONFIG);
  let opened = false;
  if (openTimer) clearTimeout(openTimer);
  openTimer = setTimeout(() => {
    if (opened) return;
    hostStarting = false;
    setBadge('مش متصل', '');
    setStatus('سيرفر الغرف مش بيرد — اتأكد من النت ودوس "إعادة المحاولة". الكود لسه: ' + roomCode, true);
    $('btnRetryHost').hidden = false;
  }, 15000);
  peer.on('open', async () => {
    opened = true;
    if (openTimer) clearTimeout(openTimer);
    hostStarting = false;
    setBadge('مضيف', 'live');
    saveRecent(roomCode, 'host');
    setStatus('الغرفة مفتوحة — الكود: ' + roomCode + '. ابعته للولي، وهي تدخل من جهازها.');
    try {
      await acquireHostStream();
      setStatus('البث جاهز — الكود: ' + roomCode + '. ابعته للولي.');
    } catch (e) {
      setStatus('الغرفة مفتوحة بالكود ' + roomCode + ' بس تجهيز البث فشل: ' + (e.message || e) + ' — دوس "إعادة المحاولة".', true);
      $('btnRetryHost').hidden = false;
    }
  });
  peer.on('call', (call) => {
    activeCall = call;
    call.answer(hostStream || new MediaStream());
    call.on('stream', () => {}); // host does not need the guest stream for video; mic audio (if any) plays via the call
    call.on('close', () => { setStatus('الضيف خرج. الغرفة لسه مفتوحة بالكود ' + roomCode + '.'); setGuestState('مستني الضيف يدخل…', false); activeCall = null; });
    call.on('error', (e) => setStatus(peerErrorArabic(e), true));
    startStats(call.peerConnection);
    setGuestState('الضيف متصل — البث شغال', true);
    setStatus('الولي دخلت الغرفة — البث شغال لحظياً.');
  });
  peer.on('connection', (conn) => {
    dataConn = conn;
    conn.on('data', (ev) => {
      // Guest remote input: forward to the BrowserView in the main process.
      if (ev && ev.type) ipcRenderer.send('remote-input', ev);
    });
    conn.on('open', () => { setGuestState('الضيف متصل وبيتحكم', true); setStatus('الضيف متصل وبيتحكم — لو عايز تمنع التحكم شيل علامة السماح.'); });
  });
  peer.on('error', (e) => {
    setStatus(peerErrorArabic(e), true);
    if (!opened) { setBadge('مش متصل', ''); $('btnRetryHost').hidden = false; }
  });
  peer.on('disconnected', () => {
    setStatus('الاتصال بسيرفر الغرف اتقطع — بيحاول يرجع…');
    try { peer.reconnect(); } catch (e) {}
  });
}

function retryHosting() {
  $('btnRetryHost').hidden = true;
  destroyPeer();
  hostStarting = false;
  role = null;
  startHosting(true); // same code, shown again immediately
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
  let guestOpened = false;
  const guestTimer = setTimeout(() => {
    if (!guestOpened) setStatus('سيرفر الغرف مش بيرد — اتأكد من النت وحاول تاني.', true);
  }, 15000);
  peer.on('open', () => {
    guestOpened = true;
    clearTimeout(guestTimer);
    const conn = peer.connect('ourbeam-' + code, { reliable: true });
    dataConn = conn;
    conn.on('open', () => setStatus('متصل بالمضيف — جاري استقبال البث...'));
    conn.on('error', (e) => setStatus(peerErrorArabic(e), true));
    const call = peer.call('ourbeam-' + code, mic || new MediaStream());
    activeCall = call;
    call.on('stream', (remoteStream) => {
      const v = $('remoteVideo');
      v.srcObject = remoteStream;
      v.play().catch(() => {});
      $('viewerWrap').hidden = false;
      $('homeHint').hidden = true;
      $('btnLeave').hidden = false;
      $('btnLeave2').hidden = false;
      $('sideLeave').hidden = false;
      showParty('guest');
      saveRecent(code, 'guest');
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
  const v = $('remoteVideo'); v.srcObject = null;
  statsEl.textContent = 'التأخير: — | السرعة: — | الصورة: —';
  warnEl.hidden = true;
  setBadge('مش متصل', '');
  setStatus('خرجت من الغرفة. استضيف غرفة أو انضم بكود تاني.');
  reportViewBounds();
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

$('btnHost').addEventListener('click', () => startHosting());
$('btnHostHome').addEventListener('click', () => startHosting());
$('btnJoinHome').addEventListener('click', () => { $('joinBox').hidden = false; $('joinCode').focus(); });
$('btnRetryHost').addEventListener('click', retryHosting);
$('btnNewTab').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'airconsole');
  $('address').value = 'https://www.airconsole.com';
  if (r && r.url) $('address').value = r.url;
});
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
  $('btnFullscreen').textContent = fullscreenOn ? 'ارجع للواجهة' : 'ملء الشاشة';
  $('btnFullscreen2').textContent = fullscreenOn ? 'ارجع للواجهة' : 'ملء الشاشة';
  $('chrome').style.display = fullscreenOn ? 'none' : '';
  $('sidebar').style.display = fullscreenOn ? 'none' : '';
  $('bottombar').style.display = fullscreenOn ? 'none' : '';
  $('party').style.display = fullscreenOn ? 'none' : '';
  if (fullscreenOn) setStatus('وضع اللعبة بملء الشاشة — دوس Esc عشان ترجع للواجهة.');
  if (!fullscreenOn) { /* layout back; BrowserView bounds restored by stage ResizeObserver */ }
});
$('btnFullscreen2').addEventListener('click', () => $('btnFullscreen').click());
$('btnLeave2').addEventListener('click', leaveRoom);
$('sideLeave').addEventListener('click', leaveRoom);
$('sideAirconsole').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'airconsole');
  $('address').value = 'https://www.airconsole.com';
  if (r && r.url) $('address').value = r.url;
});
$('sideYoutube').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'go', 'https://www.youtube.com');
  if (r && r.url) $('address').value = r.url;
});
$('sideFullscreen').addEventListener('click', () => $('btnFullscreen').click());
$('btnOpenBrowser').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'airconsole');
  $('address').value = 'https://www.airconsole.com';
  if (r && r.url) $('address').value = r.url;
});
$('btnCopyCode2').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomCode || ''); setStatus('الكود اتنسخ: ' + roomCode); }
  catch (e) { setStatus('الكود: ' + roomCode + ' — انسخه يدوياً.', true); }
});
$('guestVolume').addEventListener('input', (e) => { $('remoteVideo').volume = e.target.value / 100; });
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

// ---------- Browser chrome: live tab title / address + BrowserView bounds ----------
// The BrowserView must sit exactly over the stage (under the header, right of the
// sidebar, left of the party panel) — so the renderer measures the stage rect and
// reports it to the main process instead of hardcoding numbers.
function reportViewBounds() {
  try {
    const r = $('stage').getBoundingClientRect();
    ipcRenderer.invoke('set-view-bounds', {
      x: Math.round(r.left), y: Math.round(r.top),
      width: Math.round(r.width), height: Math.round(r.height),
    });
  } catch (e) {}
}
window.addEventListener('resize', reportViewBounds);
if (window.ResizeObserver) {
  new ResizeObserver(reportViewBounds).observe($('stage'));
  new ResizeObserver(reportViewBounds).observe($('chrome'));
}
ipcRenderer.on('page-info', (_e, info) => {
  if (!info) return;
  if (info.title) $('tabTitle').textContent = info.title;
  if (info.url && document.activeElement !== $('address')) $('address').value = info.url;
});

// ---------- Mic mute (bottom bar + sidebar) ----------
let micMuted = false;
function updateMicButtons() {
  const b = $('btnMicMute'), s = $('sideMic');
  b.classList.toggle('muted', micMuted);
  s.classList.toggle('muted', micMuted);
  b.querySelector('span').textContent = micMuted ? 'المايك مكتوم' : 'المايك شغال';
}
function toggleMicMute() {
  micMuted = !micMuted;
  const apply = (stream) => { if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; }); };
  apply(micStream); apply(hostStream);
  updateMicButtons();
  setStatus(micMuted ? 'المايك مكتوم — الضيف مش هيسمعك.' : 'المايك شغال تاني.');
}
$('btnMicMute').addEventListener('click', toggleMicMute);
$('sideMic').addEventListener('click', toggleMicMute);

// ---------- LOAD SAVE: recent rooms (localStorage) ----------
const RECENT_KEY = 'ourbeam-recent';
function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch (e) { return []; }
}
function saveRecent(code, r) {
  if (!code) return;
  const list = loadRecent().filter((x) => x.code !== code);
  list.unshift({ code, role: r, ts: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch (e) {}
  renderRecent();
}
function renderRecent() {
  const list = loadRecent();
  const box = $('recentList');
  box.innerHTML = '';
  $('noRecent').hidden = list.length > 0;
  list.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'save-row';
    const when = new Date(item.ts);
    const whenText = when.toLocaleDateString('ar-EG') + ' ' + when.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = '<span class="save-code" dir="ltr">' + item.code + '</span>' +
      '<span class="save-meta">' + (item.role === 'host' ? 'استضفتها' : 'انضميت ليها') + ' — ' + whenText + '</span>';
    const btn = document.createElement('button');
    btn.textContent = item.role === 'host' ? 'استضيف تاني' : 'انضم تاني';
    btn.addEventListener('click', () => {
      if (item.role === 'host') { roomCode = item.code; startHosting(true); }
      else { $('joinCode').value = item.code; $('joinBox').hidden = false; startJoining(); }
    });
    row.appendChild(btn);
    box.appendChild(row);
  });
}
renderRecent();
reportViewBounds();
