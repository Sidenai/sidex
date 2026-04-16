import { defineConfig } from 'vite';
import * as path from 'path';
import { nlsPlugin } from './scripts/vite-plugin-nls';

export default defineConfig({
  clearScreen: false,
  assetsInclude: ['**/*.wasm', '**/*.json', '**/*.tmLanguage.json'],
  publicDir: 'public',
  plugins: [nlsPlugin()],
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  resolve: {
    alias: {
      'vs': path.resolve(__dirname, 'src/vs'),
    },
  },
  build: {
    target: ['es2022', 'chrome100', 'safari15'],
    minify: 'esbuild',
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        textMateWorker: path.resolve(__dirname, 'src/vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain.ts'),
        editorWorker: path.resolve(__dirname, 'src/vs/editor/common/services/editorWebWorkerMain.ts'),
        extensionHostWorker: path.resolve(__dirname, 'src/vs/workbench/api/worker/extensionHostWorkerMain.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'editorWorker') {
            return 'assets/editorWorker.js';
          }
          if (chunkInfo.name === 'textMateWorker') {
            return 'assets/textMateWorker.js';
          }
          if (chunkInfo.name === 'extensionHostWorker') {
            return 'assets/extensionHostWorker.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if ((assetInfo.name ?? '').endsWith('.ts')) {
            const base = (assetInfo.name ?? 'asset').slice(0, -3);
            return `assets/${base}-[hash].js`;
          }
          return 'assets/[name]-[hash][extname]';
        },
        manualChunks(id, { getModuleInfo }) {
          const isWorkerDep = (moduleId: string, visited = new Set<string>()): boolean => {
            if (visited.has(moduleId)) return false;
            visited.add(moduleId);
            const info = getModuleInfo(moduleId);
            if (!info) return false;
            if (info.isEntry && (moduleId.includes('WorkerMain') || moduleId.includes('workerMain'))) {
              return true;
            }
            for (const importer of info.importers) {
              if (isWorkerDep(importer, visited)) return true;
            }
            return false;
          };

          if (isWorkerDep(id)) {
            return undefined;
          }

          if (id.includes('xterm') || id.includes('/terminal/')) {
            return 'terminal';
          }
          if (
            (id.includes('/vs/editor/') && !id.includes('/workbench/')) ||
            id.includes('/vs/platform/')
          ) {
            return 'core';
          }
        },
      },
    },
  },
  optimizeDeps: {
    include: ['vscode-textmate', 'vscode-oniguruma'],
    exclude: ['@tauri-apps/api'],
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'workers/[name]-[hash].js',
        chunkFileNames: 'workers/[name]-[hash].js',
      },
    },
  },
});
