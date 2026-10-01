import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const clientRoot = resolve(import.meta.dirname, 'src/client');

export default defineConfig({
  root: clientRoot,
  publicDir: false,
  // Relative URLs: the page is served from the secret /admin/<path>/ prefix.
  base: './',
  build: {
    outDir: resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    target: 'es2022',
  },
});
