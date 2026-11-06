#!/usr/bin/env node
import { InvalidInstallCodeError } from '@joygotchi/pet';
import { run } from './cli.js';
import { PetNotFoundError } from './install.js';

/**
 * The binary, and nothing else.
 *
 * `cli.ts` holds the commands so importing them does not run them — the tests
 * import `parseArgs`, and a module that calls `process.exit` on import takes
 * the test runner with it.
 */
run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    // The two failures a person will actually hit get a sentence they can act
    // on; anything else is a bug and prints as one.
    if (error instanceof InvalidInstallCodeError) {
      console.error(`That is not a valid install code: ${error.message}`);
    } else if (error instanceof PetNotFoundError) {
      console.error(error.message);
    } else {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    }
    process.exit(1);
  });
