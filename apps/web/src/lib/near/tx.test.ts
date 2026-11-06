import { describe, expect, it } from 'vitest';
import { ReceiptFailedError, assertReceiptsSucceeded, txEvents, txLogs } from './tx';
import type { TxOutcome } from './wallet.svelte';

const panic = (message: string) => ({
  Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: message } } } }
});

const outcome = (parts: Partial<TxOutcome>): TxOutcome =>
  ({
    transaction: { hash: 'HASH', signer_id: 'alice.testnet', receiver_id: 'game.testnet' },
    status: { SuccessValue: '' },
    ...parts
  }) as TxOutcome;

describe('assertReceiptsSucceeded', () => {
  // The reason this exists: a NEAR transaction reports success as soon as its
  // first receipt is accepted, so a check living in a cross-contract callback
  // fails invisibly. Staking somebody else's pet used to come back clean.
  it('throws on a failed receipt under a successful transaction', () => {
    const tx = outcome({
      status: { SuccessValue: 'dHJ1ZQ==' },
      receipts_outcome: [
        { outcome: { logs: [], status: { SuccessValue: '' } } },
        { outcome: { logs: [], status: panic('Smart contract panicked: Pet is already staked') } }
      ]
    });

    expect(() => assertReceiptsSucceeded(tx)).toThrow(ReceiptFailedError);
    expect(() => assertReceiptsSucceeded(tx)).toThrow('Pet is already staked');
  });

  it('keeps what the contract said and drops the boilerplate', () => {
    try {
      assertReceiptsSucceeded(outcome({ status: panic('Smart contract panicked: Attach 1 yoctoNEAR') }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ReceiptFailedError).message).toBe('Attach 1 yoctoNEAR');
      expect((error as ReceiptFailedError).txHash).toBe('HASH');
    }
  });

  it('names the kind when the failure is not a panic', () => {
    const tx = outcome({ status: { Failure: { ActionError: { kind: { AccountDoesNotExist: {} } } } } });
    expect(() => assertReceiptsSucceeded(tx)).toThrow('AccountDoesNotExist');
  });

  it('passes a transaction that really did succeed', () => {
    const ok = outcome({
      receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{}'], status: { SuccessValue: '' } } }]
    });
    expect(assertReceiptsSucceeded(ok)).toBe(ok);
    expect(assertReceiptsSucceeded(outcome({}))).toBeTruthy();
  });
});

describe('txEvents', () => {
  const minted = outcome({
    receipts_outcome: [
      { outcome: { logs: ['not an event'], status: { SuccessValue: '' } } },
      {
        outcome: {
          logs: [
            'EVENT_JSON:{"standard":"joygotchi","event":"pet_minted","data":[{"pet_id":7}]}',
            'EVENT_JSON:{ broken'
          ],
          status: { SuccessValue: '' }
        }
      }
    ]
  });

  it('reads the pet id out of the contract rather than guessing it', () => {
    // Two people minting in the same block would guess the same wrong number
    // from the supply, so the id has to come from the event.
    const events = txEvents(minted);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('pet_minted');
    expect((events[0]?.data[0] as { pet_id: number }).pet_id).toBe(7);
  });

  it('ignores a malformed event line instead of failing the mint', () => {
    expect(() => txEvents(minted)).not.toThrow();
  });

  it('collects logs across every receipt', () => {
    expect(txLogs(minted)).toHaveLength(3);
    expect(txEvents(outcome({}))).toEqual([]);
  });
});
