import { ACTION_PRICE, formatCredits, toMicroCredits, type StakeAccount } from '@joygotchi/pet';
import { reactToGame, signAndSend } from './wallet.svelte';

/**
 * Feed a pet, claiming first when the balance alone will not cover it.
 *
 * Shared, because there are two ways to feed now — the panel's tile and the
 * button on the name plate — and feeding is not one call. Earned credits sit
 * in `pending` until `claim_credits` moves them, and the contract only ever
 * spends the balance, so "not enough credits" while the window shows plenty
 * is a thing that happens unless this runs first. Two copies of that rule
 * would be one copy away from a quick-feed that fails for a reason nobody
 * can see.
 */
export async function feedPet(
  network: string,
  petId: number,
  account: StakeAccount | null
): Promise<void> {
  if (!canAfford(account)) {
    throw new Error(`Feeding costs ${ACTION_PRICE.ai_feed} credits, and there are not enough.`);
  }

  const balance = Number(account ? formatCredits(account.credit_balance, 6) : 0);
  const pending = Number(account ? formatCredits(account.pending_credits, 6) : 0);

  if (balance < ACTION_PRICE.ai_feed && pending > 0) {
    await signAndSend(network, 'claim_credits', {});
  }

  await signAndSend(network, 'spend_credits', {
    action: 'ai_feed',
    pet_id: petId,
    amount: toMicroCredits(ACTION_PRICE.ai_feed)
  });

  reactToGame('fed');
}

/**
 * Whether a feed can go through at all — balance and claimable together,
 * because the claim happens on the way.
 */
export function canAfford(account: StakeAccount | null): boolean {
  if (!account) return false;
  const balance = Number(formatCredits(account.credit_balance, 6));
  const pending = Number(formatCredits(account.pending_credits, 6));
  return balance + pending >= ACTION_PRICE.ai_feed;
}
