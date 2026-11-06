import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  // Tauri serves this; a fixed port means `tauri.conf.json` can point at it.
  server: { port: 5275, strictPort: true },
  build: { target: 'esnext' }
});
