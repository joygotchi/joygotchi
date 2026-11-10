<script lang="ts">
  import {
    ACTION_PRICE,
    autoFeedBudgetFor,
    AUTO_FEED_HOURS,
    formatCredits,
    ITEMS,
    itemName,
    levelToEvolve,
    type ItemId,
    type PetStatus,
    type StakeAccount
  } from '@joygotchi/pet';
  import {
    getInventory,
    getPetOnChain,
    getPetStatus,
    getStakeAccount,
    accessoriesOf,
    accessoryContractFor,
    forgetReads,
    getAccessoryKinds,
    getCreditItems,
    getListings,
    isAttackable,
    miningAvailableAt,
    listPets,
    stakeContractFor,
    wornBy,
    type AccessoryKind,
    type ChainPetSummary,
    type Listing,
    type OwnedAccessory
  } from './chain';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import BattleScene from './BattleScene.svelte';
  import { artPathFor } from './art';
  import { canAfford, canSpend, evolvePet, feedPet, gradeFeed, revivePet } from './actions';
  import { artOf, BACKDROPS, setStyle, styleFor } from './style.svelte';
  import { clearThread, say, threadFor } from './chat.svelte';
  import { markSelfFight } from './battle-watch';
  import {
    findEvent,
    readableError,
    reactToGame,
    requestAccessoryAction,
    requestMarketAction,
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
  /** Everyone else's pets; `why` is null when this one can actually be fought. */
  type Target = ChainPetSummary & { why: string | null };
  let targets = $state<Target[]>([]);
  /** How many of them this pet could actually fight right now. */
  const fightable = $derived(targets.filter((t) => t.why === null).length);
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
  let onChain = $state<ChainPetSummary | null>(null);
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
  /** Whether this session's key covers the credit-priced meal. */
  const feedSignsHere = $derived((session?.methodNames ?? []).includes('feed_pet'));

  const stakeSignsHere = $derived(
    (session?.methodNames ?? []).includes(status?.staked ? 'unstake_pet' : 'stake_pet')
  );
  const wounded = $derived(Number(status?.wounded_until ?? 0) / 1e6 > Date.now());
  /**
   * A starved pet takes revival items and nothing else.
   *
   * `buy_item` refuses anything without `is_revival` once the clock has run
   * out, so offering Beef to a dead pet is offering a transaction that will
   * be thrown back — and the refusal arrives after the wallet, the browser
   * trip and the signature.
   */
  const starved = $derived(Number(onChain?.seconds_until_starving ?? 1) <= 0);
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
      onChain = await getPetOnChain(pet.chain.network, pet.chain.contract, pet.petId);
      const current = onChain?.owner_id ?? pet.chain.owner;
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
      void getCreditItems(pet.chain.network, stake)
        .then((items: Array<[number, string]>) => (shop = items))
        .catch(() => {});
      void getListings(pet.chain.network, stake)
        .then((found) => (listings = found))
        .catch(() => {});
      void loadAccessories(current);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      loading = false;
      loadedOnce = true;
    }
  }

  /** Run one action with the panel's busy, error and note handling around it. */
  /**
   * Things the contract will only do for the pet's owner.
   *
   * Checked here rather than only on each tile, because a tile that forgets
   * is a transaction that charges and refunds: `feed_pet`, `revive_pet` and
   * `evolve_pet` all debit, call the game contract, hear "that pet belongs to
   * someone else", and give the credits back. Correct, and a confusing way to
   * learn you are signed in as the wrong account.
   *
   * One tile did forget. Collapsing Feed and Revive into a single tile
   * dropped the `mine` check that `canFeed` had always carried, and Evolve
   * was written afterwards without it.
   *
   * Auto-feed is the worst of the three, and the only one that would not
   * have refunded. The row reads the *owner's* allowance and the call sets
   * the *signer's*, so pressing it on somebody else's pet quietly configures
   * your own account while the number on screen — theirs — does not move. It
   * looks exactly like a button that does nothing.
   */
  const OWNER_ONLY = ['feed', 'revive', 'evolve', 'stake', 'auto'];

  async function act(label: string, run: () => Promise<unknown>, after: string) {
    if (OWNER_ONLY.includes(label) && !mine) {
      refused = `${pet.displayName} belongs to ${owner}. Connect as them to act on it.`;
      return;
    }

    busy = label;
    refused = null;
    note = null;
    try {
      await run();
      /*
       * Only when there is one to set. A runner that writes its own note —
       * feeding does, because it has the XP and the pet's line to report —
       * passes an empty string, and this used to overwrite that with it.
       *
       * Five feeds in a row told the player nothing at all for this reason,
       * including the message saying the XP had not been paid. A failure you
       * cannot see is worse than the failure.
       */
      if (after) note = after;
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

  /**
   * Feeding, which is now the only way to earn XP.
   *
   * It used to take two purchases: `feed_pet` moved the hunger clock and a
   * separate "AI meal" bought the XP, the Focus Lens and the drop roll. One
   * meal does all of it, so the note says what the pet got rather than which
   * of two things you bought.
   */
  function feed() {
    void act(
      'feed',
      async () => {
        const hash = await feedPet(net(), pet.petId, account);
        const graded = await gradeFeed(hash, session?.accountId ?? '');
        if (graded.xp === null) {
          // Louder than a note: the meal was paid for and earned nothing.
          refused = `Fed, but no XP: ${graded.why ?? 'the feeder did not answer'}`;
          return;
        }
        note = graded.line
          ? `+${graded.xp} XP — “${graded.line}”`
          : `Fed. ${pet.displayName} earned ${graded.xp} XP.`;
      },
      ''
    );
  }

  const revive = () =>
    act('revive', () => revivePet(net(), pet.petId, account), `${pet.displayName} is back.`);

  /**
   * Evolving, which the contract gates on level and the app explains before
   * the press rather than after. A refund is a correct answer that still
   * costs the player a round trip and a moment of doubt.
   */
  /*
   * Progress through this level, read off the chain. `xp_for_next_level` is
   * what the contract will charge for the next one, not a running total, so
   * the bar is simply one against the other.
   */
  const xpNow = $derived(Number(onChain?.xp ?? 0));
  const xpNeeded = $derived(Number(onChain?.xp_for_next_level ?? 0));
  const toNextLevel = $derived(xpNeeded > 0 ? Math.max(0, xpNeeded - xpNow) : null);
  const xpPercent = $derived(xpNeeded > 0 ? Math.min(100, (xpNow / xpNeeded) * 100) : 0);

  const phase = $derived(Number(onChain?.evolution_phase ?? 1));
  const needsLevel = $derived(levelToEvolve(phase));
  const canEvolve = $derived(
    needsLevel !== null && Number(onChain?.level ?? 0) >= needsLevel
  );

  const evolve = () =>
    act('evolve', () => evolvePet(net(), pet.petId, account), `${pet.displayName} evolved.`);

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

  /**
   * The allowance is per account, so it has to be sized by how many pets the
   * account owns. It was a fixed one-pet figure, which meant switching this
   * on with five pets covered the first two the oracle reached and left the
   * rest to starve — and said nothing, because the contract is right to stop
   * at the allowance it was handed.
   */
  async function autoFeedBudget(): Promise<string> {
    const owner = session?.accountId;
    if (!owner) return autoFeedBudgetFor(1);

    const all = await listPets(net(), pet.chain.contract).catch(() => []);
    return autoFeedBudgetFor(all.filter((other) => other.owner_id === owner).length);
  }

  const toggleAutoFeed = () =>
    act(
      'auto',
      async () =>
        signAndSend(net(), 'set_auto_feed_budget', {
          budget: autoFeedOn ? '0' : await autoFeedBudget()
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
  /**
   * Everyone else's pets, with the reason each one cannot be fought.
   *
   * It used to filter them away and leave the list empty, which is what
   * "nobody to fight" meant — and for a long time that was every single pet,
   * because a staked pet could not be attacked and staking is the only way
   * to earn. A silently empty roster reads as a broken button. Showing the
   * roster with reasons says what the game is actually waiting for.
   */
  async function loadTargets(owner: string) {
    const all = await listPets(net(), pet.chain.contract).catch(() => []);
    const others = all.filter((o) => o.pet_id !== pet.petId && o.owner_id !== owner);

    const allowed = await Promise.all(
      others.map((other) => isAttackable(net(), stake, other.pet_id))
    );

    targets = others
      .map((other, index) => ({
        ...other,
        why:
          Number(other.seconds_until_starving ?? 1) <= 0
            ? 'starved'
            : allowed[index]
              ? null
              : 'warded or just fought'
      }))
      // Fightable first; the rest are context, not choices.
      .sort((a, b) => Number(a.why !== null) - Number(b.why !== null));
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
   * The shop, in credits, as `[item_id, micro_credits]` from the contract.
   *
   * It used to be the game contract's NEAR shop, which sold food the credit
   * balance can already buy and needed a browser round trip for every
   * purchase, because `buy_item` is payable and no session key may attach a
   * deposit. `buy_credit_item` takes none, so this signs in the app.
   */
  let shop = $state<Array<[number, string]>>([]);
  let showShop = $state(false);

  /**
   * The item market: other players' prices, so buying needs a wallet.
   *
   * The shop next door is the contract's own prices, which a session key may
   * pay. The difference is who chose the number, and it is the whole reason
   * one signs here and the other does not.
   */
  let showMarket = $state(false);
  let listings = $state<Listing[]>([]);

  /** The drawn item for each id, so the bag reads as a bag. */
  const ITEM_ART: Record<number, string> = {
    101: '/assets/items/holy_water.png',
    102: '/assets/items/shield.png',
    103: '/assets/items/food.png',
    104: '/assets/item/star.png'
  };

  let showBag = $state(false);
  let showStyle = $state(false);
  let showChat = $state(false);
  let draft = $state('');
  let thinking = $state(false);
  const thread = $derived(threadFor(pet.slug));

  async function send() {
    const text = draft.trim();
    if (!text || thinking) return;
    draft = '';
    thinking = true;
    try {
      await say(pet, text, session?.accountId);
    } finally {
      thinking = false;
    }
  }

  const dressed = $derived(styleFor(pet.slug));
  const backdropArt = $derived(artOf(BACKDROPS, dressed.backdrop));

  /** The accessory contract for this pet's deployment. */
  const accessory = $derived(accessoryContractFor(pet.chain.contract));
  let kinds = $state<AccessoryKind[]>([]);
  let owned = $state<OwnedAccessory[]>([]);
  let worn = $state<OwnedAccessory | null>(null);
  const hatArt = $derived(worn?.art ?? null);

  /** NEAR, from yoctoNEAR, short enough for a 340px panel. */
  const nearOf = (yocto: string) => {
    const n = Number(BigInt(yocto) / 10n ** 18n) / 1e6;
    return n < 1 ? String(Number(n.toFixed(3))) : String(n);
  };

  /** Whether this session holds the accessory contract's key. */
  const wearSignsHere = $derived((session?.methodNames ?? []).includes('equip'));

  /**
   * Wearing signs here; buying cannot.
   *
   * `mint` is payable, so by protocol no function-call key will ever carry
   * it — that one is a browser trip for as long as hats cost NEAR. `equip`
   * and `unequip` are free, and now have a key of their own, so putting a
   * hat on costs nothing but a click.
   */
  function wear(method: 'equip' | 'unequip', tokenId: string) {
    if (!wearSignsHere) {
      void requestAccessoryAction(method, accessory, pet.petId, { token_id: tokenId });
      return;
    }
    void act(
      method,
      () =>
        signAndSend(
          net(),
          method,
          method === 'equip' ? { token_id: tokenId, pet_id: pet.petId } : { token_id: tokenId }
        ),
      method === 'equip' ? 'Worn.' : 'Taken off.'
    );
  }

  const buyAccessory = (kind: string) =>
    void requestAccessoryAction('mint', accessory, pet.petId, { kind });

  async function loadAccessories(who: string) {
    const [k, mine, on] = await Promise.all([
      getAccessoryKinds(pet.chain.network, accessory).catch(() => []),
      accessoriesOf(pet.chain.network, accessory, who).catch(() => []),
      wornBy(pet.chain.network, accessory, pet.petId).catch(() => null)
    ]);
    kinds = k ?? [];
    owned = mine ?? [];
    worn = on ?? null;
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
          <li class="muted">No other pets on this contract yet.</li>
        {:else}
          {#each targets as target (target.pet_id)}
            <li class:unavailable={target.why !== null}>
              <img class="jg-px" alt="" src={artPathFor(target)} />
              <span class="target-name">
                {target.name}
                <small>
                  lv {target.level}{target.star ? ` ·${target.star}★` : ''}
                  {#if target.why}· {target.why}{/if}
                </small>
              </span>
              <button
                class="jg-btn"
                class:primary={target.why === null}
                disabled={busy !== null || target.why !== null}
                onclick={() => {
                  opponent = target;
                  fight = 'ready';
                  wager = null;
                }}
                title={target.why
                  ? `${target.name} cannot be fought right now — ${target.why}`
                  : `Wager credits against ${target.owner_id}`}
              >
                Fight
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      <button class="jg-btn wide" onclick={() => (showTargets = false)}>Back</button>
    </div>
  {:else if showMarket}
    <div class="view">
      <p class="lead">
        Other players' prices, so buying opens your browser. The shop next
        door is the contract's own, and signs here.
      </p>
      <p class="section">For sale</p>
      <ul class="targets jg-screen">
        {#if listings.length === 0}
          <li class="muted">Nothing listed yet.</li>
        {:else}
          {#each listings as entry (entry.id)}
            {@const mine = entry.seller_id === session?.accountId}
            <li>
              <img class="jg-px" alt="" src={ITEM_ART[entry.item_id] ?? '/assets/items/food.png'} />
              <span class="target-name">
                {itemName(entry.item_id)}
                <small>
                  ×{entry.quantity} · {formatCredits(entry.price_each)} each
                  {#if mine}· yours{/if}
                </small>
              </span>
              <button
                class="jg-btn"
                class:primary={!mine}
                disabled={walletAction.running !== null}
                onclick={() =>
                  requestMarketAction(mine ? 'cancel_listing' : 'buy_listing', stake, {
                    listing_id: entry.id,
                    quantity: mine ? undefined : 1
                  })}
                title={mine ? 'Take it down and get the items back' : `Buy one from ${entry.seller_id}`}
              >
                {mine ? 'Cancel ↗' : 'Buy ↗'}
              </button>
            </li>
          {/each}
        {/if}
      </ul>

      <p class="section">Sell from your bag</p>
      <ul class="targets jg-screen">
        {#if inventory.length === 0}
          <li class="muted">Nothing to sell. Items drop while you play.</li>
        {:else}
          {#each inventory as [id, owned] (id)}
            <li>
              <img class="jg-px" alt="" src={ITEM_ART[id] ?? '/assets/items/food.png'} />
              <span class="target-name">
                {itemName(id)}<small>×{owned}</small>
              </span>
              <button
                class="jg-btn"
                disabled={walletAction.running !== null}
                onclick={() => requestMarketAction('list_item', stake, { item_id: id, quantity: 1 })}
                title="You set the price on the next screen"
              >
                Sell ↗
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      <button class="jg-btn wide" onclick={() => (showMarket = false)}>Back</button>
    </div>
  {:else if showShop}
    <div class="view">
      <p class="lead">
        Paid in credits, and signed here. Feeding is what moves
        {pet.displayName}'s hunger; these are everything else.
      </p>
      <ul class="grid jg-screen">
        {#each shop as [id, price] (id)}
          <li class="card">
            <img class="art jg-px" alt="" src={ITEM_ART[id] ?? '/assets/items/food.png'} />
            <span class="title">{itemName(id)}</span>
            <span class="effect">{ITEMS[id as ItemId]?.blurb ?? ''}</span>
            <button
              class="jg-btn primary buy"
              disabled={busy !== null || !canSpend(account, Number(formatCredits(price, 6)))}
              onclick={() =>
                act('shop', () => signAndSend(net(), 'buy_credit_item', { item_id: id, quantity: 1 }), `${itemName(id)} is in your bag.`)}
              title={`${formatCredits(price, 6)} credits`}
            >
              {formatCredits(price, 6)}
            </button>
          </li>
        {/each}
        {#if shop.length === 0}
          <li class="muted span2">The shop could not be read from the contract.</li>
        {/if}
      </ul>
      <button class="jg-btn wide" onclick={() => (showShop = false)}>Back</button>
    </div>
  {:else if showChat}
    <div class="view chat">
      <ul class="thread jg-screen">
        {#if thread.length === 0}
          <li class="muted">
            {pet.displayName} reads its own state off the chain — how hungry it
            is, what level it is, whether it is at work. Ask it something.
          </li>
        {/if}
        {#each thread as turn, i (i)}
          <li class:mine={turn.role === 'user'}>
            <span class="who">{turn.role === 'user' ? 'you' : pet.displayName}</span>
            <span class="said">{turn.content}</span>
          </li>
        {/each}
        {#if thinking}<li class="muted">…</li>{/if}
      </ul>

      <div class="say">
        <input
          bind:value={draft}
          maxlength="280"
          placeholder="Say something"
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void send();
            }
          }}
        />
        <button class="jg-btn primary" disabled={thinking || draft.trim() === ''} onclick={send}>
          Say
        </button>
      </div>

      <div class="actions">
        <button class="jg-btn" onclick={() => clearThread(pet.slug)}>Forget</button>
        <button class="jg-btn" onclick={() => (showChat = false)}>Back</button>
      </div>
    </div>
  {:else if showStyle}
    <div class="view">
      <!--
        No sentence here any more. "Yours" and "Shop" below already say what
        they are, and a line of capitals across the top of a 340px panel is
        the part people have to read past to get to the hats. The warning
        stays, because it is the one thing a player cannot work out by
        looking.
      -->
      {#if !wearSignsHere}
        <p class="lead">Wearing opens your browser until you connect again.</p>
      {/if}

      {#if worn}
        <ul class="grid jg-screen">
          <li class="card picked span2 worn">
            <img class="art jg-px" alt="" src={worn.art} />
            <span class="title">Wearing: {worn.kind} · #{worn.token_id}</span>
            <button
              class="jg-btn"
              disabled={busy !== null || walletAction.running !== null}
              onclick={() => worn && wear('unequip', worn.token_id)}
            >
              {busy === 'unequip' ? '…' : wearSignsHere ? 'Take off' : 'Take off ↗'}
            </button>
          </li>
        </ul>
      {/if}

      <p class="section">Yours</p>
      <ul class="grid jg-screen">
        {#each owned.filter((a) => a.token_id !== worn?.token_id) as item (item.token_id)}
          <li class="card">
            <img class="art jg-px" alt="" src={item.art} />
            <span class="title">{item.kind}</span>
            <span class="effect">#{item.token_id}</span>
            <button
              class="jg-btn primary buy"
              disabled={busy !== null || walletAction.running !== null}
              onclick={() => wear('equip', item.token_id)}
            >
              {busy === 'equip' ? '…' : wearSignsHere ? 'Wear' : 'Wear ↗'}
            </button>
          </li>
        {/each}
        {#if owned.length === (worn ? 1 : 0)}
          <li class="muted span2">
            Nothing yet. Anything bought below is a token you own.
          </li>
        {/if}
      </ul>

      <p class="section">Shop</p>
      <ul class="grid jg-screen">
        {#each kinds as kind (kind.slug)}
          {@const gone = kind.supply_cap !== 0 && kind.minted >= kind.supply_cap}
          <li class="card" class:empty={gone}>
            <img class="art jg-px" alt="" src={kind.art} />
            <span class="title">{kind.name}</span>
            <span class="effect">
              {#if kind.supply_cap === 0}
                no limit
              {:else}
                {kind.minted}/{kind.supply_cap}
              {/if}
            </span>
            <button
              class="jg-btn primary buy"
              disabled={walletAction.running !== null || gone}
              onclick={() => buyAccessory(kind.slug)}
              title={gone ? 'All of these have been minted' : 'Opens your browser — paid in NEAR'}
            >
              {gone ? 'gone' : `${nearOf(kind.price)} ↗`}
            </button>
          </li>
        {/each}
      </ul>

      <p class="section">Backdrop</p>
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
      <p class="section">Bag</p>
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
      <!--
        Level, stars, and the bar underneath: how much of this level is done.
        "lv 1" on its own cannot tell you whether a meal moved anything, and
        a pet whose only visible number never changes reads as a pet nothing
        is happening to.
      -->
      <span class="badge tl">
        lv {onChain?.level ?? pet.level}{pet.star ? ` ${'★'.repeat(pet.star)}` : ''}
        {#if toNextLevel !== null}
          <small>{xpNow}/{xpNeeded}</small>
        {/if}
      </span>
      {#if toNextLevel !== null}
        <span class="xp" title="{toNextLevel} XP to level {(onChain?.level ?? 0) + 1}">
          <span class="xp-fill" style:width="{xpPercent}%"></span>
        </span>
      {/if}
      <span class="badge tr">{pet.rarity}</span>
      <span class="hero-wrap">
        <img class="hero jg-px" alt={pet.displayName} src={heroArt} />
        {#if hatArt}<img class="hero-hat jg-hat jg-px" alt="" src={hatArt} />{/if}
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
              spend, and the oracle is a service that has to be running
              somewhere. `apps/oracle` is that service and it installs as a
              login agent — but it runs on a machine, not in here, so a switch
              claiming the pet was safe would still be the most expensive lie
              in the app.

              The figure comes off the chain rather than from the constant the
              button sends. They agree right after a toggle and stop agreeing
              the moment the account gains a pet, and the one that is true is
              the allowance the contract will actually enforce.
            -->
            <!--
              Two short facts, not a sentence: the allowance and what is left
              of it. The reading is the point and a wrapped line hides it.
            -->
            Auto-feed {formatCredits(account?.auto_feed_budget ?? '0')}/day
            {#if autoFeedUsed > 0}
              · {autoFeedUsed.toFixed(3)} used
            {/if}
          {:else}
            <!--
              Short, but it still says what is at stake. "Auto-feed off" on
              its own is a setting; the pet starving while nobody is looking
              is the reason anyone would turn it on.
            -->
            Auto-feed off · no cover while away
          {/if}
        </span>
        <button
          class="jg-btn"
          class:primary={!autoFeedOn}
          disabled={busy !== null || !mine}
          onclick={toggleAutoFeed}
          title={!mine
            ? `This allowance belongs to ${owner} — connect as them to change it`
            : autoFeedOn
            ? 'Stop the oracle feeding this account'
            : `${ACTION_PRICE.auto_feed} credits a meal, each buying ${AUTO_FEED_HOURS} hours — the daily allowance covers every pet this account owns`}
        >
          {busy === 'auto' ? '…' : autoFeedOn ? 'Off' : 'On'}
        </button>
      </div>
      {#if autoFeedOn && autoFeedUsed === 0}
        <p class="note warn">
          Nothing has been spent from this yet. The feeder runs on a machine
          rather than in here, so until one is running {pet.displayName} still
          needs feeding by hand.
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
          Feeding signs here, in credits. `spend_credits("ai_feed")` only
          recorded a meal nothing turned into food; `feed_pet` spends and
          calls the game contract, which moves the clock. A starved pet is
          the exception: coming back needs a revival item, and those are
          bought with NEAR through the shop.
        -->
        {@render tile(
          starved ? 'Revive' : 'Feed',
          starved ? '/assets/items/holy_water.png' : '/assets/items/beef.png',
          starved ? revive : feed,
          busy !== null ||
            !mine ||
            !feedSignsHere ||
            !canSpend(account, starved ? ACTION_PRICE.revive : ACTION_PRICE.feed),
          !mine
            ? `${pet.displayName} belongs to ${owner} — connect as them to act on it`
            : !feedSignsHere
            ? 'This session key was granted before this could be signed here — reconnect in Settings'
            : starved
              ? canSpend(account, ACTION_PRICE.revive)
                ? `${ACTION_PRICE.revive} credits to bring ${pet.displayName} back`
                : `Reviving costs ${ACTION_PRICE.revive} credits`
              : canFeed
                ? `${ACTION_PRICE.feed} credits for 12 hours, XP, and a roll for a drop`
                : 'Not enough credits',
          busy === 'feed' || busy === 'revive' ? '…' : undefined
        )}
        <!--
          Shop and Evolve, both of which I had left unreachable. Collapsing
          Feed and Revive into one tile took the Shop tile out with it, so the
          credit shop existed and nothing opened it; Evolve had never been
          wired at all. Eleven tiles do not divide by three, so the last row
          carries two — which reads as a list that ended, where one tile alone
          under two gaps reads as something missing.
        -->
        {@render tile(
          'Shop',
          '/assets/items/water.png',
          () => (showShop = true),
          busy !== null,
          'Tonics, wards and lenses, paid in credits'
        )}
        {@render tile(
          'Market',
          '/assets/item/coin.png',
          () => (showMarket = true),
          busy !== null,
          'Buy and sell items with other players'
        )}
        {@render tile(
          'Evolve',
          '/assets/item/star.png',
          evolve,
          busy !== null || !mine || !canEvolve || !canSpend(account, ACTION_PRICE.evolve),
          !mine
            ? `${pet.displayName} belongs to ${owner}`
            : needsLevel === null
            ? `${pet.displayName} is fully evolved`
            : !canEvolve
              ? `Needs level ${needsLevel} — it is ${Number(onChain?.level ?? 0)}`
              : canSpend(account, ACTION_PRICE.evolve)
                ? `${ACTION_PRICE.evolve} credits for phase ${phase + 1}`
                : `Evolving costs ${ACTION_PRICE.evolve} credits`,
          /*
           * The label carries the gate. Greyed out with the reason only in a
           * tooltip reads as broken — and this one takes twenty-six battles
           * to clear, which is a long time to wonder whether the button
           * works.
           */
          busy === 'evolve'
            ? '…'
            : needsLevel !== null && !canEvolve
              ? `Evolve · lv ${needsLevel}`
              : undefined
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
        <!--
          The fourth place the same rule lived. The contracts stopped refusing
          a staked pet a fight; this still greyed the tile out and explained
          why with a sentence that was no longer true.

          The count is of pets that can actually be fought, not of the roster:
          the list shows everyone with a reason now, and counting the ones
          that cannot fight would promise opponents that are not there.
        -->
        {@render tile(
          `Battle ${fightable ? `(${fightable})` : ''}`,
          '/assets/button/attack.png',
          () => (showTargets = true),
          busy !== null,
          fightable ? 'Pick somebody to attack' : 'Nobody can be fought right now — see who is out there'
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
          'Talk',
          '/assets/ui/info.svg',
          () => (showChat = true),
          busy !== null,
          `Ask ${pet.displayName} something — it knows its own state`
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
    /* Everything but the strip the name plate occupies. */
    inset: 2px 2px calc(var(--jg-plate, 62px) + 6px) 2px;
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

  /* The panel's pet is a still image, so it breathes here or nowhere. */
  .hero {
    width: 96px;
    image-rendering: pixelated;
    display: block;
    animation: jg-breathe 2.4s ease-in-out infinite;
  }

  .hero-hat {
    position: absolute;
    left: 50%;
    top: 14%;
    width: 44%;
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

  /*
   * Fixed pixels, not percentages. `max-height: 100%` on an SVG inside a
   * 28px box came out 84px: with `max-width` also set the two constraints
   * fight over the aspect ratio and the image wins, so every swatch
   * overflowed its card and printed itself across the label below.
   */
  .swatch {
    display: grid;
    place-items: center;
    width: 100%;
    height: 30px;
    overflow: hidden;
    font-size: 10px;
    color: var(--jg-muted);
  }

  .swatch img {
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 30px;
    object-fit: contain;
    image-rendering: pixelated;
  }

  .swatch.wide img {
    width: 100%;
    height: 30px;
    max-height: 30px;
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

  /* The level badge's second number: smaller, so the level still reads first. */
  .badge small {
    font-size: 7px;
    color: var(--jg-muted);
  }

  /*
   * The bar sits under the badge rather than inside it: a badge that changes
   * width as XP climbs would shuffle the art every few meals.
   */
  .xp {
    position: absolute;
    top: 20px;
    left: 3px;
    width: 58px;
    height: 4px;
    background: #ffffffcc;
    border: 1px solid var(--jg-edge);
  }

  .xp-fill {
    display: block;
    height: 100%;
    background: var(--jg-good, #5aa469);
    transition: width 0.3s;
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
  /*
   * Three columns, because there are nine tiles. Four left a row of one —
   * the bag sitting alone under three empty cells — and the panel is 340px
   * wide, so the fourth column was buying ragged edges with icon size.
   */
  .tiles {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }

  .view {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-height: 0;
  }

  /* The transcript takes the panel; the input stays pinned under it. */
  .chat {
    flex: 1;
    min-height: 0;
  }

  .thread {
    flex: 1;
    min-height: 120px;
    max-height: 300px;
    overflow-y: auto;
    margin: 0;
    padding: 4px;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .thread li {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 9px;
    line-height: 1.5;
  }

  .thread .who {
    font-size: 7px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--jg-muted);
  }

  .thread .said {
    padding: 3px 5px;
    background: #fff;
    border: 1px solid var(--jg-edge);
  }

  /* Yours sit right and tinted, so the two voices are told apart without
     reading the labels. */
  .thread li.mine {
    align-items: flex-end;
  }

  .thread li.mine .said {
    background: var(--jg-bevel);
  }

  .say {
    display: flex;
    gap: 4px;
  }

  .say input {
    flex: 1;
    min-width: 0;
    font-family: var(--jg-pixel);
    font-size: 9px;
    color: var(--jg-ink);
    background: #fff;
    border: 3px solid var(--jg-edge);
    padding: 4px 6px;
  }

  .say input:focus {
    outline: none;
    border-color: var(--jg-good);
  }

  /*
   * Silkscreen has no lowercase — every glyph is a capital — so a sentence
   * set in it reads as shouting and a long one is genuinely hard to scan.
   * That is a reason to write less here, not to restyle: these are kept to
   * one line at 340px.
   */
  .lead {
    margin: 0;
    font-size: 9px;
    color: var(--jg-muted);
  }

  /* A section marker, which is a different job from a sentence. */
  .section {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 2px 0 0;
    font-size: 8px;
    letter-spacing: 0.1em;
    color: var(--jg-muted);
  }

  .section::after {
    content: '';
    flex: 1;
    height: 2px;
    background: var(--jg-edge);
    opacity: 0.35;
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
  /*
   * Three across rather than two. These lists are short — one hat, one kind
   * in the shop — and at two columns every one of them left half a row of
   * white, which read as something missing rather than as a small list.
   */
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    margin: 0;
    padding: 4px;
    list-style: none;
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

  /*
   * What the pet is wearing is one thing, and a card shaped for a grid gave
   * it a column's worth of height and three columns' worth of width, nearly
   * all of it white. A row puts the art, the name and the button on one
   * line.
   */
  .card.worn {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
  }

  .card.worn .title {
    flex: 1;
    text-align: left;
  }

  /* Still listed, visibly not a choice. */
  .targets li.unavailable {
    opacity: 0.45;
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
