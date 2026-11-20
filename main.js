// MyEverything — Main process (Electron 45)
// - Main window: Arabic RTL UI (renderer)
// - BrowserView: the shared Chromium browser (AirConsole by default)
// - Host capture is done in the renderer via desktopCapturer + getUserMedia
//   (see renderer.js startHostStream). This process only owns the BrowserView
//   and injects remote input into it via webContents.sendInputEvent.
const { app, BrowserWindow, BrowserView, ipcMain, session } = require('electron');
const path = require('path');

let mainWindow = null;
let view = null;
let viewBounds = { x: 0, y: 110, width: 1280, height: 690 };
let allowControl = true;
let fullscreenGame = false;

function createView() {
  view = new BrowserView({
    webPreferences: {
      // AirConsole needs a modern Chromium with WebGL / WebAudio / autoplay.
      // No node inside the game page itself.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.setBrowserView(view);
  view.setBounds(viewBounds);
  view.setAutoResize({ width: true, height: true });
  view.webContents.loadURL('https://www.airconsole.com');
  // AirConsole games want audio without a user gesture on the console page.
  view.webContents.setAudioMuted(false);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'MyEverything — متصفح مشترك',
    backgroundColor: '#0b0b0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, // personal app: renderer needs require('peerjs') + desktopCapturer
      contextIsolation: false,
      webviewTag: false,
    },
  });

  mainWindow.loadFile('index.html');
  createView();

  mainWindow.on('resize', () => {
    if (!view || fullscreenGame) return;
    const [w, h] = mainWindow.getContentSize();
    viewBounds = { x: 0, y: 110, width: w, height: h - 110 };
    view.setBounds(viewBounds);
  });

  mainWindow.on('closed', () => { mainWindow = null; view = null; });
}

// ---- IPC: navigation / view control (called from renderer via preload) ----
ipcMain.handle('nav', (_e, action, url) => {
  if (!view) return { url: '', canGoBack: false, canGoForward: false };
  const wc = view.webContents;
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
  if (view && !fullscreenGame) view.setBounds(bounds);
  return true;
});

ipcMain.handle('set-fullscreen-game', (_e, on) => {
  fullscreenGame = !!on;
  if (!view) return false;
  if (on) {
    const [w, h] = mainWindow.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
    view.setAutoResize({ width: true, height: true });
  } else {
    const [w, h] = mainWindow.getContentSize();
    viewBounds = { x: 0, y: 110, width: w, height: h - 110 };
    view.setBounds(viewBounds);
  }
  return fullscreenGame;
});

ipcMain.handle('set-allow-control', (_e, on) => { allowControl = !!on; return allowControl; });

// ---- IPC: remote input from the guest (relative 0..1 coords from viewer video) ----
ipcMain.on('remote-input', (_e, ev) => {
  if (!view || !allowControl) return;
  const wc = view.webContents;
  const b = view.getBounds();
  const x = Math.round((ev.x || 0) * b.width);
  const y = Math.round((ev.y || 0) * b.height);
  try {
    if (ev.type === 'mousemove') {
      wc.sendInputEvent({ type: 'mouseMove', x, y });
    } else if (ev.type === 'mousedown') {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: ev.button || 'left', clickCount: 1 });
    } else if (ev.type === 'mouseup') {
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: ev.button || 'left', clickCount: 1 });
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
