<script lang="ts">
  import { MOTION, motionDuration } from '@joygotchi/pet';
  import { convertFileSrc } from '@tauri-apps/api/core';
  import { artPathFor } from './art';
  import type { ChainPetSummary } from './chain';
  import type { InstalledPet } from './types';

  /**
   * A fight, shown rather than reported.
   *
   * The pets lunge at each other while the transaction is in flight, and the
   * result lands on the sprites — the winner jumps, the loser shakes. The
   * timing is honest about what is happening: the clash runs as long as the
   * chain takes, so nothing pretends to be finished before it is.
   *
   * The opponent's art is read from the chain's kind and phase rather than
   * from a file, because only the installed pet has a folder on this machine.
   */
  type Props = {
    mine: InstalledPet;
    target: ChainPetSummary;
    phase: 'ready' | 'fighting' | 'won' | 'lost';
    transferred: string | null;
    onfight: () => void;
    onclose: () => void;
  };
  let { mine, target, phase, transferred, onfight, onclose }: Props = $props();

  const myArt = $derived(convertFileSrc(`${mine.directory}/${mine.states.idle ?? ''}`));
  const theirArt = $derived(artPathFor(target));

  /** What each side is doing, as a state the shared motion table knows. */
  const myMotion = $derived(
    phase === 'fighting' ? 'battling' : phase === 'won' ? 'jumping' : phase === 'lost' ? 'failed' : 'idle'
  );
  const theirMotion = $derived(
    phase === 'fighting' ? 'battling' : phase === 'won' ? 'failed' : phase === 'lost' ? 'jumping' : 'idle'
  );
</script>

<div class="scene jg">
  <div class="arena">
    <div class="side">
      <img
        class="sprite"
        alt={mine.displayName}
        src={myArt}
        style:animation="{MOTION[myMotion]} {motionDuration(myMotion)}s ease-in-out infinite"
      />
      <span class="name">{mine.displayName}</span>
    </div>

    <span class="versus" class:clash={phase === 'fighting'}>VS</span>

    <div class="side">
      <!--
        The flip lives on a wrapper, not on the sprite. Every motion keyframe
        sets `transform`, so a `scaleX(-1)` on the image itself is overwritten
        the moment an animation runs — the opponent faced the wrong way for
        the whole fight and turned round only between animations.
      -->
      <span class="flip">
        <img
          class="sprite"
          alt={target.name}
          src={theirArt}
          style:animation="{MOTION[theirMotion]} {motionDuration(theirMotion)}s ease-in-out infinite"
        />
      </span>
      <span class="name">{target.name}</span>
    </div>
  </div>

  {#if phase === 'ready'}
    <p class="line">Winner takes the wager. The odds swing ±15%.</p>
    <!--
      The drawn button is the button. It carries its own label, so putting
      text over it would say "ATTACK NOW" twice.
    -->
    <button class="attack" onclick={onfight} aria-label="Attack now">
      <img alt="" src="/assets/button/button-attack.png" />
    </button>
    <button class="jg-btn wide" onclick={onclose}>Back</button>
  {:else if phase === 'fighting'}
    <p class="line pulse">Settling on chain…</p>
  {:else}
    <p class="result" class:won={phase === 'won'} class:lost={phase === 'lost'}>
      {phase === 'won' ? 'WON' : 'LOST'}
      {#if transferred}
        <span class="amount">{phase === 'won' ? '+' : '−'}{transferred}</span>
      {/if}
    </p>
    <button class="jg-btn wide" onclick={onclose}>Back</button>
  {/if}
</div>

<style>
  .scene {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 4px;
    font-family: var(--jg-pixel);
    color: var(--jg-ink);
  }

  /*
   * The drawn arena, with the fighters standing on it. It is a scene rather
   * than a panel: a fight reported in a grey box is the thing this screen
   * exists to stop being.
   */
  .arena {
    position: relative;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: end;
    gap: 2px;
    min-height: 110px;
    padding: 10px 6px 14px;
    background: url('/assets/background/battle.png') center / cover no-repeat;
    border: 3px solid var(--jg-edge);
    image-rendering: pixelated;
  }

  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }

  .sprite {
    height: 62px;
    image-rendering: pixelated;
  }

  .flip {
    display: block;
    transform: scaleX(-1);
  }

  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0 3px;
    font-size: 8px;
    color: var(--jg-ink);
    background: #ffffffcc;
    border: 1px solid var(--jg-edge);
  }

  .versus {
    align-self: center;
    font-size: 10px;
    color: #fff;
    text-shadow: 1px 1px 0 var(--jg-edge), -1px -1px 0 var(--jg-edge),
      1px -1px 0 var(--jg-edge), -1px 1px 0 var(--jg-edge);
  }

  .versus.clash {
    color: var(--jg-bad);
    animation: jg-shake 0.5s ease-in-out infinite;
  }

  /* The art is the whole control: no frame, no background, no label. */
  .attack {
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
    line-height: 0;
  }

  .attack img {
    width: 100%;
    image-rendering: pixelated;
  }

  .attack:active img {
    transform: translateY(2px);
  }

  .line {
    margin: 0;
    font-size: 8px;
    line-height: 1.6;
    color: var(--jg-muted);
  }

  .pulse {
    animation: jg-breathe 1.4s ease-in-out infinite;
  }

  .result {
    margin: 0;
    font-size: 16px;
    text-align: center;
    letter-spacing: 0.1em;
  }

  .result.won {
    color: var(--jg-good);
  }

  .result.lost {
    color: var(--jg-bad);
  }

  .amount {
    display: block;
    font-size: 9px;
    letter-spacing: 0;
    color: var(--jg-muted);
  }

  .wide {
    width: 100%;
  }
</style>
