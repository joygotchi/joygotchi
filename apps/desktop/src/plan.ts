import {
  ACTION_PRICE,
  ITEMS,
  autoFeedBudgetFor,
  describeIntent,
  formatCredits,
  levelToEvolve,
  type Intent,
  type StakeAccount
} from '@joygotchi/pet';
import type { ChainPetSummary } from './chain';

/**
 * Turning a pet's proposal into something the app is willing to sign.
 *
 * Every number here is read from the chain or from the contract's own price
 * table. None of it comes from the model, which supplied one word. That is
 * the whole point of the split: the pet may say "feed me", and what feeding
 * costs, whether it is your pet, and whether it is even alive are all
 * answered by this file afterwards.
 *
 * A refusal is a result, not an error. The card says why rather than
 * greying out, because "Feed" with no explanation is the shape of bug this
 * project has produced four times.
 */
export type Plan =
  | { ok: true; label: string; cost: number; method: string }
  | { ok: false; label: string; why: string };

export type PlanContext = {
  pet: ChainPetSummary | null;
  account: StakeAccount | null;
  mine: boolean;
  petName: string;
  ownedPets: number;
  minesAt: number;
  signable: (method: string) => boolean;
};

const credits = (account: StakeAccount | null) =>
  account
    ? Number(formatCredits(account.credit_balance, 6)) +
      Number(formatCredits(account.pending_credits, 6))
    : 0;

export function planIntent(intent: Intent, ctx: PlanContext): Plan {
  const label = describeIntent(intent, ctx.petName);
  const no = (why: string): Plan => ({ ok: false, label, why });

  // Everything below acts on a pet or spends a balance, and both belong to
  // whoever is signed in.
  if (!ctx.mine) return no(`${ctx.petName} is not yours to act on`);

  const alive = Number(ctx.pet?.seconds_until_starving ?? 0) > 0;

  switch (intent.kind) {
    case 'feed': {
      if (!alive) return no(`${ctx.petName} has starved — it needs reviving first`);
      return need('feed_pet', ACTION_PRICE.feed);
    }
    case 'revive': {
      if (alive) return no(`${ctx.petName} is not starved`);
      return need('revive_pet', ACTION_PRICE.revive);
    }
    case 'evolve': {
      const phase = Number(ctx.pet?.evolution_phase ?? 1);
      const at = levelToEvolve(phase);
      if (at === null) return no(`${ctx.petName} is fully evolved`);
      if (Number(ctx.pet?.level ?? 0) < at) return no(`It needs level ${at} first`);
      return need('evolve_pet', ACTION_PRICE.evolve);
    }
    case 'claim': {
      const pending = ctx.account
        ? Number(formatCredits(ctx.account.pending_credits, 6))
        : 0;
      if (pending <= 0) return no('Nothing has been earned yet');
      return need('claim_credits', 0);
    }
    case 'mine': {
      if (ctx.minesAt > Date.now()) return no('Mining is still on cooldown');
      return need('claim_mining', 0);
    }
    case 'faucet':
      return need('claim_faucet', 0);
    case 'auto_feed': {
      const on = Number(ctx.account?.auto_feed_budget ?? 0) > 0;
      if (on === intent.on) return no(`Auto-feed is already ${on ? 'on' : 'off'}`);
      return need('set_auto_feed_budget', 0);
    }
    case 'buy_item':
      return need('buy_credit_item', priceOf(intent.itemId));
    case 'use_item':
      return need('use_item', 0);
  }

  function need(method: string, cost: number): Plan {
    if (!ctx.signable(method)) {
      return no('This session key predates that — reconnect in Settings');
    }
    if (cost > 0 && credits(ctx.account) < cost) {
      return no(`It costs ${cost} credits and there are not enough`);
    }
    return { ok: true, label, cost, method };
  }
}

/**
 * What the contract charges for an item.
 *
 * Mirrored from the seeded prices rather than taken from the model or the
 * link. The app also reads the live table for the shop; this is the fallback
 * for a card drawn before that read lands.
 */
function priceOf(itemId: number): number {
  const fallback: Record<number, number> = { 101: 0.01, 102: 0.05, 103: 0.02, 104: 0.015 };
  return fallback[itemId] ?? 0;
}

/** The budget an auto-feed intent should set, by how many pets you own. */
export const autoFeedBudget = (ownedPets: number) => autoFeedBudgetFor(ownedPets);

/** Only items the game sells can appear on a card. */
export const itemName = (id: number) => ITEMS[id as keyof typeof ITEMS]?.name ?? `Item ${id}`;
