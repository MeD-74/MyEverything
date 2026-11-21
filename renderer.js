// OurBeam — Renderer: UI + PeerJS signalling + host capture + guest viewer
// Networking: PeerJS public cloud is used for SIGNALLING ONLY. The video/audio
// stream itself is peer-to-peer WebRTC (direct when possible). No TURN server
// is configured (no free credentials) — if both sides are behind strict NAT,
// P2P may fail; see README troubleshooting.
// Latency honesty: stats below are real values from RTCPeerConnection.getStats().
// Nothing here invents a latency number.
const { ipcRenderer } = require('electron');
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
  race: { label: 'Race — 720p / 60fps', width: 1280, height: 720, frameRate: 60 },
  hd:   { label: 'High quality — 1080p / 30fps', width: 1920, height: 1080, frameRate: 30 },
  cinema: { label: 'Cinema — 1080p / 60fps', width: 1920, height: 1080, frameRate: 60 },
  low:  { label: 'Weak connection — 480p / 30fps', width: 854, height: 480, frameRate: 30 },
};

let peer = null, role = null, roomCode = null;
let hostStream = null, micStream = null, activeCall = null, dataConn = null;
// The host-initiated media call that carries the screen video to the guest.
// (The guest's own outbound call is audio-only: its offer has no video
// m-line, so no video can ever flow back on it — see ensureGuestCall.)
let videoCall = null;
let statsTimer = null, lastStats = null;
let fullscreenOn = false;

// ---------- Names: each side sets its display name; it is exchanged with
// the peer over the data connection so the party panel shows real names. ----------
const NAME_KEY = 'ourbeam-name';
let myName = '';
let peerName = '';
let peerOnline = false;
try { myName = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}
$('myName').value = myName;
function displayName(name, fallback) { const n = (name || '').trim(); return n || fallback; }

function renderParty() {
  const hostName = role === 'host' ? displayName(myName, 'Host') : displayName(peerName, 'Host');
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
$('myName').addEventListener('input', (e) => {
  myName = e.target.value;
  try { localStorage.setItem(NAME_KEY, myName); } catch (err) {}
  renderParty();
  sendHello();
});

function peerErrorEnglish(err) {
  const t = (err && err.type) || '';
  if (t === 'peer-unavailable') return 'Room not found or the host has not opened it yet — check the code and make sure the host has the app open.';
  if (t === 'network' || t === 'server-error') return 'Cannot reach the room server — check your internet and try again.';
  if (t === 'browser-incompatible') return 'The built-in browser does not support WebRTC.';
  return 'Connection problem: ' + (err && err.message ? err.message : t);
}

function destroyPeer() {
  try { if (statsTimer) clearInterval(statsTimer); } catch (e) {}
  statsTimer = null;
  try { if (openTimer) clearTimeout(openTimer); } catch (e) {}
  openTimer = null;
  try { if (dataConn) dataConn.close(); } catch (e) {}
  try { if (activeCall) activeCall.close(); } catch (e) {}
  try { if (videoCall) videoCall.close(); } catch (e) {}
  try { if (peer) peer.destroy(); } catch (e) {}
  peer = null; activeCall = null; dataConn = null; videoCall = null;
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
        'Delay: ' + (rttMs === null ? '—' : rttMs + 'ms') +
        ' | Speed: ' + (bitrateKbps === null ? '—' : bitrateKbps + ' kbps') +
        ' | FPS: ' + (fps === null ? '—' : fps + ' fps') +
        (dropped === null ? '' : ' | Dropped: ' + dropped);
      const bad = rttMs !== null && rttMs > 250;
      warnEl.hidden = !bad;
    } catch (e) { /* stats are best-effort; stream keeps running */ }
  }, 2000);
}

// ---------- Host capture: the OurBeam window (game) + system audio ----------
async function acquireHostStream() {
  const q = QUALITY[$('quality').value] || QUALITY.race;
  // desktopCapturer lives in the MAIN process only — the renderer asks for
  // the source list over IPC (see 'get-screen-sources' in main.js).
  const sources = await ipcRenderer.invoke('get-screen-sources');
  const self = sources.find((s) => /OurBeam/i.test(s.name)) || sources.find((s) => s.name.toLowerCase().includes('screen')) || sources[0];
  if (!self) throw new Error('No screen source available for streaming.');
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
    } catch (e) { setStatus('Mic not available — streaming without mic audio.', true); }
  }
  // Low-latency hint: keep the video track at the requested frame rate.
  hostStream.getVideoTracks().forEach((t) => { try { t.contentHint = 'motion'; } catch (e) {} });
  return hostStream;
}

async function replaceHostVideoTrack() {
  if (!videoCall || !videoCall.peerConnection) return;
  const sender = videoCall.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
  const track = hostStream && hostStream.getVideoTracks()[0];
  if (sender && track) { try { await sender.replaceTrack(track); } catch (e) {} }
}

// The screen video can ONLY travel on a call the HOST places: the guest's
// outbound call offers no video m-line (it carries mic audio at most), so
// answering it can never send video back — SDP answers can't add media
// sections the offer didn't have. The guest therefore gets the screen on
// this host-initiated call, and accepts it via its peer.on('call') handler.
function bindHostCall(call) {
  call.on('stream', () => {}); // host does not need the guest stream for video; mic audio (if any) plays via the call
  call.on('close', () => { setStatus('Guest left. The room is still open with code ' + roomCode + '.'); setGuestState('Waiting for guest…', false); clearPeer(); if (activeCall === call) activeCall = null; if (videoCall === call) videoCall = null; });
  call.on('error', (e) => setStatus(peerErrorEnglish(e), true));
  startStats(call.peerConnection);
  setGuestState('Guest connected — streaming live', true);
  setStatus('Loly joined the room — streaming live.');
}
function hostHasLiveVideo() {
  try {
    const pc = videoCall && videoCall.peerConnection;
    return !!(pc && pc.getSenders().some((s) => s.track && s.track.kind === 'video' && s.track.readyState === 'live'));
  } catch (e) { return false; }
}
// (Re)place the host-initiated video call to the guest once the screen
// stream exists and the guest is reachable. Called when the stream becomes
// ready, when the guest's mic call arrives, and when the data connection
// opens — whichever comes last wins, so a guest who joined while the host
// was still capturing still gets the video.
function ensureGuestCall() {
  if (role !== 'host' || !hostStream || !peer) return;
  if (videoCall && hostHasLiveVideo()) return;
  const guestId = (videoCall && videoCall.peer) || (activeCall && activeCall.peer) || (dataConn && dataConn.peer);
  if (!guestId) return;
  try { if (videoCall) videoCall.close(); } catch (e) {}
  videoCall = null;
  try {
    const call = peer.call(guestId, hostStream);
    videoCall = call;
    activeCall = call;
    bindHostCall(call);
  } catch (e) {}
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
  renderParty();
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
  setGuestState('Waiting for guest…', false);
  showParty('host');
}

async function startHosting(keepCode) {
  if (peer) { setStatus('You are already connected — leave the room first.', true); return; }
  if (hostStarting) return;
  hostStarting = true;
  roomCode = (keepCode && roomCode) ? roomCode : String(Math.floor(100000 + Math.random() * 900000));
  role = 'host';
  // 1) The code goes on screen RIGHT NOW, before any network or capture.
  showHostCode(roomCode);
  setBadge('Connecting…', 'connecting');
  setStatus('Your code: ' + roomCode + ' — connecting to the room server… send it to Loly now.');
  // 2) Create the peer FIRST (cheap), then capture the screen.
  peer = new Peer('ourbeam-' + roomCode, PEER_CONFIG);
  let opened = false;
  if (openTimer) clearTimeout(openTimer);
  openTimer = setTimeout(() => {
    if (opened) return;
    hostStarting = false;
    setBadge('Not connected', '');
    setStatus('Room server is not responding — check your internet and click "Retry". Your code is still: ' + roomCode, true);
    $('btnRetryHost').hidden = false;
  }, 15000);
  peer.on('open', async () => {
    opened = true;
    if (openTimer) clearTimeout(openTimer);
    hostStarting = false;
    setBadge('Host', 'live');
    saveRecent(roomCode, 'host');
    setStatus('Room is open — code: ' + roomCode + '. Send it to Loly so she can join from her device.');
    try {
      await acquireHostStream();
      setStatus('Stream is ready — code: ' + roomCode + '. Send it to Loly.');
      ensureGuestCall();
    } catch (e) {
      setStatus('Room is open with code ' + roomCode + ' but stream setup failed: ' + (e.message || e) + ' — click "Retry".', true);
      $('btnRetryHost').hidden = false;
    }
  });
  peer.on('call', (call) => {
    activeCall = call;
    // This is the guest's mic call (audio only). Answer at once — the
    // screen video goes out on the host-initiated call (ensureGuestCall),
    // because this call's offer has no video m-line to answer with.
    call.answer(hostStream || micStream || new MediaStream());
    bindHostCall(call);
    ensureGuestCall();
  });
  peer.on('connection', (conn) => {
    dataConn = conn;
    conn.on('data', (ev) => {
      if (!ev || !ev.type) return;
      if (ev.type === 'hello') { setPeerName(ev.name); setGuestState(displayName(ev.name, 'Guest') + ' is connected', true); return; }
      // Guest remote input: forward to the BrowserView in the main process.
      ipcRenderer.send('remote-input', ev);
    });
    conn.on('open', () => {
      sendHello();
      setGuestState('Guest connected and controlling', true);
      setStatus('Guest connected and controlling — uncheck "Let guest control" if you want to stop that.');
      ensureGuestCall();
    });
  });
  peer.on('error', (e) => {
    setStatus(peerErrorEnglish(e), true);
    if (!opened) { setBadge('Not connected', ''); $('btnRetryHost').hidden = false; }
  });
  peer.on('disconnected', () => {
    setStatus('Connection to the room server dropped — reconnecting…');
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
// One handler for any incoming media call — the outbound call to the host
// and host-initiated (re-)calls after the stream becomes ready.
function attachGuestStream(call) {
  call.on('stream', (remoteStream) => {
    const v = $('remoteVideo');
    v.srcObject = remoteStream;
    v.play().catch(() => {});
    // The guest's own outbound call carries audio only (mic) — the screen
    // video arrives on the host's call. Only open the viewer for video.
    if (!remoteStream.getVideoTracks().length) return;
    $('viewerWrap').hidden = false;
    $('homeHint').hidden = true;
    $('btnLeave').hidden = false;
    $('btnLeave2').hidden = false;
    $('sideLeave').hidden = false;
    showParty('guest');
    saveRecent(roomCode, 'guest');
    setStatus('Stream is live — this is the host\'s screen in real time. Your phone is the AirConsole controller.');
  });
  call.on('close', () => { setStatus('The host closed the stream.', true); });
  call.on('error', (e) => setStatus(peerErrorEnglish(e), true));
  startStats(call.peerConnection);
}
async function startJoining() {
  const code = $('joinCode').value.trim();
  if (!/^\d{6}$/.test(code)) { setStatus('Type the room code — 6 digits.', true); return; }
  if (peer) { setStatus('You are already connected — leave the room first.', true); return; }
  role = 'guest';
  roomCode = code;
  setBadge('Guest', 'guest');
  setStatus('Connecting to the host...');
  let mic = null;
  if ($('micOn').checked) {
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); micStream = mic; }
    catch (e) { setStatus('Mic not available — continuing without mic audio.', true); }
  }
  peer = new Peer(PEER_CONFIG);
  let guestOpened = false;
  const guestTimer = setTimeout(() => {
    if (!guestOpened) setStatus('Room server is not responding — check your internet and try again.', true);
  }, 15000);
  peer.on('open', () => {
    guestOpened = true;
    clearTimeout(guestTimer);
    const conn = peer.connect('ourbeam-' + code, { reliable: true });
    dataConn = conn;
    conn.on('open', () => { sendHello(); setStatus('Connected to the host — receiving the stream...'); });
    conn.on('data', (ev) => {
      if (ev && ev.type === 'hello') { setPeerName(ev.name); setGuestState(displayName(ev.name, 'Host') + ' is streaming', true); }
    });
    conn.on('error', (e) => setStatus(peerErrorEnglish(e), true));
    const call = peer.call('ourbeam-' + code, mic || new MediaStream());
    activeCall = call;
    attachGuestStream(call);
  });
  // The host may call the guest (again) once its screen stream is ready —
  // accept it the same way as the outbound call.
  peer.on('call', (incoming) => {
    incoming.answer(micStream || mic || new MediaStream());
    activeCall = incoming;
    attachGuestStream(incoming);
  });
  peer.on('error', (e) => setStatus(peerErrorEnglish(e), true));
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
  $('sideLeave').hidden = true;
  $('party').hidden = true;
  $('btnRetryHost').hidden = true;
  setGuestState('Waiting for guest…', false);
  const v = $('remoteVideo'); v.srcObject = null;
  statsEl.textContent = 'Delay: — | Speed: — | FPS: —';
  warnEl.hidden = true;
  setBadge('Not connected', '');
  setStatus('You left the room. Host a room or join with another code.');
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
    if (role === 'guest' && document.activeElement !== $('joinCode') && document.activeElement !== $('myName')) sendInput({ type: 'keydown', key: e.key });
  });
  window.addEventListener('keyup', (e) => { if (role === 'guest' && document.activeElement !== $('joinCode') && document.activeElement !== $('myName')) sendInput({ type: 'keyup', key: e.key }); });
})();

// ---------- Tabs: real tabs, one BrowserView each ----------
let tabs = [];           // { id, title, url }
let activeTabId = null;

function activeTab() { return tabs.find((t) => t.id === activeTabId) || null; }
function shortTitle(title, url) {
  const t = (title || '').trim();
  if (t && t !== url) return t.length > 24 ? t.slice(0, 24) + '…' : t;
  try { return new URL(url).hostname.replace(/^www\./, '') || 'New Tab'; }
  catch (e) { return 'New Tab'; }
}
function renderTabs() {
  const box = $('tabs');
  box.innerHTML = '';
  tabs.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '');
    const span = document.createElement('span');
    span.className = 'tab-title';
    span.textContent = shortTitle(t.title, t.url);
    span.title = t.url;
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab';
    close.addEventListener('click', async (e) => {
      e.stopPropagation();
      const r = await ipcRenderer.invoke('tab-close', t.id);
      tabs = tabs.filter((x) => x.id !== t.id);
      if (r && r.activeId) activeTabId = r.activeId;
      if (tabs.length === 0) { await initTabs(); return; }
      renderTabs();
      syncAddressBar();
    });
    el.appendChild(span);
    el.appendChild(close);
    el.addEventListener('click', async () => {
      if (t.id === activeTabId) return;
      activeTabId = t.id;
      await ipcRenderer.invoke('tab-switch', t.id);
      renderTabs();
      syncAddressBar();
    });
    box.appendChild(el);
  });
}
function syncAddressBar() {
  const t = activeTab();
  if (t && document.activeElement !== $('address')) $('address').value = t.url;
}
async function newTab(url) {
  const r = await ipcRenderer.invoke('tab-new', url || undefined);
  if (!r || !r.id) return;
  tabs.push({ id: r.id, title: 'Home', url: r.url || 'ourbeam://home' });
  activeTabId = r.id;
  renderTabs();
  syncAddressBar();
}
async function initTabs() {
  const r = await ipcRenderer.invoke('tab-init');
  if (!r || !r.id) return;
  tabs = [{ id: r.id, title: r.title || 'New Tab', url: r.url || 'https://www.airconsole.com' }];
  activeTabId = r.id;
  renderTabs();
  syncAddressBar();
}

// ---------- Toolbar / navigation (active tab) ----------
$('btnGo').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'go', $('address').value.trim());
  if (r && r.url) { $('address').value = r.url; const t = activeTab(); if (t) t.url = r.url; renderTabs(); }
});
$('address').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const r = await ipcRenderer.invoke('nav', 'go', $('address').value.trim());
    if (r && r.url) { $('address').value = r.url; const t = activeTab(); if (t) t.url = r.url; renderTabs(); }
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
$('btnYoutube').addEventListener('click', async () => {
  const r = await ipcRenderer.invoke('nav', 'go', 'https://www.youtube.com');
  if (r && r.url) $('address').value = r.url;
});

$('btnNewTab').addEventListener('click', () => newTab());
$('btnHost').addEventListener('click', () => startHosting());
$('btnHostHome').addEventListener('click', () => startHosting());
$('btnJoinHome').addEventListener('click', () => { $('joinBox').hidden = false; $('joinCode').focus(); });
$('btnRetryHost').addEventListener('click', retryHosting);
$('btnJoinShow').addEventListener('click', () => { $('joinBox').hidden = false; $('joinCode').focus(); });
$('btnJoinCancel').addEventListener('click', () => { $('joinBox').hidden = true; });
$('btnJoin').addEventListener('click', startJoining);
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') startJoining(); });
$('btnCopyCode').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomCode || ''); setStatus('Code copied: ' + roomCode); }
  catch (e) { setStatus('Code: ' + roomCode + ' — copy it manually.', true); }
});
$('btnLeave').addEventListener('click', leaveRoom);

$('btnFullscreen').addEventListener('click', async () => {
  fullscreenOn = !fullscreenOn;
  await ipcRenderer.invoke('set-fullscreen-game', fullscreenOn);
  $('btnFullscreen').textContent = fullscreenOn ? 'Exit Fullscreen' : 'Fullscreen';
  $('btnFullscreen2').textContent = fullscreenOn ? 'Exit Fullscreen' : 'Fullscreen';
  $('chrome').style.display = fullscreenOn ? 'none' : '';
  $('sidebar').style.display = fullscreenOn ? 'none' : '';
  $('bottombar').style.display = fullscreenOn ? 'none' : '';
  $('party').style.display = fullscreenOn ? 'none' : '';
  $('fullscreenBar').hidden = !fullscreenOn;
  if (fullscreenOn) setStatus('Fullscreen game mode — press Esc or click "Exit Fullscreen" at the top to go back.');
  if (!fullscreenOn) { /* layout back; BrowserView bounds restored by stage ResizeObserver */ }
});
$('btnExitFullscreen').addEventListener('click', () => $('btnFullscreen').click());
$('btnFullscreen2').addEventListener('click', () => $('btnFullscreen').click());
$('btnLeave2').addEventListener('click', leaveRoom);
$('sideLeave').addEventListener('click', leaveRoom);
$('sideNewTab').addEventListener('click', () => newTab());
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
$('btnOpenBrowser').addEventListener('click', () => newTab());
$('btnCopyCode2').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomCode || ''); setStatus('Code copied: ' + roomCode); }
  catch (e) { setStatus('Code: ' + roomCode + ' — copy it manually.', true); }
});
$('guestVolume').addEventListener('input', (e) => { $('remoteVideo').volume = e.target.value / 100; });
$('allowControl').addEventListener('change', (e) => ipcRenderer.invoke('set-allow-control', e.target.checked));
$('quality').addEventListener('change', async () => {
  if (role !== 'host' || !hostStream) { setStatus('Quality changed — it will apply when you host a room.'); return; }
  const old = hostStream;
  try {
    await acquireHostStream();
    old.getTracks().forEach((t) => t.stop());
    await replaceHostVideoTrack();
    ensureGuestCall();
    setStatus('Quality changed to ' + (QUALITY[$('quality').value] || {}).label + '.');
  } catch (e) { setStatus('Failed to change quality: ' + (e.message || e), true); }
});
$('micOn').addEventListener('change', () => setStatus('Mic setting will apply on the next connection.'));

// ---------- Browser chrome: live tab title / address + BrowserView bounds ----------
// The BrowserView must sit exactly over the stage (under the header) — so the
// renderer measures the stage rect and reports it to the main process instead
// of hardcoding numbers.
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
  const t = tabs.find((x) => x.id === info.tabId) || activeTab();
  if (t) {
    if (info.title) t.title = info.title;
    if (info.url) t.url = info.url;
    renderTabs();
    if (t.id === activeTabId) syncAddressBar();
  }
});

// ---------- Mic mute (bottom bar) ----------
let micMuted = false;
function updateMicButtons() {
  const b = $('btnMicMute'), s = $('sideMic');
  b.classList.toggle('muted', micMuted);
  s.classList.toggle('muted', micMuted);
  b.querySelector('span').textContent = micMuted ? 'Mic muted' : 'Mic on';
}
function toggleMicMute() {
  micMuted = !micMuted;
  const apply = (stream) => { if (stream) stream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; }); };
  apply(micStream); apply(hostStream);
  updateMicButtons();
  setStatus(micMuted ? 'Mic muted — the guest cannot hear you.' : 'Mic is on again.');
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
    const whenText = when.toLocaleDateString('en-GB') + ' ' + when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = '<span class="save-code" dir="ltr">' + item.code + '</span>' +
      '<span class="save-meta">' + (item.role === 'host' ? 'Hosted' : 'Joined') + ' — ' + whenText + '</span>';
    const btn = document.createElement('button');
    btn.textContent = item.role === 'host' ? 'Host again' : 'Join again';
    btn.addEventListener('click', () => {
      if (item.role === 'host') { roomCode = item.code; startHosting(true); }
      else { $('joinCode').value = item.code; $('joinBox').hidden = false; startJoining(); }
    });
    row.appendChild(btn);
    box.appendChild(row);
  });
}
renderRecent();
renderParty();
initTabs();
reportViewBounds();
