import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    {
      name: 'browser-node-crypto-shim',
      enforce: 'pre',
      resolveId(id, _importer, options) {
        if (process.env.VITEST || options?.ssr) return null;
        if (id === 'node:crypto' || id === 'crypto') {
          return '\0virtual:browser-node-crypto';
        }
        return null;
      },
      load(id) {
        if (id === '\0virtual:browser-node-crypto') {
          return `
            export function createHmac() {
              throw new Error('createHmac is server-only and not available in browser');
            }
            export function timingSafeEqual() {
              throw new Error('timingSafeEqual is server-only and not available in browser');
            }
          `;
        }
        return null;
      },
    },
    tailwindcss(),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_LOBBY_URL || 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.VITE_SITE_WS_URL || 'ws://localhost:8081',
        ws: true,
      },
    },
  },
});
