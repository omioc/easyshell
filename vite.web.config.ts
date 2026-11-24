import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Browser-only preview of the renderer.
 *
 * The renderer talks to the host through `window.easyshell`, which does not exist
 * in a plain browser. `getBridge()` falls back to the in-memory mock so the whole
 * UI (tabs, session info, settings, themes) can be reviewed without Electron.
 */
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: resolve('out/web'),
    emptyOutDir: true,
  },
});
