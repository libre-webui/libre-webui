/*
 * Libre WebUI - Electron Main Process
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const {
  app,
  BrowserWindow,
  shell,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// Get icon path for Linux (icons are in extraResources for production)
const getIconPath = () => {
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    return path.join(__dirname, 'assets', 'icons', '256x256.png');
  }
  return path.join(process.resourcesPath, 'icons', '256x256.png');
};

// Set app icon for Linux About dialog
if (process.platform === 'linux') {
  app.whenReady().then(() => {
    const iconPath = getIconPath();
    app.setAboutPanelOptions({
      applicationName: 'Libre WebUI',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © 2025 Kroonen AI, Inc.',
      iconPath: iconPath,
    });
  });
}

// Prevent multiple instances (fixes fork bomb issue)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Keep references to prevent garbage collection
let mainWindow = null;
let splashWindow = null;
let backendProcess = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const BACKEND_PORT = process.env.PORT || 3001;
const FRONTEND_PORT = 5173;

// Paths
const getResourcePath = (...segments) => {
  if (isDev) {
    return path.join(__dirname, '..', ...segments);
  }
  return path.join(process.resourcesPath, ...segments);
};

// Create splash screen while loading
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 400,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.center();
}

// Create the main application window
function createMainWindow() {
  // Get icon for Linux
  let windowIcon;
  if (process.platform === 'linux') {
    const iconPath = getIconPath();
    windowIcon = nativeImage.createFromPath(iconPath);
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
    icon: windowIcon,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'http:' || target.protocol === 'https:') {
        shell.openExternal(target.toString());
      }
    } catch {
      // Refuse malformed and non-web schemes.
    }
    return { action: 'deny' };
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    if (splashWindow) {
      splashWindow.close();
      splashWindow = null;
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// Where the last landing choice is remembered: {mode: 'local'} or
// {mode: 'remote', url}. Absent means the landing page decides.
const getLandingChoicePath = () =>
  path.join(app.getPath('userData'), 'landing.json');

function readLandingChoice() {
  try {
    const choice = JSON.parse(fs.readFileSync(getLandingChoicePath(), 'utf8'));
    if (choice && choice.mode === 'local') return choice;
    if (
      choice &&
      choice.mode === 'remote' &&
      typeof choice.url === 'string' &&
      /^https?:\/\//.test(choice.url)
    ) {
      return choice;
    }
  } catch {
    // No saved choice, or an unreadable one: the landing page decides.
  }
  return null;
}

function saveLandingChoice(choice) {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getLandingChoicePath(), JSON.stringify(choice));
  } catch (error) {
    console.error('Could not remember the landing choice:', error);
  }
}

// A server qualifies when its health endpoint answers. Both the Docker image
// and a bare `npm run dev:backend` expose /health at the root.
function probeServer(baseUrl) {
  return new Promise(resolve => {
    let target;
    try {
      target = new URL('/health', baseUrl);
    } catch {
      resolve(false);
      return;
    }
    const client = target.protocol === 'https:' ? https : http;
    const request = client.get(target.toString(), response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(5000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

// Only the bundled landing page may steer the window; content loaded from a
// server must not be able to invoke these channels.
const isLandingSender = event => {
  try {
    const senderUrl = new URL(event.senderFrame.url);
    return (
      senderUrl.protocol === 'file:' &&
      senderUrl.pathname.endsWith('/landing.html')
    );
  } catch {
    return false;
  }
};

function loadLocalApp(window) {
  if (isDev) {
    window.loadURL(`http://localhost:${FRONTEND_PORT}`);
    return;
  }
  const frontendPath = getResourcePath('frontend', 'dist', 'index.html');
  window.loadFile(frontendPath).catch(err => {
    console.error('Failed to load frontend:', err);
    dialog.showErrorBox('Load Error', `Could not load app: ${err.message}`);
  });
}

function showLanding(window) {
  window.loadFile(path.join(__dirname, 'landing.html'));
}

// A tolerant version lookup for the setup screen; the system-info endpoint is
// public and answers before any login.
function fetchLocalVersion() {
  return new Promise(resolve => {
    const request = http.get(
      `http://localhost:${BACKEND_PORT}/api/auth/system-info`,
      response => {
        let body = '';
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body).data.version || null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    request.on('error', () => resolve(null));
    request.setTimeout(2000, () => {
      request.destroy();
      resolve(null);
    });
  });
}

function registerLandingHandlers() {
  ipcMain.on('landing-launch-local', event => {
    if (!isLandingSender(event) || !mainWindow) return;
    saveLandingChoice({ mode: 'local' });
    loadLocalApp(mainWindow);
  });

  ipcMain.handle('landing-probe-local', async event => {
    if (!isLandingSender(event)) return { healthy: false, version: null };
    const healthy = await probeServer(`http://localhost:${BACKEND_PORT}`);
    const version = healthy ? await fetchLocalVersion() : null;
    return { healthy, version };
  });

  // The preload has always exposed getVersion; answer it.
  ipcMain.handle('get-version', () => app.getVersion());

  // The landing page's guidance links only; arbitrary pages stay out.
  const LANDING_LINKS = new Set([
    'https://docs.librewebui.org/DOCKER/',
    'https://docs.docker.com/get-docker/',
    'https://ollama.com/download',
    'https://librewebui.org',
    'https://docs.librewebui.org',
    'https://kroonen.ai',
  ]);
  ipcMain.on('landing-open-external', (event, url) => {
    if (!isLandingSender(event)) return;
    if (LANDING_LINKS.has(url)) shell.openExternal(url);
  });

  ipcMain.handle('landing-connect', async (event, rawUrl) => {
    if (!isLandingSender(event) || !mainWindow) {
      return { ok: false, error: 'Not available right now.' };
    }
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch {
      return { ok: false, error: 'That is not a valid address.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: 'The address must start with http or https.' };
    }
    const base = url.toString().replace(/\/+$/, '');
    if (!(await probeServer(base))) {
      return {
        ok: false,
        error: 'No Libre WebUI server answered at that address.',
      };
    }
    saveLandingChoice({ mode: 'remote', url: base });
    mainWindow.loadURL(base);
    return { ok: true };
  });
}

registerLandingHandlers();

// Check if backend is running
async function checkBackend() {
  return new Promise(resolve => {
    const req = http.get(`http://localhost:${BACKEND_PORT}/api/health`, res => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Start backend in a new Terminal window (macOS)
function startBackendInTerminal() {
  const projectRoot = isDev
    ? path.join(__dirname, '..')
    : path.join(process.resourcesPath, '..');

  // Use AppleScript to open Terminal and run the backend
  const script = `
    tell application "Terminal"
      activate
      do script "cd '${projectRoot}' && npm run dev:backend"
    end tell
  `;

  backendProcess = spawn('osascript', ['-e', script], {
    detached: true,
    stdio: 'ignore',
  });

  backendProcess.unref();
  console.log('Started backend in Terminal');
}

// Stop backend process
function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

// Create application menu
function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(
                'window.dispatchEvent(new CustomEvent("open-settings"))'
              );
            }
          },
        },
        {
          label: 'Switch Server…',
          click: () => {
            fs.rmSync(getLandingChoicePath(), { force: true });
            if (mainWindow) showLanding(mainWindow);
          },
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Documentation',
          click: () => shell.openExternal('https://librewebui.org'),
        },
        {
          label: 'GitHub',
          click: () =>
            shell.openExternal('https://github.com/libre-webui/libre-webui'),
        },
        { type: 'separator' },
        {
          label: 'Report Issue',
          click: () =>
            shell.openExternal(
              'https://github.com/libre-webui/libre-webui/issues'
            ),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// Main application startup
async function main() {
  createSplashWindow();
  createMenu();

  try {
    // Check if backend is available
    const backendAvailable = await checkBackend();
    if (backendAvailable) {
      console.log('Backend server detected on port', BACKEND_PORT);
    } else {
      console.log(
        'Backend not detected - please start it manually with: npm run dev:backend'
      );
      // Disabled auto-start in Terminal for now
      // startBackendInTerminal();
    }

    // Create main window
    const window = createMainWindow();

    // The landing page decides on first launch; afterwards the remembered
    // choice routes straight in. A remembered server that stops answering
    // returns to the landing page rather than a blank window.
    const choice = readLandingChoice();
    if (!choice) {
      showLanding(window);
    } else if (choice.mode === 'remote') {
      if (await probeServer(choice.url)) {
        window.loadURL(choice.url);
      } else {
        showLanding(window);
      }
    } else {
      loadLocalApp(window);
    }

    // Open DevTools in dev mode
    if (isDev) {
      window.webContents.openDevTools();
    }
  } catch (error) {
    console.error('Failed to start application:', error);
    dialog.showErrorBox(
      'Startup Error',
      `Failed to start Libre WebUI: ${error.message}\n\nPlease check the logs and try again.`
    );
    app.quit();
  }
}

// App lifecycle events
app.whenReady().then(main);

// Focus existing window if second instance tries to launch
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    main();
  }
});

// Handle certificate errors for localhost
app.on(
  'certificate-error',
  (event, _webContents, url, _error, _certificate, callback) => {
    if (url.startsWith('https://localhost')) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  }
);
