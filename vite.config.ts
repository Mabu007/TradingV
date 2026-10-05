import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    /*
     * Which environment variables reach the browser bundle.
     *
     * Vite exposes only `VITE_`-prefixed variables by default, so a project
     * configured with the Firebase/AI Studio names (`FIREBASE_apiKey`) built a
     * bundle with no Firebase configuration in it at all: sign-in was silently
     * unavailable in production while the same repository read perfectly in a
     * local `.env` that used the Vite names. The failure was invisible because
     * the fallback path is a working product, not a crash.
     *
     * `FIREBASE_` is added so the variables this project actually has are the
     * ones that work. Everything under that prefix is Firebase's own browser
     * configuration — apiKey, authDomain, projectId, storageBucket,
     * messagingSenderId, appId, measurementId — which is client-visible by
     * design and is what Firebase itself embeds in every web app. No secret
     * belongs under this prefix, and none does.
     */
    envPrefix: ['VITE_', 'FIREBASE_'],
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