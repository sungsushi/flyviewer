import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works at any path (e.g. a GitHub Pages project
  // site at https://<user>.github.io/<repo>/) without hard-coding the repo name.
  base: './',
  build: {
    // three.js alone is ~650 kB minified (~170 kB gzipped); the app budget is 200 kB gzipped.
    chunkSizeWarningLimit: 800,
  },
});
