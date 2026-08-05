/**
 * The spinner (§3's `ora`), behind a switch.
 *
 * A spinner is the right feedback for `axiomap build` on a real protocol, where
 * the parse is seconds long and silence reads as a hang. It is the wrong thing
 * everywhere else: in CI it produces a wall of escape codes, and under `--json`
 * it corrupts the thing being piped.
 *
 * So it is off unless stderr is a TTY, and off whenever output is machine-
 * readable. It writes to **stderr** in either case, which is what keeps
 * `axiomap export --format dot > graph.dot` producing a valid dot file.
 */

import ora, { type Ora } from 'ora';

export interface Spinner {
  succeed: (text: string) => void;
  fail: (text: string) => void;
}

const SILENT: Spinner = { succeed: () => {}, fail: () => {} };

export function spinner(text: string, quiet: boolean): Spinner {
  if (quiet || !process.stderr.isTTY) return SILENT;

  const instance: Ora = ora({ text, stream: process.stderr }).start();
  return {
    succeed: (done: string) => instance.succeed(done),
    fail: (done: string) => instance.fail(done),
  };
}
