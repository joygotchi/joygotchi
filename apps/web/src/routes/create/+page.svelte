<script lang="ts">
  import CopyField from '#lib/components/CopyField.svelte';
  import { installCommand } from '#lib/cli';
  import { explorerToken } from '#lib/config';
  import { wallet } from '#lib/near/wallet.svelte';
  import { createSpecies, getPet, getSpecies, mintPet, speciesPriceNear } from '#lib/pets';
  import { artUris, artUriError, speciesIdError, MAX_SPECIES_NAME } from '#lib/species';
  import { BASE_KINDS, BASE_PHASES, type BaseKind } from '#lib/sprite';

  /*
   * The creator.
   *
   * A species used to be a line in the contract's source and six files in
   * the desktop app's bundle, so adding one took two deploys. It is now a
   * transaction — and the art it points at is a recolour of a drawing this
   * app already serves, which is why making one needs nowhere to upload to.
   */

  let base = $state<BaseKind>('greendragon');
  let hue = $state(200);
  let saturation = $state(110);
  let id = $state('');
  let displayName = $state('');
  let petName = $state('');

  let busy = $state(false);
  let error = $state<string | null>(null);
  let registered = $state<string | null>(null);
  let minted = $state<{ petId: number; slug: string; installCode: string } | null>(null);
  let price = $state('5');

  $effect(() => {
    speciesPriceNear().then((asked) => (price = asked));
  });

  const palette = $derived({ hue, saturation });

  /** Previews come from this app, so what you see is what gets registered. */
  const previews = $derived(
    BASE_PHASES.map(
      (phase) =>
        `/api/species/art/${base}/${phase}.gif?h=${palette.hue}&s=${palette.saturation}`
    )
  );

  const cleanId = $derived(
    id
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 24)
  );
  const cleanName = $derived(displayName.trim().slice(0, MAX_SPECIES_NAME));
  const cleanPetName = $derived(
    petName
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, '')
      .trim()
      .slice(0, 16)
  );

  const idProblem = $derived(cleanId === '' ? null : speciesIdError(cleanId));

  /**
   * The urls that will go on chain, checked by the same rules the contract
   * uses. `origin` is this page's own, so a preview deployment registers
   * art that only exists on that preview — which is a thing to know before
   * paying, not after.
   */
  const uris = $derived(
    typeof location === 'undefined' ? [] : artUris(location.origin, base, palette)
  );
  const uriProblem = $derived(uris.map(artUriError).find((why) => why !== null) ?? null);

  const ready = $derived(
    Boolean(wallet.accountId) &&
      cleanId !== '' &&
      !idProblem &&
      cleanName !== '' &&
      !uriProblem &&
      !busy
  );

  async function register() {
    if (!ready) return;
    busy = true;
    error = null;
    try {
      // Taken ids are the one refusal worth catching before the wallet opens:
      // it is the likeliest, and the only one the form cannot see for itself.
      if (await getSpecies(cleanId)) {
        throw new Error(`"${cleanId}" is taken. Pick another id.`);
      }
      await createSpecies(cleanId, cleanName, uris, price);
      registered = cleanId;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function mintFirst() {
    if (!registered || cleanPetName.length < 2) return;
    busy = true;
    error = null;
    try {
      const petId = await mintPet(cleanPetName, registered);
      const pet = await getPet(petId);
      if (!pet) throw new Error(`Pet ${petId} was minted but cannot be read back yet`);
      minted = { petId, slug: pet.slug, installCode: pet.pkg.installCode };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<h1 class="text-sm tracking-widest text-muted uppercase">Create a species</h1>
<p class="mt-2 max-w-2xl text-sm text-muted">
  Recolour a drawing this game already ships. Anyone can then mint one, and
  the art is served by this site, so there is nothing to upload and nothing
  for you to keep online.
</p>
<p class="mt-2 max-w-2xl text-sm text-muted">
  This is the quick way, and it is a recolour: the pet moves the way every
  pet here moves, which is CSS over one drawing. To draw your own —
  <span class="text-text">nine states, eight frames each</span>, really
  animated — make the sheet in whatever you like and submit the folder:
</p>
<pre class="mt-3 max-w-2xl overflow-x-auto border border-line bg-panel p-3 text-xs text-muted"><code>my-wyvern/
  species.json   {"{"}"id":"wyvern","name":"Azure Wyvern"{"}"}
  1.png          8×9 atlas, 1536×1872. Phases 2 and 3 optional.

npx @joygotchi/joygotchi submit ./my-wyvern</code></pre>
<p class="mt-2 max-w-2xl text-xs text-muted">
  It checks the grid and prints the call that registers the species — which
  you sign, because it costs NEAR. The sheet is the
  <a
    class="text-accent"
    href="https://petdex.dev/docs"
    rel="noreferrer noopener"
    target="_blank">same format petdex uses</a
  >, so one made for either works in the other.
</p>

<div class="mt-6 grid gap-6 lg:grid-cols-[320px_1fr]">
  <!-- What it will look like, at the size a player sees it. -->
  <div class="border border-line bg-panel p-4">
    <div class="grid grid-cols-3 gap-2">
      {#each previews as src, index (src)}
        <figure class="border border-line bg-ink p-1">
          <img class="pixel w-full" alt="Phase {BASE_PHASES[index]}" {src} />
          <figcaption class="mt-1 text-center text-[0.6rem] text-muted">
            Phase {BASE_PHASES[index]}
          </figcaption>
        </figure>
      {/each}
    </div>

    <div class="mt-4 flex gap-2">
      {#each BASE_KINDS as kind (kind)}
        <button
          class="flex-1 border px-2 py-1.5 text-xs"
          class:border-accent={base === kind}
          class:text-accent={base === kind}
          class:border-line={base !== kind}
          class:text-muted={base !== kind}
          onclick={() => (base = kind)}
          type="button"
        >
          {kind === 'blackdragon' ? 'Black' : 'Green'}
        </button>
      {/each}
    </div>

    <!--
      A shift, not a colour. Every colour in the drawing moves by this much,
      which is what keeps a dragon's shading and its highlights looking
      drawn rather than painted over.
    -->
    <label class="mt-4 block text-xs text-muted">
      Hue shift <span class="text-text">{hue}°</span>
      <input class="mt-1 w-full" type="range" min="0" max="359" bind:value={hue} />
    </label>
    <label class="mt-2 block text-xs text-muted">
      Saturation <span class="text-text">{saturation}%</span>
      <input class="mt-1 w-full" type="range" min="25" max="200" bind:value={saturation} />
    </label>
  </div>

  <div class="border border-line bg-panel p-4">
    {#if !wallet.accountId}
      <p class="text-sm text-muted">Connect a wallet to register a species.</p>
    {:else if minted}
      <p class="text-sm">
        <span class="text-accent">{cleanPetName}</span> is the first
        <span class="text-accent">{cleanName}</span>.
      </p>
      <p class="mt-2 text-xs text-muted">
        Install it on your desktop, or
        <a class="text-accent" href={explorerToken(minted.petId)} rel="noreferrer" target="_blank">
          see it on the explorer
        </a>. Its art is a url now, so the explorer draws it too.
      </p>
      <div class="mt-3"><CopyField label="Install it" value={installCommand(minted.installCode)} /></div>
    {:else if registered}
      <p class="text-sm">
        <span class="text-accent">{cleanName}</span> is registered. Anyone can mint one.
      </p>
      <label class="mt-4 block text-xs text-muted">
        Name the first one
        <input
          class="mt-1 w-full border border-line bg-ink px-2 py-1.5 text-sm text-text"
          bind:value={petName}
          placeholder="SMAUG"
        />
      </label>
      <button
        class="mt-3 bg-accent px-3 py-2 text-xs font-bold text-ink disabled:opacity-40"
        disabled={busy || cleanPetName.length < 2}
        onclick={mintFirst}
        type="button"
      >
        {busy ? 'Minting…' : 'Mint the first one'}
      </button>
    {:else}
      <label class="block text-xs text-muted">
        Id <span class="text-muted/70">— lowercase, in urls and on every pet</span>
        <input
          class="mt-1 w-full border bg-ink px-2 py-1.5 text-sm text-text"
          class:border-bad={idProblem}
          class:border-line={!idProblem}
          bind:value={id}
          placeholder="wyvern"
        />
      </label>
      {#if idProblem}<p class="mt-1 text-xs text-bad">{idProblem}</p>{/if}

      <label class="mt-4 block text-xs text-muted">
        Name <span class="text-muted/70">— what players read</span>
        <input
          class="mt-1 w-full border border-line bg-ink px-2 py-1.5 text-sm text-text"
          bind:value={displayName}
          placeholder="Azure Wyvern"
        />
      </label>

      {#if uriProblem}
        <p class="mt-3 text-xs text-bad">{uriProblem}</p>
      {/if}

      <p class="mt-4 text-xs text-muted">
        Registering costs <span class="text-text">{price} NEAR</span> and cannot be undone:
        pets of a species point at its id, so it is never deleted.
      </p>

      <button
        class="mt-3 bg-accent px-3 py-2 text-xs font-bold text-ink disabled:opacity-40"
        disabled={!ready}
        onclick={register}
        type="button"
      >
        {busy ? 'Registering…' : `Register for ${price} NEAR`}
      </button>
    {/if}

    {#if error}
      <p class="mt-3 border border-bad/40 bg-bad/10 p-2 text-xs text-bad">{error}</p>
    {/if}
  </div>
</div>
