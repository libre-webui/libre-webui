import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

dotenv.config();

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, 'package.json'), 'utf-8')
);

// Get version - use VITE_APP_VERSION env var if set (Docker builds), otherwise detect git branch
const getVersion = () => {
  // If explicitly set via environment (Docker CI builds)
  if (process.env.VITE_APP_VERSION) {
    return process.env.VITE_APP_VERSION;
  }

  // Try to detect git branch for local dev
  try {
    const gitDir = path.resolve(import.meta.dirname, '../.git');
    if (existsSync(gitDir)) {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: path.resolve(import.meta.dirname, '..'),
        encoding: 'utf-8',
      }).trim();
      if (branch === 'dev') {
        const commitHash = execSync('git rev-parse --short HEAD', {
          cwd: path.resolve(import.meta.dirname, '..'),
          encoding: 'utf-8',
        }).trim();
        return `${packageJson.version}-dev (${commitHash})`;
      }
    }
  } catch {
    // Git not available, use package.json version
  }

  return packageJson.version;
};

const appVersion = getVersion();

// Latest released section of the root CHANGELOG, embedded for the
// What's New dialog. Falls back to null when the file is absent (e.g.
// standalone frontend builds).
const getLatestReleaseNotes = () => {
  try {
    const changelog = readFileSync(
      path.resolve(import.meta.dirname, '../CHANGELOG.md'),
      'utf-8'
    );
    const headings = [
      ...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] - (\S+)\s*$/gm),
    ];
    if (headings.length === 0) return null;
    const [first, second] = headings;
    const start = (first.index ?? 0) + first[0].length;
    const end = second?.index ?? changelog.length;
    return {
      version: first[1],
      date: first[2],
      body: changelog.slice(start, end).trim(),
    };
  } catch {
    return null;
  }
};

const API_BASE_URL = process.env.VITE_API_BASE_URL || 'http://localhost:3001';
const WS_BASE_URL = process.env.VITE_WS_BASE_URL || 'ws://localhost:3001';

// Use relative paths for Electron builds
const isElectron = process.env.ELECTRON_BUILD === 'true';

// https://vitejs.dev/config/
/**
 * The artifact sandbox runs on an opaque origin, so it fetches the vendored
 * runtime with `Origin: null`, and module scripts are always fetched in CORS
 * mode. Production serves these headers from the backend; this does the same
 * for the dev server.
 */
const artifactRuntimeHeaders = () => ({
  name: 'libre-artifact-runtime-headers',
  configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
    server.middlewares.use(
      (
        req: { url?: string },
        res: { setHeader: (name: string, value: string) => void },
        next: () => void
      ) => {
        if (req.url?.startsWith('/artifact-runtime/')) {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        }
        next();
      }
    );
  },
});

/** The artifact runtime build stamp, or a placeholder before it is built. */
const artifactRuntimeFingerprint = (): string => {
  try {
    return readFileSync(
      path.resolve(import.meta.dirname, 'public/artifact-runtime/.build-fingerprint'),
      'utf-8'
    )
      .trim()
      .slice(0, 16);
  } catch {
    return 'dev';
  }
};

export default defineConfig({
  plugins: [react(), artifactRuntimeHeaders()],
  base: isElectron ? './' : '/',
  define: {
    // Identifies the artifact runtime build, so a cached bundle from an
    // earlier release cannot answer for the current one. Read from the stamp
    // the runtime build writes rather than kept in a generated source file.
    __ARTIFACT_RUNTIME_FINGERPRINT__: JSON.stringify(
      artifactRuntimeFingerprint()
    ),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
    __LATEST_RELEASE_NOTES__: JSON.stringify(getLatestReleaseNotes()),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  server: {
    host: false, // Allow --host flag to override
    port: 5173, // Default port, can be overridden by --port flag
    proxy: {
      '/api': {
        target: API_BASE_URL,
        changeOrigin: true,
      },
      '/ws': {
        target: WS_BASE_URL,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // Disable sourcemaps for production
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom')) return 'react-vendor';
          if (id.includes('node_modules/react/')) return 'react-vendor';
          if (id.includes('node_modules/react-router')) return 'router-vendor';
          if (
            id.includes('node_modules/lucide-react') ||
            id.includes('node_modules/react-hot-toast')
          )
            return 'ui-vendor';
          if (
            id.includes('node_modules/react-syntax-highlighter') ||
            id.includes('node_modules/refractor') ||
            id.includes('node_modules/prismjs')
          )
            return 'syntax-highlight';
          if (
            id.includes('node_modules/remark-math') ||
            id.includes('node_modules/rehype-katex') ||
            id.includes('node_modules/katex') ||
            id.includes('node_modules/micromark-extension-math') ||
            id.includes('node_modules/mdast-util-math')
          )
            return 'markdown-math';
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/remark-') ||
            id.includes('node_modules/rehype-') ||
            id.includes('node_modules/unified') ||
            id.includes('node_modules/micromark') ||
            id.includes('node_modules/mdast-util-') ||
            id.includes('node_modules/hast-util-') ||
            id.includes('node_modules/unist-util-') ||
            id.includes('node_modules/vfile') ||
            id.includes('node_modules/property-information') ||
            id.includes('node_modules/space-separated-tokens') ||
            id.includes('node_modules/comma-separated-tokens') ||
            id.includes('node_modules/html-url-attributes') ||
            id.includes('node_modules/devlop')
          )
            return 'markdown-core';
          if (
            id.includes('node_modules/axios') ||
            id.includes('node_modules/zustand') ||
            id.includes('node_modules/clsx') ||
            id.includes('node_modules/tailwind-merge')
          )
            return 'utils-vendor';
        },
        chunkFileNames: 'js/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
    // Performance optimizations
    chunkSizeWarningLimit: 1000,
  },
  // Dependency optimization
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-router',
      'zustand',
      'axios',
      'react-hot-toast',
      'lucide-react',
      'clsx',
      'tailwind-merge',
    ],
  },
});
