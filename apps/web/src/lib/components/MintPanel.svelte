<script lang="ts">
  import { goto } from '$app/navigation';
  import CopyField from '#lib/components/CopyField.svelte';
  import { installCommand } from '#lib/cli';
  import { NETWORK, explorerToken } from '#lib/config';
  import { wallet } from '#lib/near/wallet.svelte';
  import { getPet, listSpecies, mintPriceNear, mintPet } from '#lib/pets';
  import type { ChainSpecies } from '@joygotchi/pet';

  type Props = { onminted?: () => void };
  let { onminted }: Props = $props();

  let name = $state('');
  let kind = $state('blackdragon');

  /*
   * Every species the contract knows, not a constant.
   *
   * This list used to be `PET_KINDS`, two names compiled into the app, so a
   * species somebody registered was unmintable here until the next deploy —
   * which is most of what the registry was supposed to end.
   */
  let species = $state<ChainSpecies[]>([]);
  $effect(() => {
    listSpecies().then((found) => {
      species = found;
      if (found.length > 0 && !found.some((one) => one.id === kind)) kind = found[0]!.id;
    });
  });
  let minting = $state(false);
  let error = $state<string | null>(null);
  let minted = $state<{ petId: number; slug: string; installCode: string } | null>(null);

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
      const petId = await mintPet(cleanName, kind);

      // Read the pet back rather than assembling it here: the contract rolls
      // the rarity, and what it rolled is the first thing anyone wants to see.
      const pet = await getPet(petId);
      if (!pet) throw new Error(`Pet ${petId} was minted but cannot be read back yet`);

      minted = { petId, slug: pet.slug, installCode: pet.pkg.installCode };
      name = '';
      onminted?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      minting = false;
    }
  }
</script>

<div class="border border-line bg-panel">
  <div class="border-b border-line px-4 py-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Mint a pet</h2>
    <p class="mt-1 text-xs text-muted">
      {mintPriceNear} NEAR on {NETWORK}. The contract rolls the rarity — 70% common, 20% rare, 8%
      epic, 2% legendary.
    </p>
  </div>

  {#if minted}
    <div class="flex flex-col gap-4 p-4">
      <p class="text-sm">
        <span class="text-accent">Minted.</span>
        Pet #{minted.petId} is yours.
      </p>

      <CopyField label="Install code" value={minted.installCode} />
      <CopyField label="Install it" prefix="$ " value={installCommand(minted.installCode)} />

      <div class="flex flex-wrap gap-2 text-xs">
        <button
          class="border border-accent bg-accent px-3 py-2 font-bold text-ink"
          onclick={() => goto(`/pets/${minted?.slug}`)}
        >
          Open its page
        </button>
        <button class="border border-line px-3 py-2 hover:border-line-bright" onclick={() => (minted = null)}>
          Mint another
        </button>
        <a
          class="border border-line px-3 py-2 text-muted hover:border-line-bright"
          href={explorerToken(minted.petId)}
          rel="noreferrer"
          target="_blank"
        >
          On the explorer
        </a>
      </div>
    </div>
  {:else}
    <div class="flex flex-col gap-4 p-4">
      <label class="flex flex-col gap-1">
        <span class="text-[0.65rem] tracking-widest text-muted uppercase">Name</span>
        <input
          class="border border-line bg-ink px-3 py-2 text-sm outline-none focus:border-line-bright"
          maxlength="16"
          placeholder="ANCALAGON"
          bind:value={name}
        />
      </label>

      <div class="flex flex-col gap-1">
        <span class="text-[0.65rem] tracking-widest text-muted uppercase">Kind</span>
        <div class="flex gap-2">
          <!--
            The drawing comes from the species' own registered url, which is
            the only thing that works for one created after this app shipped.
          -->
          {#each species as option (option.id)}
            <button
              class="flex flex-1 flex-col items-center gap-1 border p-3"
              class:border-accent={kind === option.id}
              class:border-line={kind !== option.id}
              onclick={() => (kind = option.id)}
            >
              <img class="pixel h-16" alt={option.name} src={option.art[0]} />
              <span class="text-[0.65rem] text-muted">{option.name}</span>
            </button>
          {/each}
        </div>
      </div>

      {#if error}
        <p class="border border-bad/40 px-3 py-2 text-xs text-bad">{error}</p>
      {/if}

      {#if wallet.accountId}
        <button
          class="border border-accent bg-accent px-3 py-2 text-xs font-bold text-ink disabled:opacity-40"
          disabled={!canMint}
          onclick={mint}
        >
          {minting ? 'Minting…' : `Mint for ${mintPriceNear} NEAR`}
        </button>
      {:else}
        <p class="border border-line px-3 py-2 text-xs text-muted">
          Connect a wallet to mint. On testnet, a faucet account is enough.
        </p>
      {/if}
    </div>
  {/if}
</div>
