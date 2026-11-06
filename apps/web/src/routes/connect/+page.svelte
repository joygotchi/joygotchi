<script lang="ts">
  import { page } from '$app/state';
  import { addKeyForContract, connectedAccount, grantFunctionCallKey } from '#lib/near/wallet.svelte';

  /**
   * The desktop app's way in to a wallet.
   *
   * The desktop cannot reach a browser extension and should not host a wallet
   * itself, so it sends people here: this page asks whichever wallet they
   * already use to add the key the desktop generated, then hands the account
   * back over loopback.
   *
   * Going through `near-connect` rather than a single wallet's URL is the
   * point. MyNearWallet — which this app used to link to directly — announced
   * its shutdown for 31 October 2026. A desktop app wired to one wallet's
   * redirect scheme dies with that wallet; one that asks a selector does not.
   *
   * The desktop generates the keypair and sends only the public half, so this
   * page never sees a secret and the key it asks for is one only that machine
   * can use.
   */
  type Phase = 'review' | 'connecting' | 'done' | 'error';

  let phase = $state<Phase>('review');
  let message = $state<string | null>(null);

  /**
   * Whether this browser already has a wallet session.
   *
   * Shown rather than inferred, because the desktop opens your *default*
   * browser — which is often not the one you signed in to the gallery with.
   * Being asked to pick a wallet then looks like the page forgot you; saying
   * so turns it into an explanation.
   */
  let signedInAs = $state<string | null>(null);
  let checked = $state(false);

  $effect(() => {
    void connectedAccount().then((account) => {
      signedInAs = account;
      checked = true;
    });
  });

  const params = $derived(page.url.searchParams);
  const publicKey = $derived(params.get('public_key') ?? '');
  const contractId = $derived(params.get('contract_id') ?? '');
  const methods = $derived((params.get('methods') ?? '').split(',').filter(Boolean));
  const gameContractId = $derived(params.get('game_contract_id') ?? '');
  const gamePublicKey = $derived(params.get('game_public_key') ?? '');
  const gameMethods = $derived((params.get('game_methods') ?? '').split(',').filter(Boolean));
  const callback = $derived(params.get('callback') ?? '');

  /**
   * Only ever a loopback address.
   *
   * Without this, a crafted link could have someone grant a key and then send
   * the result to whatever host the link named. The key is scoped to our
   * contract and six methods either way, but handing the grant to a stranger
   * is not something to leave to the scope limits.
   */
  function loopbackOnly(raw: string): URL | null {
    try {
      const url = new URL(raw);
      const host = url.hostname;
      const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
      return url.protocol === 'http:' && local ? url : null;
    } catch {
      return null;
    }
  }

  const target = $derived(loopbackOnly(callback));
  const valid = $derived(
    publicKey.startsWith('ed25519:') && contractId.length > 0 && methods.length > 0 && target !== null
  );

  let returnUrl = $state<string | null>(null);

  /**
   * Tell the app, by two routes that fail differently.
   *
   * The fetch is what normally does it: a request to the loopback server needs
   * no navigation and cannot be blocked as mixed content, which a top-level
   * jump from https to http://127.0.0.1 can be. `no-cors` means the response
   * is unreadable, which does not matter — the server only has to receive it.
   *
   * The navigation stays as a fallback, and the link stays visible after both,
   * because a grant that the app never hears about leaves somebody staring at
   * "Waiting for the wallet…" with nothing to click.
   */
  async function handBack(extra: Record<string, string>) {
    if (!target) return;
    for (const [key, value] of Object.entries(extra)) target.searchParams.set(key, value);

    const url = target.toString();
    returnUrl = url;

    try {
      await fetch(url, { mode: 'no-cors' });
    } catch {
      // The app may not be listening. The navigation below still tries.
    }

    window.location.href = url;
  }

  async function approve() {
    if (!valid) return;
    phase = 'connecting';
    message = null;

    try {
      const accountId = await grantFunctionCallKey({
        contractId,
        publicKey,
        allowMethods: { anyMethod: false, methodNames: methods },
        // A quarter of a NEAR of gas, which is near-connect's own default.
        // It caps gas only — never what the key can spend in the game.
        gasAllowance: { kind: 'limited', amount: '250000000000000000000000' }
      });

      // The second key, for the game contract. Asked for separately because
      // NEAR binds a key to one contract, and after the first so a refusal
      // here leaves a usable session rather than none.
      if (gameContractId && gameMethods.length > 0 && gamePublicKey) {
        await addKeyForContract({
          contractId: gameContractId,
          // Its own key. NEAR maps a public key to one permission, so reusing
          // the first one here adds nothing and says nothing about it.
          publicKey: gamePublicKey,
          allowMethods: { anyMethod: false, methodNames: gameMethods },
          gasAllowance: { kind: 'limited', amount: '250000000000000000000000' }
        });
      }

      phase = 'done';
      await handBack({ account_id: accountId, public_key: publicKey });
    } catch (cause) {
      phase = 'error';
      message = cause instanceof Error ? cause.message : String(cause);
    }
  }

  const refuse = () => handBack({ errorCode: 'userRejected' });
</script>

<svelte:head><title>Connect · JOYGOTCHI</title></svelte:head>

<div class="mx-auto max-w-lg">
  <h1 class="text-sm tracking-widest text-muted uppercase">Connect the desktop app</h1>

  {#if !valid}
    <div class="mt-4 border border-bad/40 bg-panel p-4 text-xs">
      <p class="text-bad">This link is not one the desktop app made.</p>
      <ul class="mt-2 space-y-1 text-muted">
        {#if !publicKey.startsWith('ed25519:')}<li>· no key to grant</li>{/if}
        {#if contractId === ''}<li>· no contract named</li>{/if}
        {#if methods.length === 0}<li>· no methods named</li>{/if}
        {#if target === null}
          <li>· it would send the result somewhere other than this machine</li>
        {/if}
      </ul>
      <p class="mt-3 text-muted">Open the desktop app and press Connect there instead.</p>
    </div>
  {:else if phase === 'done'}
    <div class="mt-4 border border-line bg-panel p-4 text-xs">
      <p class="text-accent">Granted. Handing you back to the app…</p>
      {#if returnUrl}
        <p class="mt-2 text-muted">
          Still here?
          <a class="text-accent hover:underline" href={returnUrl}>Tell the app yourself</a>
          — it is listening on this machine.
        </p>
      {/if}
    </div>
  {:else}
    <div class="mt-4 border border-line bg-panel">
      <div class="border-b border-line px-4 py-3 text-xs text-muted">
        JOYGOTCHI Desktop is asking your wallet for a key. You are not sending anything, and the
        key stays on the machine that asked.

        {#if !checked}
          <p class="mt-2 text-muted">Looking for a wallet in this browser…</p>
        {:else if signedInAs}
          <p class="mt-2 text-accent">
            Signed in here as {signedInAs} — it will sign without asking you to pick again.
          </p>
        {:else if checked}
          <p class="mt-2 text-warn">
            No wallet is connected <em>in this browser</em>. The app opens your default browser,
            which may not be the one you used on the gallery, so you will be asked to pick one.
          </p>
        {/if}
      </div>

      <dl class="divide-y divide-line text-xs">
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">It may call</dt>
          <dd class="text-right">{contractId}</dd>
        </div>
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="shrink-0 text-muted">And only these</dt>
          <dd class="text-right break-all">{methods.join(', ')}</dd>
        </div>
        {#if gameContractId && gameMethods.length > 0}
          <div class="flex justify-between gap-3 px-4 py-2">
            <dt class="shrink-0 text-muted">And on the game</dt>
            <dd class="text-right break-all">
              {gameContractId}: {gameMethods.join(', ')}
              <span class="block text-muted">a second key, and a second signature</span>
            </dd>
          </div>
        {/if}
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">It cannot</dt>
          <dd class="text-right text-accent">move NEAR, or touch any other contract</dd>
        </div>
        <div class="flex justify-between gap-3 px-4 py-2">
          <dt class="text-muted">Revoke it</dt>
          <dd class="text-right">by deleting the key in your wallet</dd>
        </div>
      </dl>

      <div class="flex gap-2 border-t border-line p-4 text-xs">
        <button
          class="flex-1 border border-accent bg-accent px-3 py-2 font-bold text-ink disabled:opacity-40"
          disabled={phase === 'connecting'}
          onclick={approve}
        >
          {#if phase === 'connecting'}
            Waiting for your wallet…
          {:else if signedInAs}
            Grant the key
          {:else}
            Choose a wallet
          {/if}
        </button>
        <button class="border border-line px-3 py-2 hover:border-line-bright" onclick={refuse}>
          Cancel
        </button>
      </div>

      {#if message}
        <p class="border-t border-bad/30 px-4 py-2 text-xs text-bad">{message}</p>
      {/if}
    </div>
  {/if}
</div>
