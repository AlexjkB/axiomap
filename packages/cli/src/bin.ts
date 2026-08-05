#!/usr/bin/env node
/**
 * The executable.
 *
 * Everything real is in `program.ts`; this file exists to be the one place that
 * knows `process` exists, so that the whole command surface stays callable from
 * a test without spawning anything.
 */

import { run } from './program.js';

process.exitCode = await run(process.argv.slice(2), {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
