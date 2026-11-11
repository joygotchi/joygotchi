import { describe, expect, it } from 'vitest';
import { artPathFor } from './art';

/*
 * The pet's drawing changes with its evolution phase, and the phase lives on
 * chain while the installed package is written once and never again. So the
 * window drew the animal the pet used to be, and pressing Evolve looked like
 * it did nothing at all — the transaction had landed, the sprite had not.
 *
 * These pin the resolution the fix depends on: a different phase is a
 * different filename, which is how the stale copy is spotted.
 */
describe('artPathFor', () => {
  it('gives a different file for each phase', () => {
    const paths = [1, 2, 3].map((p) =>
      artPathFor({ kind: 'greendragon', evolution_phase: p })
    );
    expect(new Set(paths).size).toBe(3);
  });

  it('names the phase in the file, so a stale package is comparable', () => {
    // The installed package stores `greendragon/1.gif`; the chain saying 2
    // has to produce something that does not end with it.
    const installed = 'greendragon/1.gif';
    const wanted = artPathFor({ kind: 'greendragon', evolution_phase: 2 });

    expect(wanted.endsWith(installed)).toBe(false);
    expect(artPathFor({ kind: 'greendragon', evolution_phase: 1 }).endsWith(installed)).toBe(true);
  });

  it('caps at the last drawing there is', () => {
    // Four phases on the contract, three sprites per kind.
    expect(artPathFor({ kind: 'greendragon', evolution_phase: 4 })).toBe(
      artPathFor({ kind: 'greendragon', evolution_phase: 3 })
    );
  });

  it('falls back rather than drawing nothing', () => {
    expect(artPathFor({})).toContain('blackdragon');
    expect(artPathFor({ kind: 'greendragon' })).toContain('greendragon/1');
  });
});
