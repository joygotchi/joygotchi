import { describe, expect, it } from 'vitest';
import { artPathFor, hatAnchorFor } from './art';

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

describe('hatAnchorFor', () => {
  /*
   * A hat used to sit at one fixed spot in CSS, which fitted the phase-one
   * green dragon and nothing else. The head moves right and up with each
   * evolution, so evolving left the hat over a wing.
   */
  it('keeps the placement that was already right', () => {
    expect(hatAnchorFor({ kind: 'greendragon', evolution_phase: 1 })).toEqual({
      left: 50,
      top: 14
    });
  });

  it('moves the hat as the head moves', () => {
    const one = hatAnchorFor({ kind: 'greendragon', evolution_phase: 1 });
    const two = hatAnchorFor({ kind: 'greendragon', evolution_phase: 2 });

    expect(two.left).toBeGreaterThan(one.left);
    expect(two.top).toBeLessThan(one.top);
  });

  it('has a row for every drawing that exists', () => {
    for (const kind of ['greendragon', 'blackdragon']) {
      for (const phase of [1, 2, 3]) {
        const at = hatAnchorFor({ kind, evolution_phase: phase });
        expect(at.left, `${kind} ${phase}`).toBeGreaterThan(0);
        expect(at.top).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('falls back rather than dropping the hat at 0,0', () => {
    expect(hatAnchorFor({ kind: 'nosuchpet' })).toEqual({ left: 50, top: 14 });
    // Phase 4 wears phase 3's drawing, so it wears phase 3's placement.
    expect(hatAnchorFor({ kind: 'greendragon', evolution_phase: 4 })).toEqual(
      hatAnchorFor({ kind: 'greendragon', evolution_phase: 3 })
    );
  });
});
