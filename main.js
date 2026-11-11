'use strict';
/**
 * Tactical Comms desktop overlay (Electron).
 *
 *   npm install --save-dev electron
 *   npm start                      (terminal 1: the room server)
 *   npm run overlay                (terminal 2: the overlay)
 *
 * Options (CLI flag or env var):
 *   --server=http://host:3000   TACTICAL_SERVER   room server to load (default http://localhost:3000)
 *   --key=`                     TACTICAL_KEY      global toggle key (Electron accelerator, default `)
 *
 * Behaviour
 *   - A transparent, frameless, always-on-top window covers the primary display.
 *   - Hidden state: fully click-through and never takes focus, so your game keeps the mouse
 *     and keyboard. Only incoming-interaction flashes and notification banners are drawn.
 *   - Press the toggle key: the HUD (room panel + radial menu) appears and captures the mouse.
 *     Pick a command / press ESC / press the key again and it collapses back to click-through.
 *   - Ctrl+Shift+Q quits.
 */
const path = require('path');
const { app, BrowserWindow, globalShortcut, screen, ipcMain } = require('electron');

const argv = process.argv.slice(1);
function arg(name, fallback) {
  const prefix = `--${name}=`;
  const a = argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : fallback;
}

const SERVER = process.env.TACTICAL_SERVER || arg('server', 'http://localhost:3000');
const TOGGLE_KEY = process.env.TACTICAL_KEY || arg('key', '`');
const QUIT_KEY = 'CommandOrControl+Shift+Q';

let serverOrigin;
try {
  const u = new URL(SERVER);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('bad protocol');
  serverOrigin = u.origin;
} catch {
  console.error(`Invalid --server value: ${SERVER} (expected http://host:port or https://host)`);
  process.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let win = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** interactive = HUD visible and capturing mouse/keyboard; otherwise click-through and unfocusable. */
function applyInteractive(on) {
  if (!win || win.isDestroyed()) return;
  if (on) {
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.show();
    win.focus();
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
    win.blur();            // hand focus back to the game
    win.setFocusable(false);
  }
}

function showErrorAndRetry() {
  if (!win || win.isDestroyed()) return;
  const html =
    '<body style="margin:0;background:transparent;font:600 13px sans-serif;color:#fff">' +
    '<div style="position:fixed;top:24px;left:50%;transform:translateX(-50%);background:rgba(8,10,12,.88);' +
    'border:1px solid rgba(255,255,255,.2);border-top:2px solid #ef4444;padding:10px 22px;letter-spacing:.06em;white-space:nowrap">' +
    `CANNOT REACH ${esc(SERVER)} - RETRYING... (CTRL+SHIFT+Q TO QUIT)</div></body>`;
  applyInteractive(false);
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
  setTimeout(() => {
    if (win && !win.isDestroyed()) win.loadURL(SERVER).catch(() => {});
  }, 3000);
}

function createWindow() {
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds;
  win = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');                          // above borderless-fullscreen games
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); // macOS spaces / fullscreen apps

  // The page is an http(s) page: keep it on the room server and block pop-ups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(serverOrigin) && !url.startsWith('data:')) e.preventDefault();
  });
  win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) showErrorAndRetry(); // -3 = aborted (benign)
  });

  win.once('ready-to-show', () => win.show());
  win.loadURL(SERVER).catch(() => {});
}

ipcMain.on('overlay:interactive', (e, on) => {
  if (win && e.sender === win.webContents) applyInteractive(Boolean(on));
});
ipcMain.on('overlay:quit', (e) => {
  if (win && e.sender === win.webContents) app.quit();
});

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();
  createWindow();

  const ok = globalShortcut.register(TOGGLE_KEY, () => {
    if (win && !win.isDestroyed()) win.webContents.send('overlay:toggle');
  });
  if (!ok) {
    console.warn(`Could not register global toggle key "${TOGGLE_KEY}" (in use by another app?). Try --key=F8`);
  }
  globalShortcut.register(QUIT_KEY, () => app.quit());
  console.log(`Overlay running -> ${SERVER}  |  toggle: ${TOGGLE_KEY}  |  quit: Ctrl+Shift+Q`);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
