import type { Intent } from '@joygotchi/pet';
import type { InstalledPet } from './types';

/**
 * Talking to a pet.
 *
 * The transcript is per pet and lives only for as long as the window does.
 * Keeping it would mean deciding what to do when the pet is sold, and a pet
 * that remembers conversations with its previous owner is a worse feature
 * than one that forgets.
 *
 * The model never holds a key and is never shown one. It answers in words;
 * anything that costs money is still a button somebody presses.
 */
export type Turn = { role: 'user' | 'assistant'; content: string };

/**
 * The one thing a pet is currently proposing, per pet.
 *
 * Kept beside the thread rather than inside it: a proposal is a live offer
 * with a button, and a transcript is a record of what was said. Asking
 * again replaces it, so there is never more than one button waiting.
 */
const offers = $state<Record<string, Intent | null>>({});

export const offerFor = (slug: string): Intent | null => offers[slug] ?? null;
export const clearOffer = (slug: string) => (offers[slug] = null);

const SITE = () =>
  localStorage.getItem('joygotchi:api') ?? 'https://joygotchi.vercel.app';

/** How much of the thread the server is told about. It keeps six. */
const SEND_LAST = 8;

const threads = $state<Record<string, Turn[]>>({});

export const threadFor = (slug: string): Turn[] => threads[slug] ?? [];

export function clearThread(slug: string) {
  threads[slug] = [];
}

/**
 * Send one message and append the reply.
 *
 * Both turns go into the thread before the request returns, so the window
 * shows what was said while the pet is thinking. A failure replaces the
 * pending reply rather than leaving a gap, because a message that vanishes
 * reads as the app dropping it.
 */
export async function say(pet: InstalledPet, text: string, viewer?: string): Promise<void> {
  const message = text.trim().slice(0, 280);
  if (!message) return;

  const slug = pet.slug;
  const history = threadFor(slug).slice(-SEND_LAST);
  threads[slug] = [...history, { role: 'user', content: message }];

  try {
    const response = await fetch(`${SITE()}/api/ai/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ petId: pet.petId, message, viewer, history })
    });

    const body = (await response.json().catch(() => null)) as
      | { reply?: string; error?: string; intent?: Intent | null }
      | null;

    // Typed already, by the endpoint. Nothing here reads the pet's words for
    // meaning — they are only ever shown.
    offers[slug] = body?.intent ?? null;

    const reply =
      body?.reply?.trim() ||
      (body?.error
        ? `(${body.error})`
        : '(no answer — the gallery may be unreachable from here)');

    threads[slug] = [...threads[slug], { role: 'assistant', content: reply }];
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    threads[slug] = [...threads[slug], { role: 'assistant', content: `(${why})` }];
  }
}
