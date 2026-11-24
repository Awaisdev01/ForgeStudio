const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gateway', {
  getState: () => ipcRenderer.invoke('gw:getState'),
  saveConfig: (patch) => ipcRenderer.invoke('gw:saveConfig', patch),
  mintToken: (plan) => ipcRenderer.invoke('gw:mintToken', plan),
  testUpstream: () => ipcRenderer.invoke('gw:testUpstream'),
  onEvent: (cb) => ipcRenderer.on('gw:event', (_e, data) => cb(data)),
});
