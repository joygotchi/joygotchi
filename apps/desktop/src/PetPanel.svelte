<script lang="ts">
  import { formatCredits, ITEMS, itemName, type PetStatus, type StakeAccount } from '@joygotchi/pet';
  import { ACTION_PRICE } from '@joygotchi/pet';
  import { getInventory, getPetStatus, getStakeAccount, stakeContractFor } from './chain';
  import { session as walletSession, signAndSend } from './wallet.svelte';
  import type { InstalledPet } from './types';

  /**
   * What this pet is up to, and what you can do about it.
   *
   * Only the actions the session key may sign appear here. Staking is absent
   * on purpose rather than broken: `stake_pet` wants one yoctoNEAR, a
   * function-call key cannot attach any deposit, and that is the whole reason
   * the contract asks for it — moving a pet in or out of the lab should take
   * a real wallet signature.
   */
  type Props = { pet: InstalledPet; onclose: () => void };
  let { pet, onclose }: Props = $props();

  let account = $state<StakeAccount | null>(null);
  let status = $state<PetStatus | null>(null);
  let inventory = $state<Array<[number, number]>>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let busy = $state<string | null>(null);
  let note = $state<string | null>(null);

  const session = $derived(walletSession.current);
  const mine = $derived(session?.accountId === pet.chain.owner);
  const credits = $derived(Number(account ? formatCredits(account.credit_balance, 6) : 0));
  const canFeed = $derived(mine && credits >= ACTION_PRICE.ai_feed);

  const stake = $derived(stakeContractFor(pet.chain.contract));
  const wounded = $derived(Number(status?.wounded_until ?? 0) / 1e6 > Date.now());
  const warded = $derived(Number(status?.shielded_until ?? 0) / 1e6 > Date.now());

  async function load() {
    loading = true;
    error = null;
    try {
      const [acc, st, inv] = await Promise.all([
        getStakeAccount(pet.chain.network, stake, pet.chain.owner),
        getPetStatus(pet.chain.network, stake, pet.petId),
        getInventory(pet.chain.network, stake, pet.chain.owner)
      ]);
      account = acc;
      status = st;
      inventory = inv;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
    }
  }

  /**
   * Claim first when the balance alone will not cover it. Earned credits sit
   * in `pending` until `claim_credits` moves them, and the contract only ever
   * spends the balance — so "not enough credits" while the panel shows plenty
   * is a thing that happens unless this does.
   */
  async function act(label: string, run: () => Promise<unknown>, after: string) {
    busy = label;
    error = null;
    note = null;
    try {
      await run();
      note = after;
      await load();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = null;
    }
  }

  const net = () => pet.chain.network;

  const feed = () =>
    act(
      'feed',
      async () => {
        const pending = Number(account ? formatCredits(account.pending_credits, 6) : 0);
        if (credits < ACTION_PRICE.ai_feed && pending > 0) {
          await signAndSend(net(), 'claim_credits', {});
        }
        await signAndSend(net(), 'spend_credits', {
          action: 'ai_feed',
          pet_id: pet.petId,
          amount: String(Math.round(ACTION_PRICE.ai_feed * 1e6))
        });
      },
      'Fed.'
    );

  $effect(() => {
    void pet.petId;
    void load();
  });
</script>

<div class="panel">
  <header data-tauri-drag-region>
    <span>{pet.displayName} <small>#{pet.petId}</small></span>
    <button data-tauri-drag-region="false" onclick={onclose} title="Close">✕</button>
  </header>

  {#if loading}
    <p class="muted">Reading the chain…</p>
  {:else if error}
    <p class="bad">{error}</p>
    <button class="wide" onclick={load}>Try again</button>
  {:else}
    <dl>
      <div><dt>Rarity</dt><dd>{pet.rarity}</dd></div>
      <div><dt>Level</dt><dd>{pet.level}{pet.star ? ` · ${'★'.repeat(pet.star)}` : ''}</dd></div>
      <div>
        <dt>In the lab</dt>
        <dd class:accent={status?.staked}>{status?.staked ? 'working' : 'idle'}</dd>
      </div>
      <div>
        <dt>Condition</dt>
        <dd class:warn={wounded}>
          {wounded ? 'wounded' : warded ? 'warded' : 'fine'}
        </dd>
      </div>
      {#if status && status.lens_feeds_left > 0}
        <div><dt>Lens</dt><dd class="accent">{status.lens_feeds_left} feeds</dd></div>
      {/if}
    </dl>

    <dl class="owner">
      <div>
        <dt>Credits</dt>
        <dd class="accent">{account ? formatCredits(account.credit_balance) : '0'}</dd>
      </div>
      <div>
        <dt>Unclaimed</dt>
        <dd>{account ? formatCredits(account.pending_credits) : '0'}</dd>
      </div>
    </dl>

    {#if inventory.length > 0}
      <ul class="items">
        {#each inventory as [id, count] (id)}
          <li title={ITEMS[id as keyof typeof ITEMS]?.blurb ?? ''}>
            {itemName(id)} <span class="muted">×{count}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if !session}
      <p class="note">Connect a wallet in Settings (⌘,) to feed it from here.</p>
    {:else if !mine}
      <p class="note">
        You are signing as {session.accountId}; this pet belongs to {pet.chain.owner}.
      </p>
    {:else}
      <div class="actions">
        <button disabled={busy !== null || !canFeed} onclick={feed}>
          {busy === 'feed' ? 'Feeding…' : `Feed · ${ACTION_PRICE.ai_feed}`}
        </button>
        <button
          disabled={busy !== null}
          onclick={() => act('claim', () => signAndSend(net(), 'claim_credits', {}), 'Claimed.')}
        >
          {busy === 'claim' ? 'Claiming…' : 'Claim'}
        </button>
        <button
          disabled={busy !== null}
          onclick={() => act('mine', () => signAndSend(net(), 'claim_mining', {}), 'Mined.')}
        >
          {busy === 'mine' ? 'Mining…' : 'Mine'}
        </button>
      </div>

      {#if note}<p class="ok">{note}</p>{/if}

      <p class="note">
        Staking asks your wallet — a session key cannot attach the yoctoNEAR the contract wants
        for moving a pet in or out of the lab.
      </p>
    {/if}
  {/if}
</div>

<style>
  .panel {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 0 6px;
    background: #0b0d10f2;
    border: 1px solid #39414d;
    font-size: 11px;
    overflow-y: auto;
  }

  header {
    cursor: grab;
    position: sticky;
    top: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid #242a33;
    background: #0b0d10;
  }

  header small {
    color: #8b95a3;
  }

  header button {
    cursor: pointer;
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 1px 6px;
  }

  dl {
    margin: 0;
    padding: 0 8px;
  }

  dl.owner {
    padding-top: 6px;
    border-top: 1px solid #171b22;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 0;
  }

  dt {
    color: #8b95a3;
  }

  dd {
    margin: 0;
  }

  .accent {
    color: #b6f36b;
  }

  .warn {
    color: #f3a66b;
  }

  .bad {
    color: #f36b7b;
    padding: 0 8px;
  }

  .muted {
    color: #8b95a3;
    padding: 0 8px;
  }

  .items {
    margin: 0;
    padding: 6px 8px 0;
    list-style: none;
    border-top: 1px solid #171b22;
  }

  .actions {
    display: flex;
    gap: 4px;
    padding: 6px 8px 0;
    border-top: 1px solid #171b22;
  }

  .actions button {
    flex: 1;
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    font-size: 10px;
    padding: 3px 4px;
    cursor: pointer;
  }

  .actions button:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ok {
    margin: 4px 0 0;
    padding: 0 8px;
    color: #b6f36b;
  }

  .note {
    margin: auto 0 0;
    padding: 6px 8px 0;
    border-top: 1px solid #171b22;
    color: #8b95a3;
    line-height: 1.5;
  }

  button.wide {
    margin: 0 8px;
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    padding: 3px 8px;
    cursor: pointer;
  }
</style>
