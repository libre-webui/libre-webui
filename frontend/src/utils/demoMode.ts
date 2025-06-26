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

/**
 * Check if the app is running in demo mode
 * This can be detected by:
 * 1. Environment variable VITE_DEMO_MODE
 * 2. Hostname containing vercel.app
 * 3. Hostname containing netlify.app
 * 4. Any other demo deployment indicators
 */
export const isDemoMode = (): boolean => {
  // Check explicit demo mode environment variable
  if (import.meta.env.VITE_DEMO_MODE === 'true') {
    return true;
  }

  // Check if running on common demo hosting platforms
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;

    // Vercel deployment
    const allowedVercelHosts = ['vercel.app', 'www.vercel.app', 'vercel.dev', 'www.vercel.dev'];
    if (allowedVercelHosts.includes(hostname)) {
      return true;
    }

    // Netlify deployment
    const allowedNetlifyHosts = ['netlify.app', 'www.netlify.app', 'netlify.com', 'www.netlify.com'];
    if (allowedNetlifyHosts.includes(hostname)) {
      return true;
    }

    // GitHub Pages
    const allowedGitHubHosts = ['github.io', 'www.github.io'];
    if (allowedGitHubHosts.includes(hostname)) {
      return true;
    }

    // Other common demo domains
    if (hostname.includes('demo.') || hostname.includes('preview.')) {
      return true;
    }
  }

  return false;
};

/**
 * Get demo mode configuration
 */
export const getDemoConfig = () => {
  return {
    isDemo: isDemoMode(),
    message:
      'This is a demo version for presentation purposes only. The Ollama backend is not connected.',
    showBanner: true,
    allowInteraction: false, // Set to true if you want to allow UI interaction in demo mode
  };
};

/**
 * Check if backend is likely available (not in demo mode)
 */
export const isBackendAvailable = (): boolean => {
  return !isDemoMode();
};
