/**
 * Strip ANSI colour before asserting on output.
 *
 * `picocolors` disables itself when stdout is not a TTY, which under vitest
 * means these suites usually see plain text anyway — but "usually" is not a
 * thing to write assertions against, and a developer running the suite through
 * a TTY-preserving wrapper should not see it go red.
 *
 * The escape byte is built with `String.fromCharCode` rather than written as
 * `` in a regex literal, which keeps `no-control-regex` satisfied without
 * an inline disable that then has to be maintained.
 */

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function plain(text: string): string {
  return text.replace(ANSI, '');
}
