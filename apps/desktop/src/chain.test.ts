import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetReads, viewFunction } from './chain';

/**
 * The two things a public RPC made necessary, and the one thing that must not
 * happen: a contract's answer being retried as if it were a network blip.
 */

const ok = (value: unknown) => ({
  ok: true,
  json: async () => ({
    result: { result: Array.from(new TextEncoder().encode(JSON.stringify(value))) }
  })
});

const httpError = (status: number) => ({ ok: false, status, json: async () => ({}) });

const panic = (message: string) => ({
  ok: true,
  json: async () => ({ result: { result: [], error: message } })
});

function stubFetch(responses: unknown[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    calls.push(init.body);
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

afterEach(() => {
  forgetReads();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('viewFunction', () => {
  it('retries a rate limit and returns the answer', async () => {
    const { fetchMock } = stubFetch([httpError(429), ok({ pet_id: 6 })]);

    await expect(viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 })).resolves.toEqual({
      pet_id: 6
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('retries a network failure too', async () => {
    const { fetchMock } = stubFetch([new Error('fetch failed'), ok(1)]);

    await expect(viewFunction('testnet', 'c.testnet', 'nft_total_supply')).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does not retry a contract panic — that is an answer', async () => {
    // Asking a contract the same question again gets the same panic, and
    // three of them is just three times the wait before the error shows.
    const { fetchMock } = stubFetch([panic('Smart contract panicked: Pet is already staked')]);

    await expect(viewFunction('testnet', 'c.testnet', 'stake_pet')).rejects.toThrow(
      'already staked'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after three tries rather than hammering', async () => {
    const { fetchMock } = stubFetch([httpError(503), httpError(503), httpError(503)]);

    await expect(viewFunction('testnet', 'c.testnet', 'get_pool')).rejects.toThrow('503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it('serves one request to two callers asking the same thing', async () => {
    // The window polls every pet for the battle watcher and the panel wants
    // the same list for its targets, on separate timers.
    const { fetchMock } = stubFetch([ok({ pet_id: 6 })]);

    const [a, b] = await Promise.all([
      viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 }),
      viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 })
    ]);

    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps different arguments apart', async () => {
    const { fetchMock } = stubFetch([ok({ pet_id: 6 }), ok({ pet_id: 7 })]);

    await Promise.all([
      viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 }),
      viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 7 })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not serve a failure to the next caller', async () => {
    // A cached rejection would turn one blip into four seconds of them.
    const { fetchMock } = stubFetch([
      httpError(500),
      httpError(500),
      httpError(500),
      ok({ pet_id: 6 })
    ]);

    await expect(viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 })).rejects.toThrow();
    await expect(viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 })).resolves.toEqual({
      pet_id: 6
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  }, 10_000);

  it('asks a different node each time round', async () => {
    // Asking the one that just rate-limited you, three times, is not a retry.
    const { calls, fetchMock } = stubFetch([httpError(429), ok({ pet_id: 6 })]);
    const urls: string[] = [];

    await viewFunction('testnet', 'c.testnet', 'get_pet', { pet_id: 6 });
    for (const [url] of (fetchMock as unknown as { mock: { calls: [string][] } }).mock.calls) {
      urls.push(url);
    }

    expect(calls).toHaveLength(2);
    expect(new Set(urls).size).toBe(2);
  }, 10_000);

  it('forgets everything after something is signed', async () => {
    const { fetchMock } = stubFetch([ok({ credits: 1 }), ok({ credits: 2 })]);

    await viewFunction('testnet', 'c.testnet', 'get_account');
    forgetReads();
    await expect(viewFunction('testnet', 'c.testnet', 'get_account')).resolves.toEqual({
      credits: 2
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
