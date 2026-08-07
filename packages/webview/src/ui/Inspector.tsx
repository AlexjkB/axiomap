/**
 * §11's inspector: "full attributes, callers, callees, all clickable".
 *
 * Everything it shows arrived through `HostBridge.inspect`, which is
 * `inspectNode` on the other side of the transport. That is not a stylistic
 * choice — §5 leaves this package unable to hold an `AxiomapGraph`, so there is
 * no expression it could write that answers "who calls this" locally, and Phase
 * 7b's note is explicit that the inspector must not grow a second
 * implementation of the query API.
 *
 * It deliberately does **not** read the drawn view for its relations. A view
 * carries only what it draws: a caller outside the hop limit, or inside a
 * collapsed directory, is not in it. An inspector built from the view would
 * quietly answer "the callers I happen to be showing you", which is a different
 * question from the one §11 asks and the more dangerous one to answer wrongly.
 *
 * The attributes are §10's, printed as they are. `accessControl: none` is
 * rendered as "no recognised guard" rather than "unguarded" for the reason §10
 * gives: these fields say what this tool found, not what is true.
 */

import type {
  FunctionNode,
  GraphNode,
  NodeInspection,
  NodeRelation,
  OverlayData,
  SourceSlice,
  StateVariableNode,
} from '@axiomap/core';

import { CodePreview } from './CodePreview.js';
import type { Palette } from './style.js';

export interface InspectorProps {
  /** The node being inspected, or null while nothing is selected. */
  inspection: NodeInspection | null;
  /** Set while a request is in flight, so a slow host does not read as empty. */
  busy: boolean;
  error: string | null;
  /** The host's audit-state files, for this node's review entry and findings. */
  overlays: OverlayData | null;
  /** §11's inline preview: the byte range the host cut around this node's `src`. */
  slice: SourceSlice | null;
  sliceBusy: boolean;
  sliceError: string | null;
  /** Resolved once by the app, so the preview's theme is the graph's (§11). */
  palette: Palette;
  /** Inspect another node without moving the graph. */
  onInspect: (id: string) => void;
  /** Re-root the graph on a node — §11's "focus here". */
  onFocus: (id: string, kind: string) => void;
  onClose: () => void;
}

function where(file: string, line: number, column: number): string {
  return `${file}:${String(line)}:${String(column)}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="ax-attr">
      <span className="ax-attr-key">{label}</span>
      <span className="ax-attr-value">{value}</span>
    </div>
  );
}

/** §11's fourth fact, unabridged here — the node label only had room for three. */
function flagList(node: FunctionNode): string {
  const on = Object.entries(node.flags)
    .filter(([, value]) => value)
    .map(([key]) => key.replace(/^has/, '').replace(/^[A-Z]/, (c) => c.toLowerCase()));
  return on.length === 0 ? 'none' : on.join(', ');
}

function FunctionAttributes({ node }: { node: FunctionNode }): JSX.Element {
  const guard =
    node.accessControl.confidence === 'high'
      ? `recognised modifier: ${node.accessControl.modifiers.join(', ')}`
      : node.accessControl.confidence === 'low'
        ? `evidence of an inline check${node.accessControl.modifiers.length === 0 ? '' : ` (${node.accessControl.modifiers.join(', ')})`}`
        : 'no recognised guard';

  return (
    <>
      <Row label="visibility" value={`${node.visibility} ${node.stateMutability}`} />
      <Row label="kind" value={node.subkind} />
      {node.selector === undefined ? null : <Row label="selector" value={<code>{node.selector}</code>} />}
      <Row
        label="modifiers"
        value={node.modifiers.length === 0 ? 'none' : node.modifiers.join(', ')}
      />
      <Row label="access control" value={`${node.accessControl.confidence} — ${guard}`} />
      <Row
        label="reentrancy"
        value={
          node.reentrancy.externalCallThenWrite
            ? `call-then-write shape, ${node.reentrancy.guarded ? 'guarded' : 'no recognised guard'}`
            : 'no call-then-write shape'
        }
      />
      <Row
        label="reachable"
        value={
          node.externallyReachable
            ? `yes — from ${String(node.entrypoints.length)} entrypoint${node.entrypoints.length === 1 ? '' : 's'}`
            : 'not from any entrypoint in this graph'
        }
      />
      <Row
        label="metrics"
        value={`${String(node.metrics.sloc)} sloc · cyclomatic ${String(node.metrics.cyclomatic)} · depth ${String(node.metrics.maxDepth)}`}
      />
      <Row label="flags" value={flagList(node)} />
      <Row label="body hash" value={<code>{node.bodyHash === '' ? 'no body' : node.bodyHash}</code>} />
    </>
  );
}

function StateVariableAttributes({ node }: { node: StateVariableNode }): JSX.Element {
  return (
    <>
      <Row label="type" value={<code>{node.type}</code>} />
      <Row label="visibility" value={node.visibility} />
      <Row
        label="qualifiers"
        value={
          [
            node.isConstant ? 'constant' : '',
            node.isImmutable ? 'immutable' : '',
            node.isTransient ? 'transient' : '',
            node.isMapping ? 'mapping' : '',
          ]
            .filter((part) => part !== '')
            .join(', ') || 'none'
        }
      />
      {/* Absent rather than null when the compiler reported no layout (§10). */}
      <Row label="slot" value={node.slot === undefined ? 'unknown — no artifacts' : node.slot} />
    </>
  );
}

/**
 * §16 (Phase 8c): `@inheritdoc` is stored verbatim in `natspec`, never
 * resolved by the parser — resolving which base it names is a UI concern,
 * and this is where it happens. The candidate is whatever this function's
 * `overrides`/`implements` edges already point at, so there is nothing left
 * to parse: the base a doc comment inherits from is exactly the relation the
 * resolver already drew. Fails visibly, per §6, rather than guessing — a
 * function that writes `@inheritdoc` without overriding or implementing
 * anything in this graph says so, instead of silently showing nothing.
 */
function NatSpec({
  node,
  outgoing,
  onInspect,
}: {
  node: GraphNode;
  outgoing: readonly NodeRelation[];
  onInspect: (id: string) => void;
}): JSX.Element | null {
  const text = 'natspec' in node ? node.natspec : undefined;
  if (text === undefined) return null;

  const hasInheritdoc = /@inheritdoc\b/.test(text);
  const bases = hasInheritdoc
    ? outgoing.filter((r) => r.edgeKind === 'overrides' || r.edgeKind === 'implements')
    : [];

  return (
    <section className="ax-inspect-section">
      <h3>NatSpec</h3>
      <pre className="ax-natspec">{text}</pre>
      {!hasInheritdoc ? null : bases.length === 0 ? (
        <p className="ax-empty">
          @inheritdoc found, but this function does not override or implement anything in this
          graph — nothing to resolve it against.
        </p>
      ) : (
        <ul className="ax-relations">
          {bases.map((relation) => (
            <li key={`inheritdoc:${relation.edgeKind}:${relation.id}`}>
              <button
                type="button"
                className="ax-relation"
                onClick={() => {
                  onInspect(relation.id);
                }}
              >
                <span className="ax-relation-name">{relation.name}</span>
                <span className="ax-relation-meta">@inheritdoc → {relation.edgeKind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function relationLabel(relation: NodeRelation): string {
  const parts: string[] = [relation.edgeKind];
  if (relation.subkind !== undefined) parts.push(relation.subkind);
  if (relation.count > 1) parts.push(`${String(relation.count)}×`);
  return parts.join(' ');
}

function Relations({
  title,
  empty,
  relations,
  onInspect,
  onFocus,
}: {
  title: string;
  empty: string;
  relations: readonly NodeRelation[];
  onInspect: (id: string) => void;
  onFocus: (id: string, kind: string) => void;
}): JSX.Element {
  return (
    <section className="ax-inspect-section">
      <h3>
        {title} <span className="ax-count">{relations.length}</span>
      </h3>
      {relations.length === 0 ? (
        <p className="ax-empty">{empty}</p>
      ) : (
        <ul className="ax-relations">
          {relations.map((relation) => (
            <li key={`${relation.edgeKind}:${relation.id}:${String(relation.virtual)}`}>
              <button
                type="button"
                className="ax-relation"
                title={`${relation.id}\n${where(relation.src.file, relation.src.line, relation.src.column)}`}
                onClick={() => {
                  onInspect(relation.id);
                }}
              >
                <span className="ax-relation-name">{relation.name}</span>
                <span className="ax-relation-meta">
                  {relationLabel(relation)}
                  {/* §10: a fanned-out arm is a possible target, never a certain
                      one, and an auditor is entitled to know which they read. */}
                  {relation.virtual ? ' · possible' : ''}
                  {relation.crossTrustBoundary ? ' · cross-trust' : ''}
                  {` · ${relation.resolution}`}
                </span>
              </button>
              <button
                type="button"
                className="ax-chip"
                title="Focus the graph here (§11)"
                onClick={() => {
                  onFocus(relation.id, relation.kind);
                }}
              >
                focus
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Inspector({
  inspection,
  busy,
  error,
  overlays,
  slice,
  sliceBusy,
  sliceError,
  palette,
  onInspect,
  onFocus,
  onClose,
}: InspectorProps): JSX.Element {
  if (error !== null) {
    return (
      <aside className="ax-inspector">
        <header className="ax-inspect-head">
          <strong>Inspector</strong>
          <button type="button" className="ax-chip" onClick={onClose}>
            close
          </button>
        </header>
        <p className="ax-inspect-error">{error}</p>
      </aside>
    );
  }

  if (inspection === null) {
    return (
      <aside className="ax-inspector">
        <header className="ax-inspect-head">
          <strong>Inspector</strong>
          <button type="button" className="ax-chip" onClick={onClose}>
            close
          </button>
        </header>
        <p className="ax-empty">{busy ? 'loading…' : 'Click a node to inspect it.'}</p>
      </aside>
    );
  }

  const node = inspection.node;
  const review = overlays?.review[node.id];
  const findings = overlays?.findings[node.id] ?? [];

  return (
    <aside className="ax-inspector">
      <header className="ax-inspect-head">
        <div className="ax-inspect-title">
          <code className="ax-inspect-name">{node.name}</code>
          <span className="ax-inspect-kind">{node.kind}</span>
        </div>
        <button type="button" className="ax-chip" onClick={onClose}>
          close
        </button>
      </header>

      <div className="ax-inspect-body">
        <section className="ax-inspect-section">
          <div className="ax-attrs">
            <Row label="id" value={<code className="ax-wrap">{node.id}</code>} />
            <Row label="source" value={<code>{where(node.file, node.src.line, node.src.column)}</code>} />
            {inspection.scope === null ? null : (
              <Row
                label="scope"
                value={
                  <button
                    type="button"
                    className="ax-link"
                    onClick={() => {
                      onInspect(inspection.scope?.id ?? '');
                    }}
                  >
                    {inspection.scope.name}
                  </button>
                }
              />
            )}
            {node.kind === 'Function' ? <FunctionAttributes node={node} /> : null}
            {node.kind === 'StateVariable' ? <StateVariableAttributes node={node} /> : null}
            {node.kind === 'Contract' ? (
              <>
                <Row label="contract kind" value={node.contractKind} />
                <Row
                  label="linearization"
                  value={`${node.linearizedBases.length === 0 ? 'itself only' : node.linearizedBases.join(' → ')} (${node.linearizationCertainty})`}
                />
                <Row
                  label="scaffolding"
                  value={
                    [node.isTest ? 'test' : '', node.isMock ? 'mock' : '']
                      .filter((part) => part !== '')
                      .join(', ') || 'no'
                  }
                />
              </>
            ) : null}
            {node.kind === 'Unresolved' ? (
              <>
                <Row label="category" value={node.category} />
                {/* §4: an unresolved edge is a correct answer, and this is what
                    the resolver could and could not see. */}
                <Row label="reason" value={node.reason} />
              </>
            ) : null}
          </div>
        </section>

        <NatSpec node={node} outgoing={inspection.outgoing} onInspect={onInspect} />

        {/* §11's preview sits directly under the attributes: the question a
            click on a function asks is "what does it do", and the answer is the
            body. Everything below this is about what surrounds it. */}
        <CodePreview slice={slice} busy={sliceBusy} error={sliceError} palette={palette} />

        {review === undefined && findings.length === 0 ? null : (
          <section className="ax-inspect-section">
            <h3>Audit state</h3>
            {review === undefined ? null : (
              <div className="ax-attrs">
                <Row
                  label="review"
                  value={`${review.status}${review.staleness === 'stale' ? ' — stale, the body changed since' : ''}`}
                />
                <Row label="reviewed" value={`${review.at}${review.reviewer === undefined ? '' : ` by ${review.reviewer}`}`} />
                {review.note === undefined ? null : <Row label="note" value={review.note} />}
              </div>
            )}
            {findings.length === 0 ? null : (
              <ul className="ax-findings">
                {findings.map((finding) => (
                  <li key={finding.id}>
                    <span className={`ax-impact ax-impact-${finding.impact.toLowerCase()}`}>
                      {finding.impact}
                    </span>{' '}
                    <code>{finding.check}</code>
                    {finding.staleness === 'current' ? null : (
                      <span className="ax-stale"> stale</span>
                    )}
                    <p>{finding.description.trim().split('\n')[0]}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {inspection.members.length === 0 ? null : (
          <section className="ax-inspect-section">
            <h3>
              Members <span className="ax-count">{inspection.members.length}</span>
            </h3>
            <ul className="ax-relations">
              {inspection.members.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    className="ax-relation"
                    title={member.id}
                    onClick={() => {
                      onInspect(member.id);
                    }}
                  >
                    <span className="ax-relation-name">{member.name}</span>
                    <span className="ax-relation-meta">{member.kind}</span>
                  </button>
                  <button
                    type="button"
                    className="ax-chip"
                    onClick={() => {
                      onFocus(member.id, member.kind);
                    }}
                  >
                    focus
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Relations
          title="Incoming"
          empty="Nothing in this graph points at it."
          relations={inspection.incoming}
          onInspect={onInspect}
          onFocus={onFocus}
        />
        <Relations
          title="Outgoing"
          empty="It points at nothing."
          relations={inspection.outgoing}
          onInspect={onInspect}
          onFocus={onFocus}
        />
      </div>
    </aside>
  );
}
