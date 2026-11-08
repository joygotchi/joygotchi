<script lang="ts">
  import { convertFileSrc, invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { AgentEvent } from '@joygotchi/pet';
  import BattleScene from './BattleScene.svelte';
  import PetPanel from './PetPanel.svelte';
  import { listPets, type ChainPetSummary } from './chain';
  import { detectBattle, startedHere, type SpectatedBattle } from './battle-watch';
  import Settings from './Settings.svelte';
  import { HOLD_MS, MOTION_CSS, motionDuration } from '@joygotchi/pet';
  import { petReaction, session as walletSession, watchConnect } from './wallet.svelte';
  import { canAfford, feedPet } from './actions';
  import {
    accessoryContractFor,
    forgetReads,
    getStakeAccount,
    stakeContractFor,
    wornBy,
    type OwnedAccessory
  } from './chain';
  import { ACTION_PRICE, formatCredits, type StakeAccount } from '@joygotchi/pet';
  import { artOf, BACKDROPS, styleFor } from './style.svelte';
  import { MOTION, nextReaction, visibleState, type Reaction } from './pet-state';
  import type { InstalledPet } from './types';

  const STORAGE_KEY = 'joygotchi:active-pet';
  /**
   * Where to ask for a line about what just happened.
   *
   * The deployed gallery by default, because that is the one with the NEAR AI
   * key on it. Point it at a dev server with
   * `localStorage.setItem('joygotchi:api', 'http://localhost:5173')`.
   */
  const API = localStorage.getItem('joygotchi:api') ?? 'https://joygotchi.vercel.app';

  let pets = $state<InstalledPet[]>([]);
  let activeSlug = $state<string | null>(localStorage.getItem(STORAGE_KEY));
  let reaction = $state<Reaction | null>(null);
  let now = $state(Date.now());
  let line = $state<string | null>(null);
  let showSettings = $state(false);
  let showPanel = $state(false);

  /**
   * Fights your pet was in, including the ones you did not start.
   *
   * `chainPets` is the previous read, kept apart from `pets` on purpose: that
   * array drives the whole window, and reassigning it every few seconds is
   * what once made the panel reload forever.
   */
  let chainPets = $state<ChainPetSummary[]>([]);
  let spectating = $state<SpectatedBattle | null>(null);
  let account = $state<StakeAccount | null>(null);
  let feeding = $state(false);
  let feedError = $state<string | null>(null);

  // The window is pet-sized until something needs room.
  $effect(() => {
    void invoke('set_panel_open', {
      open: showSettings || showPanel || spectating !== null
    }).catch(() => {});
  });
  let overPet = $state(false);

  const active = $derived(
    pets.find((pet) => pet.slug === activeSlug) ?? pets[0] ?? null
  );
  // Named `pose`, not `state`: a variable called `state` in a file that uses
  // `$state(...)` makes `$state` read as a store subscription to it, and the
  // whole component silently type-checks as legacy Svelte.
  /**
   * This pet's row from the chain poll the battle watcher already runs.
   *
   * Everything the plate shows was being fetched and thrown away: the window
   * knew the pet's level, its star and how long until it starves, and still
   * drew a grey pill with a name in it. No extra request.
   */
  const chainSelf = $derived(chainPets.find((p) => p.pet_id === active?.petId) ?? null);

  const foodLeft = $derived(Number(chainSelf?.seconds_until_starving ?? 0));

  /*
   * The bar is scaled to a day, not to the contract's seven-day ceiling.
   *
   * Against the ceiling almost every real pet sits under ten percent, so the
   * bar reads "nearly empty" permanently and stops meaning anything. A day is
   * the horizon you can actually act on: full means you can forget about it,
   * and anything part-filled is today's problem. The exact countdown is the
   * number beside it, so nothing is being hidden by the rescale.
   */
  const foodFull = $derived(Math.max(0, Math.min(1, foodLeft / 86_400)));
  const hunger = $derived(
    foodLeft <= 0 ? 'starved' : foodLeft < 3_600 ? 'urgent' : foodLeft < 12 * 3_600 ? 'low' : 'ok'
  );

  /** "14h", "3d" — a countdown nobody has to do arithmetic on. */
  const foodLabel = $derived.by(() => {
    if (!chainSelf) return '';
    if (foodLeft <= 0) return 'starved';
    if (foodLeft < 3_600) return `${Math.ceil(foodLeft / 60)}m`;
    if (foodLeft < 86_400) return `${Math.floor(foodLeft / 3_600)}h`;
    return `${Math.floor(foodLeft / 86_400)}d`;
  });

  const signedIn = $derived(walletSession.current);
  const ownsActive = $derived(
    !!signedIn && !!active && signedIn.accountId === (chainSelf?.owner_id ?? active.chain.owner)
  );
  const canFeed = $derived(ownsActive && canAfford(account) && !feeding);

  /**
   * Feed without opening anything.
   *
   * Feeding is the one action with a deadline — the pet starves on a clock —
   * so it is the one that should not cost two clicks and a panel. Same
   * `feedPet` the panel calls, claim-first and all.
   */
  async function quickFeed() {
    if (!active || !canFeed) return;
    feeding = true;
    feedError = null;
    try {
      await feedPet(active.chain.network, active.petId, account);
      forgetReads();
      await Promise.all([loadAccount(), pollBattles()]);
    } catch (cause) {
      feedError = cause instanceof Error ? cause.message : String(cause);
      setTimeout(() => (feedError = null), 6_000);
    } finally {
      feeding = false;
    }
  }

  async function loadWorn() {
    if (!active) {
      worn = null;
      return;
    }
    worn = await wornBy(
      active.chain.network,
      accessoryContractFor(active.chain.contract),
      active.petId
    ).catch(() => null);
  }

  async function loadAccount() {
    const who = walletSession.current?.accountId;
    if (!who || !active) {
      account = null;
      return;
    }
    account = await getStakeAccount(
      active.chain.network,
      stakeContractFor(active.chain.contract),
      who
    ).catch(() => null);
  }

  const pose = $derived(visibleState(reaction, now));
  const motion = $derived(MOTION[pose]);

  const dressed = $derived(active ? styleFor(active.slug) : null);
  const backdropArt = $derived(dressed ? artOf(BACKDROPS, dressed.backdrop) : null);
  /** Read off the accessory contract: the hat is a token, not a setting. */
  let worn = $state<OwnedAccessory | null>(null);
  const hatArt = $derived(worn?.art ?? null);

  const artSrc = $derived.by(() => {
    if (!active) return null;
    const file = active.states[pose] ?? active.states.idle;
    return file ? convertFileSrc(`${active.directory}/${file}`) : null;
  });

  async function load() {
    const found = await invoke<InstalledPet[]>('list_pets');
    const isNew = found.length > pets.length;

    // Only replace the array when it really changed. Reassigning every few
    // seconds hands the panel a new object for the same pet, which it reads
    // as "a different pet" and reloads — the window flashing its loading
    // state forever.
    const same =
      found.length === pets.length &&
      found.every((pet, index) => pet.slug === pets[index]?.slug && pet.level === pets[index]?.level);
    if (!same) pets = found;

    // Installing a pet happens in a terminal while this window is open, so
    // the app looks broken if it only notices at startup. Select the newest
    // one when it is the first, or when nothing is selected.
    if (isNew && (!activeSlug || pets.length === 1)) {
      activeSlug = pets[pets.length - 1]?.slug ?? activeSlug;
    }
  }

  /**
   * Whether the cursor is over the pet, which is all this tracks now.
   *
   * It used to also toggle the window's click-through, which is what made the
   * pet undraggable: a window ignoring cursor events never gets `mouseenter`,
   * so the flag that was supposed to clear on hover could never clear. The
   * switch lives in Settings instead, outside the window it silences.
   */
  const setOverPet = (over: boolean) => (overPet = over);

  /**
   * Touch the pet and it answers.
   *
   * Until now a click on the sprite did nothing at all: the window reacted
   * to a coding agent's tool calls and to things signed in the panel, but
   * not to the person looking at it. A desktop pet you cannot touch is a
   * status icon with a sprite.
   *
   * Throttled, because the reply costs an inference and a toddler with a
   * mouse would otherwise buy a hundred.
   */
  let lastPet = 0;

  function petTouched() {
    const at = Date.now();
    if (at - lastPet < 4_000) {
      // Still acknowledge it. Ignoring the second click reads as broken,
      // even when the first one is still being answered.
      reaction = nextReaction(reaction, { kind: 'game', what: 'petted' });
      return;
    }
    lastPet = at;
    void react({ kind: 'game', what: 'petted' });
  }

  async function react(event: AgentEvent) {
    reaction = nextReaction(reaction, event);
    if (!active) return;

    try {
      const response = await fetch(`${API}/api/ai/react`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ petId: active.petId, event })
      });
      const body = (await response.json()) as { line?: string | null };
      if (body.line) {
        line = body.line;
        setTimeout(() => (line = null), 6_000);
      }
    } catch {
      // No web app reachable, or no NEAR AI key on it. The pet still animates;
      // a speech bubble is the part that is allowed to be missing.
    }
  }

  /**
   * Watch the chain for fights involving this pet.
   *
   * Lives here rather than in the panel because being attacked is not
   * something you are present for: the point is to see it when you are doing
   * something else, with the panel closed.
   */
  async function pollBattles() {
    if (!active) return;
    const found = await listPets(active.chain.network, active.chain.contract).catch(() => []);
    if (found.length === 0) return;

    const seen = detectBattle(active.petId, chainPets, found);
    chainPets = found;
    if (!seen) return;
    // The panel is already showing this one.
    if (startedHere()) return;

    reaction = nextReaction(reaction, { kind: 'game', what: 'battled' });
    // Only a known opponent gets the arena; otherwise the pet still reacts
    // and the stats refresh, which is all the chain actually told us.
    // Stays until it is dismissed. An overlay that times out is no use for
    // the one thing this exists for: finding out what happened while you
    // were not watching.
    if (seen.opponent) spectating = seen;
    void load();
  }

  $effect(() => {
    // Registered for the app's lifetime: a wallet grant is a round trip
    // through the browser and must not depend on a panel staying open.
    void watchConnect();
    void load();
    void pollBattles();
    void loadAccount();
    void loadWorn();

    const ticker = setInterval(() => (now = Date.now()), 250);
    // Cheap: reading a couple of small files every few seconds.
    const rescan = setInterval(() => void load(), 5_000);
    // Slower than the file rescan: this one is a round trip to an RPC for
    // every pet on the contract, not a couple of local reads.
    const battles = setInterval(() => {
      void pollBattles();
      void loadAccount();
      void loadWorn();
    }, 12_000);
    const unlisten = listen<AgentEvent>('agent-event', (event) => void react(event.payload));

    return () => {
      clearInterval(ticker);
      clearInterval(rescan);
      clearInterval(battles);
      void unlisten.then((off) => off());
    };
  });

  $effect(() => {
    if (activeSlug) localStorage.setItem(STORAGE_KEY, activeSlug);
  });

  // Feeding and fighting drive the pet the same way an agent's hooks do, so
  // the sprite behind the panel reacts to what you just did to it.
  $effect(() => {
    if (!petReaction.what) return;
    const what = petReaction.what;
    petReaction.what = null;
    reaction = nextReaction(reaction, { kind: 'game', what });

    /*
     * A meal is two beats: the eating, then being pleased about it. One
     * `feeding` and back to idle reads as a pet chewing and losing interest,
     * which is not what being fed feels like. The hop lands as the munch
     * ends — `HOLD_MS.feeding` is the contract for how long that is, rather
     * than a number guessed here and left to drift.
     */
    if (what === 'fed') {
      setTimeout(() => {
        reaction = { state: 'jumping', until: Date.now() + HOLD_MS.jumping };
      }, HOLD_MS.feeding);
    }
  });
</script>

<svelte:head>
  {@html `<style>${MOTION_CSS}</style>`}
</svelte:head>

<svelte:window
  onkeydown={(event) => {
    // The same shortcut petdex uses, because muscle memory is a feature.
    if ((event.metaKey || event.ctrlKey) && event.key === ',') {
      event.preventDefault();
      showSettings = !showSettings;
    }
  }}
/>

<main class="stage">
  {#if !active}
    <div
      class="empty"
      onmouseenter={() => setOverPet(true)}
      onmouseleave={() => setOverPet(false)}
      role="status"
    >
      <p>No pet installed yet.</p>
      <code>npx joygotchi install &lt;code&gt;</code>
      <button class="jg-btn" onclick={load}>Look again</button>
    </div>
  {:else}
    {#if line}
      <p class="bubble">{line}</p>
    {/if}

    {#if backdropArt}
      <!--
        A card the pet stands in front of, sized to the stage so it lines up
        with the name plate below it. Outside `.pet` on purpose: in there it
        bobbed with the sprite, and scenery that moves with the actor is not
        scenery.
      -->
      <img class="backdrop" alt="" data-tauri-drag-region draggable="false" src={backdropArt} />
    {/if}

    <div
      class="pet"
      data-state={pose}
      data-tauri-drag-region
      onmouseenter={() => setOverPet(true)}
      onmouseleave={() => setOverPet(false)}
      onclick={petTouched}
      ondblclick={() => (showSettings = true)}
      onkeydown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          showPanel = true;
        }
      }}
      role="button"
      tabindex="0"
      aria-label="What {active.displayName} is up to"
      style:animation-name={motion}
      style:animation-duration="{motionDuration(pose)}s"
    >
      {#if artSrc}
        <img
          class="sprite"
          alt={active.displayName}
          data-tauri-drag-region
          draggable="false"
          src={artSrc}
        />
        {#if hatArt}
          <!--
            Inside `.pet`, so it rides the sprite's animation: a hat that
            stays still while the pet bobs is a hat floating next to a pet.
          -->
          <img class="hat jg-hat" alt="" data-tauri-drag-region draggable="false" src={hatArt} />
        {/if}
        <!--
          A shadow, so the pet stands on the desktop rather than hovering in
          front of it. It does not move with the sprite's animation, which is
          what makes the bobbing read as the pet leaving the ground.
        -->
        <span class="shadow" data-tauri-drag-region></span>

        {#if chainSelf?.shield}
          <!--
            What the pet is carrying, carried visibly. Shields are weight in
            the lab now, so a player who paid for one should be able to see it
            on the pet rather than take the plate's word for it. They orbit
            the sprite instead of sitting on it: there is no art of a dragon
            holding a shield, and faking one would look worse than not.
          -->
          <span class="guard" data-tauri-drag-region>
            {#each { length: Math.min(3, chainSelf.shield) } as _, i (i)}
              <img
                class="jg-px"
                alt=""
                src="/assets/items/shield.png"
                style:animation-delay="{i * 0.35}s"
              />
            {/each}
            {#if chainSelf.shield > 3}<small>+{chainSelf.shield - 3}</small>{/if}
          </span>
        {/if}
      {/if}
    </div>

    <!--
      The name plate. It carries the two things that change on their own and
      can lose you the pet if you miss them — how long until it starves, and
      whether it is at work — so neither needs the panel open to be seen.
    -->
    <div class="plate" class:dim={!overPet}>
      <div class="row">
        <span class="name">{active.displayName}</span>
        {#if chainSelf}
          <span class="lv">LV {chainSelf.level}</span>
          {#each { length: Math.min(3, chainSelf.star) } as _, i (i)}
            <img class="star jg-px" alt="" src="/assets/item/star.png" />
          {/each}
        {/if}
        <span class="spacer"></span>
        {#if ownsActive}
          <button
            class="feed"
            disabled={!canFeed}
            onclick={quickFeed}
            title={canAfford(account)
              ? `Feed ${active.displayName} · ${ACTION_PRICE.ai_feed} credits`
              : 'Not enough credits to feed'}
          >
            <img class="jg-px" alt="Feed" src="/assets/items/beef.png" />
          </button>
        {/if}
        <!--
          Drawn icons rather than ⓘ ⚙ ✕. At eight pixels those glyphs were
          three indistinguishable grey marks, and they were the only things
          on screen not made of pixels.
        -->
        <button title="What this pet is up to" onclick={() => (showPanel = true)}>
          <img class="jg-px" alt="Status" src="/assets/ui/info.svg" />
        </button>
        <button title="Settings (⌘,)" onclick={() => (showSettings = true)}>
          <img class="jg-px" alt="Settings" src="/assets/ui/gear.svg" />
        </button>
        <button class="close" title="Quit JOYGOTCHI" onclick={() => invoke('quit')}>
          <img class="jg-px" alt="Quit" src="/assets/ui/close.svg" />
        </button>
      </div>

      {#if chainSelf}
        <div class="row meter">
          <img class="jg-px" alt="Food" src="/assets/items/food.png" />
          <span class="bar" data-level={hunger}>
            <span class="fill" style:width="{Math.max(3, foodFull * 100)}%"></span>
          </span>
          <span class="food" data-level={hunger}>{foodLabel}</span>
          {#if chainSelf.shield}
            <!-- What the pet is carrying, not what it could buy. -->
            <span class="carry" title="{chainSelf.shield} shield — each absorbs one hit">
              {#each { length: Math.min(3, chainSelf.shield) } as _, i (i)}
                <img class="jg-px" alt="" src="/assets/items/shield.png" />
              {/each}
              {#if chainSelf.shield > 3}<small>×{chainSelf.shield}</small>{/if}
            </span>
          {/if}
          {#if chainSelf.locked}<span class="chip work">LAB</span>{/if}
          {#if account}
            <!--
              Balance and claimable together, because that is what the feed
              button can actually spend: it claims on the way. Showing the
              balance alone put a "0" next to an enabled Feed, which reads as
              a bug rather than as credits waiting one call away.
            -->
            <span class="coins" title="Credits you can spend — earned ones are claimed on use">
              {formatCredits(
                (BigInt(account.credit_balance) + BigInt(account.pending_credits)).toString()
              )}
            </span>
          {/if}
        </div>
      {/if}

      {#if feeding}
        <p class="plate-note">Feeding…</p>
      {:else if feedError}
        <p class="plate-note bad">{feedError}</p>
      {/if}
    </div>
  {/if}

  {#if spectating?.opponent && active}
    <!-- Somebody picked a fight with this pet. Show it, do not report it. -->
    <div class="spectate jg jg-frame">
      <p class="spectate-title">
        {spectating.outcome === 'lost' ? 'Attacked' : 'Defended'}
      </p>
      <BattleScene
        mine={active}
        target={spectating.opponent}
        phase={spectating.outcome}
        transferred={null}
        onfight={() => {}}
        onclose={() => (spectating = null)}
      />
    </div>
  {:else if showPanel && active}
    <PetPanel
      pet={active}
      {pets}
      onpick={(slug) => (activeSlug = slug)}
      onclose={() => (showPanel = false)}
    />
  {/if}

  {#if showSettings}
    <Settings
      {pets}
      active={active?.slug ?? null}
      onclose={() => (showSettings = false)}
      onpick={(slug) => {
        activeSlug = slug;
        showSettings = false;
      }}
      onrefresh={load}
    />
  {/if}
</main>

<style>
  :global(html, body) {
    margin: 0;
    background: transparent;
    overflow: hidden;
    font-family: var(--jg-pixel);
    color: var(--jg-ink);
    user-select: none;
  }

  .stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100vh;
    padding: 8px;
    box-sizing: border-box;
  }

  .pet {
    position: relative;
    width: 98px;
    height: 104px;
    display: grid;
    place-items: center;
    animation-iteration-count: infinite;
    animation-timing-function: ease-in-out;
  }

  /*
   * Sits outside the animated transform on purpose: a shadow that bobs with
   * the sprite is painted on its feet, and the pet never looks like it left
   * the ground.
   */
  .shadow {
    position: absolute;
    bottom: 4px;
    left: 50%;
    width: 46px;
    height: 8px;
    margin-left: -23px;
    border-radius: 50%;
    background: radial-gradient(ellipse at center, #0b0d1055 0%, #0b0d1000 70%);
    pointer-events: none;
  }

  /*
   * The sprite only. It used to be `.pet > img`, which also caught the
   * backdrop and the hat and beat their own rules on specificity — the
   * backdrop came out pet-sized and the hat needed `!important` to get a
   * width at all.
   */
  .pet > img.sprite {
    width: 100%;
  }

  .pet > img {
    image-rendering: pixelated;
    -webkit-user-drag: none;
  }

  /*
   * Behind the pet, which takes saying out loud: an absolutely positioned
   * element paints above a static one whatever the document order, so the
   * first version hid the sprite completely and left the hat floating over
   * a meadow.
   */
  .backdrop {
    position: absolute;
    left: 8px;
    bottom: 32px;
    /*
     * Stated, not inferred. `width: auto` between a left and a right offset
     * stretches a div and does not stretch an image: a replaced element
     * falls back to its intrinsic ratio, so the card came out square and
     * sat in the corner.
     */
    width: calc(100% - 16px);
    height: 150px;
    /* So the border lands inside and the two boxes measure the same. */
    box-sizing: border-box;
    object-fit: cover;
    image-rendering: pixelated;
    border: 2px solid var(--jg-edge);
    z-index: 0;
  }

  .sprite {
    position: relative;
    z-index: 1;
  }

  /*
   * Placed as a share of the sprite box rather than in pixels, so it keeps
   * its seat if the window is ever resized. Tuned against the dragons' horn
   * line: lower and it covers the eyes, higher and it hovers.
   */
  /* Above the sprite, which now has a layer of its own. */
  .hat {
    position: absolute;
    left: 50%;
    top: 14%;
    width: 44%;
    pointer-events: none;
    z-index: 2;
  }

  /*
   * What the pet says, as a speech bubble rather than a toast. Light, because
   * it floats over the editor: a dark box there reads as another window, and
   * the one thing this should look like is the pet talking.
   */
  /*
   * The shields float beside the pet on their own gentle bob, offset from
   * each other so three of them read as three rather than as one thick one.
   */
  .guard {
    position: absolute;
    right: 2px;
    bottom: 26px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    pointer-events: none;
  }

  .guard img {
    width: 13px;
    height: 22px;
    object-fit: contain;
    animation: jg-bob 2.6s ease-in-out infinite;
  }

  .guard small {
    font-size: 7px;
    color: var(--jg-ink);
    background: #ffffffcc;
    border: 1px solid var(--jg-edge);
    padding: 0 2px;
  }

  .bubble {
    position: relative;
    max-width: 220px;
    margin: 0 0 10px;
    padding: 5px 7px;
    font-size: 8px;
    line-height: 1.6;
    color: var(--jg-ink);
    background: #fff;
    border: 3px solid var(--jg-edge);
    text-align: center;
  }

  /* The tail, in two squares, so it stays pixel art at any zoom. */
  .bubble::after,
  .bubble::before {
    content: '';
    position: absolute;
    left: 50%;
    width: 6px;
    height: 6px;
  }

  .bubble::before {
    bottom: -9px;
    margin-left: -4px;
    background: var(--jg-edge);
  }

  .bubble::after {
    bottom: -6px;
    margin-left: -3px;
    background: #fff;
  }

  .plate {
    position: relative;
    z-index: 2;
    transition: opacity 0.15s;
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-self: stretch;
    margin: 2px 0 0;
    padding: 3px 4px;
    font-size: 8px;
    color: var(--jg-ink);
    background: var(--jg-bevel);
    border: 2px solid var(--jg-edge);
    box-shadow: inset -2px -2px 0 #c3d2da;
  }

  /* Visible but out of the way until the cursor is near. */
  .plate.dim {
    opacity: 0.55;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .name {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 92px;
  }

  .lv {
    color: var(--jg-muted);
  }

  .star {
    width: 7px;
    height: 7px;
  }

  .spacer {
    flex: 1;
  }

  .plate button {
    background: none;
    border: 0;
    padding: 0 1px;
    line-height: 0;
    cursor: pointer;
  }

  .plate button img {
    width: 14px;
    height: 14px;
    object-fit: contain;
    opacity: 0.75;
    transition: opacity 0.1s;
  }

  .plate button:hover img {
    opacity: 1;
  }

  .plate button:active img {
    transform: translateY(1px);
  }

  .meter img {
    width: 10px;
    height: 10px;
    object-fit: contain;
  }

  /*
   * Food, against the contract's own seven-day ceiling. A well-fed pet barely
   * moves the bar, so urgency is carried by colour as well as length — the
   * fill is honest, the colour is readable.
   */
  .bar {
    flex: 1;
    height: 6px;
    background: #fff;
    border: 1px solid var(--jg-edge);
    overflow: hidden;
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--jg-good);
  }

  .bar[data-level='low'] .fill { background: var(--jg-gold); }
  .bar[data-level='urgent'] .fill,
  .bar[data-level='starved'] .fill { background: var(--jg-bad); }

  .food {
    min-width: 20px;
    text-align: right;
    color: var(--jg-muted);
  }

  .food[data-level='urgent'],
  .food[data-level='starved'] {
    color: var(--jg-bad);
  }

  .plate button.feed {
    padding: 0;
    line-height: 0;
  }

  .plate button.feed img {
    width: 16px;
    height: 16px;
    opacity: 1;
  }

  .plate button.feed:not(:disabled):hover img {
    transform: translateY(-1px);
  }

  .plate button.feed:disabled {
    cursor: default;
    opacity: 0.35;
    filter: grayscale(1);
  }

  .coins {
    color: var(--jg-ink);
  }

  .plate-note {
    margin: 0;
    font-size: 7px;
    line-height: 1.5;
    color: var(--jg-muted);
  }

  .plate-note.bad {
    color: var(--jg-bad);
  }

  .carry {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }

  .carry img {
    width: 7px;
    height: 9px;
    object-fit: contain;
  }

  .carry small {
    font-size: 7px;
    color: var(--jg-muted);
  }

  .chip {
    padding: 0 3px;
    font-size: 7px;
    color: #fff;
    background: var(--jg-good);
    border: 1px solid var(--jg-edge);
  }

  .spectate {
    position: absolute;
    inset: 2px;
    overflow-y: auto;
  }

  .spectate-title {
    margin: 0;
    padding: 4px 6px;
    font-size: 9px;
    letter-spacing: 0.08em;
    color: var(--jg-bad);
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    padding: 10px;
    font-size: 9px;
    text-align: center;
    color: var(--jg-ink);
    background: var(--jg-screen);
    border: 3px solid var(--jg-edge);
  }

  .empty code {
    color: var(--jg-good);
    font-size: 8px;
  }

</style>
