import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  // Without this, svelte-check reads `$state(...)` as a store subscription to
  // a variable named `state` — Svelte 5 auto-detects runes per component, but
  // the tooling needs telling for a plain Vite app. SvelteKit sets it for you,
  // which is why only this app saw it.
  compilerOptions: { runes: true }
};
