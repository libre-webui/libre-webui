/*
 * Libre WebUI - Electron Preload Script
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Platform info
  platform: process.platform,
  isElectron: true,

  // App info
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Window controls
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),

  // File operations
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (data) => ipcRenderer.invoke('save-file', data),

  // System
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Events
  onOpenSettings: (callback) => {
    window.addEventListener('open-settings', callback);
    return () => window.removeEventListener('open-settings', callback);
  },
});

// Add CSS for native-like appearance on macOS
if (process.platform === 'darwin') {
  document.addEventListener('DOMContentLoaded', () => {
    // Add padding for traffic lights
    const style = document.createElement('style');
    style.textContent = `
      body {
        -webkit-app-region: drag;
      }
      input, textarea, button, select, a, [role="button"] {
        -webkit-app-region: no-drag;
      }
      /* Add top padding for macOS title bar */
      .sidebar-header, .main-header {
        padding-top: 28px !important;
      }
    `;
    document.head.appendChild(style);
  });
}
