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
    target: ChainPetSummary & { kind?: string; evolution_phase?: number };
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

<div class="scene">
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

    <span class="versus" class:clash={phase === 'fighting'}>vs</span>

    <div class="side">
      <img
        class="sprite flip"
        alt={target.name}
        src={theirArt}
        style:animation="{MOTION[theirMotion]} {motionDuration(theirMotion)}s ease-in-out infinite"
      />
      <span class="name">{target.name}</span>
    </div>
  </div>

  {#if phase === 'ready'}
    <p class="line">
      Winner takes the wager. The odds swing ±15%, so this is not a free win.
    </p>
    <div class="buttons">
      <button class="go" onclick={onfight}>Fight</button>
      <button onclick={onclose}>Back</button>
    </div>
  {:else if phase === 'fighting'}
    <p class="line pulse">Settling on chain…</p>
  {:else}
    <p class="result" class:won={phase === 'won'} class:lost={phase === 'lost'}>
      {phase === 'won' ? 'Won' : 'Lost'}
      {#if transferred}
        <span class="amount">{phase === 'won' ? '+' : '−'}{transferred}</span>
      {/if}
    </p>
    <div class="buttons">
      <button onclick={onclose}>Back</button>
    </div>
  {/if}
</div>

<style>
  .scene {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
  }

  .arena {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 4px;
    min-height: 92px;
    background: #0b0d10;
    border: 1px solid #242a33;
    padding: 6px 4px;
  }

  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    overflow: hidden;
  }

  .sprite {
    height: 56px;
    image-rendering: pixelated;
  }

  .flip {
    transform: scaleX(-1);
  }

  .name {
    font-size: 9px;
    color: #8b95a3;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .versus {
    font-size: 10px;
    color: #39414d;
  }

  .versus.clash {
    color: #f36b7b;
    animation: jg-shake 0.5s ease-in-out infinite;
  }

  .line {
    margin: 0;
    font-size: 10px;
    line-height: 1.5;
    color: #8b95a3;
  }

  .pulse {
    animation: jg-breathe 1.4s ease-in-out infinite;
  }

  .result {
    margin: 0;
    font-size: 14px;
    text-align: center;
  }

  .result.won {
    color: #b6f36b;
  }

  .result.lost {
    color: #f36b7b;
  }

  .amount {
    display: block;
    font-size: 10px;
    color: #8b95a3;
  }

  .buttons {
    display: flex;
    gap: 4px;
  }

  .buttons button {
    flex: 1;
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    font-size: 10px;
    padding: 3px 6px;
    cursor: pointer;
  }

  .buttons button.go {
    border-color: #b6f36b;
    color: #b6f36b;
  }
</style>
