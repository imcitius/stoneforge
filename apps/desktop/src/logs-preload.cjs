const { ipcRenderer } = require('electron');

// Only this isolated preload can send the window-scoped close request. No bridge
// or project commands are exposed to the page, and log content cannot run scripts.
window.addEventListener('DOMContentLoaded', () => {
  const close = document.getElementById('close');
  close.addEventListener('click', () => ipcRenderer.send('logs:close'));
  close.focus();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' || (event.metaKey && event.key.toLowerCase() === 'w')) {
    event.preventDefault();
    ipcRenderer.send('logs:close');
  }
});
