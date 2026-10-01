import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

const clientRoot = resolve(import.meta.dirname, 'src/client');

/**
 * In development Vite serves the pages itself, so map the server's clean URLs
 * (`/control`, `/login`, `/overlay`) to their HTML entry points. Sign-in
 * redirects then come from the client, which handles a 401 by going to /login.
 */
function cleanPageUrls(): Plugin {
  const pages = new Set(['/control', '/login', '/overlay']);
  return {
    name: 'clean-page-urls',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const [path = '', query] = (request.url ?? '').split('?', 2);
        if (pages.has(path)) request.url = `${path}.html${query === undefined ? '' : `?${query}`}`;
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // The backend (`npm run dev:server`) reads PORT from .env; proxy to the same port.
  const { PORT = '8080' } = loadEnv(mode, import.meta.dirname, '');
  const backend = `localhost:${PORT}`;
  return {
    root: clientRoot,
    publicDir: false,
    plugins: [cleanPageUrls()],
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
      // Keep the browser's Host header (changeOrigin: false) so the backend's
      // same-origin checks see the Vite origin on both Host and Origin.
      proxy: {
        '/api': { target: `http://${backend}`, changeOrigin: false },
        '/ws': { target: `ws://${backend}`, ws: true, changeOrigin: false },
        '/healthz': { target: `http://${backend}`, changeOrigin: false },
      },
    },
  };
});
