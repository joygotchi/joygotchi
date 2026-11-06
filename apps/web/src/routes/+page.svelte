<script lang="ts">
  import MintPanel from '#lib/components/MintPanel.svelte';
  import PetCard from '#lib/components/PetCard.svelte';
  import { listPets, type GalleryPet } from '#lib/pets';

  let pets = $state<GalleryPet[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let filter = $state<'all' | 'blackdragon' | 'greendragon'>('all');

  async function load() {
    loading = true;
    error = null;
    try {
      pets = await listPets();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  const shown = $derived(filter === 'all' ? pets : pets.filter((pet) => pet.kind === filter));
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
    <a class="border border-accent bg-accent px-3 py-2 font-bold text-ink" href="#mint">
      Mint a pet
    </a>
    <a class="border border-line px-3 py-2 hover:border-line-bright" href="/download">
      Get the desktop app
    </a>
  </div>
</section>

<div class="mb-4 flex items-end justify-between gap-4">
  <div class="flex items-baseline gap-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Pets</h2>
    <span class="text-xs text-muted">{pets.length} minted</span>
  </div>

  <div class="flex gap-1 text-[0.65rem]">
    {#each [['all', 'All'], ['blackdragon', 'Black'], ['greendragon', 'Green']] as const as [value, label] (value)}
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
    {pets.length === 0 ? 'No pets yet. Mint the first one.' : 'No pets of that kind yet.'}
  </div>
{:else}
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each shown as pet (pet.pet_id)}
      <PetCard {pet} />
    {/each}
  </div>
{/if}

<section class="mt-12 scroll-mt-20" id="mint">
  <MintPanel onminted={load} />
</section>
