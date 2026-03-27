// electron/src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPairing: () => ipcRenderer.invoke('get-pairing'),
  navigateTo: (url) => ipcRenderer.invoke('navigate-to', url),
  requestMoreTime: (reason) => ipcRenderer.invoke('request-more-time', { reason }),
  setDeviceToken: (token, expiresAt) => ipcRenderer.invoke('set-device-token', { token, expiresAt }),
  onMessage: (cb) => {
    window.addEventListener('message', (e) => cb && cb(e.data));
  }
});

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'request-more-time') {
    ipcRenderer.send('overlay-request-more-time', { reason: e.data.reason });
  }
});
