<script lang="ts">
  import { formatCredits, ITEMS, itemName, type PetStatus, type StakeAccount } from '@joygotchi/pet';
  import { getInventory, getPetStatus, getStakeAccount, stakeContractFor } from './chain';
  import type { InstalledPet } from './types';

  /**
   * What this pet is up to on chain.
   *
   * Read-only, and the panel says why rather than showing buttons that cannot
   * work: every action — feeding, staking, items — is a signed transaction,
   * and the app holds no key. The options are both real and neither is free:
   * a function-call access key scoped to the two game contracts, granted once
   * from the website and stored here, or a round trip to the browser per
   * action. The first is what NEAR's limited keys are for; the second never
   * stops being annoying. That is a decision, not an oversight.
   */
  type Props = { pet: InstalledPet; onclose: () => void };
  let { pet, onclose }: Props = $props();

  let account = $state<StakeAccount | null>(null);
  let status = $state<PetStatus | null>(null);
  let inventory = $state<Array<[number, number]>>([]);
  let error = $state<string | null>(null);
  let loading = $state(true);

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

  $effect(() => {
    void pet.petId;
    void load();
  });
</script>

<div class="panel">
  <header>
    <span>{pet.displayName} <small>#{pet.petId}</small></span>
    <button onclick={onclose} title="Close">✕</button>
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

    <p class="note">
      Feeding, staking and items are signed transactions and this app holds no key yet, so they
      live on the pet's page for now.
    </p>
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
