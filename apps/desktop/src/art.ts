import { artPath, atlasFrom, isBundledKind, type EvolutionPhase } from '@joygotchi/pet';

/**
 * Art for a pet that is not installed on this machine.
 *
 * Only your own pets have a folder under `~/.joygotchi`, but a battle needs
 * to draw the other side too. The app already ships every drawing in
 * `public/assets/animation`, so the opponent is served by the app itself.
 *
 * It used to come from the deployed gallery over https, which was wrong twice
 * over: the window's CSP allows images from `'self'`, `asset:` and `data:`
 * and nothing else, so the browser refused to load it and the opponent's half
 * of the arena was simply empty — and fetching a file that is already on disk
 * made a fight depend on the network.
 *
 * `artPath` keeps this and the CLI's bundle agreeing about which drawing
 * belongs to which kind and phase.
 */
export function artPathFor(pet: {
  kind?: string;
  category?: string;
  evolution_phase?: number;
}): string | null {
  const kind = pet.kind ?? pet.category ?? 'blackdragon';
  /*
   * `null`, not a path, for a species this app ships no drawings for.
   *
   * Anybody can register a species on the contract, and its art lives at a
   * url that was chosen after this app was built. Returning a path anyway
   * would produce `/assets/animation/wyvern/1.gif`, which is a 404 — and a
   * 404 here is an empty pet, which is how this app has already broken an
   * arena once. Callers fall back to the copy in the pet's own folder.
   */
  if (!isBundledKind(kind)) return null;
  const phase = Math.min(4, Math.max(1, Math.trunc(pet.evolution_phase ?? 1))) as EvolutionPhase;
  return `/assets/animation/${artPath(kind, phase)}`;
}

/**
 * Where a hat sits on each drawing.
 *
 * It used to be one position in CSS — `left: 50%, top: 14%` — which is right
 * for a phase-one green dragon and wrong for every other sprite. The head
 * moves right and up with each evolution, so evolving left the hat floating
 * over a wing.
 *
 * Measured rather than guessed: the eyes are the one landmark every sprite
 * has, and the numbers below are each sprite's eye position offset by the
 * gap between the eyes and the hat on the placement that was already
 * correct. A new drawing needs a row here, and the comment above says how to
 * work one out.
 */
const HAT_ANCHORS: Record<string, Record<number, { left: number; top: number }>> = {
  greendragon: {
    1: { left: 50, top: 14 },
    2: { left: 69, top: 1 },
    3: { left: 66, top: 0 }
  },
  blackdragon: {
    1: { left: 62, top: 8 },
    2: { left: 62, top: 0 },
    3: { left: 64, top: 0 }
  }
};

/** The hat's placement for this pet, as percentages of the sprite box. */
export function hatAnchorFor(pet: {
  kind?: string;
  category?: string;
  evolution_phase?: number;
}): { left: number; top: number } {
  const kind = pet.kind ?? pet.category ?? 'blackdragon';
  const phase = Math.min(3, Math.max(1, Math.trunc(pet.evolution_phase ?? 1)));
  return HAT_ANCHORS[kind]?.[phase] ?? { left: 50, top: 14 };
}

/**
 * A registered species' drawing for a pet's phase, from its on-chain urls.
 *
 * For pets this app ships no drawings for — anyone can register a species,
 * and its art lives at an https url chosen after this app was built. The
 * roster used to hand `null` straight to an <img>, which drew a broken image.
 */
export function speciesArtFor(
  pet: { category?: string; kind?: string; evolution_phase?: number },
  species: Map<string, string[]>
): string | null {
  const art = species.get(pet.category ?? pet.kind ?? '') ?? [];
  if (art.length === 0) return null;
  const phase = Math.max(1, Math.trunc(pet.evolution_phase ?? 1));
  return art[Math.min(phase, art.length) - 1] ?? art[0]!;
}

/**
 * Svelte action: if the image turns out to be a sprite atlas, show only its
 * first cell — the idle pose — instead of all seventy-two frames at once.
 *
 * Decided by measuring, as everywhere else: nothing in a url says what is
 * behind it. Needs `crossorigin="anonymous"` on the <img> so the canvas can
 * read the pixels; `/api/art` serves the header that allows it.
 */
export function firstCell(node: HTMLImageElement) {
  const crop = () => {
    if (node.dataset.cell === 'done') return;
    const sheet = atlasFrom(node.src, node.naturalWidth, node.naturalHeight);
    if (!sheet.ok) return;
    const { width, height } = sheet.atlas.frame;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    try {
      context.drawImage(node, 0, 0, width, height, 0, 0, width, height);
      node.dataset.cell = 'done';
      node.src = canvas.toDataURL('image/png');
    } catch {
      // A host without CORS: leave the whole sheet rather than nothing.
    }
  };
  if (node.complete && node.naturalWidth > 0) crop();
  node.addEventListener('load', crop);
  return { destroy: () => node.removeEventListener('load', crop) };
}
