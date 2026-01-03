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

const { app, BrowserWindow, shell, Menu, dialog, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    show: false,
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
    shell.openExternal(url);
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

// Check if backend is running
async function checkBackend() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${BACKEND_PORT}/api/health`, (res) => {
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
          click: () => shell.openExternal('https://github.com/libre-webui/libre-webui'),
        },
        { type: 'separator' },
        {
          label: 'Report Issue',
          click: () => shell.openExternal('https://github.com/libre-webui/libre-webui/issues'),
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
      console.log('Backend not detected - please start it manually with: npm run dev:backend');
      // Disabled auto-start in Terminal for now
      // startBackendInTerminal();
    }

    // Create main window
    const window = createMainWindow();

    // Load the app
    if (isDev) {
      // In development, load from Vite dev server
      window.loadURL(`http://localhost:${FRONTEND_PORT}`);
    } else {
      // In production, load the built frontend
      const frontendPath = getResourcePath('frontend', 'dist', 'index.html');
      console.log('Loading frontend from:', frontendPath);
      window.loadFile(frontendPath).catch((err) => {
        console.error('Failed to load frontend:', err);
        dialog.showErrorBox('Load Error', `Could not load app: ${err.message}`);
      });
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
app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  if (url.startsWith('https://localhost')) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});
