import { GAME_CONTRACT } from '#lib/config';
import { viewFunction } from '#lib/near/rpc';
import { petSlug, type ChainPet } from '@joygotchi/pet';
import type { RequestHandler } from './$types';

/**
 * Every page worth finding: the fixed ones, and one per pet on chain.
 *
 * Read from the contract on request and cached for an hour at the edge, so a
 * pet minted today is in tomorrow's crawl without a deploy.
 */
const PAGES = ['/', '/create', '/download'];

async function allPets(): Promise<ChainPet[]> {
  const out: ChainPet[] = [];
  for (let from = 0; ; from += 100) {
    const page = await viewFunction<ChainPet[]>(GAME_CONTRACT, 'get_pets', {
      from_index: from,
      limit: 100
    });
    out.push(...page);
    if (page.length < 100) return out;
  }
}

export const GET: RequestHandler = async ({ url, setHeaders }) => {
  const pets = await allPets().catch(() => [] as ChainPet[]);
  const urls = [
    ...PAGES.map((path) => `${url.origin}${path}`),
    ...pets
      .sort((a, b) => Number(a.pet_id) - Number(b.pet_id))
      .map((pet) => `${url.origin}/pets/${petSlug(pet)}`)
  ];

  setHeaders({
    'content-type': 'application/xml; charset=utf-8',
    'cache-control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'
  });
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((loc) => `  <url><loc>${loc}</loc></url>`).join('\n') +
      `\n</urlset>\n`
  );
};
