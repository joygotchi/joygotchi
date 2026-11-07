<script lang="ts">
  import { convertFileSrc, invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { AgentEvent } from '@joygotchi/pet';
  import BattleScene from './BattleScene.svelte';
  import PetPanel from './PetPanel.svelte';
  import { listPets, type ChainPetSummary } from './chain';
  import { detectBattle, startedHere, type SpectatedBattle } from './battle-watch';
  import Settings from './Settings.svelte';
  import { MOTION_CSS, motionDuration } from '@joygotchi/pet';
  import { petReaction, watchConnect } from './wallet.svelte';
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

  const pose = $derived(visibleState(reaction, now));
  const motion = $derived(MOTION[pose]);

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

    const ticker = setInterval(() => (now = Date.now()), 250);
    // Cheap: reading a couple of small files every few seconds.
    const rescan = setInterval(() => void load(), 5_000);
    // Slower than the file rescan: this one is a round trip to an RPC for
    // every pet on the contract, not a couple of local reads.
    const battles = setInterval(() => void pollBattles(), 12_000);
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

    <div
      class="pet"
      data-state={pose}
      data-tauri-drag-region
      onmouseenter={() => setOverPet(true)}
      onmouseleave={() => setOverPet(false)}
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
        <img alt={active.displayName} data-tauri-drag-region draggable="false" src={artSrc} />
        <!--
          A shadow, so the pet stands on the desktop rather than hovering in
          front of it. It does not move with the sprite's animation, which is
          what makes the bobbing read as the pet leaving the ground.
        -->
        <span class="shadow" data-tauri-drag-region></span>
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
        <button title="What this pet is up to" onclick={() => (showPanel = true)}>ⓘ</button>
        <button title="Settings (⌘,)" onclick={() => (showSettings = true)}>⚙</button>
        <button class="close" title="Quit JOYGOTCHI" onclick={() => invoke('quit')}>✕</button>
      </div>

      {#if chainSelf}
        <div class="row meter">
          <img class="jg-px" alt="Food" src="/assets/items/food.png" />
          <span class="bar" data-level={hunger}>
            <span class="fill" style:width="{Math.max(3, foodFull * 100)}%"></span>
          </span>
          <span class="food" data-level={hunger}>{foodLabel}</span>
          {#if chainSelf.locked}<span class="chip work">LAB</span>{/if}
        </div>
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
    width: 160px;
    height: 170px;
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
    bottom: 6px;
    left: 50%;
    width: 72px;
    height: 10px;
    margin-left: -36px;
    border-radius: 50%;
    background: radial-gradient(ellipse at center, #0b0d1055 0%, #0b0d1000 70%);
    pointer-events: none;
  }

  .pet img {
    width: 100%;
    image-rendering: pixelated;
    -webkit-user-drag: none;
  }

  /*
   * What the pet says, as a speech bubble rather than a toast. Light, because
   * it floats over the editor: a dark box there reads as another window, and
   * the one thing this should look like is the pet talking.
   */
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
    transition: opacity 0.15s;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 150px;
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
    max-width: 62px;
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
    color: var(--jg-muted);
    font: inherit;
    font-size: 9px;
    line-height: 1;
    padding: 0 1px;
    cursor: pointer;
  }

  .plate button:hover {
    color: var(--jg-ink);
  }

  .plate button.close:hover {
    color: var(--jg-bad);
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
