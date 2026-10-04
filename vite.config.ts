import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        /*
         * `@` means the repository root.
         *
         * Resolved from the config file's own URL rather than `__dirname`,
         * which does not exist in an ES module and made Vite warn that the
         * config uses features `configLoader: 'native'` does not support —
         * a warning that becomes a hard failure when native loading becomes the
         * default. Suppressing the warning would have hidden the real cause;
         * this removes the cause.
         *
         * `import.meta.dirname` would read better, but it is Node 20.11+ and
         * this project targets older toolchains, so `fileURLToPath` is the
         * portable ESM equivalent and needs no Node version negotiation.
         */
        '@': fileURLToPath(new URL('.', import.meta.url)),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});