import { json } from '@sveltejs/kit';
import { GAME_CONTRACT } from '#lib/config';
import { AiUnavailableError, complete, petPersona } from '#lib/server/near-ai';
import { corsHeaders, preflight } from '#lib/server/cors';
import { viewFunction } from '#lib/near/rpc';
import type { ChainPet } from '@joygotchi/pet';
import type { RequestHandler } from './$types';

/**
 * One line from a pet about the meal it just ate. It decides nothing.
 *
 * This endpoint used to grade the meal, and the XP depended on its answer.
 * It does not any more, and the reason is worth keeping: across four prompts
 * and 168 samples the model never varied meaningfully inside a band — it
 * picked one number per hunger state and stayed on it. The "grade" was
 * already a function of `starves_at`, evaluated over a network, behind a
 * key, at a model's latency, and unverifiable by the player paying for it.
 *
 * `feedXp` in `@joygotchi/pet` is that function now, and the oracle runs it
 * on state it reads itself. So nothing here is on the paying path: no
 * transaction is verified, because there is no longer anything to protect
 * beyond a sentence, and a request that gets no answer costs the player
 * nothing. What the model is left with is the part arithmetic genuinely
 * cannot do.
 *
 * The pet speaks in its own voice again, which is the right voice for this.
 * The bias that made it a bad judge of its owner's cooking — "You like them
 * and you show it" — is exactly what makes it good company.
 */
export const OPTIONS: RequestHandler = ({ request }) => preflight(request);

export const POST: RequestHandler = async ({ request }) => {
  const cors = corsHeaders(request.headers.get('origin'));

  const body = (await request.json().catch(() => null)) as { petId?: unknown } | null;
  const petId = Number(body?.petId ?? 0);

  if (!Number.isInteger(petId) || petId < 1) {
    return json({ error: 'petId is required' }, { status: 400, headers: cors });
  }

  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: petId
  }).catch(() => null);
  if (!pet) {
    return json({ error: `no pet ${petId}` }, { status: 404, headers: cors });
  }

  try {
    const line = await complete(
      [
        { role: 'system', content: petPersona(pet, { viewerIsOwner: true }) },
        { role: 'user', content: 'Your owner just bought you a meal. Say one short thing about it.' }
      ],
      { maxTokens: 60, temperature: 0.9 }
    );
    return json({ petId, line: line.trim() }, { headers: cors });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return json({ petId, line: null, error: error.message }, { status: 503, headers: cors });
    }
    return json({ petId, line: null }, { headers: cors });
  }
};
