// OurBeam — Main process (Electron 45)
// - Main window: English LTR UI (renderer)
// - Real tabs: one BrowserView per tab (AirConsole by default). Tabs can be
//   opened (+), closed (x) and switched — each keeps its own page.
// - Host capture is done in the renderer via desktopCapturer + getUserMedia
//   (see renderer.js startHostStream). This process only owns the BrowserViews
//   and injects remote input into the active one via webContents.sendInputEvent.
const { app, BrowserWindow, BrowserView, ipcMain, session } = require('electron');
const path = require('path');

let mainWindow = null;
// The renderer measures the real stage rect and reports it via
// 'set-view-bounds'; this is only the fallback until the first report.
let viewBounds = { x: 0, y: 140, width: 1280, height: 660 };
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
  const tab = { view, url: url || 'https://www.airconsole.com', title: 'New Tab' };
  tabs.set(id, tab);
  const sendPageInfo = () => {
    try {
      tab.url = view.webContents.getURL();
      tab.title = view.webContents.getTitle() || tab.url;
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
  view.webContents.loadURL(tab.url);
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
  // Never leave the window without a tab: open a fresh one instead.
  if (tabs.size === 0) {
    const created = createTab('https://www.airconsole.com');
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
      nodeIntegration: true, // personal app: renderer needs require('peerjs') + desktopCapturer
      contextIsolation: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile('index.html');
  const first = createTab('https://www.airconsole.com');
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
    const created = createTab('https://www.airconsole.com');
    showTab(created.id);
  }
  const tab = activeTab();
  return { id: activeTabId, url: tab.url, title: tab.title };
});
ipcMain.handle('tab-new', (_e, url) => {
  const created = createTab(url || 'https://www.airconsole.com');
  showTab(created.id);
  return { id: created.id, url: created.tab.url };
});
ipcMain.handle('tab-close', (_e, id) => closeTab(id));
ipcMain.handle('tab-switch', (_e, id) => {
  const ok = showTab(id);
  const tab = activeTab();
  return { ok, activeId: activeTabId, url: tab ? tab.url : '' };
});

ipcMain.handle('nav', (_e, action, url) => {
  const tab = activeTab();
  if (!tab) return { url: '', canGoBack: false, canGoForward: false };
  const wc = tab.view.webContents;
  try {
    if (action === 'go' && url) {
      const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
      wc.loadURL(u);
    } else if (action === 'back' && wc.canGoBack()) wc.goBack();
    else if (action === 'forward' && wc.canGoForward()) wc.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'airconsole') wc.loadURL('https://www.airconsole.com');
  } catch (err) { console.error('nav error', err); }
  return { url: wc.getURL(), canGoBack: wc.canGoBack(), canGoForward: wc.canGoForward() };
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
    const [w, h] = mainWindow.getContentSize();
    tab.view.setBounds({ x: 0, y: 0, width: w, height: h });
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

// Keep the game page's media working: allow autoplay with sound in this app.
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'audioCapture', 'display-capture'].includes(permission));
  });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
