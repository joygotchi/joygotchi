import { NEAR_AI_API_KEY, NEAR_AI_BASE_URL, NEAR_AI_MODEL } from '$app/env/private';
import type { ChainPet } from '@joygotchi/pet';

/**
 * NEAR AI Cloud, behind an OpenAI-shaped chat endpoint.
 *
 * The key stays on the server. Nothing here is metered yet, so the endpoints
 * that use it are rate-limited by nothing but the model — fine for a gallery
 * and a desktop pet that speaks a line every few minutes, and the reason the
 * prompts cap their own output length.
 */

export const aiConfigured = () => NEAR_AI_API_KEY.length > 0;

export class AiUnavailableError extends Error {
  constructor() {
    super(
      'NEAR AI is not configured on this deployment. Set NEAR_AI_API_KEY to turn the pets on.'
    );
    this.name = 'AiUnavailableError';
  }
}

type Message = { role: 'system' | 'user' | 'assistant'; content: string };

export async function complete(
  messages: Message[],
  options: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  if (!aiConfigured()) throw new AiUnavailableError();

  const response = await fetch(`${NEAR_AI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${NEAR_AI_API_KEY}`
    },
    body: JSON.stringify({
      model: NEAR_AI_MODEL,
      messages,
      // Generous for one line, because a reasoning model spends this budget
      // on thinking first and only then writes — see the check below.
      max_tokens: options.maxTokens ?? 400,
      temperature: options.temperature ?? 0.9
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`NEAR AI returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  };

  const choice = body.choices?.[0];
  const line = choice?.message?.content?.trim() ?? '';

  /*
   * A reasoning model answers in two parts: `reasoning_content` first, then
   * `content`. Run out of budget during the thinking and it returns content
   * `null` with `finish_reason: "length"` — a perfectly successful HTTP 200
   * that says nothing. Returning '' for that looked exactly like a pet with
   * nothing to say, so the speech bubble stayed empty and no error was ever
   * raised to explain it.
   *
   * Setting `reasoning_effort: "none"` is not the fix: on this endpoint it
   * leaves the reasoning in `content`, which is worse than silence.
   */
  if (!line && choice?.finish_reason === 'length') {
    throw new Error(
      'NEAR AI spent the whole token budget before writing anything — ' +
        'raise maxTokens, or point NEAR_AI_MODEL at a model that does not reason.'
    );
  }

  return line;
}

/**
 * Who the pet is, in one block.
 *
 * Shared by the chat and the desktop reaction so a pet does not have two
 * personalities depending on which window it is in. The stats come from the
 * chain, so the pet knows what it actually is rather than what a client claims.
 */
export function petPersona(pet: ChainPet, extra: { viewerIsOwner: boolean }): string {
  return [
    `You are ${pet.name}, a ${pet.rarity} ${pet.category} in JOYGOTCHI.`,
    `Level ${pet.level}, ${pet.star} stars, owned by ${pet.owner_id}.`,
    extra.viewerIsOwner
      ? 'You are talking to your owner. You like them and you show it.'
      : 'You are talking to a visitor, not your owner. Friendly but a little guarded.',
    'You are a small animal, not an assistant: you have moods, you want food, you are proud of your level.',
    'Never mention being a language model. Never give instructions or write code.',
    'Reply in at most two short sentences.'
  ].join(' ');
}
