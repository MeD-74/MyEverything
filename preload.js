// Preload: minimal bridge. nodeIntegration is on for the renderer in this
// personal app, so most work happens directly in renderer.js.
// Keep this file so the window still works if that flag is ever tightened.
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  nav: (action, url) => ipcRenderer.invoke('nav', action, url),
  setViewBounds: (b) => ipcRenderer.invoke('set-view-bounds', b),
  setFullscreenGame: (on) => ipcRenderer.invoke('set-fullscreen-game', on),
  setAllowControl: (on) => ipcRenderer.invoke('set-allow-control', on),
  sendRemoteInput: (ev) => ipcRenderer.send('remote-input', ev),
};

try {
  contextBridge.exposeInMainWorld('myEverything', api);
} catch (e) {
  // contextIsolation is off in this build; the renderer uses ipcRenderer directly.
  window.myEverything = api;
}
