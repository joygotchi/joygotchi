<script lang="ts">
  import { page } from '$app/state';
  import CopyField from '#lib/components/CopyField.svelte';
  import { installCommand } from '#lib/cli';
  import MintOne from '#lib/components/MintOne.svelte';
  import PetChat from '#lib/components/PetChat.svelte';
  import PetSprite from '#lib/components/PetSprite.svelte';
  import StateViewer from '#lib/components/StateViewer.svelte';
  import { explorerAccount, explorerToken } from '#lib/config';
  import { truncateAccount } from '#lib/near/amount';
  import { wallet } from '#lib/near/wallet.svelte';
  import { artFor, getPetBySlug, type GalleryPet } from '#lib/pets';
  import {
    ACTION_PRICE,
    MAX_EVOLUTION_PHASE,
    isStarving,
    levelToEvolve
  } from '@joygotchi/pet';

  /*
   * Four phases, because that is what the game contract allows. There are
   * three sprites per kind, so the last one wears the third — worth knowing
   * when the art arrives rather than discovering it then.
   */
  const EVOLUTION = Array.from({ length: MAX_EVOLUTION_PHASE }, (_, i) => i + 1);

  let pet = $state<GalleryPet | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const slug = $derived(page.params.slug ?? '');

  /**
   * Read the pet again. Called on mount and after an action that changes it,
   * so a stake or a level-up shows without a refresh — and guarded on the slug
   * so a slow request for the previous pet cannot overwrite the current one.
   */
  async function reload(wanted = slug) {
    try {
      const found = await getPetBySlug(wanted);
      if (slug !== wanted) return;
      pet = found;
      error = found ? null : 'No pet at this address.';
    } catch (cause) {
      if (slug === wanted) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (slug === wanted) loading = false;
    }
  }

  $effect(() => {
    loading = true;
    error = null;
    void reload(slug);
  });

  const mine = $derived(Boolean(pet && wallet.accountId === pet.owner_id));
  const starving = $derived(pet ? isStarving(pet) : false);

  /** The next phase, or null when there is none left. */
  const nextPhase = $derived(
    pet && pet.pkg.evolutionPhase < MAX_EVOLUTION_PHASE ? pet.pkg.evolutionPhase + 1 : null
  );
</script>

<svelte:head>
  <title>{pet ? `${pet.name} · JOYGOTCHI` : 'JOYGOTCHI'}</title>
</svelte:head>

<a class="text-xs text-muted hover:text-text" href="/">← Gallery</a>

{#if loading}
  <div class="mt-4 h-96 animate-pulse border border-line bg-panel"></div>
{:else if error || !pet}
  <div class="mt-4 border border-line bg-panel p-8 text-sm text-muted">
    {error ?? 'No pet at this address.'}
  </div>
{:else}
  <div class="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
    <!-- Art and stats -->
    <div class="flex flex-col gap-4">
      <div class="grid-bg flex h-72 items-center justify-center border border-line bg-panel">
        <PetSprite src={artFor(pet)} height={192} alt={pet.name} dim={starving} />
      </div>

      <!--
        What it becomes, and what it costs to get there.
        The page said "Phase: 1" and nothing else, which is a number with no
        meaning attached: it does not say there are four of them, that each
        one is a different animal, or that the way between them is levels.
      -->
      <div class="border border-line bg-panel">
        <div class="border-b border-line px-3 py-2 text-xs text-muted">Evolution</div>
        <ol class="grid grid-cols-4 divide-x divide-line">
          {#each EVOLUTION as phase (phase)}
            {@const reached = pet.pkg.evolutionPhase >= phase}
            <li class="flex flex-col items-center gap-1 px-1 py-2" class:opacity-35={!reached}>
              <PetSprite src={artFor(pet, phase)} height={48} alt="Phase {phase}" motion={false} />
              <span class="text-[10px]" class:text-accent={pet.pkg.evolutionPhase === phase}>
                {pet.pkg.evolutionPhase === phase ? 'now' : `lv ${levelToEvolve(phase - 1) ?? 0}`}
              </span>
            </li>
          {/each}
        </ol>
        <p class="border-t border-line px-3 py-2 text-[11px] text-muted">
          {#if nextPhase === null}
            Fully evolved.
          {:else}
            Level {levelToEvolve(pet.pkg.evolutionPhase)} evolves it to phase {nextPhase}, for
            {ACTION_PRICE.evolve} credits in the app.
          {/if}
        </p>
      </div>

      <div class="border border-line bg-panel">
        <div class="flex items-baseline justify-between border-b border-line px-3 py-2">
          <span class="text-lg">{pet.name}</span>
          <span class="text-xs text-muted">#{pet.pet_id}</span>
        </div>

        <dl class="divide-y divide-line text-xs">
          {#each [
            ['Rarity', pet.rarity],
            ['Kind', pet.kind],
            ['Level', String(pet.level)],
            ['Stars', pet.star > 0 ? '★'.repeat(pet.star) : '—'],
            ['Phase', String(pet.pkg.evolutionPhase)],
            ['Owner', truncateAccount(pet.owner_id)],
            ['Status', pet.locked ? 'At work in the AI Lab' : starving ? 'Starved' : 'Happy']
          ] as const as [label, value] (label)}
            <div class="flex justify-between gap-3 px-3 py-2">
              <dt class="text-muted">{label}</dt>
              <dd class="truncate">{value}</dd>
            </div>
          {/each}
        </dl>
      </div>

      <div class="flex gap-2 text-xs">
        <a
          class="flex-1 border border-line px-3 py-2 text-center text-muted hover:border-line-bright"
          href={explorerToken(pet.pet_id)}
          rel="noreferrer"
          target="_blank"
        >
          This pet on the explorer
        </a>
        <a
          class="flex-1 border border-line px-3 py-2 text-center text-muted hover:border-line-bright"
          href={explorerAccount(pet.owner_id)}
          rel="noreferrer"
          target="_blank"
        >
          Its owner
        </a>
      </div>
    </div>

    <!-- Install and talk -->
    <div class="flex flex-col gap-4">
      <div class="border border-line bg-panel">
        <div class="border-b border-line px-4 py-3">
          <h2 class="text-sm tracking-widest text-muted uppercase">Install</h2>
          <p class="mt-1 text-xs text-muted">
            The code is the pet's id in a form you can copy without mistyping. The CLI decodes it,
            asks the contract who owns the pet, and writes it to
            <code class="text-text">~/.joygotchi/pets/{pet.slug}/</code>.
          </p>
        </div>

        <div class="flex flex-col gap-4 p-4">
          <CopyField label="Install code" value={pet.pkg.installCode} />
          <CopyField label="Install it" prefix="$ " value={installCommand(pet.pkg.installCode)} />

          <p class="text-[0.65rem] text-muted">
            Then open the desktop app and pick {pet.name} under Pets.
            <a class="text-accent hover:underline" href="/download">Get it here.</a>
          </p>

          <MintOne species={pet.category} />
        </div>
      </div>

      <StateViewer {pet} />

      <PetChat {pet} {mine} />
    </div>
  </div>
{/if}
