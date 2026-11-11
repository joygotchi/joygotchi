<script lang="ts">
  import { page } from '$app/state';

  /**
   * Any route that does not exist, or a page that failed to load.
   *
   * A starved dragon for the 404 — the game's own picture of "nothing here" —
   * and the way back to the places a lost visitor most likely wanted.
   */
  const missing = $derived(page.status === 404);
</script>

<svelte:head>
  <title>{missing ? 'Not found' : 'Something went wrong'} · JOYGOTCHI</title>
</svelte:head>

<section class="grid-bg -mx-4 flex flex-col items-center px-4 py-16 text-center">
  <img
    class="pixel h-32 opacity-40 grayscale"
    alt=""
    src="/assets/animation/greendragon/1.gif"
  />
  <p class="mt-6 text-xs tracking-widest text-muted uppercase">Error {page.status}</p>
  <h1 class="mt-2 text-2xl">
    {missing ? 'Nothing lives at this address.' : 'Something went wrong.'}
  </h1>
  <p class="mt-3 max-w-md text-sm text-muted">
    {#if missing}
      The pet may have been renamed, retired, or never existed. Pet links end in the pet's number,
      like <code class="text-text">/pets/kuro-6</code>.
    {:else}
      {page.error?.message ?? 'The page could not be loaded.'} Try again in a moment.
    {/if}
  </p>

  <div class="mt-8 flex flex-wrap justify-center gap-2 text-xs">
    <a class="bg-accent px-4 py-2.5 font-bold text-ink" href="/">Back to the gallery</a>
    <a class="border border-line px-4 py-2.5 hover:border-line-bright" href="/create">Create a species</a>
    <a class="border border-line px-4 py-2.5 hover:border-line-bright" href="/download">Get the desktop app</a>
  </div>
</section>
