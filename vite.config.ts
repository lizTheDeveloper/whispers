import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: '/whispers/',
  build: {
    outDir: 'dist/client',
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
  resolve: {
    alias: { '#shared': resolve(import.meta.dirname, 'src/shared') },
  },
  server: {
    port: 5190,
    proxy: {
      '/whispers/api': { target: 'http://localhost:3000', changeOrigin: true, rewrite: (path) => path.replace(/^\/whispers/, '') },
      '/whispers/ws': { target: 'ws://localhost:3000', ws: true, rewrite: (path) => path.replace(/^\/whispers/, '') },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
