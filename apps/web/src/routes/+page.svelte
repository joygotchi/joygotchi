<script lang="ts">
  import PetCard from '#lib/components/PetCard.svelte';
  import { PAGE_SIZE, SORTS, arrange, type Sort } from '#lib/gallery';
  import { listPets, type GalleryPet } from '#lib/pets';

  let pets = $state<GalleryPet[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  /** `all`, `sale`, or a species id. */
  let filter = $state('all');
  let query = $state('');
  let sort = $state<Sort>('newest');
  let showing = $state(PAGE_SIZE);

  async function load() {
    loading = true;
    error = null;
    try {
      // Every pet: the gallery searches and sorts them here, and draws a page
      // at a time, so a long list costs scrolling rather than requests.
      pets = await listPets(Number.MAX_SAFE_INTEGER);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  const shown = $derived(arrange(pets, { filter, query, sort }));

  // A new search or filter starts from the top again.
  $effect(() => {
    void filter;
    void query;
    void sort;
    showing = PAGE_SIZE;
  });

  /*
   * Filters come from the pets on screen, not a list of the two species this
   * game shipped: a registered species gets a button once a pet of it exists.
   */
  const filters = $derived([
    ['all', 'All'],
    ['sale', `For sale · ${pets.filter((pet) => pet.listing).length}`],
    ...[...new Set(pets.map((pet) => pet.kind))].map((kind) => [
      kind,
      kind.replace(/dragon$/, '')
    ])
  ] as [string, string][]);
</script>

<section class="grid-bg -mx-4 mb-10 border-b border-line px-4 py-12">
  <h1 class="max-w-2xl text-2xl leading-snug sm:text-3xl">
    A public gallery of pets that live on chain
    <span class="text-muted">and on your desktop.</span>
  </h1>

  <p class="mt-3 max-w-xl text-sm text-muted">
    Mint one on NEAR, copy its install code, and it floats over your editor and reacts to every
    tool call your coding agent makes. Feed it and talk to it with NEAR AI.
  </p>

  <div class="mt-6 flex flex-wrap gap-2 text-xs">
    <a class="border border-accent bg-accent px-3 py-2 font-bold text-ink" href="#pets">
      Pick a pet to mint
    </a>
    <a class="border border-line px-3 py-2 hover:border-line-bright" href="/download">
      Get the desktop app
    </a>
  </div>
</section>

<!-- How it works: the loop a new visitor is about to join, in four steps. -->
<section class="mb-12" aria-labelledby="how">
  <h2 id="how" class="text-sm tracking-widest text-muted uppercase">How it works</h2>
  <ol class="mt-4 grid gap-px overflow-hidden border border-line bg-line sm:grid-cols-2 lg:grid-cols-4">
    {#each [
      ['Pick a pet', 'Mint one like any pet in the gallery for 2 NEAR, or buy one that is for sale. The contract rolls its rarity.'],
      ['Put it on your desktop', 'Get the app, paste the pet\'s install code. It floats in a small window above your editor.'],
      ['Let your agent drive it', 'Every tool call your coding agent makes moves it — reading, running, failing, waiting for you.'],
      ['Raise it', 'Feed it, talk to it with NEAR AI, stake it to earn AI credits, battle, and evolve it through four phases.']
    ] as [title, body], index (title)}
      <li class="flex flex-col gap-2 bg-panel p-5">
        <span class="text-xs text-accent">0{index + 1}</span>
        <span class="text-sm text-text">{title}</span>
        <span class="text-xs leading-relaxed text-muted">{body}</span>
      </li>
    {/each}
  </ol>
  <p class="mt-3 text-xs text-muted">
    Want your own creature? <a class="text-accent hover:underline" href="/create">Create a species</a>
    — you earn 1% of every mint of it.
  </p>
</section>

<div class="mb-4 flex scroll-mt-20 items-end justify-between gap-4" id="pets">
  <div class="flex items-baseline gap-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Pets</h2>
    <span class="text-xs text-muted">{pets.length} minted</span>
  </div>

  <div class="flex flex-wrap items-center justify-end gap-1 text-[0.65rem] capitalize">
    {#each filters as [value, label] (value)}
      <button
        class="border px-2 py-1"
        class:border-accent={filter === value}
        class:border-line={filter !== value}
        class:text-accent={filter === value}
        class:text-muted={filter !== value}
        onclick={() => (filter = value)}
      >
        {label}
      </button>
    {/each}
  </div>
</div>

<div class="mb-4 flex flex-wrap gap-2 text-xs">
  <input
    class="min-w-0 flex-1 border border-line bg-panel px-3 py-2 outline-none focus:border-line-bright"
    type="search"
    placeholder="Search by name or #number"
    aria-label="Search pets"
    bind:value={query}
  />
  <select
    class="border border-line bg-panel px-2 py-2 text-muted outline-none focus:border-line-bright"
    aria-label="Sort pets"
    bind:value={sort}
  >
    {#each SORTS as [value, label] (value)}
      <option {value}>{label}</option>
    {/each}
  </select>
</div>

{#if loading}
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each Array.from({ length: 10 }) as _, index (index)}
      <div class="h-60 animate-pulse border border-line bg-panel"></div>
    {/each}
  </div>
{:else if error}
  <div class="border border-bad/40 bg-panel p-4 text-xs">
    <p class="text-bad">Could not read the contract.</p>
    <p class="mt-1 text-muted">{error}</p>
    <button class="mt-3 border border-line px-2 py-1 hover:border-line-bright" onclick={load}>
      Try again
    </button>
  </div>
{:else if shown.length === 0}
  <div class="border border-line bg-panel p-8 text-center text-sm text-muted">
    {pets.length === 0
      ? 'No pets yet.'
      : query
        ? `No pet matches “${query}”.`
        : filter === 'sale'
          ? 'Nothing for sale right now.'
          : 'No pets of that kind yet.'}
  </div>
{:else}
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each shown.slice(0, showing) as pet (pet.pet_id)}
      <PetCard {pet} />
    {/each}
  </div>
  {#if shown.length > showing}
    <div class="mt-4 flex justify-center">
      <button
        class="border border-line px-4 py-2 text-xs hover:border-line-bright"
        onclick={() => (showing += PAGE_SIZE)}
        type="button"
      >
        Show more · {shown.length - showing} left
      </button>
    </div>
  {/if}
{/if}
