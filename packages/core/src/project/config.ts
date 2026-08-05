/**
 * `axiomap.config.json` (§13).
 *
 * Nothing read this file until now. Phases 4 and 5 both plumbed their knobs
 * through and both left a note saying Phase 6 owns loading it, because Phase 6
 * is the one that owns a command line and the knobs are useless without one.
 *
 * Every field is optional and every default is the behaviour of the phase that
 * introduced it, so a project with no config file behaves exactly as it did
 * before this file existed. That is the property the golden fixtures rely on:
 * none of them has a config, and none of their graphs may move because this
 * loader now exists.
 *
 * ### An unknown key is a warning, not an error
 *
 * A config that fails closed on a typo is a config that fails on the day
 * somebody opens a v2 project with a v1 binary. Unknown keys are reported and
 * ignored — the user hears about `accessControlModifers` rather than silently
 * auditing a protocol with the wrong guard list, which is the actual failure to
 * prevent.
 *
 * ### In a diff, one config governs both revisions (§13)
 *
 * Decided in Phase 5 and implemented here: the invoking working tree's config
 * is loaded once and passed to both sides. `accessControlModifiers` feeds the
 * Phase 4 passes and `accessControl` is an attribute the diff compares, so
 * reading each checkout's own config would make a revision that renamed its
 * guard modifier *in this file* report an access-control regression on every
 * function that used it. The question `axiomap diff` answers is what changed in
 * the protocol.
 */

import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

export const CONFIG_FILE = 'axiomap.config.json';

/**
 * §13 verbatim. `renderCap` and `layout` are read, validated and carried but
 * not consumed: they belong to the renderer, which is Phase 7. Loading them now
 * means a user's config does not start failing validation the day the webview
 * lands.
 */
export const axiomapConfigSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  entrypoints: z.array(z.string()).optional(),
  accessControlModifiers: z.array(z.string()).optional(),
  reentrancyGuards: z.array(z.string()).optional(),
  trustBoundaries: z.object({ external: z.array(z.string()).optional() }).optional(),
  renderCap: z.number().int().positive().optional(),
  layout: z.string().optional(),
});

export type AxiomapConfig = z.infer<typeof axiomapConfigSchema>;

export interface LoadedConfig {
  config: AxiomapConfig;
  /** Absolute path it came from, or null when there is no config file. */
  file: string | null;
  /** Unknown keys and other survivable complaints. */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const KNOWN_KEYS = new Set(Object.keys(axiomapConfigSchema.shape));

export function parseConfig(text: string, source: string): { config: AxiomapConfig; warnings: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${source} must contain a JSON object (see AXIOMAP.md §13).`);
  }

  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(
        `${source}: unknown key "${key}", ignored. Known keys: ${[...KNOWN_KEYS].sort().join(', ')}.`,
      );
    }
  }

  const result = axiomapConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new ConfigError(
      `${source} is not a valid Axiomap config` +
        (issue === undefined ? '' : ` at ${issue.path.join('.') || '<root>'}: ${issue.message}`),
    );
  }

  return { config: result.data, warnings };
}

/**
 * Load `<root>/axiomap.config.json`, or the file named explicitly.
 *
 * An absent file at the default location is not an error — §13 says every field
 * is optional, and by extension so is the file. An explicitly named file that
 * is absent *is* an error: the user asked for it by name.
 */
export function loadConfig(root: string, explicit?: string): LoadedConfig {
  if (explicit !== undefined) {
    const file = path.resolve(explicit);
    if (!fs.existsSync(file)) {
      throw new ConfigError(`No config file at ${file}.`);
    }
    const { config, warnings } = parseConfig(fs.readFileSync(file, 'utf8'), file);
    return { config, file, warnings };
  }

  const file = path.join(path.resolve(root), CONFIG_FILE);
  if (!fs.existsSync(file)) return { config: {}, file: null, warnings: [] };
  const { config, warnings } = parseConfig(fs.readFileSync(file, 'utf8'), file);
  return { config, file, warnings };
}
