import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import type { UserConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import svgr from 'vite-plugin-svgr';
import wasm from 'vite-plugin-wasm';
import commitHash from './plugins/commit-hash';
import yaml from './plugins/yaml';

// In dev, Vite serves the frontend (default :5173) and proxies /api to the
// Express backend so the browser stays same-origin (no CORS). Keep this port in
// sync with the `server:dev` npm script (PORT=8787).
const devApiPort = 8787;

export default {
  server: {
    proxy: {
      '/api': { target: `http://localhost:${devApiPort}`, changeOrigin: true }
    }
  },
  plugins: [
    tailwindcss(),
    react(),
    wasm(),
    yaml(),
    svgr({
      svgrOptions: { plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'] }
    }),
    commitHash(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Never serve the cached SPA shell in place of an /api request.
        navigateFallbackDenylist: [/^\/api/]
      }
    })
  ],
  build: {
    // top-level await
    target: ['chrome89', 'edge89', 'firefox89', 'safari15', 'es2022']
  }
} satisfies UserConfig;
