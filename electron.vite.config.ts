import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/** A release build: minified, no sourcemaps, nothing readable shipped. */
const productionBuild = {
  minify: 'esbuild' as const,
  sourcemap: false,
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      ...productionBuild,
      rollupOptions: {
        // Two entries. The MCP server an agent spawns is a plain Node script:
        // it must not pull in Electron, so it is never imported by the app —
        // it is a process of its own, and it is built as one.
        input: {
          index: resolve('src/main/index.ts'),
          'mcp-server': resolve('src/main/mcp/server.ts'),
        },
        // ssh2's optional native acceleration is not installed on purpose.
        external: ['cpu-features', 'sshcrypto.node'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: { ...productionBuild },
  },
  renderer: {
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
      },
    },
  },
});
