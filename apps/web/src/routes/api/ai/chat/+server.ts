import { json } from '@sveltejs/kit';
import { GAME_CONTRACT } from '#lib/config';
import { viewFunction } from '#lib/near/rpc';
import { AiUnavailableError, complete, petPersona } from '#lib/server/near-ai';
import { INTENT_GRAMMAR, readIntent, type ChainPet } from '@joygotchi/pet';
import { corsHeaders, preflight } from '#lib/server/cors';
import type { RequestHandler } from './$types';

/**
 * Talk to a pet, which may also propose one thing to do.
 *
 * The proposal is parsed here and returned as a typed intent, never as text.
 * Whatever the model writes, what leaves this endpoint is one of a closed
 * set of actions carrying no pet, no amount and no account — see `intent.ts`
 * for why each of those is absent.
 *
 * Reads the pet off the chain so it cannot be described to us.
 */
export const OPTIONS: RequestHandler = ({ request }) => preflight(request);

export const POST: RequestHandler = async ({ request }) => {
  const cors = corsHeaders(request.headers.get('origin'));
  const body = (await request.json().catch(() => null)) as {
    petId?: number;
    message?: string;
    viewer?: string;
    history?: Array<{ role?: string; content?: string }>;
  } | null;

  const petId = Number(body?.petId);
  const message = (body?.message ?? '').trim();

  if (!Number.isInteger(petId) || petId < 1) {
    return json({ error: 'petId must be a pet id' }, { status: 400, headers: cors });
  }
  if (message === '' || message.length > 280) {
    return json({ error: 'message must be 1–280 characters' }, { status: 400, headers: cors });
  }

  /*
   * The last few turns, so the pet can follow a conversation rather than
   * meeting you again every sentence.
   *
   * Bounded and filtered rather than trusted: this arrives from a client and
   * decides what a model is told. Six turns is enough to keep a thread and
   * short enough that nobody can push a prompt in by sheer length, and only
   * the two roles that belong in a transcript get through — a forged
   * `system` line is exactly how you would try to rewrite the persona.
   */
  const history = (body?.history ?? [])
    .filter(
      (turn): turn is { role: 'user' | 'assistant'; content: string } =>
        (turn?.role === 'user' || turn?.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim() !== ''
    )
    .slice(-6)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, 280) }));

  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: petId
  }).catch(() => null);

  if (!pet) return json({ error: `No pet ${petId} on ${GAME_CONTRACT}` }, { status: 404, headers: cors });

  try {
    const owner = body?.viewer === pet.owner_id;
    const reply = await complete([
      { role: 'system', content: petPersona(pet, { viewerIsOwner: owner }) },
      /*
       * Only an owner is offered the grammar. A visitor's pet has nothing to
       * propose to them, and a proposal they cannot sign is a button that
       * exists to be refused.
       */
      ...(owner
        ? [
            {
              role: 'system' as const,
              content:
                'If your owner is asking you to do something you can do, end your reply with ' +
                `exactly one of these and nothing else after it: ${INTENT_GRAMMAR}. ` +
                'Use one only when they asked for it. Never invent one that is not listed.'
            }
          ]
        : []),
      ...history,
      { role: 'user', content: message }
    ]);

    const { said, intent } = readIntent(reply);
    return json({ reply: said, intent, petId, model: 'near-ai' }, { headers: cors });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return json({ error: error.message }, { status: 503, headers: cors });
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502, headers: cors });
  }
};
