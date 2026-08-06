/**
 * Enough of the `vscode` module to test what this package decides.
 *
 * The editor's API is only available inside a running extension host, which is
 * why extension code is usually tested by launching an editor — a thing this
 * repo's CI does not have and §6's "exit criteria are tests, not vibes" still
 * has to hold without. So the modules that matter are written to keep the
 * `vscode` surface thin (`host.ts` and `session.ts` do not import it at all),
 * and `vitest.config.ts` aliases the module to this file for the ones that do.
 *
 * The rule for what goes in here: **only shapes, never behaviour**. A stub that
 * reimplemented `Range` semantics would be a second implementation of the
 * editor, and a test passing against it would say nothing. Everything below is a
 * data holder or a recorder.
 */

export class Position {
  constructor(
    readonly line: number,
    readonly character: number,
  ) {}
}

export class Range {
  constructor(
    readonly start: Position,
    readonly end: Position,
  ) {}
}

export class Selection extends Range {}

export class Uri {
  private constructor(readonly fsPath: string) {}

  static file(fsPath: string): Uri {
    return new Uri(fsPath);
  }

  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.fsPath, ...parts].join('/'));
  }

  get path(): string {
    return this.fsPath;
  }

  toString(): string {
    return `file://${this.fsPath}`;
  }
}

export const ViewColumn = { One: 1, Beside: -2 } as const;
export const ProgressLocation = { Notification: 15 } as const;
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 } as const;

export class EventEmitter<T> {
  readonly listeners: ((value: T) => void)[] = [];

  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        const at = this.listeners.indexOf(listener);
        if (at >= 0) this.listeners.splice(at, 1);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.length = 0;
  }
}

export class CodeLens {
  constructor(
    readonly range: Range,
    readonly command?: { title: string; command: string; arguments?: unknown[]; tooltip?: string },
  ) {}
}

/** What a test sets: the project root every relative path is taken against. */
export const state: { root: string } = { root: '' };

export const workspace = {
  asRelativePath(uri: Uri | string): string {
    const full = typeof uri === 'string' ? uri : uri.fsPath;
    const prefix = state.root.endsWith('/') ? state.root : `${state.root}/`;
    return full.startsWith(prefix) ? full.slice(prefix.length) : full;
  },
  textDocuments: [] as { uri: Uri; isDirty: boolean; getText: () => string }[],
  /** What a test sets; `getConfiguration` reads it. Shapes, as ever. */
  settings: {} as Record<string, unknown>,
  getConfiguration(): { get: (key: string) => unknown } {
    return { get: (key: string) => workspace.settings[key] };
  },
};

export const window = {
  activeTextEditor: undefined as unknown,
};

export const languages = {
  registerCodeLensProvider(): { dispose: () => void } {
    return { dispose: () => undefined };
  },
};

export const commands = {
  registerCommand(): { dispose: () => void } {
    return { dispose: () => undefined };
  },
};
