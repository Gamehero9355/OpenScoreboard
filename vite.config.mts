import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BACKEND_PORT = Number(process.env.PORT || 3000);

/**
 * The identity of one build, derived from the filenames it emitted.
 *
 * Filenames change exactly when the emitted content does, which makes this both
 * stable across rebuilds of identical source and different for every real
 * change. Exported so that invariant is tested rather than assumed -- a stamp
 * that did not move would silently reintroduce the stale-cache bug.
 */
export function buildFingerprint(emittedFilenames: string[]): string {
  return createHash('sha256').update([...emittedFilenames].sort().join('|')).digest('hex').slice(0, 12);
}

/**
 * Stamp the service worker's cache name with this build's own fingerprint.
 *
 * `public/` is copied verbatim, so nothing inside the client bundle can know
 * that a rebuild happened. The cache name used to be a literal in the file, which
 * meant `activate` never ran for a rebuild: every browser kept serving the
 * previous bundle out of the cache, including assets the host had stopped serving
 * entirely. One cache name per build gives exactly one invalidation, and the
 * worker then messages open clients so they reload onto the new build.
 */
function stampServiceWorkerCache(): Plugin {
  let outDir = '';
  return {
    name: 'tsb-stamp-service-worker-cache',
    configResolved(config) {
      // Vite normalises outDir against root, but be explicit rather than rely on it.
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const buildId = buildFingerprint(Object.keys(bundle));
      const file = join(outDir, 'sw.js');
      try {
        writeFileSync(file, readFileSync(file, 'utf8').replace(/__BUILD_ID__/g, buildId), 'utf8');
      } catch {
        // No service worker emitted (a dev server run, or a stripped build).
      }
    },
  };
}

export default defineConfig({
  root: 'src/frontend',
  publicDir: '../../public',
  plugins: [react(), stampServiceWorkerCache()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    port: 5273,
    strictPort: false,
    proxy: {
      '/api': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
      // Crests live in the host's logo folder and are served by the backend, so
      // a dev client has to ask the backend for them exactly like production.
      // Without this every crest came back as the SPA's index.html and drew a
      // broken image.
      '/logos': { target: `http://127.0.0.1:${BACKEND_PORT}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${BACKEND_PORT}`, ws: true },
    },
  },
});
