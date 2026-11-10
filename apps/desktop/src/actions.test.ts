import { describe, expect, it, vi, beforeEach } from 'vitest';

/*
 * `signAndSend` reaches the chain and `reactToGame` touches module state that
 * wants a browser, so both are replaced. What is under test is the one thing
 * that was wrong: whether a refund in the logs is noticed.
 */
const signAndSend = vi.fn();
vi.mock('./wallet.svelte', () => ({
  signAndSend: (...args: unknown[]) => signAndSend(...args),
  reactToGame: () => {}
}));

const { feedPet, canAfford, RefundedError } = await import('./actions');

/** Enough of a stake account to afford a feed. */
const flush = { credit_balance: '5000000', pending_credits: '0' } as never;

const EVENT = (name: string) =>
  'EVENT_JSON:' + JSON.stringify({ standard: 'joygotchi', event: name, data: [{ pet_id: 6 }] });

beforeEach(() => signAndSend.mockReset());

describe('feedPet', () => {
  it('reports a refund as a failure, not as a feed', async () => {
    // The shape that caused the bug: the transaction succeeds, the credits
    // come back, and nothing throws.
    signAndSend.mockResolvedValue({
      hash: 'TX',
      logs: ['This pet has starved — it needs a revival item', EVENT('feed_refunded')]
    });

    await expect(feedPet('testnet', 6, flush)).rejects.toThrow(RefundedError);
    await expect(feedPet('testnet', 6, flush)).rejects.toThrow(/starved/);
  });

  it('prefers the contract’s own sentence over a generic one', async () => {
    signAndSend.mockResolvedValue({
      hash: 'TX',
      logs: ['That pet belongs to someone else', EVENT('feed_refunded')]
    });

    await expect(feedPet('testnet', 6, flush)).rejects.toThrow(/belongs to someone else/);
  });

  it('still fails when the contract refunded without saying why', async () => {
    signAndSend.mockResolvedValue({ hash: 'TX', logs: [EVENT('feed_refunded')] });

    await expect(feedPet('testnet', 6, flush)).rejects.toThrow(/refunded/);
  });

  it('succeeds on a real feed', async () => {
    signAndSend.mockResolvedValue({ hash: 'TX', logs: [EVENT('pet_fed')] });

    await expect(feedPet('testnet', 6, flush)).resolves.toBeUndefined();
  });

  it('does not mistake another action’s refund for its own', async () => {
    // `auto_feed_refunded` contains the word, and it is a different call.
    signAndSend.mockResolvedValue({
      hash: 'TX',
      logs: ['This pet has starved — it needs a revival item', EVENT('auto_feed_refunded')]
    });

    await expect(feedPet('testnet', 6, flush)).resolves.toBeUndefined();
  });

  it('claims first when the balance alone will not cover the feed', async () => {
    signAndSend.mockResolvedValue({ hash: 'TX', logs: [EVENT('pet_fed')] });

    await feedPet('testnet', 6, { credit_balance: '0', pending_credits: '5000000' } as never);

    expect(signAndSend.mock.calls.map((c) => c[1])).toEqual(['claim_credits', 'feed_pet']);
  });

  it('refuses before signing when there are no credits at all', async () => {
    await expect(
      feedPet('testnet', 6, { credit_balance: '0', pending_credits: '0' } as never)
    ).rejects.toThrow(/not enough/);
    expect(signAndSend).not.toHaveBeenCalled();
  });
});

describe('canAfford', () => {
  it('counts claimable credits, because the claim happens on the way', () => {
    expect(canAfford({ credit_balance: '0', pending_credits: '5000000' } as never)).toBe(true);
    expect(canAfford({ credit_balance: '0', pending_credits: '0' } as never)).toBe(false);
    expect(canAfford(null)).toBe(false);
  });
});
