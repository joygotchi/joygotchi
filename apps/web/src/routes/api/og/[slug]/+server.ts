import { error } from '@sveltejs/kit';
import { renderCard, spriteFor } from '#lib/server/og';
import { petPreview, shortNear } from '#lib/server/preview';
import type { RequestHandler } from './$types';

/**
 * The image a link preview shows: `/api/og/<pet-slug>.png`, or
 * `/api/og/site.png` for every page that isn't a pet.
 *
 * Cached for ten minutes at the edge and served stale for a day after: a
 * pet's level and price move, but nobody needs a preview that is to-the-second.
 */
export const GET: RequestHandler = async ({ params, url, setHeaders }) => {
  const slug = params.slug.replace(/\.png$/, '');

  setHeaders({
    'content-type': 'image/png',
    'cache-control': 'public, max-age=600, s-maxage=600, stale-while-revalidate=86400'
  });

  if (slug === 'site') {
    const png = await renderCard({
      kicker: 'ON-CHAIN PETS ON NEAR',
      title: 'JOYGOTCHI',
      lines: ['LIVES ON YOUR DESKTOP', 'REACTS TO YOUR CODING AGENT', 'MINT · RAISE · BATTLE · TRADE'],
      sprite: await spriteFor(`${url.origin}/assets/animation/greendragon/2.gif`, 440)
    });
    return new Response(new Uint8Array(png));
  }

  const pet = await petPreview(slug).catch(() => null);
  if (!pet) error(404, 'No pet at this address');

  const lines = [
    `#${pet.petId} · ${pet.rarity} · LV ${pet.level}`,
    `${pet.species} · PHASE ${pet.phase}`
  ];
  if (pet.forSale) lines.push(`FOR SALE · ${shortNear(pet.forSale)} NEAR`);

  const png = await renderCard({
    kicker: 'JOYGOTCHI PET',
    title: pet.name,
    lines,
    sprite: await spriteFor(pet.art, 440)
  });
  return new Response(new Uint8Array(png));
};
