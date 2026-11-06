import { describe, expect, it } from 'vitest';
import { HOLD_MS, MOTION, nextReaction, visibleState } from './pet-state';
import { PET_STATES, type AgentEvent } from '@joygotchi/pet';

const at = 1_000_000;

describe('nextReaction', () => {
  it('shows a finish even while the pet is still "running"', () => {
    // A tool that ends is the event someone is actually waiting to see, so it
    // must not be held off by the long `running` hold.
    const running = nextReaction(null, { kind: 'tool-start', tool: 'Bash' }, at);
    const done = nextReaction(running, { kind: 'tool-end', tool: 'Bash', ok: true }, at + 500);

    expect(running.state).toBe('running');
    expect(done.state).toBe('waving');
  });

  it('extends rather than restarts when the same state repeats', () => {
    // Twenty reads in a row should look like one stretch of work, not twenty
    // twitches.
    const first = nextReaction(null, { kind: 'tool-start', tool: 'Read' }, at);
    const second = nextReaction(first, { kind: 'tool-start', tool: 'Grep' }, at + 1_000);

    expect(second.state).toBe('review');
    expect(second.until).toBe(at + 1_000 + HOLD_MS.review);
    expect(second.until).toBeGreaterThan(first.until);
  });

  it('never shortens a hold that is already running longer', () => {
    const long = { state: 'running' as const, until: at + 60_000 };
    const again = nextReaction(long, { kind: 'tool-start', tool: 'Bash' }, at);
    expect(again.until).toBe(at + 60_000);
  });

  it('shows a failure for longer than a success', () => {
    expect(HOLD_MS.failed).toBeGreaterThan(HOLD_MS.waving);
  });
});

describe('visibleState', () => {
  it('falls back to idle once the reaction has run out', () => {
    const reaction = nextReaction(null, { kind: 'tool-end', tool: 'Edit', ok: false }, at);

    expect(visibleState(reaction, at + 1)).toBe('failed');
    expect(visibleState(reaction, at + HOLD_MS.failed + 1)).toBe('idle');
  });

  it('is idle before anything has happened', () => {
    expect(visibleState(null, at)).toBe('idle');
  });

  it('does not strand the pet mid-stride on a long build', () => {
    // `running` holds for 30s, not forever: an agent that dies without sending
    // `tool-end` should still leave a pet that settles down.
    const running = nextReaction(null, { kind: 'tool-start', tool: 'Bash' }, at);
    expect(visibleState(running, at + 29_000)).toBe('running');
    expect(visibleState(running, at + 31_000)).toBe('idle');
  });
});

describe('the state table', () => {
  it('covers every state, so no event can land on an undefined animation', () => {
    for (const state of PET_STATES) {
      expect(MOTION[state], state).toBeTruthy();
      expect(HOLD_MS[state], state).toBeGreaterThanOrEqual(0);
    }
  });

  it('maps each kind of agent event to something with a hold', () => {
    const events: AgentEvent[] = [
      { kind: 'prompt' },
      { kind: 'tool-start', tool: 'Bash' },
      { kind: 'tool-start', tool: 'Read' },
      { kind: 'tool-end', tool: 'Bash', ok: true },
      { kind: 'tool-end', tool: 'Bash', ok: false },
      { kind: 'idle' }
    ];

    for (const event of events) {
      const reaction = nextReaction(null, event, at);
      expect(PET_STATES).toContain(reaction.state);
    }
  });
});
