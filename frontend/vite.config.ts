import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = process.env.VITE_API_BASE_URL || 'http://localhost:3001';
const WS_BASE_URL = process.env.VITE_WS_BASE_URL || 'ws://localhost:3001';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: false, // Allow --host flag to override
    port: 5173,  // Default port, can be overridden by --port flag
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
    minify: 'esbuild',
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks
          'react-vendor': ['react', 'react-dom'],
          'router-vendor': ['react-router-dom'],
          'ui-vendor': ['lucide-react', 'react-hot-toast'],
          'markdown-vendor': ['react-markdown', 'react-syntax-highlighter'],
          'utils-vendor': ['axios', 'zustand', 'clsx', 'tailwind-merge'],
        },
        chunkFileNames: (chunkInfo) => {
          const facadeModuleId = chunkInfo.facadeModuleId
          if (facadeModuleId && facadeModuleId.includes('node_modules')) {
            return 'vendor/[name]-[hash].js'
          }
          return 'js/[name]-[hash].js'
        },
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css')) {
            return 'css/[name]-[hash][extname]'
          }
          return 'assets/[name]-[hash][extname]'
        },
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
      'react-router-dom',
      'zustand',
      'axios',
      'react-hot-toast',
      'lucide-react',
      'clsx',
      'tailwind-merge',
      'react-syntax-highlighter' // Include this since we use it in OptimizedSyntaxHighlighter
    ],
  },
})
