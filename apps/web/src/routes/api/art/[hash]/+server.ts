import { error } from '@sveltejs/kit';
import { ART_CONTRACT, isSheetHash } from '#lib/art';
import { viewFunction } from '#lib/near/rpc';
import type { RequestHandler } from './$types';

/**
 * A sprite sheet stored on chain, as a PNG: `/api/art/<sha256>.png`.
 *
 * This is the url a species registers for art somebody drew. The sheet's
 * address is its content, so it can never change under that url — the
 * response is cached for good, and every wallet, explorer and desktop app
 * that draws the pet pays for one read of the chain between them.
 */
export const GET: RequestHandler = async ({ params }) => {
  const hash = params.hash.replace(/\.png$/, '');
  if (!isSheetHash(hash)) error(404, 'Not a sheet address');

  const base64 = await viewFunction<string | null>(ART_CONTRACT, 'get', { hash }).catch(() => null);
  if (!base64) error(404, 'No sheet at this address');

  const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*'
    }
  });
};
