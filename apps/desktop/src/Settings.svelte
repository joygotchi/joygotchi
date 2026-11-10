<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import {
    SESSION_DAYS,
    SESSION_METHODS,
    clearSession,
    connect,
    session as walletSession,
    sessionExpired
  } from './wallet.svelte';
  import type { InstalledPet } from './types';

  type Props = {
    pets: InstalledPet[];
    active: string | null;
    onclose: () => void;
    onpick: (slug: string) => void;
    onrefresh: () => void;
  };
  let { pets, active, onclose, onpick, onrefresh }: Props = $props();

  /**
   * Wiring the coding agent to the pet.
   *
   * The hook server has always listened on 127.0.0.1 and the pet has always
   * known how to react to a tool call. What was missing was the step that
   * makes it happen: the README gave a `curl` to paste, so the feature worked
   * for whoever read the README and for nobody else.
   */
  let hooked = $state(false);
  let hookNote = $state<string | null>(null);

  const readHooks = () =>
    void invoke<boolean>('agent_hooks_installed').then((on) => (hooked = on));
  readHooks();

  async function toggleHooks() {
    hookNote = null;
    try {
      if (hooked) {
        await invoke('uninstall_agent_hooks');
        hookNote = 'Disconnected.';
      } else {
        const where = await invoke<string>('install_agent_hooks');
        hookNote = `Written to ${where}. Restart the agent.`;
      }
      readHooks();
    } catch (cause) {
      hookNote = cause instanceof Error ? cause.message : String(cause);
    }
  }

  let port = $state<number | null>(null);
  let root = $state('');
  let clickThrough = $state(false);

  /**
   * Let clicks fall through to whatever is behind the pet.
   *
   * It has to be switched from here rather than by hovering the pet: a window
   * that ignores cursor events cannot notice a cursor. Turning it on means the
   * pet stops being draggable until it is turned off again, so the label says
   * so.
   */
  async function toggleClickThrough(next: boolean) {
    clickThrough = next;
    await invoke('set_click_through', { ignore: next }).catch(() => {});
  }

  const session = $derived(walletSession.current);
  const connecting = $derived(walletSession.connecting);
  const walletError = $derived(walletSession.error);

  const gameContract = $derived(pets[0]?.chain.contract ?? '');
  const expired = $derived(session ? sessionExpired(session) : false);

  async function startConnect() {
    if (!gameContract) {
      walletSession.error = 'Install a pet first — the contract comes from its pet.json.';
      return;
    }
    await connect(gameContract);
  }

  $effect(() => {
    void invoke<number>('hook_port').then((value) => (port = value));
    void invoke<string>('pets_directory').then((value) => (root = value));
  });
</script>

<div class="panel jg jg-frame">

  <header data-tauri-drag-region>
    <span>Pets</span>
    <button data-tauri-drag-region="false" onclick={onclose} title="Close">✕</button>
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

  <section class="wallet">
    <div class="row">
      <span class="muted">Coding agent</span>
      <button onclick={toggleHooks}>{hooked ? 'Disconnect' : 'Connect'}</button>
    </div>
    <p class="fine">
      {#if hooked}
        The pet reacts while you work — running on a tool call, waving when it
        lands, idle when you stop.
      {:else}
        Let the pet watch Claude Code and react to what it does. Nothing is
        read: the agent posts to 127.0.0.1 and the pet animates.
      {/if}
    </p>
    {#if hookNote}<p class="fine accent">{hookNote}</p>{/if}
  </section>

  <section class="wallet">
    <label class="row toggle">
      <span class="muted">Click through the pet</span>
      <input
        checked={clickThrough}
        onchange={(event) => toggleClickThrough(event.currentTarget.checked)}
        type="checkbox"
      />
    </label>
    <p class="fine">Clicks reach what is behind. The pet stops being draggable.</p>
  </section>

  <section class="wallet">
    {#if session && !expired}
      <div class="row">
        <span class="muted">Signing as</span>
        <span class="accent">{session.accountId}</span>
      </div>
      <p class="fine">
        {session.methodNames.length} methods on {session.contractId}. Cannot move NEAR or pets.
      </p>
      <button onclick={clearSession}>Forget this key</button>
    {:else}
      <div class="row">
        <span class="muted">Wallet</span>
        <span>{expired ? 'session expired' : 'not connected'}</span>
      </div>
      <p class="fine">
        Opens your browser once. {SESSION_METHODS.length} methods, {SESSION_DAYS} days — feeding,
        items and claiming then sign here. Staking still asks your wallet.
      </p>
      <button onclick={startConnect}>
        {connecting ? 'Waiting for the wallet… (click to retry)' : 'Connect wallet'}
      </button>
    {/if}

    {#if walletError}<p class="bad">{walletError}</p>{/if}
  </section>

  <footer>
    <button onclick={onrefresh}>Rescan</button>
    {#if port}<span>hooks on 127.0.0.1:{port}</span>{/if}
    <button class="quit" onclick={() => invoke('quit')}>Quit</button>
  </footer>
</div>

<style>
  /* Settings shares the panel's frame; only its own rules live here. */
  .panel {
    position: absolute;
    inset: 2px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    font-size: 10px;
  }

  header {
    cursor: grab;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 2px 2px 4px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-size: 9px;
    color: var(--jg-muted);
  }

  /* Its own rule. It used to share one with `.wallet`, which gave the close
     button a top border and section padding — the grey box in the corner. */
  header button {
    cursor: pointer;
    background: none;
    border: 0;
    color: var(--jg-muted);
    font: inherit;
    font-size: 12px;
    line-height: 1;
    padding: 0 2px;
  }

  header button:hover {
    color: var(--jg-bad);
  }

  .wallet {
    padding: 5px;
    margin-top: 4px;
    background: var(--jg-screen);
    border: 3px solid var(--jg-edge);
  }

  .toggle {
    cursor: pointer;
    align-items: center;
  }

  .wallet .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  .wallet button {
    margin-top: 4px;
    width: 100%;
    font-family: var(--jg-pixel);
    font-size: 9px;
    color: var(--jg-ink);
    background: var(--jg-bevel);
    border: 3px solid var(--jg-edge);
    box-shadow: inset -2px -2px 0 #c3d2da;
    padding: 4px 8px;
    cursor: pointer;
  }

  .wallet button:active:not(:disabled) {
    box-shadow: inset 2px 2px 0 #c3d2da;
    transform: translateY(1px);
  }

  .wallet button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .fine {
    margin: 4px 0 0;
    color: var(--jg-muted);
    font-size: 8px;
    line-height: 1.6;
  }

  .accent {
    color: var(--jg-good);
  }

  .muted {
    color: var(--jg-muted);
  }

  .bad {
    margin: 4px 0 0;
    color: var(--jg-bad);
    font-size: 8px;
  }

  footer button.quit {
    color: var(--jg-bad);
  }

  footer button {
    font-family: var(--jg-pixel);
    font-size: 8px;
    background: var(--jg-bevel);
    border: 2px solid var(--jg-edge);
    color: var(--jg-ink);
    cursor: pointer;
    padding: 2px 6px;
  }

  ul {
    flex: 1 1 auto;
    min-height: 60px;
    max-height: 150px;
    margin: 4px 0 0;
    padding: 2px;
    list-style: none;
    overflow-y: auto;
    background: var(--jg-screen);
    border: 3px solid var(--jg-edge);
  }

  li button {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    padding: 4px 5px;
    background: none;
    border: 0;
    color: var(--jg-ink);
    font: inherit;
    font-size: 9px;
    text-align: left;
    cursor: pointer;
  }

  li button:hover {
    background: #ffffffaa;
  }

  li button.active {
    color: var(--jg-good);
    background: #ffffffcc;
  }

  .meta {
    color: var(--jg-muted);
  }

  .empty {
    flex: 1;
    margin: 4px 0 0;
    padding: 8px;
    font-size: 9px;
    color: var(--jg-muted);
    line-height: 1.6;
    background: var(--jg-screen);
    border: 3px solid var(--jg-edge);
  }

  .empty code {
    color: var(--jg-good);
    font-size: 8px;
  }

  footer {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    justify-content: space-between;
    align-items: center;
    padding: 5px 2px 0;
    color: var(--jg-muted);
    font-size: 8px;
  }
</style>
