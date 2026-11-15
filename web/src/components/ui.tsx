import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { relativeTime } from '@shared/dates';
import type { ProjectSummary } from '@shared/types';

export function Md({ children }: { children: string }) {
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
    </div>
  );
}

export function RelTime({ date, prefix }: { date: string | null | undefined; prefix?: string }) {
  if (!date) return <span className="muted">never</span>;
  const d = new Date(date);
  return (
    <time dateTime={date} title={Number.isNaN(d.getTime()) ? date : d.toLocaleString()}>
      {prefix}
      {relativeTime(date)}
    </time>
  );
}

export function Badge({ kind = 'neutral', children, title }: { kind?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${kind}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ s }: { s: ProjectSummary }) {
  if (!s.initialised) return <Badge kind="muted">not initialised</Badge>;
  return <Badge kind={s.status ?? 'active'}>{s.status ?? 'active'}</Badge>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" /> {label}
    </div>
  );
}

/** Branch, sync state, uncommitted work, open branches and worktrees. */
export function GitSignals({ s, compact = false }: { s: ProjectSummary; compact?: boolean }) {
  const g = s.git;
  const open = g.branches.filter((b) => !b.current && !b.merged && b.name !== g.defaultBranch);
  const worktrees = (g.worktrees ?? []).filter((w) => !w.main);
  const u = g.uncommitted;
  return (
    <div className="signals">
      <span className="sig" title={g.upstream ? `Tracking ${g.upstream}` : 'No upstream branch'}>
        <span className="sig-icon" aria-hidden>
          ⎇
        </span>
        {g.detached ? 'detached' : (g.branch ?? '—')}
        {g.upstream && (g.ahead || g.behind) ? (
          <span className={`sync ${g.behind ? 'behind' : ''}`}>
            {g.ahead ? ` ↑${g.ahead}` : ''}
            {g.behind ? ` ↓${g.behind}` : ''}
          </span>
        ) : null}
        {!g.upstream && g.branch && !compact ? <span className="muted"> · local only</span> : null}
      </span>
      {u && u.total > 0 && (
        <span
          className="sig sig-dirty"
          title={`${u.staged} staged, ${u.unstaged} unstaged, ${u.untracked} untracked\n${u.files.join('\n')}${u.total > u.files.length ? '\n…' : ''}`}
        >
          ● {u.total} uncommitted
        </span>
      )}
      {u && u.total === 0 && !compact && <span className="sig muted">clean</span>}
      {open.length > 0 && (
        <span className="sig" title={open.map((b) => `${b.name}${b.ahead ? ` ↑${b.ahead}` : ''} — ${b.subject}`).join('\n')}>
          {open.length} open branch{open.length === 1 ? '' : 'es'}
        </span>
      )}
      {worktrees.length > 0 && (
        <span className="sig" title={worktrees.map((w) => `${w.path} [${w.branch ?? 'detached'}]`).join('\n')}>
          {worktrees.length} worktree{worktrees.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}
