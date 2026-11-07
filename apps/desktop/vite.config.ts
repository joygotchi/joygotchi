import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // Tauri serves this, so the port is fixed and `tauri.conf.json` points at
  // it. `strictPort` is the important half: without it Vite slides to the next
  // free port and Tauri loads whatever else is on the one it expected — which
  // is how this window once came up showing a different app entirely.
  server: { port: 5290, strictPort: true },
  build: { target: 'esnext' }
});
