import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const clientRoot = resolve(import.meta.dirname, 'src/client');
const devServerPort = Number(process.env.PORT ?? 8080);

export default defineConfig({
  root: clientRoot,
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    target: 'chrome103',
    rollupOptions: {
      input: {
        index: resolve(clientRoot, 'index.html'),
        control: resolve(clientRoot, 'control.html'),
        login: resolve(clientRoot, 'login.html'),
        overlay: resolve(clientRoot, 'overlay.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${devServerPort}`,
      '/ws': { target: `ws://localhost:${devServerPort}`, ws: true },
      '/healthz': `http://localhost:${devServerPort}`,
      // Server-side auth redirects for these pages.
      '^/(control|login)$': `http://localhost:${devServerPort}`,
    },
  },
});
