// Мост оболочки для страницы Graphspace: показать внешний сайт поверх прямоугольника панели.
// Только главный фрейм (Craft в iframe его не получает), только эти пять вызовов.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('graphspaceShell', {
  show: (url, rect) => ipcRenderer.send('web:show', { url, rect }),
  hide: () => ipcRenderer.send('web:hide'),
  nav: (action) => ipcRenderer.send('web:nav', action),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('web:state', h);
    return () => ipcRenderer.off('web:state', h);
  },
});
