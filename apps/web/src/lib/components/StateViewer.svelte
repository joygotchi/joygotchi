<script lang="ts">
  import { PET_STATES, STATE_INFO, rowFor, type Atlas, type PetState } from '@joygotchi/pet';
  import PetSprite from '#lib/components/PetSprite.svelte';
  import { artFor, type GalleryPet } from '#lib/pets';
  import { probeAtlas } from '#lib/sprite';

  /**
   * Every state this pet can be in, and what it looks like.
   *
   * Two kinds of pet end up here and the panel is honest about which one it
   * is showing.
   *
   * A pet whose species ships one drawing per phase gets **motion**: the
   * desktop app tells states apart by how it moves that single loop, and the
   * keyframes come from the same shared file the desktop imports, so the
   * preview cannot drift from the real thing.
   *
   * A pet whose species ships a nine-row sprite atlas gets **frames** — the
   * actual row for the actual state. The footer used to promise that such a
   * pet would "render here without the viewer changing", which was wishful:
   * rows need a renderer, and this is it.
   */
  type Props = { pet: GalleryPet };
  let { pet }: Props = $props();

  let selected = $state<PetState>('idle');

  const art = $derived(artFor(pet));
  const info = $derived(STATE_INFO[selected]);

  /**
   * Whether the art is an atlas, decided by measuring it.
   *
   * Nothing in the package says so: the species' art is a url its creator
   * registered, and the only way to know what is behind it is to load it and
   * look. A sheet whose grid does not divide is treated as one drawing,
   * which is what it is.
   */
  let atlas = $state<Atlas | null>(null);
  $effect(() => {
    const src = art;
    atlas = null;
    let cancelled = false;
    void probeAtlas(src).then((found) => {
      if (!cancelled) atlas = found;
    });
    return () => {
      cancelled = true;
    };
  });

  /** How many distinct drawings this pet actually has across its states. */
  const distinctArt = $derived(new Set(Object.values(pet.pkg.states)).size);
</script>

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
        <PetSprite src={art} height={128} pose={selected} alt={info.label} />
      </div>

      <div class="flex items-baseline justify-between gap-2">
        <span class="text-sm">{info.label}</span>
        <span class="text-[0.6rem] text-muted">
          {info.holdSeconds === 0 ? 'holds until something happens' : `holds ${info.holdSeconds}s`}
        </span>
      </div>
      <p class="text-[0.65rem] leading-relaxed text-muted">{info.trigger}</p>
      {#if atlas && rowFor(selected) === null}
        <!--
          `feeding` and `battling` come from the game rather than from a
          coding agent, so an 8×9 sheet has no row for them. Saying so
          beats showing the idle row and letting somebody conclude the
          sheet is wrong.
        -->
        <p class="text-[0.6rem] text-warn">
          This sheet has no row for {info.label.toLowerCase()} — it shows idle instead.
        </p>
      {/if}
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
          <!-- The label below names it, so the sprite stays unlabelled and
               a screen reader does not read every state twice. -->
          <PetSprite src={art} height={40} pose={state} />
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
    {#if atlas}
      Real frames: a <strong class="text-text">{atlas.columns}×{atlas.rows}</strong> sprite atlas,
      {atlas.frame.width}×{atlas.frame.height} a cell, one row per state. The last two states have
      no row of their own — they come from the game rather than from a coding agent — so they show
      the idle row.
    {:else if distinctArt === 1}
      These are {PET_STATES.length} motions over <strong class="text-text">one</strong> drawing, not
      {PET_STATES.length} drawings — this species ships an idle loop per evolution phase. A species
      registered with a nine-row sprite atlas renders its real frames here instead.
    {:else}
      This pet carries {distinctArt} drawings across {PET_STATES.length} states.
    {/if}
  </p>
</div>
