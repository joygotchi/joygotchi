<script lang="ts">
  import { convertFileSrc, invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { AgentEvent } from '@joygotchi/pet';
  import PetPanel from './PetPanel.svelte';
  import Settings from './Settings.svelte';
  import { MOTION_CSS, motionDuration } from '@joygotchi/pet';
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
  let overPet = $state(false);

  const active = $derived(
    pets.find((pet) => pet.slug === activeSlug) ?? pets[0] ?? null
  );
  // Named `pose`, not `state`: a variable called `state` in a file that uses
  // `$state(...)` makes `$state` read as a store subscription to it, and the
  // whole component silently type-checks as legacy Svelte.
  const pose = $derived(visibleState(reaction, now));
  const motion = $derived(MOTION[pose]);

  const artSrc = $derived.by(() => {
    if (!active) return null;
    const file = active.states[pose] ?? active.states.idle;
    return file ? convertFileSrc(`${active.directory}/${file}`) : null;
  });

  async function load() {
    pets = await invoke<InstalledPet[]>('list_pets');
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

  $effect(() => {
    void load();

    const ticker = setInterval(() => (now = Date.now()), 250);
    const unlisten = listen<AgentEvent>('agent-event', (event) => void react(event.payload));

    return () => {
      clearInterval(ticker);
      void unlisten.then((off) => off());
    };
  });

  $effect(() => {
    if (activeSlug) localStorage.setItem(STORAGE_KEY, activeSlug);
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
      <button onclick={load}>Look again</button>
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
      {/if}
    </div>

    {#if overPet}
      <div class="hint">
        <span>{active.displayName}</span>
        <button title="What this pet is up to" onclick={() => (showPanel = true)}>ⓘ</button>
        <button title="Settings (⌘,)" onclick={() => (showSettings = true)}>⚙</button>
        <button class="close" title="Quit JOYGOTCHI" onclick={() => invoke('quit')}>✕</button>
      </div>
    {/if}
  {/if}

  {#if showPanel && active}
    <PetPanel pet={active} onclose={() => (showPanel = false)} />
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
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    color: #e7ebf0;
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
    width: 160px;
    height: 170px;
    display: grid;
    place-items: center;
    animation-iteration-count: infinite;
    animation-timing-function: ease-in-out;
  }

  .pet img {
    width: 100%;
    image-rendering: pixelated;
    -webkit-user-drag: none;
  }

  .bubble {
    max-width: 220px;
    margin: 0 0 6px;
    padding: 6px 8px;
    font-size: 11px;
    line-height: 1.35;
    background: #12151aee;
    border: 1px solid #39414d;
    text-align: center;
  }

  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 2px 0 0;
    padding: 2px 6px;
    font-size: 9px;
    color: #8b95a3;
    background: #0b0d10cc;
    border: 1px solid #242a33;
  }

  .hint button {
    background: none;
    border: 0;
    color: #8b95a3;
    font: inherit;
    font-size: 11px;
    line-height: 1;
    padding: 0 2px;
    cursor: pointer;
  }

  .hint button:hover {
    color: #e7ebf0;
  }

  .hint button.close:hover {
    color: #f36b7b;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;
    padding: 12px;
    font-size: 11px;
    background: #12151aee;
    border: 1px solid #39414d;
  }

  .empty code {
    color: #b6f36b;
    font-size: 10px;
  }

  .empty button {
    background: none;
    border: 1px solid #39414d;
    color: inherit;
    font: inherit;
    font-size: 10px;
    padding: 3px 8px;
    cursor: pointer;
  }

</style>
