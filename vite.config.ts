import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';

// Config-loading time (this file) runs outside the `--env-file-if-exists=.env`
// flag on the server's own dev script, so .env has to be read here separately.
// loadEnv's third arg is the var-name prefix filter — '' (empty) turns that
// filter off, since PORT has no VITE_ prefix and would otherwise be dropped.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Mirrors the default in src/server/index.ts: `process.env.PORT ?? '3000'`.
  // Deriving the proxy target from the same PORT the server actually reads
  // keeps them from drifting apart again — see .env's PORT and this value.
  const serverPort = env.PORT ?? '3000';

  return {
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
        '/whispers/api': { target: `http://localhost:${serverPort}`, changeOrigin: true, rewrite: (path) => path.replace(/^\/whispers/, '') },
        '/whispers/ws': { target: `ws://localhost:${serverPort}`, ws: true, rewrite: (path) => path.replace(/^\/whispers/, '') },
      },
    },
    test: {
      globals: true,
      environment: 'node',
      include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
      // Reading-time pacing between story beats (src/server/pacing.ts) is
      // off in tests; the pacing tests turn it on for themselves.
      env: { PACE_MIN_MS: '0', PACE_MAX_MS: '0' },
    },
  };
});
