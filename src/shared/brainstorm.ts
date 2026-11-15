// brainstorm.json: canvas nodes and links, stored as stable, diff-friendly JSON.
import { NODE_KINDS, type BrainLink, type BrainNode, type Brainstorm, type NodeKind } from './types.js';
import { truncate } from './markdown.js';

export const BRAINSTORM_FILE = '.project/brainstorm.json';

export function emptyBrainstorm(): Brainstorm {
  return { version: 1, nodes: [] };
}

/** Sortable, collision-resistant node id: creation order == lexical order. */
export function newNodeId(now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `n-${now.toString(36).padStart(9, '0')}-${rand}`;
}

function asKind(v: unknown): NodeKind {
  return NODE_KINDS.includes(v as NodeKind) ? (v as NodeKind) : 'note';
}

function asNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function normalizeNode(raw: Partial<BrainNode> & Record<string, unknown>): BrainNode {
  const links: BrainLink[] = Array.isArray(raw.links)
    ? raw.links
        .filter((l): l is BrainLink => !!l && typeof (l as BrainLink).to === 'string')
        .map((l) => (l.label && String(l.label).trim() ? { to: l.to, label: String(l.label).trim() } : { to: l.to }))
    : [];
  const node: BrainNode = {
    id: String(raw.id ?? newNodeId()),
    text: String(raw.text ?? ''),
    kind: asKind(raw.kind),
    x: asNum(raw.x),
    y: asNum(raw.y),
    links,
  };
  if (raw.inbox) node.inbox = true;
  if (raw.author) node.author = String(raw.author);
  if (raw.created) node.created = String(raw.created);
  if (raw.promoted && typeof raw.promoted === 'object') {
    const p = raw.promoted as { type?: unknown; id?: unknown };
    if ((p.type === 'task' || p.type === 'decision') && p.id) node.promoted = { type: p.type, id: String(p.id) };
  }
  return node;
}

export function parseBrainstorm(text: string | null | undefined): Brainstorm {
  if (!text || !text.trim()) return emptyBrainstorm();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('brainstorm.json is not valid JSON');
  }
  const nodes = (data as { nodes?: unknown })?.nodes;
  if (!Array.isArray(nodes)) return emptyBrainstorm();
  return { version: 1, nodes: nodes.map((n) => normalizeNode(n as BrainNode & Record<string, unknown>)) };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Pretty-printed, sorted keys, nodes sorted by id, links sorted by target: clean diffs. */
export function serializeBrainstorm(b: Brainstorm): string {
  const ids = new Set(b.nodes.map((n) => n.id));
  const nodes = b.nodes
    .map((n) => {
      const node = normalizeNode(n as BrainNode & Record<string, unknown>);
      node.links = node.links
        .filter((l) => ids.has(l.to) && l.to !== node.id)
        .sort((a, c) => (a.to < c.to ? -1 : a.to > c.to ? 1 : 0));
      return node;
    })
    .sort((a, c) => (a.id < c.id ? -1 : a.id > c.id ? 1 : 0));
  return JSON.stringify(sortKeys({ version: 1, nodes }), null, 2) + '\n';
}

/**
 * Merge a client's full canvas into the file's current state. Nodes the client
 * never saw (e.g. an agent's Inbox note written meanwhile) are kept; nodes the
 * client saw and removed are dropped.
 */
export function mergeBrainstorm(current: Brainstorm, incoming: Brainstorm, knownIds: Iterable<string>): Brainstorm {
  const known = new Set(knownIds);
  const incomingIds = new Set(incoming.nodes.map((n) => n.id));
  const extra = current.nodes.filter((n) => !incomingIds.has(n.id) && !known.has(n.id));
  return { version: 1, nodes: [...incoming.nodes, ...extra] };
}

/** Where to put the next Inbox note: a column to the left of the canvas content. */
export function inboxPosition(b: Brainstorm): { x: number; y: number } {
  const inbox = b.nodes.filter((n) => n.inbox);
  return { x: -320, y: inbox.length * 90 };
}

export function addNote(
  b: Brainstorm,
  note: { text: string; kind: NodeKind; author?: string; inbox?: boolean; linkFrom?: string; linkLabel?: string },
  now: Date = new Date(),
): { brainstorm: Brainstorm; node: BrainNode } {
  const pos = note.inbox ? inboxPosition(b) : { x: 0, y: 0 };
  const node: BrainNode = {
    id: newNodeId(now.getTime()),
    text: note.text.trim(),
    kind: note.kind,
    x: pos.x,
    y: pos.y,
    links: [],
    created: now.toISOString(),
  };
  if (note.inbox) node.inbox = true;
  if (note.author) node.author = note.author;
  const nodes = b.nodes.map((n) =>
    n.id === note.linkFrom ? { ...n, links: [...n.links, note.linkLabel ? { to: node.id, label: note.linkLabel } : { to: node.id }] } : n,
  );
  return { brainstorm: { version: 1, nodes: [...nodes, node] }, node };
}

/**
 * The canvas as an indented outline for agents: roots in reading order
 * (top-to-bottom, left-to-right), children along links. No coordinates.
 */
export function brainstormOutline(b: Brainstorm, opts: { maxText?: number } = {}): string {
  const maxText = opts.maxText ?? 240;
  const placed = b.nodes.filter((n) => !n.inbox);
  const inbox = b.nodes.filter((n) => n.inbox);
  const byId = new Map(b.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, number>();
  for (const n of placed) for (const l of n.links) if (byId.has(l.to)) incoming.set(l.to, (incoming.get(l.to) ?? 0) + 1);
  const readingOrder = (a: BrainNode, c: BrainNode) => a.y - c.y || a.x - c.x;

  const label = (n: BrainNode) => {
    const text = truncate(n.text.replace(/\s+/g, ' ').trim() || '(empty)', maxText);
    const promoted = n.promoted ? ` → ${n.promoted.type} ${n.promoted.id}` : '';
    const by = n.author ? ` (by ${n.author})` : '';
    return `[${n.kind}] ${text}${promoted}${by} {${n.id}}`;
  };

  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (n: BrainNode, depth: number, via?: string) => {
    const indent = '  '.repeat(depth);
    const arrow = via ? `—${via}→ ` : depth > 0 ? '→ ' : '';
    if (seen.has(n.id)) {
      lines.push(`${indent}- ${arrow}(see above) {${n.id}}`);
      return;
    }
    seen.add(n.id);
    lines.push(`${indent}- ${arrow}${label(n)}`);
    const children = n.links
      .map((l) => ({ node: byId.get(l.to), label: l.label }))
      .filter((c): c is { node: BrainNode; label: string | undefined } => !!c.node && !c.node.inbox)
      .sort((a, c) => readingOrder(a.node, c.node));
    for (const c of children) walk(c.node, depth + 1, c.label);
  };

  const roots = placed.filter((n) => !incoming.get(n.id)).sort(readingOrder);
  for (const r of roots) walk(r, 0);
  // Nodes only reachable through cycles.
  for (const n of [...placed].sort(readingOrder)) if (!seen.has(n.id)) walk(n, 0);

  const out: string[] = [];
  const counts = NODE_KINDS.map((k) => [k, placed.filter((n) => n.kind === k).length] as const).filter(([, c]) => c > 0);
  out.push(
    placed.length
      ? `Canvas: ${placed.length} node${placed.length === 1 ? '' : 's'} (${counts.map(([k, c]) => `${c} ${k}`).join(', ')})`
      : 'Canvas: empty',
  );
  out.push(...lines);
  if (inbox.length) {
    out.push('', `Inbox: ${inbox.length} note${inbox.length === 1 ? '' : 's'} waiting for the user to place or discard`);
    for (const n of [...inbox].sort((a, c) => (a.id < c.id ? -1 : 1))) out.push(`- ${label(n)}`);
  }
  return out.join('\n');
}
