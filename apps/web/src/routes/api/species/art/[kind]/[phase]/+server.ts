import { error } from '@sveltejs/kit';
import { read } from '$app/server';
import { readPalette, recolour } from '#lib/sprite';
import type { RequestHandler } from './$types';

import blackdragon1 from '../../../../../../../static/assets/animation/blackdragon/1.gif?url';
import blackdragon2 from '../../../../../../../static/assets/animation/blackdragon/2.gif?url';
import blackdragon3 from '../../../../../../../static/assets/animation/blackdragon/3.gif?url';
import greendragon1 from '../../../../../../../static/assets/animation/greendragon/1.gif?url';
import greendragon2 from '../../../../../../../static/assets/animation/greendragon/2.gif?url';
import greendragon3 from '../../../../../../../static/assets/animation/greendragon/3.gif?url';

/**
 * A pet's drawing, in whatever colourway the url asks for.
 *
 * This is the whole of the pet creator's hosting. A species registered on
 * the contract needs its art at an https url, and this project has nowhere
 * to upload to — so what goes on chain is a recipe against a base this
 * project already ships, not a file somebody has to keep alive.
 *
 * Nothing here reads anything a caller supplies except two numbers, both
 * clamped, and it can only ever serve a recolour of one of six files in
 * this repository. There is no upload, no storage and no fetch.
 */

const BASES: Record<string, Record<string, string>> = {
  blackdragon: { '1': blackdragon1, '2': blackdragon2, '3': blackdragon3 },
  greendragon: { '1': greendragon1, '2': greendragon2, '3': greendragon3 }
};

export const GET: RequestHandler = async ({ params, url }) => {
  // `3.gif` and `3` both work: the path ends up in NFT metadata, and a url
  // that looks like a file is what every wallet expects to see there.
  const phase = params.phase.replace(/\.gif$/, '');
  const asset = BASES[params.kind]?.[phase];
  if (!asset) error(404, `No base drawing for ${params.kind} phase ${phase}`);

  const base = new Uint8Array(await read(asset).arrayBuffer());
  const body = recolour(base, readPalette(url.searchParams));

  // `Uint8Array<ArrayBufferLike>` is not a `BodyInit`; the buffer under it is.
  return new Response(body.buffer as ArrayBuffer, {
    headers: {
      'content-type': 'image/gif',
      /*
       * A species' art never changes: its colourway is in the url, and the
       * base is a file in this repository. So this is immutable, and every
       * client that draws the pet — wallet, explorer, the installer — pays
       * for it once.
       */
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*'
    }
  });
};
