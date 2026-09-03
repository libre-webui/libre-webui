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
      path.resolve(
        import.meta.dirname,
        'public/artifact-runtime/.build-fingerprint'
      ),
      'utf-8'
    )
      .trim()
      .slice(0, 16);
  } catch {
    return 'dev';
  }
};

/** Matches a package directory under node_modules (patterns may be regex). */
const vendor = (...packages: string[]) =>
  new RegExp(`node_modules[\\\\/](?:${packages.join('|')})[\\\\/]`);

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
    // es2022 so noVNC's top-level await is emitted as-is without a warning;
    // every browser that runs the app (ES modules + dynamic import) has it.
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Rolldown chunk groups. The legacy manualChunks function is folded
        // into a single group whose captures include a matched module's
        // dependencies, so react-markdown's group swallowed React itself and
        // dragged the whole markdown stack onto the sign-in page. Explicit
        // groups with priorities keep each vendor where it belongs.
        codeSplitting: {
          // Match the old manualChunks semantics: a group holds only the
          // modules its pattern names. Rolldown's default also captures a
          // matched module's dependencies, which lets a higher-priority
          // lazy group (math, html) steal utilities the core needs and turns
          // every optional pipeline back into an eager import.
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'react-vendor',
              test: vendor('react', 'react-dom', 'scheduler'),
              priority: 100,
            },
            {
              name: 'router-vendor',
              test: vendor('react-router', 'react-router-dom'),
              priority: 90,
            },
            {
              name: 'ui-vendor',
              test: vendor('lucide-react', 'react-hot-toast'),
              priority: 80,
            },
            {
              name: 'syntax-highlight',
              test: vendor('react-syntax-highlighter', 'refractor', 'prismjs'),
              priority: 70,
            },
            {
              name: 'markdown-math',
              test: vendor(
                'remark-math',
                'rehype-katex',
                'katex',
                'micromark-extension-math',
                'mdast-util-math'
              ),
              priority: 60,
            },
            {
              name: 'markdown-html',
              test: vendor(
                'rehype-raw',
                'rehype-sanitize',
                'hast-util-raw',
                'hast-util-sanitize',
                'hast-util-from-parse5',
                'hast-util-to-parse5',
                'parse5',
                'entities',
                'html-void-elements',
                'vfile-location'
              ),
              priority: 55,
            },
            {
              name: 'markdown-core',
              test: vendor(
                'react-markdown',
                'remark-[^/\\\\]+',
                'rehype-[^/\\\\]+',
                'unified',
                'micromark[^/\\\\]*',
                'mdast-util-[^/\\\\]+',
                'hast-util-[^/\\\\]+',
                'unist-util-[^/\\\\]+',
                'vfile[^/\\\\]*',
                'property-information',
                'space-separated-tokens',
                'comma-separated-tokens',
                'html-url-attributes',
                'devlop',
                '@ungap/structured-clone',
                'longest-streak',
                'trough',
                'bail',
                'is-plain-obj',
                'extend',
                'ccount',
                'markdown-table',
                'escape-string-regexp',
                'trim-lines',
                'hastscript',
                'style-to-js',
                'style-to-object',
                'inline-style-parser',
                'estree-util-is-identifier-name',
                'character-entities[^/\\\\]*',
                'decode-named-character-reference',
                'zwitch',
                'web-namespaces'
              ),
              priority: 50,
            },
            {
              name: 'utils-vendor',
              test: vendor('axios', 'zustand', 'clsx', 'tailwind-merge'),
              priority: 40,
            },
          ],
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
