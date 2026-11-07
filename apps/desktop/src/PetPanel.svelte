<script lang="ts">
  import {
    ACTION_PRICE,
    AUTO_FEED_DAILY_BUDGET,
    AUTO_FEED_HOURS,
    formatCredits,
    ITEMS,
    itemName,
    toMicroCredits,
    type PetStatus,
    type StakeAccount
  } from '@joygotchi/pet';
  import {
    getInventory,
    getPetOwner,
    getPetStatus,
    getStakeAccount,
    forgetReads,
    getShop,
    isAttackable,
    miningAvailableAt,
    listPets,
    stakeContractFor,
    type ChainPetSummary,
    type ShopItem
  } from './chain';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import BattleScene from './BattleScene.svelte';
  import { artPathFor } from './art';
  import { canAfford, feedPet } from './actions';
  import { artOf, BACKDROPS, HATS, setStyle, styleFor } from './style.svelte';
  import { markSelfFight } from './battle-watch';
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
   * on purpose rather than broken: minting and buying are payable, and a
   * function-call key can never attach a deposit — that is the protocol
   * keeping a session key from spending a player's NEAR. Staking used to sit
   * in that group and no longer does.
   */
  type Props = {
    pet: InstalledPet;
    /** Everything installed, so the panel can flip between them. */
    pets?: InstalledPet[];
    onpick?: (slug: string) => void;
    onclose: () => void;
  };
  let { pet, pets = [], onpick, onclose }: Props = $props();

  /**
   * Flipping between pets belongs here, not only in Settings.
   *
   * Opening the panel on a pet that is not yours used to end the screen: a
   * sentence saying so, every control hidden, and no way on from there but
   * closing the window and finding the picker. Installing somebody else's pet
   * is normal — that is what an install code is for — so the panel has to
   * carry its own way out.
   */
  const siblings = $derived(pets.length > 1 ? pets : []);
  const step = (by: number) => {
    if (siblings.length === 0) return;
    const at = siblings.findIndex((p) => p.slug === pet.slug);
    const next = siblings[(at + by + siblings.length) % siblings.length];
    if (next) onpick?.(next.slug);
  };

  let account = $state<StakeAccount | null>(null);
  let status = $state<PetStatus | null>(null);
  let inventory = $state<Array<[number, number]>>([]);
  let targets = $state<ChainPetSummary[]>([]);
  let showTargets = $state(false);
  let opponent = $state<ChainPetSummary | null>(null);
  let fight = $state<'ready' | 'fighting' | 'won' | 'lost'>('ready');
  let wager = $state<string | null>(null);
  let error = $state<string | null>(null);
  /**
   * What an action was refused for, kept apart from `error`.
   *
   * They used to share one. A contract saying "mining is still on cooldown"
   * — a correct, expected answer — replaced the whole panel with a red line
   * and a Try again button, as if the chain had fallen over. `error` is for
   * a read that failed and left nothing to draw; this is for an answer.
   */
  let refused = $state<string | null>(null);
  let miningAt = $state(0);
  /** Ticks so the mining countdown moves between loads. */
  let now = $state(Date.now());
  let loading = $state(true);
  let loadedOnce = $state(false);
  let busy = $state<string | null>(null);
  let note = $state<string | null>(null);

  const session = $derived(walletSession.current);
  let chainOwner = $state<string | null>(null);
  const owner = $derived(chainOwner ?? pet.chain.owner);
  const mine = $derived(session?.accountId === owner);
  /*
   * Balance *and* claimable, because feeding claims on the way. Checking the
   * balance alone greyed out Feed while there were earned credits sitting
   * one call away — the very case the claim-first step exists for.
   */
  const canFeed = $derived(mine && canAfford(account));

  const stake = $derived(stakeContractFor(pet.chain.contract));
  /** Seconds until mining is allowed, and the same as "4h" or "12m". */
  const minesIn = $derived(Math.max(0, Math.round((miningAt - now) / 1000)));
  const untilMine = $derived(
    minesIn >= 3600 ? `${Math.floor(minesIn / 3600)}h` : `${Math.max(1, Math.ceil(minesIn / 60))}m`
  );

  const heroArt = $derived(convertFileSrc(`${pet.directory}/${pet.states.idle ?? ''}`));
  /** Whether this session's key covers staking, or predates it being granted. */
  const stakeSignsHere = $derived(
    (session?.methodNames ?? []).includes(status?.staked ? 'unstake_pet' : 'stake_pet')
  );
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

      const [acc, st, inv, minesAt] = await Promise.all([
        getStakeAccount(pet.chain.network, stake, current),
        getPetStatus(pet.chain.network, stake, pet.petId),
        getInventory(pet.chain.network, stake, current),
        miningAvailableAt(pet.chain.network, stake, current).catch(() => '0')
      ]);
      account = acc;
      status = st;
      inventory = inv;
      miningAt = Number(minesAt) / 1e6;
      void loadTargets(current);
      void getShop(pet.chain.network, pet.chain.contract)
        .then((items) => (shop = items))
        .catch(() => {});
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
      loadedOnce = true;
    }
  }

  /** Run one action with the panel's busy, error and note handling around it. */
  async function act(label: string, run: () => Promise<unknown>, after: string) {
    busy = label;
    refused = null;
    note = null;
    try {
      await run();
      note = after;
      // The chain just changed, so the few seconds of read coalescing would
      // otherwise show the state from before the thing that was signed.
      forgetReads();
      await load();
    } catch (cause) {
      refused = readableError(cause);
    } finally {
      busy = null;
    }
  }

  const net = () => pet.chain.network;

  const feed = () => act('feed', () => feedPet(net(), pet.petId, account), 'Fed.');

  /**
   * Hand the pet's survival to the oracle, or take it back.
   *
   * This is the only thing in the product that keeps a pet alive without
   * you: `buy_item` is payable, so by protocol no session key can ever call
   * it, and a pet starves on a clock that does not care whether you are at
   * your desk. `auto_feed` spends credits instead of NEAR and is capped by a
   * budget you set here, so the worst it can do is spend what you allowed.
   */
  const autoFeedOn = $derived(Number(account?.auto_feed_budget ?? 0) > 0);
  const autoFeedUsed = $derived(Number(account?.auto_feed_spent ?? 0) / 1e6);

  const toggleAutoFeed = () =>
    act(
      'auto',
      () =>
        signAndSend(net(), 'set_auto_feed_budget', {
          budget: autoFeedOn ? '0' : toMicroCredits(AUTO_FEED_DAILY_BUDGET)
        }),
      autoFeedOn ? 'Auto-feed off.' : 'Auto-feed on.'
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

    // This window is about to show the fight itself, so the chain watcher
    // must not open its spectator overlay over the top of it.
    markSelfFight();
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

  /**
   * Put the pet in or out of the lab.
   *
   * Signs here now: the contract dropped the yoctoNEAR it used to demand, so
   * a function-call key can carry this. A session granted before that change
   * does not list the method, and no amount of retrying will fix it — so that
   * case keeps the old browser route rather than failing, until the player
   * grants a key again.
   */
  function toggleStake() {
    const method = status?.staked ? 'unstake_pet' : 'stake_pet';
    if (!stakeSignsHere) {
      void requestWalletAction(method, stake, pet.petId);
      return;
    }
    void act(
      'stake',
      () => signAndSend(net(), method, { pet_id: pet.petId }),
      status?.staked ? 'Out of the lab.' : 'At work in the lab.'
    );
  }

  /**
   * The shop's art, by the contract's own item ids.
   *
   * These four sprites were drawn for this shop and had never reached the
   * app — the only place in the product that can feed a pet was unreachable
   * from it, so `Feed` charged credits and the starvation clock ran on.
   */
  const SHOP_ART: Record<number, string> = {
    1: '/assets/items/beef.png',
    2: '/assets/items/water.png',
    3: '/assets/items/shield.png',
    4: '/assets/items/holy_water.png'
  };

  let shop = $state<ShopItem[]>([]);
  let showShop = $state(false);

  /** NEAR, from yoctoNEAR, short enough for a 340px panel. */
  const inNear = (yocto: string) => {
    const n = Number(BigInt(yocto) / 10n ** 18n) / 1e6;
    return n < 1 ? n.toFixed(2).replace(/0$/, '') : String(n);
  };

  /** The drawn item for each id, so the bag reads as a bag. */
  const ITEM_ART: Record<number, string> = {
    101: '/assets/items/holy_water.png',
    102: '/assets/items/shield.png',
    103: '/assets/items/food.png',
    104: '/assets/item/star.png'
  };

  let showBag = $state(false);
  let showStyle = $state(false);

  const dressed = $derived(styleFor(pet.slug));
  const hatArt = $derived(artOf(HATS, dressed.hat));
  const backdropArt = $derived(artOf(BACKDROPS, dressed.backdrop));

  function closeFight() {
    opponent = null;
    fight = 'ready';
    wager = null;
    showTargets = false;
  }

  $effect(() => {
    void pet.petId;
    void load();
    const tick = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(tick);
  });
</script>


{#snippet tile(
  label: string,
  art: string,
  onclick: () => void,
  disabled: boolean,
  hint: string,
  busyLabel?: string
)}
  <button class="jg-tile" {disabled} {onclick} title={hint}>
    <img alt="" src={art} />
    <span>{busyLabel ?? label}</span>
  </button>
{/snippet}

<div class="panel jg jg-frame">
  <header data-tauri-drag-region>
    {#if siblings.length > 0}
      <button
        class="arrow"
        data-tauri-drag-region="false"
        onclick={() => step(-1)}
        title="Previous pet"
      >
        <img class="jg-px" alt="" src="/assets/icon/arrow_left.png" />
      </button>
    {/if}
    <span class="who">{pet.displayName} <small>#{pet.petId}</small></span>
    {#if siblings.length > 0}
      <button class="arrow" data-tauri-drag-region="false" onclick={() => step(1)} title="Next pet">
        <img class="jg-px" alt="" src="/assets/icon/arrow_right.png" />
      </button>
    {/if}
    <button class="x" data-tauri-drag-region="false" onclick={onclose} title="Close">✕</button>
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
    <div class="view">
      <p class="lead">Who should {pet.displayName} fight?</p>
      <ul class="targets jg-screen">
        {#if targets.length === 0}
          <li class="muted">Nobody to fight — everyone is at work, warded or hurt.</li>
        {:else}
          {#each targets as target (target.pet_id)}
            <li>
              <img class="jg-px" alt="" src={artPathFor(target)} />
              <span class="target-name">
                {target.name}
                <small>lv {target.level}{target.star ? ` ·${target.star}★` : ''}</small>
              </span>
              <button
                class="jg-btn primary"
                disabled={busy !== null}
                onclick={() => {
                  opponent = target;
                  fight = 'ready';
                  wager = null;
                }}
                title="Wager credits against {target.owner_id}"
              >
                Fight
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      <button class="jg-btn wide" onclick={() => (showTargets = false)}>Back</button>
    </div>
  {:else if showShop}
    <div class="view">
      <p class="lead">
        Paid in NEAR, applied straight away. This is the only thing that moves
        {pet.displayName}'s hunger.
      </p>
      <ul class="grid jg-screen">
        {#each shop as item (item.item_id)}
          <li class="card">
            <img class="art jg-px" alt="" src={SHOP_ART[item.item_id] ?? '/assets/items/food.png'} />
            <span class="title">{item.name}</span>
            <span class="effect">
              {#if item.time_extension}+{Math.round(item.time_extension / 3600)}h{/if}
              {#if item.xp} +{item.xp}xp{/if}
              {#if item.shield} +{item.shield} shield{/if}
              {#if item.is_revival} revives{/if}
            </span>
            <button
              class="jg-btn primary buy"
              disabled={walletAction.running !== null}
              onclick={() =>
                requestWalletAction('buy_item', pet.chain.contract, pet.petId, item.item_id)}
              title="Opens your browser — paid in NEAR, so it needs a real signature"
            >
              {inNear(item.price)} ↗
            </button>
          </li>
        {/each}
        {#if shop.length === 0}
          <li class="muted span2">The shop could not be read from the contract.</li>
        {/if}
      </ul>
      <button class="jg-btn wide" onclick={() => (showShop = false)}>Back</button>
    </div>
  {:else if showStyle}
    <div class="view">
      <p class="lead">What {pet.displayName} wears, kept on this machine.</p>

      <p class="lead">Hat</p>
      <ul class="grid jg-screen">
        {#each HATS as item (item.id)}
          <li class="card" class:picked={dressed.hat === item.id}>
            <button class="pick" onclick={() => setStyle(pet.slug, { hat: item.id })}>
              <span class="swatch">
                {#if item.art}<img class="jg-px" alt="" src={item.art} />{:else}—{/if}
              </span>
              <span class="title">{item.name}</span>
            </button>
          </li>
        {/each}
      </ul>

      <p class="lead">Backdrop</p>
      <ul class="grid jg-screen">
        {#each BACKDROPS as item (item.id)}
          <li class="card" class:picked={dressed.backdrop === item.id}>
            <button class="pick" onclick={() => setStyle(pet.slug, { backdrop: item.id })}>
              <span class="swatch wide">
                {#if item.art}<img alt="" src={item.art} />{:else}—{/if}
              </span>
              <span class="title">{item.name}</span>
            </button>
          </li>
        {/each}
      </ul>

      <button class="jg-btn wide" onclick={() => (showStyle = false)}>Back</button>
    </div>
  {:else if showBag}
    <div class="view">
      <p class="lead">{pet.displayName}'s bag</p>
      <ul class="grid jg-screen">
        {#each Object.values(ITEMS) as item (item.id)}
          {@const owned = inventory.find(([id]) => id === item.id)?.[1] ?? 0}
          <li class="card" class:empty={owned === 0} title={item.blurb}>
            <span class="art-wrap">
              <img class="art jg-px" alt="" src={ITEM_ART[item.id]} />
              {#if owned > 0}<span class="count">{owned}</span>{/if}
            </span>
            <span class="title">{item.name}</span>
            <span class="buttons">
              <button
                class="jg-btn"
                disabled={busy !== null}
                onclick={() =>
                  act(
                    `buy-${item.id}`,
                    () => signAndSend(net(), 'buy_credit_item', { item_id: item.id, quantity: 1 }),
                    `Bought a ${item.name}.`
                  )}
                title="Buy one with credits"
              >
                {busy === `buy-${item.id}` ? '…' : 'Buy'}
              </button>
              <button
                class="jg-btn primary"
                disabled={busy !== null || owned === 0}
                onclick={() =>
                  act(
                    `use-${item.id}`,
                    () => signAndSend(net(), 'use_item', { item_id: item.id, pet_id: pet.petId }),
                    `Used a ${itemName(item.id)}.`
                  )}
                title={item.blurb}
              >
                {busy === `use-${item.id}` ? '…' : 'Use'}
              </button>
            </span>
          </li>
        {/each}
      </ul>
      {#if note}<p class="ok">{note}</p>{/if}
      <button class="jg-btn wide" onclick={() => (showBag = false)}>Back</button>
    </div>
  {:else if loading}
    <p class="lead">Reading the chain…</p>
  {:else if error}
    <p class="bad">{error}</p>
    <button class="jg-btn wide" onclick={load}>Try again</button>
  {:else}
    <!-- The pet, on its own screen, the way the game showed it. -->
    <div
      class="stage jg-screen"
      style:background-image={backdropArt ? `url('${backdropArt}')` : 'none'}
    >
      <span class="badge tl">lv {pet.level}{pet.star ? ` ${'★'.repeat(pet.star)}` : ''}</span>
      <span class="badge tr">{pet.rarity}</span>
      <span class="hero-wrap">
        <img class="hero jg-px" alt={pet.displayName} src={heroArt} />
        {#if hatArt}<img class="hero-hat jg-px" alt="" src={hatArt} />{/if}
      </span>
      <span class="badge bl" class:work={status?.staked}>
        {status?.staked ? 'at work' : 'idle'}
      </span>
      <span class="badge br" class:hurt={wounded} class:ward={warded}>
        {wounded ? 'wounded' : warded ? 'warded' : 'fine'}
      </span>
    </div>

    <div class="purse jg-screen">
      <img class="jg-px" alt="" src="/assets/item/coin.png" />
      <b>{account ? formatCredits(account.credit_balance) : '0'}</b>
      <span class="muted">unclaimed {account ? formatCredits(account.pending_credits) : '0'}</span>
      {#if status && status.lens_feeds_left > 0}
        <span class="lens">lens ×{status.lens_feeds_left}</span>
      {/if}
    </div>

    {#if mine}
      <!--
        On the main screen rather than behind a tile: it is the difference
        between a pet that survives the weekend and one that does not.
      -->
      <div class="auto jg-screen" class:on={autoFeedOn}>
        <img class="jg-px" alt="" src="/assets/items/food.png" />
        <span class="auto-text">
          {#if autoFeedOn}
            <!--
              "Allowed", not "on": the budget is permission for the oracle to
              spend, and the oracle is a service somebody has to run. Nothing
              in this repository runs it yet, so a switch that said the pet
              was safe would be the most expensive lie in the app.
            -->
            Auto-feed allowed · {formatCredits(toMicroCredits(AUTO_FEED_DAILY_BUDGET))}/day
            {#if autoFeedUsed > 0}
              · {autoFeedUsed.toFixed(3)} used today
            {:else}
              · nothing spent yet
            {/if}
          {:else}
            Auto-feed off — {pet.displayName} starves if you are away
          {/if}
        </span>
        <button
          class="jg-btn"
          class:primary={!autoFeedOn}
          disabled={busy !== null}
          onclick={toggleAutoFeed}
          title={autoFeedOn
            ? 'Stop the oracle feeding this account'
            : `The oracle may spend up to ${AUTO_FEED_DAILY_BUDGET} credits a day, ${ACTION_PRICE.auto_feed} at a time, each buying ${AUTO_FEED_HOURS} hours`}
        >
          {busy === 'auto' ? '…' : autoFeedOn ? 'Off' : 'On'}
        </button>
      </div>
      {#if autoFeedOn && autoFeedUsed === 0}
        <p class="note warn">
          The feeder service has not spent any of this. Until one runs,
          {pet.displayName} still needs feeding by hand.
        </p>
      {/if}
    {/if}

    {#if !session}
      <p class="note">Connect a wallet in Settings (⌘,) to play from here.</p>
    {:else if !mine}
      <p class="note">
        {pet.displayName} belongs to {owner}, and you are signing as
        {session.accountId} — so there is nothing here you can do to it.
      </p>
      {#if siblings.length > 0}
        <button class="jg-btn primary wide" onclick={() => step(1)}>
          Show my next pet →
        </button>
      {/if}
    {:else}
      <div class="tiles">
        <!--
          Feed opens the shop rather than spending credits. `spend_credits`
          with `ai_feed` records a meal and charges for it, and never touches
          `starves_at` — the deadline only moves on the game contract's
          `buy_item`. A button named Feed that does not feed is worse than no
          button, so this one goes where the food is.
        -->
        {@render tile(
          'Feed',
          '/assets/items/beef.png',
          () => (showShop = true),
          busy !== null,
          'Food and revival items, paid in NEAR'
        )}
        <!--
          Off until something runs the oracle.
          `spend_credits("ai_feed")` charges, burns a Focus Lens, rolls for a
          drop and logs the meal for the oracle to turn into XP. No oracle
          runs, so the XP never arrives. What is left is a 3.6% chance of a
          Tonic worth 0.01 for 0.002 — and a Lens, bought for 0.02, spent on
          a bonus that cannot be delivered. A pet with nothing staked does
          not even get the roll: `drop_odds` returns zero at zero weight.
        -->
        {@render tile(
          'AI meal',
          '/assets/items/food.png',
          feed,
          true,
          'Off: this earns XP through the feed oracle, and nothing runs one yet. ' +
            'It would charge credits and spend a Focus Lens for nothing.'
        )}
        {@render tile(
          'Claim',
          '/assets/item/coin.png',
          () => act('claim', () => signAndSend(net(), 'claim_credits', {}), 'Claimed.'),
          busy !== null || Number(account?.pending_credits ?? 0) === 0,
          'Move earned credits into the spendable balance',
          busy === 'claim' ? '…' : undefined
        )}
        {@render tile(
          'Faucet',
          '/assets/items/water.png',
          () => act('faucet', () => signAndSend(net(), 'claim_faucet', {}), 'Ten credits, once ever.'),
          busy !== null,
          'Ten free credits, once per account',
          busy === 'faucet' ? '…' : undefined
        )}
        {@render tile(
          minesIn > 0 ? `Mine ${untilMine}` : 'Mine',
          '/assets/button/mining.png',
          () => act('mine', () => signAndSend(net(), 'claim_mining', {}), 'Mined.'),
          busy !== null || (account?.staked_pets.length ?? 0) === 0 || minesIn > 0,
          (account?.staked_pets.length ?? 0) === 0
            ? 'Mining needs a pet at work in the lab'
            : minesIn > 0
              ? `On cooldown for another ${untilMine}`
              : 'A small top-up every six hours',
          busy === 'mine' ? '…' : undefined
        )}
        {@render tile(
          `Battle ${targets.length ? `(${targets.length})` : ''}`,
          '/assets/button/attack.png',
          () => (showTargets = true),
          busy !== null || !!status?.staked,
          status?.staked ? 'A pet at work in the lab cannot fight' : 'Pick somebody to attack'
        )}
        {@render tile(
          status?.staked ? 'Bring home' : 'AI Lab',
          '/assets/button/house.png',
          toggleStake,
          busy !== null || walletAction.running !== null,
          stakeSignsHere
            ? 'Signs here, with your session key'
            : 'Opens your browser — this session key predates staking being granted',
          busy === 'stake' ? '…' : walletAction.running ? 'browser…' : undefined
        )}
        {@render tile(
          'Style',
          '/assets/hat/crown.svg',
          () => (showStyle = true),
          busy !== null,
          'Hats and backdrops, kept on this machine'
        )}
        {@render tile(
          'Bag',
          '/assets/button/backpack.png',
          () => (showBag = true),
          busy !== null,
          'Buy and use items'
        )}
      </div>

      {#if note}<p class="ok">{note}</p>{/if}
      {#if refused}<p class="bad">{refused}</p>{/if}

      <!--
        Silkscreen is all caps at this size, so three lines of prose reads as
        a wall. One short line, and only when there is something to say.
      -->
      {#if !stakeSignsHere}
        <p class="note">AI Lab opens your browser — reconnect in Settings to sign it here.</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  /*
   * Measurements, not taste: the window is 340×460 and the frame eats 14px a
   * side, so everything below is sized against roughly 300×400 of usable
   * screen. Anything that does not fit becomes a view of its own rather than
   * something you have to scroll to find — the opponent list already taught
   * that lesson once.
   */
  .panel {
    position: absolute;
    inset: 2px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 4px;
    font-size: 10px;
    overflow-y: auto;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: grab;
  }

  .who {
    font-weight: 700;
    font-size: 11px;
    letter-spacing: 0.04em;
  }

  .who small {
    color: var(--jg-muted);
    font-size: 9px;
  }

  .arrow {
    border: 0;
    background: none;
    padding: 0 2px;
    cursor: pointer;
    line-height: 0;
  }

  .arrow img {
    width: 12px;
    height: 12px;
    object-fit: contain;
  }

  .who {
    flex: 1;
    text-align: center;
  }

  .x {
    border: 0;
    background: none;
    font: inherit;
    font-size: 12px;
    line-height: 1;
    color: var(--jg-muted);
    cursor: pointer;
  }

  .x:hover {
    color: var(--jg-bad);
  }

  /* The pet, framed, with its numbers pinned to the corners of the glass. */
  .stage {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 120px;
    padding: 4px;
    background-color: var(--jg-screen);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
  }

  /* The sprite and whatever it is wearing move as one. */
  .hero-wrap {
    position: relative;
    display: block;
    width: 96px;
  }

  .hero {
    width: 96px;
    image-rendering: pixelated;
    display: block;
  }

  .hero-hat {
    position: absolute;
    left: 50%;
    top: 14%;
    width: 44%;
    transform: translateX(-50%);
  }

  .card.picked {
    background: #fff;
    border-color: var(--jg-good);
  }

  .pick {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    width: 100%;
    border: 0;
    background: none;
    font: inherit;
    color: inherit;
    cursor: pointer;
    padding: 0;
  }

  .swatch {
    display: grid;
    place-items: center;
    width: 100%;
    height: 28px;
    font-size: 10px;
    color: var(--jg-muted);
  }

  .swatch img {
    max-width: 90%;
    max-height: 100%;
    image-rendering: pixelated;
  }

  .swatch.wide img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border: 1px solid var(--jg-edge);
  }

  .badge {
    position: absolute;
    padding: 1px 4px;
    font-size: 8px;
    line-height: 1.4;
    color: var(--jg-ink);
    background: #ffffffcc;
    border: 1px solid var(--jg-edge);
  }

  .tl { top: 3px; left: 3px; }
  .tr { top: 3px; right: 3px; }
  .bl { bottom: 3px; left: 3px; }
  .br { bottom: 3px; right: 3px; }

  .badge.work { color: var(--jg-good); }
  .badge.hurt { color: var(--jg-bad); }
  .badge.ward { color: #3b7fb8; }

  .purse {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 5px;
    font-size: 9px;
  }

  .purse img {
    width: 14px;
  }

  .purse b {
    font-size: 11px;
    color: var(--jg-ink);
  }

  .purse .muted {
    margin-left: auto;
    color: var(--jg-muted);
  }

  .auto {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 5px;
    font-size: 8px;
  }

  .auto img {
    width: 13px;
    height: 13px;
    object-fit: contain;
    filter: grayscale(1);
    opacity: 0.5;
  }

  .auto.on img {
    filter: none;
    opacity: 1;
  }

  .auto-text {
    flex: 1;
    line-height: 1.4;
    color: var(--jg-muted);
  }

  .auto.on .auto-text {
    color: var(--jg-ink);
  }

  .auto button {
    padding: 2px 7px;
  }

  .purse .lens {
    color: var(--jg-good);
  }

  /* Four across: the widest label still fits at 300px of usable width. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }

  .view {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-height: 0;
  }

  .lead {
    margin: 0;
    font-size: 9px;
    color: var(--jg-muted);
  }

  .targets {
    margin: 0;
    padding: 3px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 260px;
    overflow-y: auto;
  }

  .targets li {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 2px;
  }

  .targets li img {
    width: 24px;
    height: 24px;
    object-fit: contain;
  }

  /*
   * Items as cards, two across.
   *
   * They were rows with a 24px thumbnail, which is how a settings screen
   * lists things — the art was there and too small to read, and a row cannot
   * show you at a glance that you own two Tonics. A card gives the sprite the
   * room it was drawn at and puts the count on it.
   */
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    margin: 0;
    padding: 4px;
    list-style: none;
    max-height: 270px;
    overflow-y: auto;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px 3px;
    background: #ffffffaa;
    border: 2px solid var(--jg-edge);
  }

  .card.empty {
    background: #ffffff55;
  }

  .card.empty .art {
    filter: grayscale(0.8);
    opacity: 0.6;
  }

  .art-wrap {
    position: relative;
    display: block;
  }

  .art {
    width: 34px;
    height: 34px;
    object-fit: contain;
  }

  /* On the sprite, the way a game counts a stack. */
  .count {
    position: absolute;
    right: -4px;
    bottom: -2px;
    min-width: 11px;
    padding: 0 1px;
    font-size: 8px;
    line-height: 1.3;
    text-align: center;
    color: #fff;
    background: var(--jg-good);
    border: 1px solid var(--jg-edge);
  }

  .card .title {
    font-size: 8px;
    text-align: center;
    line-height: 1.2;
  }

  .card .effect {
    font-size: 7px;
    text-align: center;
    color: var(--jg-muted);
    line-height: 1.3;
  }

  .card .buttons {
    display: flex;
    gap: 2px;
    width: 100%;
  }

  .card .buttons button {
    flex: 1;
    padding: 2px 0;
    font-size: 8px;
  }

  .card .buy {
    width: 100%;
    margin-top: 1px;
  }

  .span2 {
    grid-column: 1 / -1;
  }

  .target-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 9px;
  }

  .target-name small {
    color: var(--jg-muted);
    font-size: 8px;
  }


  .wide {
    width: 100%;
  }

  .muted {
    color: var(--jg-muted);
  }

  .ok {
    margin: 0;
    font-size: 9px;
    color: var(--jg-good);
  }

  .bad {
    margin: 0;
    font-size: 9px;
    color: var(--jg-bad);
  }

  .note {
    margin: 0;
    font-size: 8px;
    line-height: 1.5;
    color: var(--jg-muted);
  }

  .note.warn {
    color: #a8700f;
  }
</style>
