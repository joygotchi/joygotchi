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
  /** Which phase the big preview shows. */
  let shown = $state(0);
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

<header class="max-w-2xl">
  <h1 class="text-2xl text-text">Create a species</h1>
  <p class="mt-2 text-sm leading-relaxed text-muted">
    Recolour a dragon, name it, register it. Anyone can then mint one, and the art is served from
    here, so there is nothing to upload.
  </p>
</header>

<div class="mt-8 grid overflow-hidden border border-line bg-panel lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
  <!-- Look -->
  <section class="flex flex-col gap-5 border-line p-5 lg:border-r">
    <div class="grid-bg flex h-64 items-center justify-center border border-line bg-ink">
      <img class="pixel h-44" alt="Phase {BASE_PHASES[shown]}" src={previews[shown]} />
    </div>

    <div class="grid grid-cols-3 gap-2" role="tablist" aria-label="Evolution phase">
      {#each previews as src, index (src)}
        <button
          class="flex flex-col items-center gap-1 border bg-ink py-2 transition-colors"
          class:border-accent={shown === index}
          class:border-line={shown !== index}
          role="tab"
          aria-selected={shown === index}
          onclick={() => (shown = index)}
          type="button"
        >
          <img class="pixel h-10" alt="" {src} />
          <span class="text-[0.6rem]" class:text-accent={shown === index} class:text-muted={shown !== index}>
            Phase {BASE_PHASES[index]}
          </span>
        </button>
      {/each}
    </div>

    <fieldset>
      <legend class="mb-2 text-xs text-muted">Base</legend>
      <div class="grid grid-cols-2 gap-2">
        {#each BASE_KINDS as kind (kind)}
          <button
            class="border px-2 py-1.5 text-xs transition-colors"
            class:border-accent={base === kind}
            class:text-accent={base === kind}
            class:border-line={base !== kind}
            class:text-muted={base !== kind}
            onclick={() => (base = kind)}
            type="button"
          >
            {kind === 'blackdragon' ? 'Black dragon' : 'Green dragon'}
          </button>
        {/each}
      </div>
    </fieldset>

    <!--
      A shift, not a colour: every colour in the drawing moves by this much,
      which keeps the shading looking drawn rather than painted over.
    -->
    <label class="block text-xs text-muted">
      <span class="flex justify-between">Hue <span class="text-text">{hue}°</span></span>
      <input class="mt-2 w-full accent-accent" type="range" min="0" max="359" bind:value={hue} />
    </label>
    <label class="block text-xs text-muted">
      <span class="flex justify-between">Saturation <span class="text-text">{saturation}%</span></span>
      <input class="mt-2 w-full accent-accent" type="range" min="25" max="200" bind:value={saturation} />
    </label>
  </section>

  <!-- Register -->
  <section class="flex flex-col border-t border-line p-5 lg:border-t-0">
    {#if !wallet.accountId}
      <p class="m-auto text-center text-sm text-muted">Connect a wallet to register a species.</p>
    {:else if minted}
      <p class="text-sm">
        <span class="text-accent">{cleanPetName}</span> is the first
        <span class="text-accent">{cleanName}</span>.
      </p>
      <p class="mt-2 text-xs text-muted">
        Install it on your desktop, or
        <a class="text-accent" href={explorerToken(minted.petId)} rel="noreferrer" target="_blank">
          see it on the explorer</a
        >.
      </p>
      <div class="mt-4"><CopyField label="Install it" value={installCommand(minted.installCode)} /></div>
    {:else if registered}
      <p class="text-sm">
        <span class="text-accent">{cleanName}</span> is registered. Anyone can mint one.
      </p>
      <label class="mt-5 block text-xs text-muted">
        Name the first one
        <input
          class="mt-1 w-full border border-line bg-ink px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
          bind:value={petName}
          placeholder="SMAUG"
        />
      </label>
      <button
        class="mt-4 w-full bg-accent px-3 py-2.5 text-sm font-bold text-ink disabled:opacity-40"
        disabled={busy || cleanPetName.length < 2}
        onclick={mintFirst}
        type="button"
      >
        {busy ? 'Minting…' : 'Mint the first one'}
      </button>
    {:else}
      <div class="flex flex-col gap-5">
        <label class="block text-xs text-muted">
          Name
          <input
            class="mt-1 w-full border border-line bg-ink px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            bind:value={displayName}
            placeholder="Azure Wyvern"
          />
        </label>

        <label class="block text-xs text-muted">
          Id <span class="text-muted/60">· lowercase, permanent</span>
          <input
            class="mt-1 w-full border bg-ink px-3 py-2 text-sm text-text focus:outline-none"
            class:border-bad={idProblem}
            class:border-line={!idProblem}
            class:focus:border-accent={!idProblem}
            bind:value={id}
            placeholder="wyvern"
          />
        </label>
        {#if idProblem}<p class="-mt-3 text-xs text-bad">{idProblem}</p>{/if}
        {#if uriProblem}<p class="-mt-3 text-xs text-bad">{uriProblem}</p>{/if}
      </div>

      <div class="mt-auto pt-6">
        <button
          class="w-full bg-accent px-3 py-2.5 text-sm font-bold text-ink disabled:opacity-40"
          disabled={!ready}
          onclick={register}
          type="button"
        >
          {busy ? 'Registering…' : `Register for ${price} NEAR`}
        </button>
        <p class="mt-2 text-center text-[0.65rem] text-muted">
          One-time fee. A species can't be deleted once pets point at it.
        </p>
      </div>
    {/if}

    {#if error}
      <p class="mt-3 border border-bad/40 bg-bad/10 p-2 text-xs text-bad">{error}</p>
    {/if}
  </section>
</div>

<details class="group mt-6 border border-line bg-panel">
  <summary class="flex cursor-pointer list-none items-center justify-between px-5 py-3 text-xs text-muted hover:text-text">
    <span>Drew your own? Submit a sprite sheet with nine animated states</span>
    <span class="transition-transform group-open:rotate-90">›</span>
  </summary>
  <div class="border-t border-line px-5 py-4">
    <pre class="overflow-x-auto bg-ink p-3 text-xs text-muted"><code>my-wyvern/
  species.json   {"{"}"id":"wyvern","name":"Azure Wyvern"{"}"}
  1.png          8×9 atlas, 1536×1872. Phases 2 and 3 optional.

npx @joygotchi/joygotchi submit ./my-wyvern</code></pre>
    <p class="mt-2 text-xs text-muted">
      Same sheet format as
      <a class="text-accent" href="https://petdex.dev/docs" rel="noreferrer noopener" target="_blank"
        >petdex</a
      >. The CLI checks the grid and prints the call for you to sign.
    </p>
  </div>
</details>

