/**
 * Demo mode detection utilities
 * Detects if the application is running in demo mode (e.g., deployed to Vercel for presentation)
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
    if (hostname.includes('vercel.app') || hostname.includes('vercel.dev')) {
      return true;
    }

    // Netlify deployment
    if (hostname.includes('netlify.app') || hostname.includes('netlify.com')) {
      return true;
    }

    // GitHub Pages
    if (hostname.includes('github.io')) {
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
