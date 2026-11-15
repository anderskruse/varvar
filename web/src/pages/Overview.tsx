import { useMemo, useState } from 'react';
import { truncate } from '@shared/markdown';
import type { ProjectSummary } from '@shared/types';
import { useAction, useDebounced, useHubEvents, useLoader, useSource } from '../lib/app';
import { href } from '../lib/router';
import { Badge, Empty, GitSignals, RelTime, Spinner, StatusBadge } from '../components/ui';

type StatusFilter = 'all' | 'active' | 'paused' | 'archived' | 'uninitialised' | 'stale';
type Sort = 'activity' | 'stale' | 'name';

function usePersisted<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => (localStorage.getItem(`hub.${key}`) as T) || initial);
  return [
    v,
    (nv: T) => {
      localStorage.setItem(`hub.${key}`, nv);
      setV(nv);
    },
  ];
}

const byActivity = (a: ProjectSummary, b: ProjectSummary) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? '');

export function Overview() {
  const source = useSource();
  const { data, error, loading, reload } = useLoader(() => source.listProjects(), [source]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = usePersisted<StatusFilter>('status', 'all');
  const [tag, setTag] = usePersisted<string>('tag', '');
  const [sort, setSort] = usePersisted<Sort>('sort', 'activity');
  const [scanning, setScanning] = useState(false);
  const [run, busy] = useAction();
  const reloadSoon = useDebounced(() => void reload(), 250);

  useHubEvents((e) => {
    if (e.type === 'scan') setScanning(e.state === 'started');
    else reloadSoon();
  });

  const tags = useMemo(() => [...new Set((data ?? []).flatMap((p) => p.tags))].sort(), [data]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    let l = (data ?? []).filter((p) => {
      if (q && ![p.name, p.id, p.summary, ...p.tags].some((x) => x.toLowerCase().includes(q))) return false;
      if (tag && !p.tags.includes(tag)) return false;
      switch (status) {
        case 'all':
          return true;
        case 'uninitialised':
          return !p.initialised;
        case 'stale':
          return p.stale;
        default:
          return p.initialised && p.status === status;
      }
    });
    l = [...l].sort(byActivity);
    if (sort === 'stale') l.sort((a, b) => Number(b.stale) - Number(a.stale));
    if (sort === 'name') l.sort((a, b) => a.name.localeCompare(b.name));
    return l;
  }, [data, query, status, tag, sort]);

  const counts = useMemo(() => {
    const d = data ?? [];
    return {
      all: d.length,
      active: d.filter((p) => p.initialised && p.status === 'active').length,
      paused: d.filter((p) => p.status === 'paused').length,
      archived: d.filter((p) => p.status === 'archived').length,
      uninitialised: d.filter((p) => !p.initialised).length,
      stale: d.filter((p) => p.stale).length,
    };
  }, [data]);

  return (
    <div className="page">
      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search projects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <div className="seg" role="group" aria-label="Filter by status">
          {(Object.keys(counts) as StatusFilter[]).map((k) => (
            <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>
              {k === 'uninitialised' ? 'new' : k} <span className="count">{counts[k]}</span>
            </button>
          ))}
        </div>
        {tags.length > 0 && (
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Filter by tag">
            <option value="">All tags</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
          <option value="activity">Last activity</option>
          <option value="stale">Stale first</option>
          <option value="name">Name</option>
        </select>
        {source.rescan && (
          <button className="btn" disabled={busy || scanning} onClick={() => run(() => source.rescan!())}>
            {busy || scanning ? 'Scanning…' : 'Rescan'}
          </button>
        )}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {loading && !data && <Spinner label="Scanning repos…" />}
      {data && !data.length && (
        <Empty title="No repos found">
          <p>
            Add folders to <code>roots</code> in <code>~/.varvar/config.yaml</code>, then rescan.
          </p>
        </Empty>
      )}
      {data && data.length > 0 && !list.length && <Empty title="Nothing matches these filters" />}
      <div className="cards">
        {list.map((p) => (
          <ProjectCard key={p.id} p={p} onChanged={reload} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ p, onChanged }: { p: ProjectSummary; onChanged: () => void }) {
  const source = useSource();
  const [run, busy] = useAction();
  const link = href({ page: 'project', id: p.id, tab: 'handoff', item: null });
  const h = p.latestHandoff;
  return (
    <article className={`card ${p.initialised ? '' : 'card-new'} ${p.stale ? 'card-stale' : ''}`}>
      <a className="card-link" href={link} aria-label={`Open ${p.name}`} />
      <header className="card-head">
        <h2 className="card-title">{p.name}</h2>
        <div className="card-badges">
          {p.stale && (
            <Badge kind="stale" title="Active, but no commit for a while">
              stale
            </Badge>
          )}
          <StatusBadge s={p} />
        </div>
      </header>
      {p.summary && <p className="card-summary">{truncate(p.summary, 140)}</p>}
      <GitSignals s={p} compact />
      <div className="card-commit">
        {p.git.lastCommit ? (
          <>
            <RelTime date={p.git.lastCommit.date} /> <span className="muted">—</span> {truncate(p.git.lastCommit.subject, 80)}
          </>
        ) : (
          <span className="muted">No commits yet</span>
        )}
      </div>
      {p.nextStep && (
        <div className="card-next" title={`From ${p.nextStep.source}`}>
          <span className="next-label">Next</span> {truncate(p.nextStep.text, 140)}
        </div>
      )}
      <footer className="card-foot">
        {p.openTasks !== null && (
          <span>
            {p.openTasks} open task{p.openTasks === 1 ? '' : 's'}
          </span>
        )}
        {h && (
          <span title={h.file}>
            handoff <RelTime date={h.date} /> by {h.agent}
            {h.auto && !h.reviewed && (
              <Badge kind="warn" title="Drafted from commits; not reviewed">
                auto
              </Badge>
            )}
          </span>
        )}
        {p.commitsSinceHandoff ? (
          <span className="warn-text">
            {p.commitsSinceHandoff} commit{p.commitsSinceHandoff === 1 ? '' : 's'} since handoff
          </span>
        ) : null}
        {p.tags.map((t) => (
          <span key={t} className="tag">
            #{t}
          </span>
        ))}
        {!p.initialised && source.writer && (
          <button
            className="btn btn-small btn-primary card-action"
            disabled={busy}
            onClick={() => run(async () => {
              await source.writer!.initialise(p.id);
              onChanged();
            }, `Initialised ${p.name}`)}
          >
            Initialise
          </button>
        )}
      </footer>
      {p.error && <div className="card-error">{p.error}</div>}
    </article>
  );
}
