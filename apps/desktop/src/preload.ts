import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  ping: () => ipcRenderer.invoke('desktop:ping'),
  requestMediaAccess: (kind: 'microphone' | 'camera') =>
    ipcRenderer.invoke('desktop:request-media-access', kind),
});
