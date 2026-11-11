<script lang="ts">
  import PetCard from '#lib/components/PetCard.svelte';
  import { wallet } from '#lib/near/wallet.svelte';
  import { petsOf, type GalleryPet } from '#lib/pets';

  let pets = $state<GalleryPet[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    const accountId = wallet.accountId;
    if (!accountId) {
      pets = [];
      return;
    }

    loading = true;
    error = null;
    petsOf(accountId)
      .then((found) => {
        if (wallet.accountId === accountId) pets = found;
      })
      .catch((cause) => {
        if (wallet.accountId === accountId) {
          error = cause instanceof Error ? cause.message : String(cause);
        }
      })
      .finally(() => {
        if (wallet.accountId === accountId) loading = false;
      });
  });
</script>

<h1 class="text-sm tracking-widest text-muted uppercase">My pets</h1>

{#if !wallet.accountId}
  <p class="mt-4 border border-line bg-panel p-8 text-sm text-muted">
    Connect a wallet to see the pets you own.
  </p>
{:else if loading}
  <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each Array.from({ length: 5 }) as _, index (index)}
      <div class="h-60 animate-pulse border border-line bg-panel"></div>
    {/each}
  </div>
{:else if error}
  <p class="mt-4 border border-bad/40 bg-panel p-4 text-xs text-bad">{error}</p>
{:else if pets.length === 0}
  <p class="mt-4 border border-line bg-panel p-8 text-sm text-muted">
    No pets on this account yet. <a class="text-accent hover:underline" href="/#pets">Pick one in the gallery to mint.</a>
  </p>
{:else}
  <div class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each pets as pet (pet.pet_id)}
      <PetCard {pet} />
    {/each}
  </div>
{/if}
