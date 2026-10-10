/**
 * Desktop host shell.
 *
 * The Windows application is a thin wrapper: it starts the exact same local
 * server as `npm start`, then points a normal Chromium window at it. Nothing
 * about the tournament lives in Electron, so the app keeps working if a phone,
 * a tablet or a projector browser is the only client attached.
 *
 * Multi-monitor support is real here: every screen is a proper window that can
 * be pushed to a second or third display from the Window menu.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, shell, screen } = require('electron');
const { join } = require('node:path');

const DEV_URL = process.env.TSB_DEV_URL || '';
let server = null;
let baseUrl = '';
let adminUrl = '';
let shuttingDown = false;
/** Windows that belong to the event (dashboards, displays), keyed by route. */
const windows = new Map();

/* ------------------------------------------------------------------ */
/* Single instance: a second launch focuses the existing host window   */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const first = windows.values().next().value;
    if (first && !first.isDestroyed()) {
      if (first.isMinimized()) first.restore();
      first.focus();
    }
  });

  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(
      'Tournament Scoreboard',
      `The local server could not be started.\n\n${error && error.message ? error.message : String(error)}`,
    );
    app.quit();
  });
}

async function start() {
  const dataDir = join(app.getPath('userData'), 'data');
  const clientDir = join(__dirname, '..', 'dist', 'client');

  // The packaged build starts the compiled server directly; in development the
  // Vite dev server is used and the backend is started separately by `npm run dev`.
  if (DEV_URL) {
    baseUrl = DEV_URL.replace(/\/$/, '');
  } else {
    const { startServer } = require(join(__dirname, '..', 'dist', 'server', 'backend', 'index.js'));
    server = await startServer({
      dataDir,
      clientDir,
      quiet: true,
      autoPort: true,
    });
    baseUrl = server.ready.network.url || server.url;
    adminUrl = server.adminUrl;
  }

  buildMenu(dataDir);
  openWindow('host', '/host', { width: 1500, height: 940 });
  focusMeetingDisplay();
}

/** Open (or focus) a window for one route of the app. */
function openWindow(key, path, options = {}) {
  const existing = windows.get(key);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return existing;
  }

  const win = new BrowserWindow({
    width: options.width || 1100,
    height: options.height || 800,
    minWidth: 420,
    minHeight: 420,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: false,
    title: 'Tournament Scoreboard',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => windows.delete(key));

  // Anything outside the local server opens in the real browser, and the app
  // itself can never be navigated away from its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl) || url.startsWith('http://127.0.0.1')) {
      return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#0b0d10' } };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl) && !url.startsWith('http://127.0.0.1')) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // The host window carries the admin token exactly like the QR link does, so
  // the packaged app never asks for a password on its own machine.
  const target = key === 'host' && adminUrl ? adminUrl : `${baseUrl}${path}`;
  win.loadURL(target);

  if (options.fullscreen) win.setFullScreen(true);

  windows.set(key, win);
  if (options.display) placeOnDisplay(win, options.display);
  return win;
}

/** Move a window to a specific monitor index (1 = second screen). */
function placeOnDisplay(win, index) {
  const displays = screen.getAllDisplays();
  const target = displays[index];
  if (!target) return;
  const bounds = target.bounds;
  win.setBounds({ x: bounds.x + 40, y: bounds.y + 40, width: Math.min(1600, bounds.width - 80), height: Math.min(1000, bounds.height - 80) });
  if (displays.length > 1) win.setFullScreen(true);
}

function focusMeetingDisplay() {
  const displays = screen.getAllDisplays();
  if (displays.length < 2) return;
  // A second screen is almost always the hall projector: put the board on it.
  openWindow('display', '/display', { display: 1, fullscreen: true, width: 1280, height: 720 });
}

/* ------------------------------------------------------------------ */
/* Application menu                                                    */
/* ------------------------------------------------------------------ */

function fieldNames() {
  try {
    const names = server?.store?.state?.settings?.fieldNames;
    if (Array.isArray(names) && names.length > 0) return names.slice(0, 8);
  } catch {
    /* fall through to the default */
  }
  return ['Field 1', 'Field 2'];
}

function buildMenu(dataDir) {
  const displayCount = screen.getAllDisplays().length;
  const names = fieldNames();
  const accelerators = ['CmdOrCtrl+2', 'CmdOrCtrl+3', 'CmdOrCtrl+5', 'CmdOrCtrl+6', 'CmdOrCtrl+7', 'CmdOrCtrl+8', 'CmdOrCtrl+9', 'CmdOrCtrl+0'];

  const template = [
    {
      label: 'Event',
      submenu: [
        {
          label: 'Host dashboard',
          accelerator: 'CmdOrCtrl+1',
          click: () => openWindow('host', '/host'),
        },
        ...names.map((name, index) => ({
          label: `${name} operator`,
          ...(accelerators[index] ? { accelerator: accelerators[index] } : {}),
          click: () => openWindow(`field${index + 1}`, `/field/${index + 1}`, { width: 520, height: 900 }),
        })),
        { type: 'separator' },
        {
          label: names.length > 1 ? `Live display (all ${names.length} fields)` : 'Live display',
          accelerator: 'CmdOrCtrl+4',
          click: () => openWindow('display', '/display', { fullscreen: true }),
        },
        ...names.map((name, index) => ({
          label: `${name} display`,
          click: () => openWindow(`display${index + 1}`, `/display/${index + 1}`, { fullscreen: true }),
        })),
        { label: 'Bracket display', click: () => openWindow('bracket', '/bracket') },
        { label: 'Results & statistics', click: () => openWindow('results', '/results') },
        { label: 'Settings', click: () => openWindow('settings', '/settings') },
        { type: 'separator' },
        { label: 'New tournament…', click: () => openWindow('setup', '/setup') },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Screens',
      submenu: [
        {
          label: displayCount > 1 ? `Send board to screen 2 of ${displayCount}` : 'No second screen detected',
          enabled: displayCount > 1,
          click: () => {
            const win = openWindow('display', '/display', { fullscreen: true });
            placeOnDisplay(win, 1);
          },
        },
        {
          label: 'Send bracket to next screen',
          enabled: displayCount > 1,
          click: () => {
            const win = openWindow('bracket', '/bracket');
            placeOnDisplay(win, displayCount > 2 ? 2 : 1);
          },
        },
        {
          label: 'Toggle fullscreen',
          accelerator: 'F11',
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.setFullScreen(!win.isFullScreen());
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Copy join address',
          click: async () => {
            const { clipboard } = require('electron');
            clipboard.writeText(baseUrl);
            const win = windows.get('host');
            if (win) win.focus();
          },
        },
        { label: 'Open data folder', click: () => void shell.openPath(dataDir) },
        {
          label: 'Network troubleshooting',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'Connecting phones to the scoreboard',
              message: 'Let the scoreboard talk on your private network',
              detail: [
                '1. Windows may ask once whether the app may use the network — allow it on PRIVATE networks.',
                '2. The phone and this PC must be on the same Wi-Fi network.',
                '3. Open the address shown in the dashboard, or scan the QR code.',
                '4. If nothing loads, your router may isolate clients from each other. Turn that off, or use a different access point.',
                '5. Internet access is never required.',
              ].join('\n'),
            }),
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () =>
            dialog.showMessageBox({
              type: 'info',
              title: 'Tournament Scoreboard',
              message: `Tournament Scoreboard ${app.getVersion()}`,
              detail: `Local server: ${baseUrl}\nData folder: ${dataDir}\n\nRuns entirely offline on your own network.`,
            }),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* Shutdown                                                            */
/* ------------------------------------------------------------------ */

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (shuttingDown || !server) return;
  shuttingDown = true;
  event.preventDefault();
  const timeout = setTimeout(() => app.exit(0), 4000);
  if (typeof timeout.unref === 'function') timeout.unref();
  server
    .close()
    .catch(() => undefined)
    .then(() => app.exit(0));
});
