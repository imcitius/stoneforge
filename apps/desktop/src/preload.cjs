const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  command: (command, id, options) => ipcRenderer.invoke('desktop:command', command, id, options),
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:state', listener);
    return () => ipcRenderer.removeListener('desktop:state', listener);
  },
});
