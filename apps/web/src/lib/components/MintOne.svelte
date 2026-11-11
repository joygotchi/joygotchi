<script lang="ts">
  import { goto } from '$app/navigation';
  import { NETWORK } from '#lib/config';
  import { wallet } from '#lib/near/wallet.svelte';
  import { getPet, mintPriceNear, mintPet } from '#lib/pets';

  /**
   * Mint another pet of one species, from a pet of that species.
   *
   * This replaced a picker on the home page that drew every registered
   * species side by side, which stops fitting the moment people start
   * registering them. Here the species is already chosen: it is the one on
   * the page, so the gallery is the picker and it scales with the gallery.
   */
  type Props = { species: string };
  let { species }: Props = $props();

  let name = $state('');
  let minting = $state(false);
  let error = $state<string | null>(null);

  /** Uppercase, letters and digits: the contract stores the name as given. */
  const cleanName = $derived(
    name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .trim()
      .slice(0, 16)
  );
  const canMint = $derived(Boolean(wallet.accountId) && cleanName.length >= 2 && !minting);

  async function mint() {
    if (!canMint) return;
    minting = true;
    error = null;
    try {
      const petId = await mintPet(cleanName, species);
      // Read it back: the contract rolls the rarity, and the new pet's own
      // page is where that and its install code are shown.
      const pet = await getPet(petId);
      if (!pet) throw new Error(`Pet ${petId} was minted but cannot be read back yet`);
      await goto(`/pets/${pet.slug}`);
      name = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      minting = false;
    }
  }
</script>

<div class="flex flex-col gap-2 border-t border-line pt-4">
  <div class="flex items-baseline justify-between gap-2">
    <span class="text-[0.65rem] tracking-widest text-muted uppercase">Mint one like this</span>
    <span class="text-[0.6rem] text-muted">{mintPriceNear} NEAR · {NETWORK} · rarity is rolled</span>
  </div>

  {#if wallet.accountId}
    <div class="flex gap-2">
      <input
        class="min-w-0 flex-1 border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-line-bright"
        maxlength="16"
        placeholder="NAME IT"
        aria-label="Name for the new pet"
        bind:value={name}
        onkeydown={(event) => event.key === 'Enter' && mint()}
      />
      <button
        class="shrink-0 border border-accent bg-accent px-3 py-2 text-xs font-bold text-ink disabled:opacity-40"
        disabled={!canMint}
        onclick={mint}
        type="button"
      >
        {minting ? 'Minting…' : `Mint for ${mintPriceNear} NEAR`}
      </button>
    </div>
  {:else}
    <p class="text-xs text-muted">Connect a wallet to mint one.</p>
  {/if}

  {#if error}
    <p class="border border-bad/40 px-3 py-2 text-xs text-bad">{error}</p>
  {/if}
</div>
