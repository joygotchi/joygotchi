import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Every view in the panel is a `showSomething` flag. A flag with nothing that
 * sets it true is a screen nobody can open — the code is there, it compiles,
 * it type-checks, and it is dead.
 *
 * This has happened twice in one day. The credit shop lost its tile when Feed
 * and Revive were collapsed into one, and the whole battle feature was
 * unreachable for a different reason entirely. Neither broke a test, because
 * nothing tested that a screen can be reached.
 */
const source = (name: string) =>
  readFileSync(join(import.meta.dirname, name), 'utf8');

describe('every view can be opened', () => {
  it('has something that sets each panel flag true', () => {
    const panel = source('PetPanel.svelte');

    const flags = [...panel.matchAll(/let (show[A-Z]\w*) = \$state\(false\)/g)].map(
      (match) => match[1]!
    );
    expect(flags.length).toBeGreaterThan(3);

    const orphans = flags.filter((flag) => !panel.includes(`${flag} = true`));
    expect(orphans, 'views with no way in').toEqual([]);
  });

  it('closes every one of them too', () => {
    // The other half: a screen you cannot leave is a window you have to kill.
    const panel = source('PetPanel.svelte');
    const flags = [...panel.matchAll(/let (show[A-Z]\w*) = \$state\(false\)/g)].map(
      (match) => match[1]!
    );

    const trapped = flags.filter((flag) => !panel.includes(`${flag} = false`));
    expect(trapped, 'views with no way out').toEqual([]);
  });
});
