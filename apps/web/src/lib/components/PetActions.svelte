<script lang="ts">
  import {
    ACTION_PRICE,
    buyItem,
    claimCredits,
    formatCredits,
    getInventory,
    getPetState,
    getPool,
    getStakeAccount,
    itemName,
    ITEMS,
    creditsPerDay,
    spendCredits,
    stakePet,
    unstakePet,
    useItem,
    type PetState,
    type Pool,
    type StakeAccount
  } from '#lib/economy';
  import { wallet } from '#lib/near/wallet.svelte';
  import type { GalleryPet } from '#lib/pets';

  /**
   * Everything the owner can do with this pet.
   *
   * Only rendered for the owner: every call here is rejected by the contract
   * for anyone else, and offering a button that is going to fail is worse than
   * not offering it.
   */
  type Props = { pet: GalleryPet; onchanged?: () => void };
  let { pet, onchanged }: Props = $props();

  let account = $state<StakeAccount | null>(null);
  let petState = $state<PetState | null>(null);
  let pool = $state<Pool | null>(null);
  let inventory = $state<Array<[number, number]>>([]);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);

  const staked = $derived(petState?.staked ?? false);
  const balance = $derived(account ? Number(formatCredits(account.credit_balance, 6)) : 0);
  const pending = $derived(account ? Number(formatCredits(account.pending_credits, 6)) : 0);
  const wounded = $derived(Number(petState?.wounded_until ?? 0) / 1e6 > Date.now());
  const lensLeft = $derived(petState?.lens_feeds_left ?? 0);

  /** What this pet would add per day if staked, at the pool's current size. */
  const projected = $derived.by(() => {
    if (!pool) return 0;
    const weight = Number(pet.pkg.rarity === 'legendary' ? 400 : 100);
    const after = { ...pool, total_weight: String(Number(pool.total_weight) + weight) };
    return creditsPerDay(weight, staked ? pool : after);
  });

  async function load() {
    const [acc, state, p, inv] = await Promise.all([
      wallet.accountId ? getStakeAccount(wallet.accountId).catch(() => null) : null,
      getPetState(pet.pet_id).catch(() => null),
      getPool().catch(() => null),
      wallet.accountId ? getInventory(wallet.accountId).catch(() => []) : []
    ]);
    account = acc;
    petState = state;
    pool = p;
    inventory = inv;
  }

  async function run(label: string, action: () => Promise<unknown>, after?: string) {
    busy = label;
    error = null;
    note = null;
    try {
      await action();
      note = after ?? null;
      await load();
      onchanged?.();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  /**
   * Feeding spends from the balance, and only `claim_credits` fills it. A
   * player who has been staking all week and never pressed Claim has, as far
   * as `spend_credits` is concerned, nothing — so claim first when it would
   * otherwise fail.
   */
  async function feed() {
    await run(
      'feed',
      async () => {
        if (balance < ACTION_PRICE.ai_feed && pending > 0) await claimCredits();
        await spendCredits('ai_feed', pet.pet_id);
      },
      'Fed. XP lands once the server signs the award — see the note below.'
    );
  }

  $effect(() => {
    void pet.pet_id;
    void wallet.accountId;
    void load();
  });
</script>

<div class="border border-line bg-panel">
  <div class="border-b border-line px-4 py-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">Your pet</h2>
    <p class="mt-1 text-xs text-muted">
      {#if staked}
        At work in the AI Lab, earning about
        <span class="text-accent">{projected.toFixed(2)}</span> credits a day. It cannot battle or
        be sold while it works.
      {:else}
        Idle. Staking it would earn roughly
        <span class="text-accent">{projected.toFixed(2)}</span> credits a day at the pool's
        current size.
      {/if}
    </p>
  </div>

  <div class="flex flex-wrap gap-2 p-4 text-xs">
    {#if staked}
      <button
        class="border border-line px-3 py-2 hover:border-line-bright disabled:opacity-40"
        disabled={busy !== null}
        onclick={() => run('unstake', () => unstakePet(pet.pet_id), 'Back home.')}
      >
        {busy === 'unstake' ? 'Unstaking…' : 'Unstake'}
      </button>
    {:else}
      <button
        class="border border-accent bg-accent px-3 py-2 font-bold text-ink disabled:opacity-40"
        disabled={busy !== null}
        onclick={() => run('stake', () => stakePet(pet.pet_id), 'At work.')}
      >
        {busy === 'stake' ? 'Staking…' : 'Stake for credits'}
      </button>
    {/if}

    <button
      class="border border-line px-3 py-2 hover:border-line-bright disabled:opacity-40"
      disabled={busy !== null}
      onclick={feed}
      title="{ACTION_PRICE.ai_feed} credits"
    >
      {busy === 'feed' ? 'Feeding…' : `Feed · ${ACTION_PRICE.ai_feed}`}
    </button>

    {#if lensLeft > 0}
      <span class="self-center text-[0.65rem] text-accent">lens: {lensLeft} feeds left</span>
    {/if}
    {#if wounded}
      <span class="self-center text-[0.65rem] text-warn">wounded — a Tonic clears it</span>
    {/if}
  </div>

  <!-- Items -->
  <div class="border-t border-line p-4">
    <h3 class="mb-2 text-[0.65rem] tracking-widest text-muted uppercase">Items</h3>

    <div class="grid gap-2 sm:grid-cols-2">
      {#each Object.values(ITEMS) as item (item.id)}
        {@const owned = inventory.find(([id]) => id === item.id)?.[1] ?? 0}
        <div class="flex flex-col gap-2 border border-line bg-ink p-2">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-xs">{item.name}</span>
            {#if owned > 0}<span class="text-[0.65rem] text-accent">×{owned}</span>{/if}
          </div>
          <p class="text-[0.6rem] leading-relaxed text-muted">{item.blurb}</p>

          <div class="mt-auto flex gap-1">
            <button
              class="flex-1 border border-line px-2 py-1 text-[0.65rem] hover:border-line-bright disabled:opacity-40"
              disabled={busy !== null}
              onclick={() => run(`buy-${item.id}`, () => buyItem(item.id), `Bought a ${item.name}.`)}
            >
              {busy === `buy-${item.id}` ? '…' : 'Buy'}
            </button>
            <button
              class="flex-1 border border-line px-2 py-1 text-[0.65rem] hover:border-line-bright disabled:opacity-40"
              disabled={busy !== null || owned === 0}
              onclick={() =>
                run(
                  `use-${item.id}`,
                  () => useItem(item.id, pet.pet_id),
                  `Used a ${itemName(item.id)}.`
                )}
            >
              {busy === `use-${item.id}` ? '…' : 'Use'}
            </button>
          </div>
        </div>
      {/each}
    </div>
  </div>

  {#if note}
    <p class="border-t border-line px-4 py-2 text-xs text-accent">{note}</p>
  {/if}
  {#if error}
    <p class="border-t border-bad/30 px-4 py-2 text-xs text-bad">{error}</p>
  {/if}

  <p class="border-t border-line px-4 py-2 text-[0.6rem] text-muted">
    Feeding spends credits and records the meal on chain. The XP it earns is awarded by a server
    key that this deployment does not hold yet, so levels do not move from here.
  </p>
</div>
