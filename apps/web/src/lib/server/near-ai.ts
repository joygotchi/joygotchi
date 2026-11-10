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
/**
 * How hungry the pet actually is, from its own starvation deadline.
 *
 * `starves_at` is an absolute time in nanoseconds, not a countdown, so this
 * has to be compared against now rather than treated as a duration.
 */
function hungerOf(pet: ChainPet): string {
  const deadline = Number(pet.starves_at ?? 0);
  if (!deadline) return 'You have eaten recently and you are content.';

  const secondsLeft = (deadline - Date.now() * 1e6) / 1e9;
  if (secondsLeft <= 0) return 'You have starved. You are weak and you want somebody to notice.';
  if (secondsLeft < 60 * 60) return 'You are famished and it is all you can think about.';
  if (secondsLeft < 6 * 60 * 60) return 'You are getting peckish.';
  return 'You are well fed and content; food is not on your mind.';
}

/** The same facts as `hungerOf`, told about the pet rather than to it. */
function hungerFact(pet: ChainPet): string {
  const deadline = Number(pet.starves_at ?? 0);
  if (!deadline) return 'It has eaten recently and is content.';

  const secondsLeft = (deadline - Date.now() * 1e6) / 1e9;
  if (secondsLeft <= 0) return 'It has starved and is weak.';
  if (secondsLeft < 60 * 60) return 'It is famished — food is all it can think about.';
  if (secondsLeft < 6 * 60 * 60) return 'It is getting peckish.';
  return 'It is well fed; this food adds little it needs.';
}

/**
 * The system prompt for grading a meal, which is deliberately not a pet.
 *
 * Grading used to run through `petPersona`, which asked the beneficiary — a
 * persona explicitly told "You like them and you show it" — how good its
 * owner's gift was. Across 24 samples at temperature 0.8 it answered the
 * maximum 36 every single time. A scale that only ever returns its ceiling
 * is not a scale, and a model call that always returns the same number is a
 * constant with a latency cost.
 *
 * So the grader is a third party. It never speaks to the owner, it gets the
 * pet's state as fact rather than as a role to play, and it is told where the
 * middle of the range is. The anchors are the part that matters: left alone,
 * "a number from 1 to 36" reads as an invitation to say 36.
 */
export function mealGrader(pet: ChainPet): string {
  return [
    'You grade bowls of pet food in a game. You are not the pet and you never',
    'speak to its owner.',
    `The pet is ${pet.name}, a ${pet.rarity} ${pet.category}, level ${pet.level},`,
    `${pet.star} stars.`,
    hungerFact(pet),
    'Grade how much this meal was worth to this pet, as one whole number from',
    '1 to 36. Most meals are ordinary: answer between 12 and 20. Go above 28',
    'only when the pet was famished or had starved. Go below 8 when it was',
    'already well fed. Vary your answers rather than settling on a favourite.',
    'Reply with the number and nothing else.'
  ].join(' ');
}

export function petPersona(pet: ChainPet, extra: { viewerIsOwner: boolean }): string {
  return [
    `You are ${pet.name}, a ${pet.rarity} ${pet.category} in JOYGOTCHI.`,
    `Level ${pet.level}, ${pet.star} stars, owned by ${pet.owner_id}.`,
    extra.viewerIsOwner
      ? 'You are talking to your owner. You like them and you show it.'
      : 'You are talking to a visitor, not your owner. Friendly but a little guarded.',
    'You are a small animal, not an assistant: you have moods and you are proud of your level.',
    // Hunger came out of this line as a fixed trait, so a pet answered "I am
    // very hungry" to having just been fed. It is a number on chain; read it.
    hungerOf(pet),
    'Never mention being a language model. Never give instructions or write code.',
    'Reply in at most two short sentences.'
  ].join(' ');
}
