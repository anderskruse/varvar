import { useState } from 'react';
import { PROJECT_STATUSES, type ProjectDetail, type ProjectStatus } from '@shared/types';
import { useAction, useDebounced, useHubEvents, useLoader, useSource, useToast } from '../lib/app';
import { href } from '../lib/router';
import { Badge, Empty, GitSignals, RelTime, Spinner, StatusBadge } from '../components/ui';
import { HandoffTab } from '../tabs/Handoff';
import { AgentsTab } from '../tabs/Agents';
import { TasksTab } from '../tabs/Tasks';
import { DecisionsTab } from '../tabs/Decisions';
import { BrainstormTab } from '../tabs/Brainstorm';
import { HistoryTab } from '../tabs/History';

export interface TabProps {
  detail: ProjectDetail;
  reload: () => Promise<void>;
  item: string | null;
}

const TABS: { id: string; label: string; count?: (d: ProjectDetail) => number | null }[] = [
  { id: 'handoff', label: 'Handoff', count: (d) => d.handoffs.length || null },
  { id: 'agents', label: 'Agent instructions' },
  { id: 'tasks', label: 'Tasks', count: (d) => d.summary.openTasks },
  { id: 'decisions', label: 'Decisions', count: (d) => d.decisions.length || null },
  { id: 'brainstorm', label: 'Brainstorm', count: (d) => d.brainstorm?.nodes.filter((n) => n.inbox).length || null },
  { id: 'history', label: 'History' },
];

export function ProjectPage({ id, tab, item }: { id: string; tab: string; item: string | null }) {
  const source = useSource();
  const { data, error, reload } = useLoader(() => source.getProject(id), [source, id]);
  const reloadSoon = useDebounced(() => void reload(), 250);
  useHubEvents((e) => {
    if ((e.type === 'project' && e.id === id) || e.type === 'projects') reloadSoon();
  });

  if (error && !data) {
    return (
      <div className="page">
        <a href="#/" className="back">
          ← All projects
        </a>
        <div className="alert alert-error">{error}</div>
      </div>
    );
  }
  if (!data) return <Spinner />;

  const current = TABS.some((t) => t.id === tab) ? tab : 'handoff';
  const props: TabProps = { detail: data, reload, item };
  return (
    <div className="page project">
      <a href="#/" className="back">
        ← All projects
      </a>
      <ProjectHeader detail={data} reload={reload} />
      {!data.summary.initialised ? (
        <Uninitialised detail={data} reload={reload} />
      ) : (
        <>
          <nav className="tabs" role="tablist">
            {TABS.map((t) => {
              const n = t.count?.(data);
              return (
                <a
                  key={t.id}
                  role="tab"
                  aria-selected={current === t.id}
                  className={current === t.id ? 'tab on' : 'tab'}
                  href={href({ page: 'project', id, tab: t.id, item: null })}
                >
                  {t.label}
                  {n ? <span className="count">{n}</span> : null}
                </a>
              );
            })}
          </nav>
          <section className="tab-body">
            {current === 'handoff' && <HandoffTab {...props} />}
            {current === 'agents' && <AgentsTab {...props} />}
            {current === 'tasks' && <TasksTab {...props} />}
            {current === 'decisions' && <DecisionsTab {...props} />}
            {current === 'brainstorm' && <BrainstormTab {...props} />}
            {current === 'history' && <HistoryTab {...props} />}
          </section>
        </>
      )}
    </div>
  );
}

function ProjectHeader({ detail, reload }: { detail: ProjectDetail; reload: () => Promise<void> }) {
  const source = useSource();
  const s = detail.summary;
  const [run, busy] = useAction();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const w = source.writer;
  const dirty = detail.notesDirty ?? [];

  return (
    <header className="project-head">
      <div className="project-title-row">
        <h1>{s.name}</h1>
        <StatusBadge s={s} />
        {s.stale && <Badge kind="stale">stale</Badge>}
        {s.tags.map((t) => (
          <span key={t} className="tag">
            #{t}
          </span>
        ))}
        <div className="spacer" />
        {w && s.initialised && (
          <button className="btn btn-small" onClick={() => setEditing((e) => !e)}>
            {editing ? 'Close' : 'Edit details'}
          </button>
        )}
        {w && s.initialised && (
          <button
            className="btn btn-small btn-primary"
            disabled={busy || !dirty.length}
            title={dirty.length ? `Commits only project notes:\n${dirty.join('\n')}` : 'No uncommitted project notes'}
            onClick={() =>
              run(async () => {
                const r = await w.commitNotes(s.id);
                await reload();
                toast('info', `Committed ${r.sha.slice(0, 7)}: ${r.message}. Not pushed.`);
              })
            }
          >
            Commit project notes{dirty.length ? ` (${dirty.length})` : ''}
          </button>
        )}
      </div>
      {s.summary && !editing && <p className="project-summary">{s.summary}</p>}
      {editing && detail.meta && w && (
        <MetaEditor
          detail={detail}
          onSave={(patch) =>
            run(async () => {
              await w.saveProjectMeta(s.id, patch);
              await reload();
              setEditing(false);
            }, 'Saved project.yaml')
          }
        />
      )}
      <div className="project-signals">
        <GitSignals s={s} />
        {s.git.lastCommit && (
          <span className="sig">
            last commit <RelTime date={s.git.lastCommit.date} />{' '}
            <code title={s.git.lastCommit.sha}>{s.git.lastCommit.short}</code>
          </span>
        )}
        {s.remote && <span className="sig muted">{s.remote}</span>}
        {s.path && (
          <a className="sig" href={`vscode://file${s.path}`} title={s.path}>
            open in editor
          </a>
        )}
      </div>
    </header>
  );
}

function MetaEditor({ detail, onSave }: { detail: ProjectDetail; onSave: (p: Record<string, unknown>) => void }) {
  const m = detail.meta!;
  const [name, setName] = useState(m.name);
  const [summary, setSummary] = useState(m.summary);
  const [status, setStatus] = useState<ProjectStatus>(m.status);
  const [tags, setTags] = useState(m.tags.join(', '));
  const [next, setNext] = useState(m.next_step);
  return (
    <form
      className="meta-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          name: name.trim() || m.name,
          summary: summary.trim(),
          status,
          tags: tags
            .split(',')
            .map((t) => t.trim().replace(/^#/, ''))
            .filter(Boolean),
          next_step: next.trim(),
        });
      }}
    >
      <label>
        Name <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
          {PROJECT_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="wide">
        Summary <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="One line about the project" />
      </label>
      <label className="wide">
        Tags <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated" />
      </label>
      <label className="wide">
        Next step <input value={next} onChange={(e) => setNext(e.target.value)} placeholder="Used when no handoff says what's next" />
      </label>
      <div className="actions">
        <button className="btn btn-primary" type="submit">
          Save project.yaml
        </button>
      </div>
    </form>
  );
}

function Uninitialised({ detail, reload }: { detail: ProjectDetail; reload: () => Promise<void> }) {
  const source = useSource();
  const [run, busy] = useAction();
  return (
    <Empty title="This repo has no .project/ folder yet">
      <p>
        Initialise creates <code>.project/</code> (project.yaml, handoffs, decisions, brainstorm), <code>AGENTS.md</code> with
        the varvar rules and a <code>CLAUDE.md</code> pointer. Nothing is committed.
      </p>
      {source.writer && (
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await source.writer!.initialise(detail.summary.id);
              await reload();
            }, 'Initialised')
          }
        >
          Initialise
        </button>
      )}
    </Empty>
  );
}
