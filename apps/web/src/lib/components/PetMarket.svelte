<script lang="ts">
  import { explorerAccount } from '#lib/config';
  import { formatNear, parseNear, truncateAccount } from '#lib/near/amount';
  import { wallet } from '#lib/near/wallet.svelte';
  import { buyPet, listPet, marketFeeBps, unlistPet, type GalleryPet } from '#lib/pets';

  /**
   * The pet market, on the pet it sells.
   *
   * The contract has had `list_pet` / `buy_pet` since the first deploy and no
   * page could reach them, so a creator and a player both had something to
   * sell and nowhere to sell it. Every write goes through the wallet: a sale
   * moves NEAR at a price somebody else set.
   */
  type Props = { pet: GalleryPet; mine: boolean; onchange: () => void | Promise<void> };
  let { pet, mine, onchange }: Props = $props();

  let price = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let feeBps = $state(0);

  $effect(() => {
    void marketFeeBps().then((bps) => (feeBps = bps));
  });

  const listing = $derived(pet.listing);

  /** What the seller would receive after the market's cut, for the typed price. */
  const payout = $derived.by(() => {
    try {
      const yocto = BigInt(parseNear(price || '0'));
      if (yocto <= 0n) return null;
      return formatNear(yocto - (yocto * BigInt(feeBps)) / 10_000n);
    } catch {
      return null;
    }
  });

  async function run(action: () => Promise<unknown>) {
    busy = true;
    error = null;
    try {
      await action();
      price = '';
      await onchange();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<div class="border border-line bg-panel">
  <div class="flex items-baseline justify-between border-b border-line px-4 py-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Market</h2>
    {#if listing}
      <span class="text-xs text-accent">For sale</span>
    {:else}
      <span class="text-xs text-muted">Not for sale</span>
    {/if}
  </div>

  <div class="flex flex-col gap-3 p-4">
    {#if listing}
      <div class="flex items-baseline justify-between gap-3">
        <span class="text-2xl">{formatNear(listing.price)} <span class="text-sm text-muted">NEAR</span></span>
        <a
          class="truncate text-xs text-muted hover:text-text"
          href={explorerAccount(listing.seller_id)}
          rel="noreferrer"
          target="_blank">by {truncateAccount(listing.seller_id)}</a
        >
      </div>

      {#if !wallet.accountId}
        <p class="text-xs text-muted">Connect a wallet to buy it.</p>
      {:else if mine}
        <button
          class="border border-line px-3 py-2 text-xs hover:border-line-bright disabled:opacity-40"
          disabled={busy}
          onclick={() => run(() => unlistPet(pet.pet_id))}
          type="button"
        >
          {busy ? 'Cancelling…' : 'Cancel the listing'}
        </button>
      {:else}
        <button
          class="bg-accent px-3 py-2.5 text-sm font-bold text-ink disabled:opacity-40"
          disabled={busy || pet.locked}
          onclick={() => listing && run(() => buyPet(listing))}
          type="button"
        >
          {busy ? 'Buying…' : `Buy for ${formatNear(listing.price)} NEAR`}
        </button>
        <p class="text-[0.65rem] text-muted">
          The pet moves to your account in the same transaction that pays the seller.
        </p>
      {/if}
    {:else if mine && pet.locked}
      <p class="text-xs text-muted">
        {pet.name} is at work in the AI Lab. Unstake it in the desktop app to sell it.
      </p>
    {:else if mine}
      <div class="flex gap-2">
        <label class="flex min-w-0 flex-1 items-center border border-line bg-ink focus-within:border-line-bright">
          <input
            class="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"
            inputmode="decimal"
            placeholder="Price"
            aria-label="Price in NEAR"
            bind:value={price}
          />
          <span class="pr-3 text-xs text-muted">NEAR</span>
        </label>
        <button
          class="shrink-0 border border-accent bg-accent px-3 py-2 text-xs font-bold text-ink disabled:opacity-40"
          disabled={busy || !payout}
          onclick={() => run(() => listPet(pet.pet_id, price))}
          type="button"
        >
          {busy ? 'Listing…' : 'List for sale'}
        </button>
      </div>
      <p class="text-[0.65rem] text-muted">
        {#if payout}
          You receive {payout} NEAR after the {feeBps / 100}% market fee. Cancel any time before it
          sells.
        {:else}
          A {feeBps / 100}% market fee goes to the treasury, which funds the AI credits staked pets
          earn.
        {/if}
      </p>
    {:else}
      <p class="text-xs text-muted">
        Its owner hasn't listed it. Mint one like it below, or find one for sale in the gallery.
      </p>
    {/if}

    {#if error}
      <p class="border border-bad/40 px-3 py-2 text-xs text-bad">{error}</p>
    {/if}
  </div>
</div>
