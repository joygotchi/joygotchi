<script lang="ts">
  import {
    ATLAS_CSS,
    MOTION,
    MOTION_CSS,
    atlasStyleAttr,
    motionDuration,
    type Atlas,
    type PetState
  } from '@joygotchi/pet';
  import { probeAtlas } from '#lib/sprite';

  /**
   * One pet, drawn at one size, whatever kind of art its species registered.
   *
   * This exists because every place that drew a pet did it with an `<img>`,
   * which is correct for a species that ships one drawing and shows the
   * entire sprite sheet — all seventy-two frames at once — for a species
   * that ships an atlas. The state viewer was taught to tell them apart and
   * the hero, the evolution strip, the gallery card and the chat avatar were
   * not, which is the same fault this project keeps finding: two paths, one
   * updated.
   *
   * So there is one path now. Anything drawing a pet uses this.
   */
  type Props = {
    /** The species' registered art url for the phase being shown. */
    src: string;
    /** On-screen height in pixels. The sheet is scaled to match. */
    height: number;
    /**
     * Which row, for an atlas. Ignored for a single drawing.
     *
     * Called `pose` and not `state`: a prop named `state` makes Svelte read
     * every `$state(...)` in this file as a store subscription on it, and
     * the error it produces talks about stores rather than about the name.
     */
    pose?: PetState;
    alt?: string;
    /** Apply the shared CSS motion. Off for a still thumbnail. */
    motion?: boolean;
    dim?: boolean;
  };
  let { src, height, pose = 'idle', alt = '', motion = true, dim = false }: Props = $props();

  /*
   * Whether the art is an atlas, decided by measuring it. Nothing in the
   * package says so — the url is whatever its creator registered — so the
   * only way to know is to load it and look. A sheet whose grid does not
   * divide is one drawing, which is what it is.
   */
  let atlas = $state<Atlas | null>(null);
  $effect(() => {
    const url = src;
    atlas = null;
    let cancelled = false;
    void probeAtlas(url).then((found) => {
      if (!cancelled) atlas = found;
    });
    return () => {
      cancelled = true;
    };
  });
</script>

<svelte:head>
  {@html `<style>${MOTION_CSS}${ATLAS_CSS}</style>`}
</svelte:head>

{#if atlas}
  <div
    class:opacity-40={dim}
    aria-label={alt || undefined}
    role={alt ? 'img' : 'presentation'}
    style={atlasStyleAttr(pose, atlas, src, height / atlas.frame.height)}
  ></div>
{:else if src}
  <img
    class="pixel"
    class:opacity-40={dim}
    {alt}
    src={src}
    style:height="{height}px"
    style:animation={motion
      ? `${MOTION[pose]} ${motionDuration(pose)}s ease-in-out infinite`
      : 'none'}
  />
{/if}
