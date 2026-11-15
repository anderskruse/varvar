import { useMemo, useState } from 'react';
import { relativeTime } from '@shared/dates';
import type { Task } from '@shared/types';
import { useAction, useSource } from '../lib/app';
import { Badge, Empty, Field, Md } from '../components/ui';
import type { TabProps } from '../pages/Project';

export function TasksTab({ detail, reload }: TabProps) {
  const source = useSource();
  const w = source.writer;
  const id = detail.summary.id;
  const [run, busy] = useAction();
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  // Optimistic status while the file write is in flight.
  const [moved, setMoved] = useState<Record<string, string>>({});

  const tasks = useMemo(
    () => detail.tasks.map((t) => (moved[t.id] ? { ...t, status: moved[t.id] } : t)),
    [detail.tasks, moved],
  );
  const statuses = useMemo(() => {
    const extra = [...new Set(tasks.filter((t) => t.folder === 'tasks').map((t) => t.status))].filter(
      (s) => !detail.taskStatuses.some((x) => x.toLowerCase() === s.toLowerCase()),
    );
    return [...detail.taskStatuses, ...extra];
  }, [tasks, detail.taskStatuses]);
  const drafts = tasks.filter((t) => t.folder === 'drafts');

  const move = (taskId: string, status: string) => {
    const t = tasks.find((x) => x.id === taskId);
    if (!t || t.status === status || !w) return;
    setMoved((m) => ({ ...m, [taskId]: status }));
    void run(async () => {
      await w.updateTask(id, taskId, { status });
      await reload();
    }).finally(() =>
      setMoved((m) => {
        const { [taskId]: _drop, ...rest } = m;
        return rest;
      }),
    );
  };

  return (
    <div className="tasks">
      {w && (
        <div className="row-actions">
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'New task'}
          </button>
          <span className="muted">Tasks are Backlog.md files in backlog/tasks/; its own CLI and board keep working.</span>
        </div>
      )}
      {adding && w && (
        <TaskForm
          statuses={statuses}
          busy={busy}
          onSubmit={(input) =>
            run(async () => {
              const r = await w.addTask(id, input);
              setAdding(false);
              await reload();
              return r;
            }, 'Task created')
          }
        />
      )}
      {!detail.hasBacklog && !adding ? (
        <Empty title="No backlog/ folder">
          <p>Creating the first task sets up backlog/ in the Backlog.md format.</p>
        </Empty>
      ) : (
        <div className="board">
          {statuses.map((status) => {
            const col = tasks.filter((t) => t.folder === 'tasks' && t.status.toLowerCase() === status.toLowerCase());
            return (
              <div
                key={status}
                className={`column ${dragOver === status ? 'drag-over' : ''}`}
                onDragOver={(e) => {
                  if (!w) return;
                  e.preventDefault();
                  setDragOver(status);
                }}
                onDragLeave={() => setDragOver((d) => (d === status ? null : d))}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  move(e.dataTransfer.getData('text/task-id'), status);
                }}
              >
                <h3>
                  {status} <span className="count">{col.length}</span>
                </h3>
                {col.map((t) => (
                  <TaskCard
                    key={t.id}
                    t={t}
                    open={open === t.id}
                    onToggle={() => setOpen(open === t.id ? null : t.id)}
                    draggable={!!w}
                    statuses={statuses}
                    onMove={w ? (s) => move(t.id, s) : undefined}
                  />
                ))}
              </div>
            );
          })}
          {drafts.length > 0 && (
            <div className="column column-drafts">
              <h3>
                Drafts <span className="count">{drafts.length}</span>
              </h3>
              {drafts.map((t) => (
                <TaskCard key={t.id} t={t} open={open === t.id} onToggle={() => setOpen(open === t.id ? null : t.id)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  t,
  open,
  onToggle,
  draggable,
  statuses,
  onMove,
}: {
  t: Task;
  open: boolean;
  onToggle: () => void;
  draggable?: boolean;
  statuses?: string[];
  onMove?: (status: string) => void;
}) {
  const done = t.acceptanceCriteria.filter((a) => a.checked).length;
  return (
    <div
      className={`task ${open ? 'open' : ''}`}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/task-id', t.id)}
    >
      <button className="task-head" onClick={onToggle} aria-expanded={open}>
        <span className="task-id">{t.id}</span>
        <span className="task-title">{t.title}</span>
      </button>
      <div className="task-meta">
        {t.priority && <Badge kind={`prio-${t.priority}`}>{t.priority}</Badge>}
        {t.labels.map((l) => (
          <span key={l} className="tag">
            #{l}
          </span>
        ))}
        {t.acceptanceCriteria.length > 0 && (
          <span className="muted">
            AC {done}/{t.acceptanceCriteria.length}
          </span>
        )}
        {t.parent && <span className="muted">sub-task of {t.parent}</span>}
      </div>
      {open && (
        <div className="task-body">
          {t.description ? <Md>{t.description}</Md> : <p className="muted">No description.</p>}
          {t.acceptanceCriteria.length > 0 && (
            <ul className="ac">
              {t.acceptanceCriteria.map((a) => (
                <li key={a.index} className={a.checked ? 'checked' : ''}>
                  {a.checked ? '☑' : '☐'} {a.text}
                </li>
              ))}
            </ul>
          )}
          <div className="task-foot muted">
            {t.reporter && <>by {t.reporter} · </>}
            {t.created && <>created {relativeTime(t.created)} · </>}
            <code>{t.file}</code>
          </div>
          {onMove && statuses && (
            <label className="task-move">
              Move to{' '}
              <select value={t.status} onChange={(e) => onMove(e.target.value)}>
                {statuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

function TaskForm({
  statuses,
  busy,
  onSubmit,
}: {
  statuses: string[];
  busy: boolean;
  onSubmit: (v: { title: string; description: string; status: string; priority: string | null; labels: string[]; acceptanceCriteria: string[] }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState(statuses[0] ?? 'To Do');
  const [priority, setPriority] = useState('');
  const [labels, setLabels] = useState('');
  const [ac, setAc] = useState('');
  return (
    <form
      className="form-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          title,
          description,
          status,
          priority: priority || null,
          labels: labels.split(',').map((l) => l.trim().replace(/^#/, '')).filter(Boolean),
          acceptanceCriteria: ac.split('\n').map((l) => l.replace(/^\s*[-*]\s*(\[[ x]\]\s*)?/, '').trim()).filter(Boolean),
        });
      }}
    >
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="grid-3">
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {statuses.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">—</option>
            <option>high</option>
            <option>medium</option>
            <option>low</option>
          </select>
        </Field>
        <Field label="Labels">
          <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="ui, backend" />
        </Field>
      </div>
      <Field label="Acceptance criteria" hint="One per line">
        <textarea rows={2} value={ac} onChange={(e) => setAc(e.target.value)} />
      </Field>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || !title.trim()}>
          Create task
        </button>
      </div>
    </form>
  );
}
