/**
 * Solidity syntax highlighting for §11's inline code preview.
 *
 * §3 names `shiki` with the Solidity grammar, and three things about how it is
 * wired here are decisions rather than defaults.
 *
 * ### The theme is built from the host's palette, not chosen
 *
 * A shiki theme is by construction a list of hex values, which is the one thing
 * §11 forbids: "palette derives entirely from VS Code CSS variables, no
 * hard-coded hex". So the theme is *constructed* from a resolved `Palette` — the
 * same trick `style.ts` already plays for cytoscape, and for the same reason:
 * neither shiki nor cytoscape can parse `var(--x)`, so the resolution happens
 * once, on this side. Set a host's variables and the preview re-themes with the
 * graph.
 *
 * The seven colours are `--vscode-symbolIcon-*Foreground` rather than the
 * `--vscode-charts-*` the graph draws with, because they are the roles this
 * panel actually has (keyword, type, function, string, number) and VS Code
 * publishes them for exactly that. A keyword coloured "chart blue" would be a
 * graph hue leaking into a code panel and would collide with the meaning §11's
 * channel budget gives that hue.
 *
 * ### Tokens, not HTML
 *
 * `codeToHtml` would be one line and a `dangerouslySetInnerHTML`. This renders
 * `codeToTokens` into React elements instead. shiki escapes its output and the
 * innerHTML route would very likely be safe — but the string being injected is
 * *the user's client's source code*, arriving over a bridge, and "very likely
 * safe" is not the standard this project holds itself to elsewhere. Tokens also
 * give the gutter and the focus range somewhere to attach.
 *
 * ### The engine is JavaScript, and there is no wasm
 *
 * shiki's default engine is oniguruma compiled to WebAssembly, which means a
 * `.wasm` asset to locate at runtime — and the ways that goes wrong (a CDN
 * fallback, a fetch for a missing file) are outbound requests, which decision #2
 * forbids outright. The JavaScript engine has no asset and no fetch. `forgiving`
 * is on because a grammar the JS engine cannot fully translate should degrade
 * to plainer highlighting rather than throw in a panel.
 */

import type { ThemeRegistrationRaw, ThemedToken } from 'shiki/core';

import type { Palette } from './style.js';

/** One line of highlighted code: the tokens, in order. */
export type HighlightedLine = readonly ThemedToken[];

export interface Highlighter {
  /** `code` → one array of tokens per line. */
  lines(code: string): HighlightedLine[];
}

/**
 * The Solidity grammar's scopes, mapped onto the seven roles the palette has.
 *
 * Read off the grammar rather than guessed: the scope names below are the ones
 * `@shikijs/langs/solidity` actually emits for a contract with a modifier, an
 * event, an error, an assembly block and a NatSpec comment. A scope that is not
 * listed inherits `editor.foreground`, which is the right default — an
 * unrecognised construct should look like plain code, not like nothing.
 */
type TokenColors = NonNullable<ThemeRegistrationRaw['tokenColors']>;

function tokenColors(palette: Palette): TokenColors {
  return [
    { scope: ['comment', 'comment.line', 'comment.block', 'comment.block.documentation'], settings: { foreground: palette.syntaxComment } },
    // NatSpec tags (`@notice`, `@dev`) sit inside a documentation comment and
    // are given the comment colour deliberately: they are the comment.
    { scope: ['storage.type.dev.natspec'], settings: { foreground: palette.syntaxComment } },
    {
      scope: [
        'keyword',
        'keyword.control',
        'keyword.control.flow',
        'keyword.control.exceptions',
        'keyword.control.assembly',
        'keyword.operator',
        'storage.type.contract',
        'storage.type.function',
        'storage.type.event',
        'storage.type.error',
        'storage.type.mapping',
        'storage.type.assembly',
        'storage.modifier',
        'storage.modifier.is',
        'storage.type.modifier.access',
        'storage.type.modifier.payable',
        'storage.type.modifier.readonly',
        'storage.type.modifier.indexed',
        'storage.type.modifier.extendedscope',
      ],
      settings: { foreground: palette.syntaxKeyword },
    },
    {
      scope: ['support.type.primitive', 'entity.name.type', 'entity.name.type.contract', 'entity.name.type.contract.extend'],
      settings: { foreground: palette.syntaxType },
    },
    {
      scope: [
        'entity.name.function',
        'entity.name.function.modifier',
        'entity.name.type.event',
        'entity.name.type.error',
        'storage.type.function.modifier',
        'support.function',
      ],
      settings: { foreground: palette.syntaxFunction },
    },
    { scope: ['string', 'string.quoted.double', 'string.quoted.single'], settings: { foreground: palette.syntaxString } },
    { scope: ['constant.numeric', 'constant.numeric.decimal', 'constant.numeric.hex', 'constant.language'], settings: { foreground: palette.syntaxNumber } },
    {
      scope: ['variable.parameter', 'variable.parameter.other', 'variable.parameter.event', 'variable.language', 'variable.language.transaction'],
      settings: { foreground: palette.syntaxVariable },
    },
  ];
}

export const THEME_NAME = 'axiomap';

export function themeFrom(palette: Palette): ThemeRegistrationRaw {
  return {
    name: THEME_NAME,
    // shiki uses this only to pick a default when a token has no rule; the
    // colours below are the host's either way.
    type: 'dark',
    colors: {
      'editor.background': palette.panel,
      'editor.foreground': palette.foreground,
    },
    /*
     * `settings` and `tokenColors` are the *same field* — `settings` is the
     * legacy spelling and shiki prefers it when both are present. Supplying
     * both (a rule list under `tokenColors`, an empty `settings` to satisfy the
     * type) is not a redundancy: the empty one wins and every token comes back
     * with the default colour. Nothing throws, nothing warns, and the panel
     * renders monochrome code that looks like a styling choice.
     *
     * The first entry has no `scope`, which is TextMate's spelling for the
     * default — a construct the grammar does not recognise then looks like
     * plain code rather than like nothing.
     */
    settings: [{ settings: { foreground: palette.foreground } }, ...tokenColors(palette)],
  };
}

/**
 * Build a highlighter for one palette.
 *
 * Asynchronous because the import is dynamic, and the import is dynamic because
 * the grammar and the regex engine are a few hundred kilobytes that a user who
 * never opens the inspector should not have paid for on first paint. Vite emits
 * them as their own chunk, which is the same argument §9 rule 6 makes for
 * keeping ELK off the critical path — one is about blocking, this one is about
 * download, and the mechanism is the same.
 */
export async function createSolidityHighlighter(palette: Palette): Promise<Highlighter> {
  const [{ createHighlighterCoreSync }, { createJavaScriptRegexEngine }, solidity] =
    await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs/solidity.mjs'),
    ]);

  const theme = themeFrom(palette);
  const highlighter = createHighlighterCoreSync({
    themes: [theme],
    langs: [solidity.default],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });

  return {
    lines: (code) => highlighter.codeToTokensBase(code, { lang: 'solidity', theme: THEME_NAME }),
  };
}

/**
 * The highlighter for a palette, built once.
 *
 * Keyed by the colours rather than by identity: `readDocumentPalette` returns a
 * fresh object per call, and rebuilding a grammar per render would be the kind
 * of quiet cost that only shows up on a slow machine.
 */
const cache = new Map<string, Promise<Highlighter>>();

export function solidityHighlighter(palette: Palette): Promise<Highlighter> {
  const key = [
    palette.syntaxComment,
    palette.syntaxKeyword,
    palette.syntaxType,
    palette.syntaxFunction,
    palette.syntaxString,
    palette.syntaxNumber,
    palette.syntaxVariable,
    palette.foreground,
  ].join('|');
  let pending = cache.get(key);
  if (pending === undefined) {
    pending = createSolidityHighlighter(palette);
    cache.set(key, pending);
  }
  return pending;
}
