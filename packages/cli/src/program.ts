/**
 * The command surface (§12), on `commander` (§3).
 *
 * Phase 5 shipped `axiomap diff` behind a hand-rolled switch, deliberately, so
 * that the argument framework would be a Phase 6 decision taken with the whole
 * surface visible rather than with one subcommand. This is that decision.
 *
 * Two conventions hold across every command, because §12 asks for both and a
 * surface where they hold only sometimes is worse than one where they never do:
 *
 * - **`--json` everywhere.** §12: "Table output by default, `--json` for
 *   piping. This makes Axiomap scriptable and CI-integrable, and gives it value
 *   to people who never open the GUI."
 * - **Output on stdout, everything else on stderr.** Spinners, warnings and
 *   errors go to stderr, so `axiomap export --format dot > graph.dot` and
 *   `axiomap query unresolved --json | jq` both produce clean input for the
 *   next program.
 *
 * Exit codes: 0 success or nothing found, 1 something found (`diff` saw a
 * change, a query returned rows), 2 the command could not run. §15's eighth
 * item is a CI gate built on the difference between 1 and 2.
 *
 * Writing and exiting go through the injected `Io` rather than `process`, so
 * the whole surface is exercisable in a test — `bin.ts` is the only file that
 * knows `process` exists.
 */

import { Command, CommanderError } from 'commander';

import {
  runBuild,
  runDiff,
  runExport,
  runImportFindings,
  runQuery,
  runReview,
  runStats,
  REVIEW_STATUSES,
} from './index.js';
import { colour } from './output.js';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

interface CommandResult {
  text: string;
  exitCode: number;
}

/**
 * The exit code a command produced, threaded out of commander's action
 * callbacks — which can only return `void` or a promise of it.
 */
interface Sink {
  code: number;
}

export function buildProgram(io: Io, sink: Sink): Command {
  const emit = (result: CommandResult): void => {
    io.out(result.text);
    sink.code = result.exitCode;
  };

  const integer = (name: string) => (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new CommanderError(2, 'axiomap.badNumber', `${name} must be a non-negative integer.`);
    }
    return parsed;
  };

  /** Options every command takes; §13's config file is one of them. */
  const common = (command: Command): Command =>
    command
      .option('-p, --path <dir>', 'project directory (default: the current directory)')
      .option(
        '-c, --config <file>',
        'explicit axiomap.config.json (default: <path>/axiomap.config.json)',
      )
      .option('--json', 'machine-readable output, for piping and CI')
      .option('--rebuild', 'rebuild the graph even if .axiomap/graph.json looks current')
      .option('--stale', 'use .axiomap/graph.json even when a source file is newer')
      .option('--no-enrich', 'skip the semantic tier: build the syntactic graph deliberately')
      .option('--workers <n>', 'parse worker threads', integer('--workers'));

  const program = new Command();

  program
    .name('axiomap')
    .description(
      'Graph-based navigation and comprehension for Solidity protocols.\n' +
        'Works on code that does not compile; says how certain it is.',
    )
    .version('0.0.0')
    .showHelpAfterError()
    .configureOutput({ writeOut: io.out, writeErr: io.err });

  common(
    program
      .command('build')
      .argument('[path]', 'project directory')
      .description('build the graph into .axiomap/graph.json and print the resolution score'),
  ).action(async (path: string | undefined, options: Record<string, unknown>) => {
    emit(await runBuild({ ...options, ...(path === undefined ? {} : { path }) }));
  });

  common(
    program
      .command('stats')
      .argument('[path]', 'project directory')
      .description('what this protocol is made of, and how much of it is certain'),
  ).action(async (path: string | undefined, options: Record<string, unknown>) => {
    emit(await runStats({ ...options, ...(path === undefined ? {} : { path }) }));
  });

  common(
    program
      .command('diff')
      .argument('<refA>', 'git revision or directory')
      .argument('<refB>', 'git revision or directory')
      .argument('[path]', 'project directory')
      .description('what changed between two revisions, and what needs re-review')
      .option('--update-review', 'carry .axiomap/review.json across renames and moves'),
  ).action(
    async (
      refA: string,
      refB: string,
      path: string | undefined,
      options: Record<string, unknown>,
    ) => {
      emit(await runDiff(refA, refB, { ...options, ...(path === undefined ? {} : { path }) }));
    },
  );

  common(
    program
      .command('query')
      .argument(
        '<subcommand>',
        'callers-of | callees-of | reachable-from | path | writers-of | readers-of | externals | unresolved | stale-reviews | findings',
      )
      .argument('[args...]', 'node or variable references')
      .description('ask the graph a question')
      .option('--depth <n>', 'hops for callers-of / callees-of (default: 1)', integer('--depth'))
      .option('--unprotected', 'externals: only those with no recognised access-control guard')
      .option('--payable', 'externals: only payable ones'),
  ).action(async (subcommand: string, args: string[], options: Record<string, unknown>) => {
    emit(await runQuery(subcommand, args, options));
  });

  common(
    program
      .command('export')
      .description('write a view as dot, mermaid or json')
      .option('-f, --format <format>', 'dot | mermaid | json', 'dot')
      .option(
        '-v, --view <view>',
        'protocol | contract | call | state-access | inheritance',
        'protocol',
      )
      .option('--focus <node>', 'root node; required by the contract and call views')
      .option('--up <n>', 'call view: upstream hops (default: 2)', integer('--up'))
      .option('--down <n>', 'call view: downstream hops (default: 3)', integer('--down'))
      .option('--include-tests', 'keep contracts flagged as tests or mocks')
      .option('-o, --out <file>', 'write here instead of stdout'),
  ).action(async (options: Record<string, unknown>) => {
    emit(await runExport(options));
  });

  common(
    program
      .command('review')
      .argument('[node]', 'node id, or any unambiguous suffix of one')
      .description('record or list audit review state in .axiomap/review.json')
      .option('-s, --status <status>', REVIEW_STATUSES.join(' | '))
      .option('--reviewer <name>', 'who reviewed it')
      .option('-m, --note <text>', 'what you checked')
      .option('--clear', "remove this node's review entry")
      .option('-l, --list', 'list every recorded review and whether it is still current'),
  ).action(async (node: string | undefined, options: Record<string, unknown>) => {
    emit(await runReview(node, options));
  });

  common(
    program
      .command('import-findings')
      .argument('<file>', 'output of `slither --json`')
      .description('map Slither findings onto graph nodes'),
  ).action(async (file: string, options: Record<string, unknown>) => {
    emit(await runImportFindings(file, options));
  });

  // §7 assigns `serve` to Phase 7, which is where the webview it serves gets
  // built. Registered anyway so that it says so, rather than reporting an
  // unknown command for something §12 documents.
  program
    .command('serve')
    .argument('[path]', 'project directory')
    .description('(Phase 7) build and open the UI in a browser')
    .action(() => {
      io.err(
        'axiomap serve arrives with the webview in Phase 7 (AXIOMAP.md §7).\n' +
          'Until then: axiomap export --format dot | dot -Tsvg > graph.svg\n',
      );
      sink.code = 2;
    });

  return program;
}

/** Parse and run one invocation. Returns the process exit code. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const sink: Sink = { code: 0 };
  const program = buildProgram(io, sink);
  program.exitOverride();

  try {
    await program.parseAsync([...argv], { from: 'user' });
    return sink.code;
  } catch (error) {
    // `--help` and `--version` throw here by design once `exitOverride` is on.
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? 0 : 2;
    }
    io.err(`${colour.red('error')} ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
