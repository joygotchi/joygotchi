import { json } from '@sveltejs/kit';
import { GAME_CONTRACT } from '#lib/config';
import { viewFunction } from '#lib/near/rpc';
import { AiUnavailableError, complete, petPersona } from '#lib/server/near-ai';
import type { ChainPet } from '@joygotchi/pet';
import type { RequestHandler } from './$types';

/** Talk to a pet. Reads the pet off the chain so it cannot be described to us. */
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    petId?: number;
    message?: string;
    viewer?: string;
  } | null;

  const petId = Number(body?.petId);
  const message = (body?.message ?? '').trim();

  if (!Number.isInteger(petId) || petId < 1) {
    return json({ error: 'petId must be a pet id' }, { status: 400 });
  }
  if (message === '' || message.length > 280) {
    return json({ error: 'message must be 1–280 characters' }, { status: 400 });
  }

  const pet = await viewFunction<ChainPet | null>(GAME_CONTRACT, 'get_pet', {
    pet_id: petId
  }).catch(() => null);

  if (!pet) return json({ error: `No pet ${petId} on ${GAME_CONTRACT}` }, { status: 404 });

  try {
    const reply = await complete([
      { role: 'system', content: petPersona(pet, { viewerIsOwner: body?.viewer === pet.owner_id }) },
      { role: 'user', content: message }
    ]);
    return json({ reply, petId, model: 'near-ai' });
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      return json({ error: error.message }, { status: 503 });
    }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
};
