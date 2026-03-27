// electron/src/main.js
// Minimal production-oriented Electron child app (embedded UI)
// Edit DEVICE_CONTROL_FN_URL or START_URL if needed.

const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const Store = require('electron-store');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');

const DEVICE_CONTROL_FN_URL = 'https://vjvzvigfsicyrzyfudgc.supabase.co/functions/v1/device-control'; // your deployed Edge function
const START_URL = process.env.START_URL || 'https://duckduckgo.com';

const store = new Store({
  schema: {
    deviceId: { type: 'string' },
    pairingCode: { type: 'string' },
    pairingCodeCreatedAt: { type: 'number' },
    deviceToken: { type: 'string' },
    deviceTokenExpiresAt: { type: 'string' }
  }
});

function generatePairingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function ensureDeviceRecord() {
  if (!store.get('deviceId')) store.set('deviceId', uuidv4());
  const now = Date.now();
  const createdAt = store.get('pairingCodeCreatedAt') || 0;
  if (!store.get('pairingCode') || now - createdAt > 1000 * 60 * 10) {
    const code = generatePairingCode();
    store.set('pairingCode', code);
    store.set('pairingCodeCreatedAt', now);
    // Inform Edge Function to ensure a devices row exists (non-privileged helper action)
    try {
      if (DEVICE_CONTROL_FN_URL) {
        await fetch(DEVICE_CONTROL_FN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'ensure_device', device_id: store.get('deviceId'), pairing_code: code })
        }).catch(() => {});
      }
    } catch (e) {}
  } else {
    // touch last_seen for monitoring
    try {
      if (DEVICE_CONTROL_FN_URL) {
        await fetch(DEVICE_CONTROL_FN_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'touch', device_id: store.get('deviceId') })
        }).catch(() => {});
      }
    } catch (e) {}
  }
}

let mainWindow, view, overlayWin = null, locked = false;

async function createMainWindow() {
  await ensureDeviceRecord();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const topbarHtml = `
    <!doctype html><html><head><meta charset="utf-8"/><title>Child</title>
    <style>
      body{margin:0;font-family:Arial}
      .topbar{height:70px;display:flex;align-items:center;padding:10px;gap:12px;background:#f5f7fb;border-bottom:1px solid #e6e9ef}
      .pairing{flex:1}
      .controls{display:flex;gap:8px}
      .controls input{width:420px;padding:8px;border-radius:6px;border:1px solid #ddd}
      .controls button{padding:8px 12px;border-radius:6px;background:#1a73e8;color:#fff;border:none;cursor:pointer}
    </style></head><body>
      <div class="topbar">
        <div class="pairing"><div id="device">Loading pairing...</div><div id="pair"></div></div>
        <div class="controls">
          <input id="url" placeholder="Enter URL" />
          <button id="go">Go</button>
          <button id="request">Request More Time</button>
          <button id="setToken">Set Device Token</button>
        </div>
      </div>
      <script>
        async function init() {
          const p = await window.electronAPI.getPairing();
          document.getElementById('device').innerText = 'Device ID: ' + p.deviceId;
          document.getElementById('pair').innerText = 'Pairing code: ' + p.pairingCode + ' (10m)';
        }
        document.getElementById('go').addEventListener('click', async () => {
          const url = document.getElementById('url').value || '${START_URL}';
          await window.electronAPI.navigateTo(url);
        });
        document.getElementById('request').addEventListener('click', async () => {
          const reason = prompt('Why do you need more time?') || 'Requesting more time';
          const resp = await window.electronAPI.requestMoreTime(reason);
          alert(resp.ok ? 'Request sent.' : ('Error: ' + (resp.error || 'unknown')));
        });
        document.getElementById('setToken').addEventListener('click', async () => {
          const token = prompt('Paste device token from management portal:');
          if (!token) return;
          const expiresAt = prompt('Token expires at (ISO) or leave blank:');
          await window.electronAPI.setDeviceToken(token, expiresAt || null);
          alert('Device token saved.');
        });
        init();
      </script>
    </body></html>
  `;

  mainWindow.loadURL('data:text/html,' + encodeURIComponent(topbarHtml));

  view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  });

  mainWindow.setBrowserView(view);
  const { width, height } = mainWindow.getBounds();
  view.setBounds({ x: 0, y: 70, width: width, height: height - 70 });
  view.setAutoResize({ width: true, height: true });

  await view.webContents.loadURL(START_URL);

  view.webContents.on('did-navigate', async (_e, url) => {
    try {
      const token = store.get('deviceToken');
      if (!DEVICE_CONTROL_FN_URL || !token) return;
      await fetch(DEVICE_CONTROL_FN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
        body: JSON.stringify({ action: 'write_history', url })
      }).catch(() => {});
    } catch (err) { console.error('history error', err); }
  });

  // poll device_controls
  setInterval(async () => {
    try {
      if (!DEVICE_CONTROL_FN_URL) return;
      const deviceId = store.get('deviceId');
      const res = await fetch(DEVICE_CONTROL_FN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'get_control', device_id: deviceId })
      });
      if (!res.ok) return;
      const j = await res.json().catch(() => ({}));
      const lockUntil = j?.screen_locked_until ? new Date(j.screen_locked_until) : null;
      if (lockUntil && lockUntil > new Date()) {
        if (!locked) await showLockOverlay('Screen time is over');
      } else {
        if (locked) removeLockOverlay();
      }
    } catch (e) {}
  }, 3000);
}

app.whenReady().then(createMainWindow);

async function showLockOverlay(message = 'Screen time ended') {
  if (overlayWin) return;
  locked = true;
  overlayWin = new BrowserWindow({
    width: 900,
    height: 600,
    frame: false,
    fullscreenable: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    modal: true,
    parent: mainWindow,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });

  overlayWin.setMenuBarVisibility(false);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setFullScreenable(false);

  const html = `
    <!doctype html><html><head><meta charset="utf-8"/><title>Locked</title>
    <style>body{font-family:Arial;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fff}.card{max-width:640px;padding:24px;border-radius:8px;border:1px solid #eee;text-align:center}button{padding:10px 14px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer}</style>
    </head><body>
      <div class="card">
        <h1>${message}</h1>
        <p>Your screen time has ended. Request more time from a parent.</p>
        <button id="req">Request more time</button>
      </div>
      <script>
        document.getElementById('req').addEventListener('click', () => {
          const reason = prompt('Why do you need more time?') || 'Requesting more time';
          window.postMessage({ type: 'request-more-time', reason }, '*');
        });
      </script>
    </body></html>
  `;
  overlayWin.loadURL('data:text/html,' + encodeURIComponent(html));

  overlayWin.on('close', (e) => { if (locked) e.preventDefault(); });
  mainWindow.on('close', (e) => { if (locked) e.preventDefault(); });

  globalShortcut.register('Alt+F4', () => {});
  globalShortcut.register('CommandOrControl+W', () => {});
  globalShortcut.register('F11', () => {});
  globalShortcut.register('CommandOrControl+Shift+I', () => {});
}

function removeLockOverlay() {
  locked = false;
  try {
    if (overlayWin && !overlayWin.isDestroyed()) {
      globalShortcut.unregisterAll();
      overlayWin.removeAllListeners('close');
      overlayWin.close();
      overlayWin = null;
    }
  } catch (err) { console.error('removeLockOverlay', err); }
}

app.on('window-all-closed', () => app.quit());

// IPC handlers
ipcMain.handle('get-pairing', async () => {
  await ensureDeviceRecord();
  return {
    deviceId: store.get('deviceId'),
    pairingCode: store.get('pairingCode'),
    pairingCodeCreatedAt: store.get('pairingCodeCreatedAt'),
    deviceToken: store.get('deviceToken') || null,
    deviceTokenExpiresAt: store.get('deviceTokenExpiresAt') || null
  };
});

ipcMain.handle('navigate-to', async (_, url) => {
  try {
    if (!view || !url) return { ok: false, error: 'no-view-or-url' };
    await view.webContents.loadURL(url);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('request-more-time', async (_, { reason }) => {
  try {
    const token = store.get('deviceToken');
    if (!DEVICE_CONTROL_FN_URL || !token) return { ok: false, error: 'no-device-token-or-fn' };
    const res = await fetch(DEVICE_CONTROL_FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({ action: 'request', reason })
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, error: j?.error || res.statusText };
    }
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('set-device-token', async (_, { token, expiresAt }) => {
  store.set('deviceToken', token);
  if (expiresAt) store.set('deviceTokenExpiresAt', expiresAt);
  return { ok: true };
});

ipcMain.on('overlay-request-more-time', async (_, payload) => {
  try {
    const token = store.get('deviceToken');
    if (!DEVICE_CONTROL_FN_URL || !token) return;
    await fetch(DEVICE_CONTROL_FN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: JSON.stringify({ action: 'request', reason: payload?.reason || 'Requesting more time' })
    }).catch(() => {});
  } catch (err) {
    console.error('overlay request error', err);
  }
});
