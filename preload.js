'use strict';
// Minimal, explicit bridge between the HUD page and the Electron main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  // true = HUD visible and capturing input; false = click-through, game keeps focus
  setInteractive: (on) => ipcRenderer.send('overlay:interactive', Boolean(on)),
  // fired when the global toggle key is pressed
  onToggle: (cb) => ipcRenderer.on('overlay:toggle', () => cb()),
  quit: () => ipcRenderer.send('overlay:quit'),
});
