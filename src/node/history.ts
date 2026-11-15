import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TASK_FOLDERS, parseTask } from '../shared/backlog.js';
import { toTime } from '../shared/dates.js';
import { DECISION_DIR, isDecisionFile, parseDecision } from '../shared/decision.js';
import { HANDOFF_DIR, parseHandoff, sortHandoffFiles } from '../shared/handoff.js';
import { listItems, oneLine, truncate } from '../shared/markdown.js';
import type { Decision, Handoff, HistoryItem, Task, TaskFolder } from '../shared/types.js';
import { readText } from './fsutil.js';
import { isAncestor, log, resolveCommit, type LogEntry } from './git.js';

async function listMd(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
  } catch {
    return [];
  }
}

export async function readHandoffs(repo: string, max = 200): Promise<Handoff[]> {
  const files = sortHandoffFiles(await listMd(path.join(repo, HANDOFF_DIR))).slice(0, max);
  const texts = await Promise.all(files.map((f) => readText(path.join(repo, HANDOFF_DIR, f))));
  return files.flatMap((f, i) => (texts[i] === null ? [] : [parseHandoff(f, texts[i]!)]));
}

export async function readDecisions(repo: string): Promise<Decision[]> {
  const files = (await listMd(path.join(repo, DECISION_DIR))).filter(isDecisionFile);
  const texts = await Promise.all(files.map((f) => readText(path.join(repo, DECISION_DIR, f))));
  return files
    .flatMap((f, i) => (texts[i] === null ? [] : [parseDecision(f, texts[i]!)]))
    .sort((a, b) => b.number - a.number);
}

export async function readTasks(repo: string, folders: TaskFolder[] = ['tasks', 'drafts']): Promise<Task[]> {
  const out: Task[] = [];
  for (const folder of folders) {
    const dir = TASK_FOLDERS[folder];
    for (const f of await listMd(path.join(repo, dir))) {
      const text = await readText(path.join(repo, dir, f));
      if (text !== null) out.push(parseTask(`${dir}/${f}`, text, folder));
    }
  }
  return out;
}

export type SinceSpec = { kind: 'commit'; sha: string } | { kind: 'date'; date: string } | { kind: 'none' };

/**
 * Interpret `since`: "last_handoff" (default), a commit-ish, or a date.
 */
export async function resolveSince(repo: string, since: string | undefined): Promise<SinceSpec & { label: string }> {
  const s = (since ?? 'last_handoff').trim();
  if (!s || s === 'last_handoff' || s === 'handoff') {
    const [latest] = await readHandoffs(repo, 1);
    if (!latest) return { kind: 'none', label: 'the beginning (no handoff yet)' };
    if (latest.commit && (await isAncestor(repo, latest.commit))) {
      return { kind: 'commit', sha: latest.commit, label: `last handoff ${latest.file} (commit ${latest.commit})` };
    }
    return { kind: 'date', date: latest.date, label: `last handoff ${latest.file} (${latest.date})` };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s) || /\b(ago|yesterday|today|week|day|month)\b/.test(s)) {
    return { kind: 'date', date: s, label: s };
  }
  const sha = await resolveCommit(repo, s);
  if (sha) return { kind: 'commit', sha, label: `commit ${sha.slice(0, 7)}` };
  return { kind: 'date', date: s, label: s };
}

export async function commitsSince(repo: string, spec: SinceSpec, max: number, files = false): Promise<LogEntry[]> {
  if (spec.kind === 'commit') return log(repo, { range: `${spec.sha}..HEAD`, max, files });
  if (spec.kind === 'date') return log(repo, { since: spec.date, max, files });
  return log(repo, { max, files });
}

export async function history(repo: string, since?: string, maxCommits = 300): Promise<HistoryItem[]> {
  const spec = since ? await resolveSince(repo, since) : ({ kind: 'none', label: '' } as const);
  const sinceTime = spec.kind === 'date' ? toTime(spec.date) : 0;
  const [commits, handoffs, decisions] = await Promise.all([
    commitsSince(repo, spec, maxCommits),
    readHandoffs(repo),
    readDecisions(repo),
  ]);
  const items: HistoryItem[] = [
    ...commits.map(
      (c): HistoryItem => ({ kind: 'commit', date: c.date, title: c.subject, ref: c.sha, author: c.author, detail: null }),
    ),
    ...handoffs.map(
      (h): HistoryItem => ({
        kind: 'handoff',
        date: h.date,
        title: `Handoff by ${h.agent}${h.auto ? (h.reviewed ? ' (auto)' : ' (auto, unreviewed)') : ''}`,
        ref: h.file,
        author: h.agent,
        detail: listItems(h.sections.done).slice(0, 3).join('; ') || null,
      }),
    ),
    ...decisions.map(
      (d): HistoryItem => ({
        kind: 'decision',
        date: d.date,
        title: `${d.id} ${d.title} [${d.status}]`,
        ref: d.id,
        author: d.author,
        detail: d.summary || null,
      }),
    ),
  ];
  const firstCommitTime = spec.kind === 'commit' && commits.length ? toTime(commits[commits.length - 1].date) : 0;
  const cutoff = sinceTime || firstCommitTime;
  return items
    .filter((i) => i.kind === 'commit' || !cutoff || toTime(i.date) >= cutoff)
    .sort((a, b) => toTime(b.date) - toTime(a.date));
}

export interface SearchHit {
  kind: 'commit' | 'handoff' | 'decision' | 'task';
  ref: string;
  date: string | null;
  title: string;
  snippet: string;
}

function snippetAround(text: string, query: string, width = 140): string | null {
  const flat = oneLine(text, 100_000);
  const i = flat.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - Math.floor(width / 3));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? '…' : ''}${piece}${start + width < flat.length ? '…' : ''}`;
}

export async function searchRepo(repo: string, query: string, limit = 10): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const [commits, handoffs, decisions, tasks] = await Promise.all([
    log(repo, { grep: q, max: limit, all: true }),
    readHandoffs(repo),
    readDecisions(repo),
    readTasks(repo, ['tasks', 'drafts', 'completed', 'archive']),
  ]);
  const hits: SearchHit[] = [];
  for (const c of commits) hits.push({ kind: 'commit', ref: c.short, date: c.date, title: c.subject, snippet: '' });
  for (const h of handoffs) {
    const s = snippetAround(h.body, q);
    if (s) hits.push({ kind: 'handoff', ref: h.file, date: h.date, title: `Handoff by ${h.agent}`, snippet: s });
  }
  for (const d of decisions) {
    const s = snippetAround(d.body, q);
    if (s) hits.push({ kind: 'decision', ref: d.id, date: d.date, title: `${d.title} [${d.status}]`, snippet: s });
  }
  for (const t of tasks) {
    const s = snippetAround(`${t.title}\n${t.description}`, q);
    if (s) hits.push({ kind: 'task', ref: t.id, date: t.created, title: `${t.title} [${t.status}]`, snippet: s });
  }
  return hits.sort((a, b) => toTime(b.date) - toTime(a.date)).slice(0, limit * 2);
}

export function formatHit(h: SearchHit): string {
  const date = h.date ? h.date.slice(0, 10) : '';
  return `${h.kind} ${h.ref} ${date} — ${truncate(h.title, 100)}${h.snippet ? `\n    ${h.snippet}` : ''}`;
}
