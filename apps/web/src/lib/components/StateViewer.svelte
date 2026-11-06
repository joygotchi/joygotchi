<script lang="ts">
  import {
    MOTION,
    MOTION_CSS,
    PET_STATES,
    STATE_INFO,
    motionDuration,
    type PetState
  } from '@joygotchi/pet';
  import type { GalleryPet } from '#lib/pets';

  /**
   * Every state this pet can be in, and what it looks like.
   *
   * It previews **motion**, not frames, and the panel says so rather than
   * implying nine drawings exist. A JOYGOTCHI pet has one idle loop per
   * evolution phase; the desktop app tells states apart by how it moves that
   * loop, and this shows exactly that — the keyframes come from the same
   * shared file the desktop imports, so the preview cannot drift from the real
   * thing.
   */
  type Props = { pet: GalleryPet };
  let { pet }: Props = $props();

  let selected = $state<PetState>('idle');

  const art = $derived(`/assets/animation/${pet.pkg.states[selected] ?? pet.pkg.states.idle}`);
  const info = $derived(STATE_INFO[selected]);

  /** How many distinct drawings this pet actually has across its states. */
  const distinctArt = $derived(new Set(Object.values(pet.pkg.states)).size);
</script>

<svelte:head>
  {@html `<style>${MOTION_CSS}</style>`}
</svelte:head>

<div class="border border-line bg-panel">
  <div class="border-b border-line px-4 py-3">
    <h2 class="text-sm tracking-widest text-muted uppercase">State viewer</h2>
    <p class="mt-1 text-xs text-muted">
      What {pet.name} does while you work. Your coding agent's hooks drive the first nine; the
      last two come from the game.
    </p>
  </div>

  <div class="grid gap-4 p-4 lg:grid-cols-[1fr_1.1fr]">
    <!-- The selected state, large -->
    <div class="flex flex-col gap-2">
      <div class="grid-bg flex h-56 items-center justify-center border border-line bg-ink">
        <img
          class="pixel h-32"
          alt={info.label}
          src={art}
          style:animation="{MOTION[selected]} {motionDuration(selected)}s ease-in-out infinite"
        />
      </div>

      <div class="flex items-baseline justify-between gap-2">
        <span class="text-sm">{info.label}</span>
        <span class="text-[0.6rem] text-muted">
          {info.holdSeconds === 0 ? 'holds until something happens' : `holds ${info.holdSeconds}s`}
        </span>
      </div>
      <p class="text-[0.65rem] leading-relaxed text-muted">{info.trigger}</p>
    </div>

    <!-- Every state, small -->
    <div class="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-3 xl:grid-cols-4">
      {#each PET_STATES as state (state)}
        <button
          class="flex flex-col items-center gap-1 border p-2 transition-colors"
          class:border-accent={selected === state}
          class:border-line={selected !== state}
          onclick={() => (selected = state)}
        >
          <img
            class="pixel h-10"
            alt=""
            src="/assets/animation/{pet.pkg.states[state] ?? pet.pkg.states.idle}"
            style:animation="{MOTION[state]} {motionDuration(state)}s ease-in-out infinite"
          />
          <span
            class="text-center text-[0.55rem] leading-tight"
            class:text-accent={selected === state}
            class:text-muted={selected !== state}
          >
            {STATE_INFO[state].label}
          </span>
        </button>
      {/each}
    </div>
  </div>

  <p class="border-t border-line px-4 py-2 text-[0.6rem] leading-relaxed text-muted">
    {#if distinctArt === 1}
      These are {PET_STATES.length} motions over <strong class="text-text">one</strong> drawing, not
      {PET_STATES.length} drawings — a JOYGOTCHI pet ships an idle loop per evolution phase. The
      package format already carries a per-state path and a frame size, so a pet that arrives with
      a row per state renders here without the viewer changing.
    {:else}
      This pet carries {distinctArt} drawings across {PET_STATES.length} states.
    {/if}
  </p>
</div>
