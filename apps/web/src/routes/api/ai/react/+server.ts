import { json } from '@sveltejs/kit';
import { GAME_CONTRACT } from '#lib/config';
import { viewFunction } from '#lib/near/rpc';
import { AiUnavailableError, complete, petPersona } from '#lib/server/near-ai';
import { PET_STATES, stateForEvent, type AgentEvent, type PetState } from '@joygotchi/pet';
import type { ChainPet } from '@joygotchi/pet';
import type { RequestHandler } from './$types';

/**
 * One line from the pet about what your coding agent just did.
 *
 * The desktop app calls this; the state it should animate is decided here too,
 * from the same `stateForEvent` the app would use, so the line and the
 * animation can never disagree about what happened.
 */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    petId?: number;
    event?: AgentEvent;
    agent?: string;
  } | null;

  const petId = Number(body?.petId);
  const event = body?.event;

  if (!Number.isInteger(petId) || petId < 1) {
    return json({ error: 'petId must be a pet id' }, { status: 400 });
  }
  if (!event || typeof event.kind !== 'string') {
    return json({ error: 'event is required' }, { status: 400 });
  }

  let state: PetState;
  try {
    state = stateForEvent(event);
  } catch {
    return json({ error: `unknown event kind "${event.kind}"` }, { status: 400 });
  }
  if (!PET_STATES.includes(state)) {
    return json({ error: 'event did not map to a state' }, { status: 400 });
  }

  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: petId
  }).catch(() => null);

  if (!pet) return json({ error: `No pet ${petId} on ${GAME_CONTRACT}` }, { status: 404 });

  const what =
    event.kind === 'tool-start'
      ? `Your owner's coding agent just started running ${event.tool}.`
      : event.kind === 'tool-end'
        ? `Your owner's ${event.tool} just ${event.ok ? 'succeeded' : 'failed'}.`
        : event.kind === 'prompt'
          ? 'Your owner just asked their coding agent for something.'
          : 'Your owner has gone quiet.';

  try {
    const line = await complete(
      [
        { role: 'system', content: petPersona(pet, { viewerIsOwner: true }) },
        {
          role: 'user',
          content: `${what} React in ONE short sentence, under 12 words. No quotes, no emoji.`
        }
      ],
      { maxTokens: 40 }
    );

    // The state is the part the app needs; the line is decoration. Returning
    // the state even when the model says nothing keeps the pet animating.
    return json({ state, line: line.replace(/^["']|["']$/g, '') });
  } catch (error) {
    if (error instanceof AiUnavailableError) return json({ state, line: null });
    return json({ state, line: null, error: error instanceof Error ? error.message : 'failed' });
  }
};
