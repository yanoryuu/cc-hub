import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 開発時のプロキシ先(既定はデーモン。モックは HUB_TARGET=http://127.0.0.1:7862)
const target = process.env.HUB_TARGET || 'http://127.0.0.1:7861';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cc-hub/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': { target, changeOrigin: true },
      '/auth': { target, changeOrigin: true },
      '/game': { target, changeOrigin: true },
      '/ws': { target, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
