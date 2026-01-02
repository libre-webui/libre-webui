---
sidebar_position: 1
title: "Electron Desktop App"
description: "Build and run Libre WebUI as a native desktop application for macOS. Complete guide for building, packaging, and distributing the Electron app."
slug: /ELECTRON_DESKTOP_APP
keywords: [libre webui electron, desktop app, macos app, native app, electron build, dmg installer, libre webui desktop, offline ai chat]
image: /img/social/22.png
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# 🖥️ Electron Desktop App

This guide covers building and running Libre WebUI as a native desktop application for macOS using Electron.

## 🎯 Overview

The Electron desktop app provides:

- **Native macOS experience** - Proper window management, menu bar, traffic lights
- **Offline-first design** - Works with local Ollama without internet
- **DMG installer** - Easy drag-and-drop installation
- **Auto-backend detection** - Connects to existing backend or prompts to start one

## 📋 Prerequisites

Before building the desktop app, ensure you have:

1. **Node.js 18+** installed
2. **npm** or **yarn** package manager
3. **Xcode Command Line Tools** (macOS):
   ```bash
   xcode-select --install
   ```
4. **Ollama** installed and running (for AI functionality)

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

### Production Build

Build a distributable macOS app:

```bash
# Build frontend, backend, and create DMG
npm run electron:build
```

The built app will be available at:
- **DMG**: `dist-electron/Libre WebUI-{version}-mac-arm64.dmg`
- **ZIP**: `dist-electron/Libre WebUI-{version}-mac-arm64.zip`

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
│                   Ollama (port 11434)                    │
└─────────────────────────────────────────────────────────┘
```

### Key Files

| File | Description |
|------|-------------|
| `electron/main.js` | Main Electron process |
| `electron/preload.js` | Preload script for security |
| `electron/splash.html` | Splash screen during startup |
| `electron-builder.yml` | Build configuration |

## ⚙️ Configuration

### electron-builder.yml

The build configuration supports:

```yaml
appId: com.librewebui.app
productName: Libre WebUI

mac:
  category: public.app-category.productivity
  target:
    - target: dmg
      arch:
        - arm64  # Apple Silicon
    - target: zip
      arch:
        - arm64
  darkModeSupport: true
  hardenedRuntime: true
```

### Available Scripts

| Script | Description |
|--------|-------------|
| `npm run electron:dev` | Development mode with hot reload |
| `npm run electron:build` | Build production DMG for macOS |
| `npm run electron:pack` | Build without creating installer |

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
- **Traffic light position**: Custom positioned at (15, 15)

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

**Code signing warnings:**
```
skipped macOS application code signing
```
This is normal for development builds. For distribution, you'll need an Apple Developer certificate.

## 📦 Distribution

### Creating a Signed Build

For App Store or notarized distribution:

1. **Get an Apple Developer account**
2. **Create signing certificates** in Xcode
3. **Create entitlements file** at `electron/entitlements.mac.plist`
4. **Configure signing** in `electron-builder.yml`:
   ```yaml
   mac:
     hardenedRuntime: true
     gatekeeperAssess: false
     entitlements: electron/entitlements.mac.plist
     entitlementsInherit: electron/entitlements.mac.plist
   ```

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
  shell.openExternal(url);
  return { action: 'deny' };
});
```

## 🚧 Limitations

### Current Limitations

- **macOS only** - Currently only Apple Silicon (arm64) is supported
- **Requires external backend** - The backend must run separately
- **No auto-updates** - Updates require downloading new DMG

### Future Plans

- Windows and Linux support
- Bundled backend option
- Auto-update functionality
- Universal binary (arm64 + x64)

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

**🚀 Ready to build?** Run `npm run electron:build` and find your DMG in `dist-electron/`.
