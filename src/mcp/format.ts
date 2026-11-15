// Compact, context-window-sized text for agents.
import { relativeTime } from '../shared/dates.js';
import { truncate } from '../shared/markdown.js';
import type { Decision, Handoff, ProjectSummary, Task } from '../shared/types.js';

export const RESPONSE_CAP = 4000;

/** Cap a response at a line boundary and say how to get more. */
export function cap(text: string, more: string, max = RESPONSE_CAP): string {
  if (text.length <= max) return text;
  const room = max - 200;
  const cut = text.lastIndexOf('\n', room);
  const head = text.slice(0, cut > room / 2 ? cut : room);
  const rest = text.length - head.length;
  return `${head}\n… [truncated: ${rest} more characters. ${more}]`;
}

export function projectLine(s: ProjectSummary): string {
  const status = s.initialised ? (s.status ?? 'active') : 'not initialised';
  const stale = s.stale ? ', STALE' : '';
  const commit = s.git.lastCommit
    ? `${relativeTime(s.git.lastCommit.date)}: ${truncate(s.git.lastCommit.subject, 60)}`
    : 'no commits';
  const next = s.nextStep ? ` | next: ${truncate(s.nextStep.text, 90)}` : '';
  return `${s.id} | ${s.name} | ${status}${stale} | ${commit}${next}`;
}

export function statusText(s: ProjectSummary): string {
  const g = s.git;
  const lines: string[] = [];
  lines.push(`# ${s.name} (${s.id})`);
  if (s.summary) lines.push(s.summary);
  lines.push(
    `Status: ${s.initialised ? (s.status ?? 'active') : 'not initialised (no .project/ folder)'}${s.stale ? ' — stale: no commit in a while' : ''}`,
  );
  if (s.tags.length) lines.push(`Tags: ${s.tags.join(', ')}`);
  if (s.path) lines.push(`Path: ${s.path}`);
  const sync =
    g.upstream && g.ahead !== null
      ? ` (${g.ahead} ahead, ${g.behind} behind ${g.upstream})`
      : g.branch
        ? ' (no upstream)'
        : '';
  lines.push(`Branch: ${g.detached ? 'detached HEAD' : (g.branch ?? 'unknown')}${sync}`);
  if (g.lastCommit) {
    lines.push(`Last commit: ${g.lastCommit.short} ${g.lastCommit.date.slice(0, 16)} (${relativeTime(g.lastCommit.date)}) by ${g.lastCommit.author}: ${g.lastCommit.subject}`);
  } else lines.push('Last commit: none');
  if (g.uncommitted) {
    const u = g.uncommitted;
    if (u.total === 0) lines.push('Uncommitted: clean');
    else {
      lines.push(
        `Uncommitted: ${u.total} file${u.total === 1 ? '' : 's'} (${u.staged} staged, ${u.unstaged} unstaged, ${u.untracked} untracked${u.conflicted ? `, ${u.conflicted} conflicted` : ''}): ${u.files.slice(0, 10).join(', ')}${u.total > 10 ? ', …' : ''}`,
      );
    }
  }
  const open = g.branches.filter((b) => !b.current && !b.merged && b.name !== g.defaultBranch);
  if (open.length) {
    lines.push(`Open branches (${open.length}): ${open.slice(0, 8).map((b) => `${b.name} (${relativeTime(b.date)})`).join(', ')}${open.length > 8 ? ', …' : ''}`);
  }
  const extraWt = (g.worktrees ?? []).filter((w) => !w.main);
  if (extraWt.length) lines.push(`Worktrees: ${extraWt.map((w) => `${w.path} [${w.branch ?? 'detached'}]`).join(', ')}`);
  if (s.latestHandoff) {
    const h = s.latestHandoff;
    lines.push(
      `Latest handoff: ${h.file} by ${h.agent}, ${h.date}${h.auto ? (h.reviewed ? ' (auto)' : ' (auto, unreviewed)') : ''}${s.commitsSinceHandoff ? `; ${s.commitsSinceHandoff} commit${s.commitsSinceHandoff === 1 ? '' : 's'} since` : ''}`,
    );
  } else lines.push('Latest handoff: none');
  lines.push(`Next step: ${s.nextStep ? `${s.nextStep.text} (from ${s.nextStep.source})` : 'not recorded'}`);
  lines.push(`Open tasks: ${s.openTasks ?? 'no backlog/ folder'}`);
  if (s.agents.claudeMd && !s.agents.claudePointer) lines.push('Warning: CLAUDE.md does not point to AGENTS.md.');
  if (s.error) lines.push(`Error while reading: ${s.error}`);
  return lines.join('\n');
}

export function handoffText(h: Handoff): string {
  const head = [
    `## Handoff ${h.file}`,
    `date: ${h.date} · agent: ${h.agent}${h.branch ? ` · branch: ${h.branch}` : ''}${h.commit ? ` · commit: ${h.commit}` : ''}`,
  ];
  if (h.auto) head.push(h.reviewed ? '(auto-drafted, reviewed)' : '(AUTO-DRAFTED FROM COMMITS, NOT REVIEWED — treat as a hint)');
  return `${head.join('\n')}\n\n${h.body.trim()}`;
}

export function decisionLine(d: Decision): string {
  return `${d.id} [${d.status}] ${d.date} ${d.title} — ${d.summary || '(no decision text yet)'}`;
}

export function decisionText(d: Decision): string {
  return [
    `# ${d.id} ${d.title}`,
    `status: ${d.status} · date: ${d.date}${d.author ? ` · author: ${d.author}` : ''}${d.supersededBy ? ` · superseded by: ${d.supersededBy}` : ''}`,
    '',
    d.body.trim().replace(/^#\s+.*\n/, '').trim(),
  ].join('\n');
}

export function taskLine(t: Task): string {
  const bits = [t.priority ? `(${t.priority})` : '', t.labels.length ? `#${t.labels.join(' #')}` : '', t.folder === 'drafts' ? '[draft]' : '']
    .filter(Boolean)
    .join(' ');
  return `${t.id} [${t.status}] ${t.title}${bits ? ` ${bits}` : ''}`;
}
