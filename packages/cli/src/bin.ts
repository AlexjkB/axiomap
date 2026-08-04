#!/usr/bin/env node
/**
 * The entry point.
 *
 * A hand-rolled switch rather than `commander`, because Phase 5 has exactly one
 * command and §7 gives the whole command surface to Phase 6. Wiring an argument
 * framework around a single subcommand now would be a Phase 6 decision made
 * early and with one data point.
 */

import { describe, runDiff, USAGE } from './index.js';

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === 'diff') {
    const json = rest.includes('--json');
    const positional = rest.filter((arg) => !arg.startsWith('-'));
    const [refA, refB, target] = positional;
    if (refA === undefined || refB === undefined) {
      process.stderr.write(`axiomap diff needs two revisions.\n\n${USAGE}`);
      return 2;
    }
    const result = await runDiff(refA, refB, {
      json,
      ...(target === undefined ? {} : { target }),
    });
    process.stdout.write(result.text);
    return result.exitCode;
  }

  process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n${describe()}\n`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
