// Dynamedia — preload (puente seguro renderer <-> main)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dynamedia', {
  navigate: (url) => ipcRenderer.send('navigate', url),
  downloadMedia: (url) => ipcRenderer.invoke('download-media', url),
  getStats: () => ipcRenderer.invoke('get-stats'),
  onNavigateUrl: (cb) => ipcRenderer.on('navigate-url', (_e, url) => cb(url)),
  onStats: (cb) => ipcRenderer.on('stats', (_e, stats) => cb(stats)),
  onOpenUrl: (cb) => ipcRenderer.on('open-url', (_e, url) => cb(url)),
});