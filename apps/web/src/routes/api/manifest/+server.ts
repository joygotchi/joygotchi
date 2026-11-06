import { json } from '@sveltejs/kit';
import { GAME_CONTRACT, NETWORK } from '#lib/config';
import { listPets } from '#lib/pets';
import type { RequestHandler } from './$types';

/**
 * Every pet on the contract, as a flat manifest.
 *
 * The same idea as petdex's `/api/manifest`: one public URL any client can
 * read — the CLI, the desktop app, a Discord bot, somebody's wearable — so
 * building on JOYGOTCHI never means scraping these pages.
 *
 * It is a projection of the chain, not a database. Which also means it can
 * never disagree with the chain for longer than the cache header below.
 */
export const GET: RequestHandler = async ({ url, setHeaders }) => {
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 60) || 60));

  const pets = await listPets(limit);

  setHeaders({
    // Long enough that a gallery refresh does not hit the RPC for every
    // visitor, short enough that a new pet shows up while you are still
    // looking at the page you minted it from.
    'cache-control': 'public, max-age=15, s-maxage=30, stale-while-revalidate=60'
  });

  return json({
    format: 'joygotchi/1',
    network: NETWORK,
    contract: GAME_CONTRACT,
    total: pets.length,
    assetBase: `${url.origin}/assets/animation`,
    pets: pets.map((pet) => ({
      slug: pet.slug,
      petId: pet.pet_id,
      displayName: pet.name,
      installCode: pet.pkg.installCode,
      kind: pet.kind,
      rarity: pet.pkg.rarity,
      level: pet.level,
      star: pet.star,
      evolutionPhase: pet.pkg.evolutionPhase,
      owner: pet.owner_id,
      art: `${url.origin}/assets/animation/${pet.pkg.states.idle}`,
      page: `${url.origin}/pets/${pet.slug}`,
      spriteVersion: pet.pkg.spriteVersion,
      frame: pet.pkg.frame
    }))
  });
};
