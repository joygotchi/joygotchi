<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import type { InstalledPet } from './types';

  type Props = {
    pets: InstalledPet[];
    active: string | null;
    onclose: () => void;
    onpick: (slug: string) => void;
    onrefresh: () => void;
  };
  let { pets, active, onclose, onpick, onrefresh }: Props = $props();

  let port = $state<number | null>(null);
  let root = $state('');

  $effect(() => {
    void invoke<number>('hook_port').then((value) => (port = value));
    void invoke<string>('pets_directory').then((value) => (root = value));
  });
</script>

<div class="panel">
  <header>
    <span>Pets</span>
    <button onclick={onclose} title="Close">✕</button>
  </header>

  {#if pets.length === 0}
    <p class="empty">
      Nothing in <code>{root}</code> yet. Copy a pet's install code from the gallery and run
      <code>npx joygotchi install &lt;code&gt;</code>.
    </p>
  {:else}
    <ul>
      {#each pets as pet (pet.slug)}
        <li>
          <button class:active={pet.slug === active} onclick={() => onpick(pet.slug)}>
            <span class="name">{pet.displayName}</span>
            <span class="meta">{pet.rarity} · lv {pet.level}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <footer>
    <button onclick={onrefresh}>Rescan</button>
    {#if port}<span>hooks on 127.0.0.1:{port}</span>{/if}
  </footer>
</div>

<style>
  .panel {
    position: absolute;
    inset: 4px;
    display: flex;
    flex-direction: column;
    background: #0b0d10f2;
    border: 1px solid #39414d;
    font-size: 11px;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 8px;
    border-bottom: 1px solid #242a33;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #8b95a3;
  }

  header button,
  footer button {
    background: none;
    border: 1px solid #242a33;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 1px 6px;
  }

  ul {
    flex: 1;
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-y: auto;
  }

  li button {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: none;
    border: 0;
    border-bottom: 1px solid #171b22;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  li button.active {
    color: #b6f36b;
  }

  .meta {
    color: #8b95a3;
  }

  .empty {
    flex: 1;
    margin: 0;
    padding: 10px 8px;
    color: #8b95a3;
    line-height: 1.5;
  }

  .empty code {
    color: #b6f36b;
  }

  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 8px;
    border-top: 1px solid #242a33;
    color: #8b95a3;
    font-size: 10px;
  }
</style>
