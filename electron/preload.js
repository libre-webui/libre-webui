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
  saveFile: data => ipcRenderer.invoke('save-file', data),

  // System
  openExternal: url => ipcRenderer.send('open-external', url),

  // Landing page choices; the main process only honors these when the
  // bundled landing page itself is the sender.
  landing: {
    launchLocal: () => ipcRenderer.send('landing-launch-local'),
    connect: url => ipcRenderer.invoke('landing-connect', url),
    probeLocal: () => ipcRenderer.invoke('landing-probe-local'),
    openExternal: url => ipcRenderer.send('landing-open-external', url),
  },

  // Events
  onOpenSettings: callback => {
    window.addEventListener('open-settings', callback);
    return () => window.removeEventListener('open-settings', callback);
  },
});

// Let the renderer tune native-only details without turning the entire
// document into a draggable region. App.tsx and Sidebar.tsx own the explicit
// title-bar drag surfaces so page and menu scroll gestures stay interactive.
const markElectronRuntime = () => {
  if (!document.documentElement) return;
  document.documentElement.dataset.runtime = 'electron';
  document.documentElement.dataset.platform = process.platform;
};

if (document.documentElement) {
  markElectronRuntime();
} else {
  document.addEventListener('DOMContentLoaded', markElectronRuntime, {
    once: true,
  });
}
