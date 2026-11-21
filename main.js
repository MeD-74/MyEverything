// OurBeam — Main process (Electron 45)
// - Main window: English LTR UI (renderer)
// - Real tabs: one BrowserView per tab. New tabs and the first tab open the
//   local home page (home.html, Hyperbeam-style new tab) — NOT AirConsole.
// - The macOS app menu (File/Edit/View/Window) is removed; those actions live
//   as icons in the sidebar instead.
// - AdGuard AdBlocker (beta, MV3, bundled in assets/extensions/adguard) is
//   loaded into the session so ads are blocked inside every tab.
// - Host capture: the renderer picks the source list over IPC
//   ('get-screen-sources' — desktopCapturer is main-process only) and then
//   captures it with getUserMedia chromeMediaSource 'desktop'
//   (see renderer.js acquireHostStream). This process only owns the BrowserViews
//   and injects remote input into the active one via webContents.sendInputEvent.
const { app, BrowserWindow, BrowserView, ipcMain, session, Menu, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// Local home page (file:// URL) and the pretty address shown for it.
const HOME_FILE = path.join(__dirname, 'home.html');
const HOME_URL = pathToFileURL(HOME_FILE).href;
const HOME_DISPLAY_URL = 'ourbeam://home';

let mainWindow = null;
// The renderer measures the real stage rect and reports it via
// 'set-view-bounds'; this is only the fallback until the first report.
let viewBounds = { x: 60, y: 140, width: 1220, height: 660 };
let allowControl = true;
let fullscreenGame = false;

// ---- Tabs: id -> { view, url, title } ----
const tabs = new Map();
let tabCounter = 0;
let activeTabId = null;

function activeTab() { return tabs.get(activeTabId) || null; }

function createTab(url) {
  const id = 'tab-' + (++tabCounter);
  const view = new BrowserView({
    webPreferences: {
      // AirConsole needs a modern Chromium with WebGL / WebAudio / autoplay.
      // No node inside the game page itself.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  const tab = { view, url: url || HOME_URL, title: 'Home' };
  tabs.set(id, tab);
  const sendPageInfo = () => {
    try {
      const realUrl = view.webContents.getURL();
      const isHome = realUrl === HOME_URL || realUrl.startsWith('file://');
      tab.url = isHome ? HOME_DISPLAY_URL : realUrl;
      tab.title = isHome ? 'Home' : (view.webContents.getTitle() || tab.url);
      mainWindow.webContents.send('page-info', { tabId: id, title: tab.title, url: tab.url });
    } catch (e) {}
  };
  view.webContents.on('page-title-updated', sendPageInfo);
  view.webContents.on('did-navigate', sendPageInfo);
  view.webContents.on('did-navigate-in-page', sendPageInfo);
  // AirConsole games want audio without a user gesture on the console page.
  view.webContents.setAudioMuted(false);
  view.setBounds(viewBounds);
  view.setAutoResize({ width: true, height: true });
  if (tab.url === HOME_URL) view.webContents.loadFile(HOME_FILE);
  else view.webContents.loadURL(tab.url);
  return { id, tab };
}

function showTab(id) {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return false;
  activeTabId = id;
  if (!fullscreenGame) tab.view.setBounds(viewBounds);
  mainWindow.setBrowserView(tab.view);
  return true;
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return { closed: false, activeId: activeTabId };
  try { mainWindow.removeBrowserView(tab.view); } catch (e) {}
  try { tab.view.webContents.destroy(); } catch (e) {}
  tabs.delete(id);
  // Never leave the window without a tab: open a fresh home tab instead.
  if (tabs.size === 0) {
    const created = createTab();
    showTab(created.id);
  } else if (activeTabId === id) {
    showTab([...tabs.keys()][tabs.size - 1]);
  }
  return { closed: true, activeId: activeTabId };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'OurBeam — Shared Browser',
    backgroundColor: '#000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, // personal app: renderer needs require('peerjs')
      contextIsolation: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile('index.html');
  const first = createTab();
  showTab(first.id);

  mainWindow.on('resize', () => {
    if (fullscreenGame) return;
    const tab = activeTab();
    if (!tab) return;
    const [w, h] = mainWindow.getContentSize();
    viewBounds = { x: viewBounds.x, y: viewBounds.y, width: w - viewBounds.x, height: h - viewBounds.y };
    tab.view.setBounds(viewBounds);
  });

  mainWindow.on('closed', () => { mainWindow = null; tabs.clear(); activeTabId = null; });
}

// ---- IPC: tabs + navigation (called from renderer via preload) ----
ipcMain.handle('tab-init', () => {
  if (!activeTabId) {
    const created = createTab();
    showTab(created.id);
  }
  const tab = activeTab();
  return { id: activeTabId, url: tab.url, title: tab.title };
});
ipcMain.handle('tab-new', (_e, url) => {
  const created = createTab(url || HOME_URL);
  showTab(created.id);
  return { id: created.id, url: created.tab.url };
});
ipcMain.handle('tab-close', (_e, id) => closeTab(id));
ipcMain.handle('tab-switch', (_e, id) => {
  const ok = showTab(id);
  const tab = activeTab();
  return { ok, activeId: activeTabId, url: tab ? tab.url : '' };
});

// Screen sources for host capture. desktopCapturer is MAIN-PROCESS ONLY in
// Electron 45 — require('electron').desktopCapturer is undefined in the
// renderer, so the renderer asks here over IPC instead. (That was the real
// sharing bug: the renderer called desktopCapturer.getSources directly and
// capture threw on every machine, so guests always got an empty stream.)
ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.handle('nav', (_e, action, url) => {
  const tab = activeTab();
  if (!tab) return { url: '', canGoBack: false, canGoForward: false };
  const wc = tab.view.webContents;
  try {
    if (action === 'home' || (action === 'go' && (!url || url === HOME_DISPLAY_URL || url === 'home'))) {
      wc.loadFile(HOME_FILE);
    } else if (action === 'go' && url) {
      const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      wc.loadURL(u);
    } else if (action === 'back' && wc.canGoBack()) wc.goBack();
    else if (action === 'forward' && wc.canGoForward()) wc.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'airconsole') wc.loadURL('https://www.airconsole.com');
  } catch (err) { console.error('nav error', err); }
  const realUrl = wc.getURL();
  const isHome = realUrl === HOME_URL || realUrl.startsWith('file://');
  return { url: isHome ? HOME_DISPLAY_URL : realUrl, canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
});

ipcMain.handle('set-view-bounds', (_e, bounds) => {
  viewBounds = bounds;
  const tab = activeTab();
  if (tab && !fullscreenGame) tab.view.setBounds(bounds);
  return true;
});

ipcMain.handle('set-fullscreen-game', (_e, on) => {
  fullscreenGame = !!on;
  const tab = activeTab();
  if (!tab) return false;
  if (on) {
    // Leave a 40px strip at the top for the "Exit Fullscreen" bar, so there
    // is always a visible way out (the BrowserView would cover any HTML
    // button placed over the game area).
    const [w, h] = mainWindow.getContentSize();
    tab.view.setBounds({ x: 0, y: 40, width: w, height: h - 40 });
    tab.view.setAutoResize({ width: true, height: true });
  } else {
    const [w, h] = mainWindow.getContentSize();
    viewBounds = { x: viewBounds.x, y: viewBounds.y, width: w - viewBounds.x, height: h - viewBounds.y };
    tab.view.setBounds(viewBounds);
  }
  return fullscreenGame;
});

ipcMain.handle('set-allow-control', (_e, on) => { allowControl = !!on; return allowControl; });

// ---- IPC: remote input from the guest (relative 0..1 coords from viewer video) ----
ipcMain.on('remote-input', (_e, ev) => {
  const tab = activeTab();
  if (!tab || !allowControl) return;
  const wc = tab.view.webContents;
  const b = tab.view.getBounds();
  const x = Math.round((ev.x || 0) * b.width);
  const y = Math.round((ev.y || 0) * b.height);
  try {
    if (ev.type === 'mousemove') {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
    } else if (ev.type === 'mousedown') {
      wc.sendInputEvent({ type: 'mousedown', x, y, button: ev.button || 'left', clickCount: 1 });
    } else if (ev.type === 'mouseup') {
      wc.sendInputEvent({ type: 'mouseup', x, y, button: ev.button || 'left', clickCount: 1 });
    } else if (ev.type === 'wheel') {
      wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: ev.deltaY || 0 });
    } else if (ev.type === 'keydown' || ev.type === 'keyup') {
      wc.sendInputEvent({ type: ev.type, keyCode: ev.key || '' });
    }
  } catch (err) { console.error('remote-input error', err); }
});

// AdGuard: bundled unpacked extension (assets/extensions/adguard). In the
// packaged app it lives unpacked next to app.asar (see asarUnpack in
// package.json); in dev it is read from __dirname. Loading is best-effort:
// if it fails, the browser still works, just without ad blocking.
function adguardPath() {
  const dev = path.join(__dirname, 'assets', 'extensions', 'adguard');
  if (fs.existsSync(path.join(dev, 'manifest.json'))) return dev;
  const prod = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'extensions', 'adguard');
  if (fs.existsSync(path.join(prod, 'manifest.json'))) return prod;
  return null;
}

// Keep the game page's media working: allow autoplay with sound in this app.
app.whenReady().then(async () => {
  // No File/Edit/View/Window menu bar: those actions live as icons in the
  // sidebar instead (see index.html). On macOS this leaves only the minimal
  // app menu (OurBeam / Quit).
  Menu.setApplicationMenu(null);
  const extPath = adguardPath();
  if (extPath) {
    try {
      const ext = await session.defaultSession.loadExtension(extPath);
      console.log('AdGuard loaded:', ext.name, ext.version);
    } catch (e) { console.error('AdGuard failed to load:', e); }
  } else {
    console.error('AdGuard extension files not found under assets/extensions/adguard');
  }
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'display-capture'].includes(permission));
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
