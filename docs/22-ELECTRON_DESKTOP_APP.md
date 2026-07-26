---
sidebar_position: 1
title: 'Electron Desktop App'
description: 'Build and run the Libre WebUI frontend as an Electron desktop application for macOS, Windows, and Linux.'
slug: /ELECTRON_DESKTOP_APP
keywords:
  [
    libre webui electron,
    desktop app,
    macos app,
    windows app,
    linux app,
    native app,
    electron build,
    dmg installer,
    libre webui desktop,
    offline ai chat,
  ]
image: /img/social/22.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# 🖥️ Electron Desktop App

This guide covers building and running the Libre WebUI frontend as an Electron
desktop application for macOS, Windows, and Linux.

## 🎯 Overview

The Electron desktop app provides:

- **Desktop window integration** - Native window management and application menus
- **Offline-first design** - Works with local Ollama without internet
- **Platform packages** - DMG/ZIP, Windows Setup/portable EXE, AppImage, and DEB targets
- **Backend detection** - Connects to an existing backend and logs manual start instructions when it is absent

## 📋 Prerequisites

Before building the desktop app, ensure you have:

1. **Node.js 22.22+** installed
2. **npm** or **yarn** package manager
3. The build tools required by the target operating system. On macOS, install
   **Xcode Command Line Tools**:
   ```bash
   xcode-select --install
   ```
4. A separately running Libre WebUI backend connected to Ollama or configured
   model-provider plugins

To use Work, also install and start Docker on the machine running the backend.
Docker is not bundled in the desktop application.

## 🚀 Quick Start

### Development Mode

Run the app in development mode with hot reloading:

```bash
# Start both frontend and Electron together
npm run electron:dev
```

This will:

- Start the Vite development server on port 5173
- Wait for the frontend to be ready
- Launch Electron pointing to the dev server

### Production Builds

Build on the operating system matching the desired package:

```bash
# macOS arm64: DMG and ZIP
npm run electron:build

# Windows: Setup and portable EXE
npm run electron:build:win

# Linux: AppImage and DEB
npm run electron:build:linux
```

Packages are written to `dist-electron/`. The configured release names are:

- macOS: `Libre-WebUI-Frontend-{version}-mac-arm64.dmg` and `.zip`
- Windows: `Libre-WebUI-Frontend-Setup-{version}.exe` and
  `Libre-WebUI-Frontend-{version}.exe`
- Linux: `Libre-WebUI-Frontend-{version}.AppImage` and
  `Libre-WebUI-Frontend-{version}-{arch}.deb`

## 🏗️ Architecture

### How It Works

```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────┐    ┌─────────────────────────────┐ │
│  │   Main Process  │    │       Renderer Process       │ │
│  │   (Node.js)     │    │    (React Frontend)          │ │
│  │                 │    │                               │ │
│  │  • Window mgmt  │    │  • UI rendering               │ │
│  │  • Menu bar     │    │  • API calls to backend       │ │
│  │  • Backend check│    │  • WebSocket connection       │ │
│  └─────────────────┘    └─────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│                     Communicates with                    │
│              External Backend (port 3001)                │
│                         ↓                                │
│             Ollama or configured model provider         │
└─────────────────────────────────────────────────────────┘
```

### Work in the Desktop App

The Electron package is a frontend client. It does not bundle the Libre WebUI
backend, Docker, or a Work container runtime. Work availability is determined
by the separately running backend:

- a native backend that can run `docker info` can create task-scoped Work
  containers and named volumes;
- a backend running in the standard Libre WebUI Docker image reports Work as
  unavailable; and
- the Electron app continues to support Chat when Work is unavailable.

Work files live on the backend's Docker host, not inside the Electron app. The
embedded preview uses a dynamically assigned loopback port on that backend host,
so preview works only when the desktop client and backend are on the same
machine. A custom Electron build pointed at a remote backend can still use Work
conversation and file APIs, but it cannot reach that server's loopback preview
URL.

### Key Files

| File                   | Description                  |
| ---------------------- | ---------------------------- |
| `electron/main.js`     | Main Electron process        |
| `electron/preload.js`  | Preload script for security  |
| `electron/splash.html` | Splash screen during startup |
| `electron-builder.yml` | Build configuration          |

## ⚙️ Configuration

### electron-builder.yml

The build configuration supports:

```yaml
appId: com.librewebui.app
productName: Libre WebUI Frontend

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch:
        - arm64 # Apple Silicon
    - target: zip
      arch:
        - arm64
  darkModeSupport: true
  hardenedRuntime: true
```

### Available Scripts

| Script                         | Description                                |
| ------------------------------ | ------------------------------------------ |
| `npm run electron:dev`         | Development mode with hot reload           |
| `npm run electron:build`       | Build macOS arm64 DMG and ZIP              |
| `npm run electron:build:win`   | Build Windows Setup and portable EXE       |
| `npm run electron:build:linux` | Build Linux AppImage and DEB               |
| `npm run electron:verify:mac`  | Verify the packaged macOS application      |
| `npm run electron:pack`        | Build unpacked output without an installer |

## 🎨 macOS Integration

### Title Bar

The app uses a custom title bar style (`hiddenInset`) for a native macOS look:

- Traffic light buttons integrated into the sidebar
- Extra padding added to avoid overlap with controls
- Draggable title bar area for window movement

### Window Features

- **Minimum size**: 800x600 pixels
- **Default size**: 1400x900 pixels
- **Dark mode support**: Follows system preference
- **Traffic light position**: Custom positioned at (12, 12)

### Menu Bar

Full native menu bar with:

- App menu (About, Preferences, Quit)
- Edit menu (Undo, Redo, Cut, Copy, Paste)
- View menu (Reload, DevTools, Zoom)
- Window menu (Minimize, Zoom, Full Screen)
- Help menu (Documentation, GitHub, Report Issue)

## 🔧 Troubleshooting

### Common Issues

**1. App shows "Connecting to backend..." forever**

The backend needs to be running separately. Start it with:

```bash
npm run dev:backend
```

Or run the full development environment:

```bash
npm run dev
```

**2. Click events not working in sidebar**

This was fixed by adding `-webkit-app-region: no-drag` to interactive elements. If you experience this, ensure you have the latest version.

**3. Logo/icons not displaying**

Assets need relative paths for file:// protocol. Use `./logo.png` instead of `/logo.png`.

**4. Navigation doesn't work after clicking**

The app uses HashRouter instead of BrowserRouter for file:// protocol compatibility. This is handled automatically.

### Build Errors

**SQLite/SQLCipher compilation errors:**

```bash
# Clear npm cache and rebuild
rm -rf node_modules
npm install
npm run electron:build
```

**macOS blocks the downloaded application as damaged:**

Libre WebUI temporarily uses an ad-hoc signature for macOS builds. This keeps
the application bundle structurally valid, but it does not identify the
publisher to Apple and cannot be notarized. After copying the application to
Applications, approve it in **System Settings → Privacy & Security → Open
Anyway**.

If macOS does not offer that option, remove the quarantine attribute only after
verifying that the application came from the official Libre WebUI release:

```bash
xattr -dr com.apple.quarantine "/Applications/Libre WebUI Frontend.app"
open "/Applications/Libre WebUI Frontend.app"
```

Do not disable Gatekeeper globally. Seamless distribution still requires a
Developer ID Application certificate and Apple notarization.

## 📦 Distribution

### Creating a Signed Build

For App Store or notarized distribution:

1. **Get an Apple Developer account**
2. **Create signing certificates** in Xcode
3. **Create entitlements file** at `electron/entitlements.mac.plist`
4. **Remove the temporary `identity: '-'` override** and configure signing in
   `electron-builder.yml`:

   ```yaml
   mac:
     hardenedRuntime: true
     gatekeeperAssess: false
     entitlements: electron/entitlements.mac.plist
     entitlementsInherit: electron/entitlements.mac.plist
     notarize: true
   ```

5. **Provide CI credentials** through `CSC_LINK`, `CSC_KEY_PASSWORD`, and one
   of electron-builder's supported Apple notarization credential sets.

### GitHub Releases

The build configuration includes GitHub release support:

```yaml
publish:
  provider: github
  owner: libre-webui
  repo: libre-webui
```

To publish a release:

```bash
# Build and publish
npm run electron:build -- --publish always
```

## 🔐 Security

### Context Isolation

The app uses proper security practices:

```javascript
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  webSecurity: true,
  preload: path.join(__dirname, 'preload.js'),
}
```

### External Links

External links are opened in the default browser, not inside the app:

```javascript
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
```

## 🚧 Limitations

### Current Limitations

- **macOS architecture** - Current macOS packages support Apple Silicon
  (`arm64`) only; Windows and Linux have their own configured build targets
- **Requires external backend** - The backend must run separately
- **Work depends on backend Docker** - The desktop package does not include a
  container runtime
- **No auto-updates** - Updates require downloading and installing a new package

### Future Plans

- Bundled backend option
- Auto-update functionality
- Universal macOS binary (arm64 + x64)

## 📊 Technical Details

### Bundle Contents

The built app includes:

- Electron framework (~200MB)
- Built frontend (~2MB)
- Plugin configurations (~50KB)
- Assets and icons

### Performance

- **Startup time**: ~2-3 seconds
- **Memory usage**: ~150-300MB (depends on chat history)
- **Disk space**: ~250MB installed

---

**🚀 Ready to build?** Run the platform command above and find the package in
`dist-electron/`.

See [Work: Isolated Workspaces](./WORKSPACES) for runtime, provider, storage, and
preview security details.
