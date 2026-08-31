/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.tsx';
import { applyDocumentLanguage, i18nReady } from './i18n';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>
  );
};

void i18nReady
  .catch(() => {
    // Keep the application usable if translation initialization fails entirely.
    applyDocumentLanguage('en');
  })
  .then(renderApp);

// A stale client (open tab or cached shell) can ask for a lazy chunk a newer
// deployment no longer serves; the failed dynamic import would silently kill
// that subtree ("half the page disappears"). Vite announces the failure —
// recover by reloading once, which fetches the current shell network-first.
// The sessionStorage latch prevents a reload loop when the network itself is
// the problem, and clears after a healthy minute.
window.addEventListener('vite:preloadError', event => {
  const LATCH = 'libre:chunk-reload';
  if (sessionStorage.getItem(LATCH)) return;
  event.preventDefault();
  sessionStorage.setItem(LATCH, String(Date.now()));
  window.location.reload();
});
window.setTimeout(() => {
  sessionStorage.removeItem('libre:chunk-reload');
}, 60_000);

// Production only: the dev server serves fresh modules directly, and a dev
// service worker would fight both Vite and the e2e route mocks.
// The version query keys the service worker's cache to this build, so every
// release installs fresh and prunes the previous release's assets.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const version = encodeURIComponent(
      String(import.meta.env.VITE_APP_VERSION || 'v1')
    );
    navigator.serviceWorker.register(`/sw.js?v=${version}`).catch(() => {
      // Offline shell and push are progressive enhancements.
    });
  });
}
