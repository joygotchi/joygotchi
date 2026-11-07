<script lang="ts">
  import {
    ACTION_PRICE,
    formatCredits,
    ITEMS,
    itemName,
    type PetStatus,
    type StakeAccount
  } from '@joygotchi/pet';
  import {
    getInventory,
    getPetOwner,
    getPetStatus,
    getStakeAccount,
    isAttackable,
    listPets,
    stakeContractFor,
    type ChainPetSummary
  } from './chain';
  import BattleScene from './BattleScene.svelte';
  import {
    findEvent,
    readableError,
    reactToGame,
    requestWalletAction,
    session as walletSession,
    signAndSend,
    walletAction
  } from './wallet.svelte';
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
  let targets = $state<ChainPetSummary[]>([]);
  let showTargets = $state(false);
  let opponent = $state<ChainPetSummary | null>(null);
  let fight = $state<'ready' | 'fighting' | 'won' | 'lost'>('ready');
  let wager = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let loadedOnce = $state(false);
  let busy = $state<string | null>(null);
  let note = $state<string | null>(null);

  const session = $derived(walletSession.current);
  let chainOwner = $state<string | null>(null);
  const owner = $derived(chainOwner ?? pet.chain.owner);
  const mine = $derived(session?.accountId === owner);
  const credits = $derived(Number(account ? formatCredits(account.credit_balance, 6) : 0));
  const canFeed = $derived(mine && credits >= ACTION_PRICE.ai_feed);

  const stake = $derived(stakeContractFor(pet.chain.contract));
  const wounded = $derived(Number(status?.wounded_until ?? 0) / 1e6 > Date.now());
  const warded = $derived(Number(status?.shielded_until ?? 0) / 1e6 > Date.now());

  async function load() {
    // Only the first read shows a loading state; a refresh leaves what is on
    // screen and swaps it when the answer arrives. Keyed on having loaded at
    // all, not on having an account — a new player has no account yet, and
    // would otherwise sit in a loading state forever.
    loading = !loadedOnce;
    error = null;
    try {
      // The owner comes first: the credits and inventory shown belong to
      // whoever owns the pet now, not to whoever owned it at install time.
      const current = (await getPetOwner(pet.chain.network, pet.chain.contract, pet.petId)) ??
        pet.chain.owner;
      chainOwner = current;

      const [acc, st, inv] = await Promise.all([
        getStakeAccount(pet.chain.network, stake, current),
        getPetStatus(pet.chain.network, stake, pet.petId),
        getInventory(pet.chain.network, stake, current)
      ]);
      account = acc;
      status = st;
      inventory = inv;
      void loadTargets(current);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
      loadedOnce = true;
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
      error = readableError(cause);
    } finally {
      busy = null;
    }
  }

  const net = () => pet.chain.network;

  /**
   * Feed, claiming first when the balance alone will not cover it.
   *
   * Earned credits sit in `pending` until `claim_credits` moves them, and the
   * contract only ever spends the balance — so "not enough credits" while the
   * panel shows plenty is a thing that happens unless this does.
   */
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
        reactToGame('fed');
      },
      'Fed.'
    );

  /**
   * Who this pet could pick a fight with.
   *
   * Filtered here so the list only holds fights the chain will accept:
   * somebody else's pet, not at work in the lab, not starved, and not warded
   * or still wounded. The game contract checks all of this again — these
   * filters exist so nobody clicks a button that was never going to work.
   */
  async function loadTargets(owner: string) {
    const all = await listPets(net(), pet.chain.contract).catch(() => []);
    const candidates = all.filter(
      (other) =>
        other.pet_id !== pet.petId &&
        other.owner_id !== owner &&
        !other.locked &&
        Number(other.seconds_until_starving ?? 1) > 0
    );

    const allowed = await Promise.all(
      candidates.map((other) => isAttackable(net(), stake, other.pet_id))
    );
    targets = candidates.filter((_, index) => allowed[index]);
  }

  /**
   * Fight, with the scene doing the talking.
   *
   * The clash plays while the transaction is in flight rather than for a
   * fixed time, so nothing pretends to be finished before the chain says so,
   * and the outcome comes from the contract's own `battle_settled` event.
   */
  async function attack() {
    if (!opponent) return;
    const target = opponent;

    fight = 'fighting';
    error = null;
    note = null;

    try {
      const { logs } = await signAndSend(net(), 'attack', {
        pet_id: pet.petId,
        target_pet_id: target.pet_id
      });

      const settled = findEvent<{ winner_pet_id: number; transferred: string }>(
        logs,
        'battle_settled'
      );
      if (!settled) throw new Error('The battle went through but reported no result');

      fight = settled.winner_pet_id === pet.petId ? 'won' : 'lost';
      reactToGame('battled');
      wager = formatCredits(settled.transferred);
      await load();
    } catch (cause) {
      error = readableError(cause);
      opponent = null;
      fight = 'ready';
    }
  }

  function closeFight() {
    opponent = null;
    fight = 'ready';
    wager = null;
    showTargets = false;
  }

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

  {#if opponent}
    <BattleScene
      mine={pet}
      target={opponent}
      phase={fight}
      transferred={wager}
      onfight={attack}
      onclose={closeFight}
    />
  {:else if showTargets}
    <!--
      A view of its own, not a list under the button.
      The window is 340×460 and the panel scrolls, so the list used to open
      below the fold: the button said "Never mind" and nothing else appeared
      to change. Taking the panel means the choice is always the thing on
      screen, which is what it is.
    -->
    <div class="picker">
      <p class="muted">Pick somebody for {pet.displayName} to attack.</p>
      <ul class="targets">
        {#if targets.length === 0}
          <li class="muted">Nobody to fight: every other pet is at work, warded or hurt.</li>
        {:else}
          {#each targets as target (target.pet_id)}
            <li>
              <span class="target-name">
                {target.name}
                <span class="muted">lv {target.level}{target.star ? ` ·${target.star}★` : ''}</span>
              </span>
              <button
                disabled={busy !== null}
                onclick={() => {
                  opponent = target;
                  fight = 'ready';
                  wager = null;
                }}
                title="Wager credits against {target.owner_id}"
              >
                fight
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      <button class="wide" onclick={() => (showTargets = false)}>Back</button>
    </div>
  {:else if loading}
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
        You are signing as {session.accountId}; this pet belongs to {owner}.
      </p>
    {:else}
      <div class="actions">
        <button disabled={busy !== null || !canFeed} onclick={feed}>
          {busy === 'feed' ? 'Feeding…' : `Feed · ${ACTION_PRICE.ai_feed}`}
        </button>
        <button
          disabled={busy !== null || Number(account?.pending_credits ?? 0) === 0}
          onclick={() => act('claim', () => signAndSend(net(), 'claim_credits', {}), 'Claimed.')}
          title="Move earned credits into the spendable balance"
        >
          {busy === 'claim' ? 'Claiming…' : 'Claim'}
        </button>
        <button
          disabled={busy !== null}
          onclick={() => act('faucet', () => signAndSend(net(), 'claim_faucet', {}), 'Ten credits, once ever.')}
          title="Ten free credits, once per account"
        >
          {busy === 'faucet' ? '…' : 'Faucet'}
        </button>
        <button
          disabled={busy !== null || (account?.staked_pets.length ?? 0) === 0}
          onclick={() => act('mine', () => signAndSend(net(), 'claim_mining', {}), 'Mined.')}
          title={(account?.staked_pets.length ?? 0) === 0
            ? 'Mining needs a pet at work in the lab'
            : 'A small top-up every six hours'}
        >
          {busy === 'mine' ? 'Mining…' : 'Mine'}
        </button>
      </div>

      <div class="actions">
        <button
          disabled={busy !== null || status?.staked}
          onclick={() => (showTargets = true)}
          title={status?.staked
            ? 'A pet at work in the lab cannot fight'
            : 'Pick somebody to attack'}
        >
          Battle ({targets.length})
        </button>
      </div>

      <div class="actions">
        <button
          disabled={walletAction.running !== null}
          onclick={() =>
            requestWalletAction(status?.staked ? 'unstake_pet' : 'stake_pet', stake, pet.petId)}
          title="Opens your browser — the contract wants a real signature for this"
        >
          {#if walletAction.running}
            In your browser…
          {:else if status?.staked}
            Unstake ↗
          {:else}
            Stake ↗
          {/if}
        </button>
      </div>

      <ul class="items-grid">
        {#each Object.values(ITEMS) as item (item.id)}
          {@const owned = inventory.find(([id]) => id === item.id)?.[1] ?? 0}
          <li>
            <span class="item-name" title={item.blurb}>
              {item.name}{#if owned > 0}<span class="accent"> ×{owned}</span>{/if}
            </span>
            <span class="item-buttons">
              <button
                disabled={busy !== null}
                onclick={() =>
                  act(
                    `buy-${item.id}`,
                    () =>
                      signAndSend(net(), 'buy_credit_item', { item_id: item.id, quantity: 1 }),
                    `Bought a ${item.name}.`
                  )}
                title="Buy one"
              >
                {busy === `buy-${item.id}` ? '…' : '+'}
              </button>
              <button
                disabled={busy !== null || owned === 0}
                onclick={() =>
                  act(
                    `use-${item.id}`,
                    () => signAndSend(net(), 'use_item', { item_id: item.id, pet_id: pet.petId }),
                    `Used a ${itemName(item.id)}.`
                  )}
                title="Use on this pet"
              >
                {busy === `use-${item.id}` ? '…' : 'use'}
              </button>
            </span>
          </li>
        {/each}
      </ul>

      {#if note}<p class="ok">{note}</p>{/if}

      <p class="note">
        Staking opens your browser — the contract wants a yoctoNEAR, which a session key may never
        attach. Battling signs here, on the second key granted for the game contract.
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

  .items-grid {
    margin: 6px 0 0;
    padding: 6px 8px 0;
    border-top: 1px solid #171b22;
    list-style: none;
  }

  .items-grid li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
  }

  .item-name {
    color: #8b95a3;
  }

  .item-buttons {
    display: flex;
    gap: 3px;
  }

  .item-buttons button {
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    font-size: 10px;
    padding: 1px 6px;
    cursor: pointer;
  }

  .item-buttons button:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px;
    min-height: 0;
  }

  .targets {
    margin: 0;
    padding: 0;
    flex: 1;
    overflow-y: auto;
    list-style: none;
    border-top: 1px solid #171b22;
  }

  .targets li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
    padding: 2px 0;
  }

  .target-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .targets button {
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    font-size: 10px;
    padding: 1px 6px;
    cursor: pointer;
  }

  .targets button:disabled {
    opacity: 0.35;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px 0;
    border-top: 1px solid #171b22;
  }

  .actions button {
    flex: 1 1 60px;
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
