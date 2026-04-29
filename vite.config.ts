import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works at any subpath
  // (GitHub Pages serves at /<repo>/).
  base: './',
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    host: true,
  },
});

