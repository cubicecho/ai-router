import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Where `npm run dev:server` listens: Vite takes 3000, as every cubicecho app's UI does. */
const API = 'http://localhost:3001';
/** Every cubicecho app's UI is here, in development and in preview. */
const UI = { host: '0.0.0.0', port: 3000, strictPort: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true },
  // The UI calls its own origin; in development these paths are the server's.
  server: {
    ...UI,
    proxy: {
      '^/graphql(\\?|$)': { target: API, changeOrigin: true },
      '/healthz': { target: API, changeOrigin: true },
      '/sso': { target: API, changeOrigin: true },
      '/api/auth': { target: API, changeOrigin: true },
    },
  },
  preview: UI,
});
