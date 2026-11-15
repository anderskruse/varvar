import { useState } from 'react';
import { DECISION_STATUSES, type Decision } from '@shared/types';
import { useAction, useSource } from '../lib/app';
import { href } from '../lib/router';
import { Badge, Empty, Field, Md } from '../components/ui';
import type { TabProps } from '../pages/Project';

export function DecisionsTab({ detail, reload, item }: TabProps) {
  const source = useSource();
  const w = source.writer;
  const id = detail.summary.id;
  const [run, busy] = useAction();
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<string>('all');

  const list = detail.decisions.filter((d) => filter === 'all' || d.status === filter);
  const statusCounts = DECISION_STATUSES.map((s) => [s, detail.decisions.filter((d) => d.status === s).length] as const);

  return (
    <div className="decisions">
      <div className="row-actions">
        {w && (
          <button className="btn btn-primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'New decision'}
          </button>
        )}
        {detail.decisions.length > 0 && (
          <div className="seg">
            <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
              all <span className="count">{detail.decisions.length}</span>
            </button>
            {statusCounts
              .filter(([, n]) => n > 0)
              .map(([s, n]) => (
                <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>
                  {s} <span className="count">{n}</span>
                </button>
              ))}
          </div>
        )}
      </div>
      {adding && w && (
        <DecisionForm
          busy={busy}
          onSubmit={(v) =>
            run(async () => {
              await w.logDecision(id, v);
              setAdding(false);
              await reload();
            }, 'Decision logged as proposed')
          }
        />
      )}
      {!detail.decisions.length && !adding && (
        <Empty title="No decisions yet">
          <p>
            Lasting choices go here as numbered ADRs in <code>.project/decisions/</code>. Agents add them with{' '}
            <code>log_decision</code>.
          </p>
        </Empty>
      )}
      <div className="decision-list">
        {list.map((d) => (
          <DecisionItem
            key={d.file}
            d={d}
            open={item === d.id}
            projectId={id}
            onStatus={
              w
                ? (status) =>
                    run(async () => {
                      await w.updateDecision(id, d.id, { status });
                      await reload();
                    })
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

function DecisionItem({ d, open, projectId, onStatus }: { d: Decision; open: boolean; projectId: string; onStatus?: (s: string) => void }) {
  return (
    <article className={`decision ${open ? 'open' : ''}`}>
      <a className="decision-head" href={href({ page: 'project', id: projectId, tab: 'decisions', item: open ? null : d.id })}>
        <span className="decision-id">{d.id}</span>
        <span className="decision-title">{d.title}</span>
        <Badge kind={`adr-${d.status}`}>{d.status}</Badge>
        <span className="muted decision-date">{d.date}</span>
      </a>
      {!open && d.summary && <p className="decision-summary">{d.summary}</p>}
      {open && (
        <div className="decision-body">
          <Md>{d.body.trim().replace(/^#\s+.*\n/, '')}</Md>
          <div className="decision-foot">
            <span className="muted">
              {d.author && <>by {d.author} · </>}
              <code>.project/decisions/{d.file}</code>
            </span>
            {onStatus && (
              <label>
                Status{' '}
                <select value={d.status} onChange={(e) => onStatus(e.target.value)}>
                  {[...new Set([...DECISION_STATUSES, d.status])].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function DecisionForm({ busy, onSubmit }: { busy: boolean; onSubmit: (v: { title: string; context: string; decision: string; consequences: string }) => void }) {
  const [v, setV] = useState({ title: '', context: '', decision: '', consequences: '' });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      className="form-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      <Field label="Title" hint="Short and imperative, e.g. “Use React Flow for the canvas”">
        <input value={v.title} onChange={set('title')} autoFocus required />
      </Field>
      <Field label="Context" hint="Why is a decision needed? What forces are at play?">
        <textarea rows={3} value={v.context} onChange={set('context')} />
      </Field>
      <Field label="Decision" hint="What was decided. Start with a one-sentence summary.">
        <textarea rows={3} value={v.decision} onChange={set('decision')} />
      </Field>
      <Field label="Consequences" hint="What becomes easier or harder?">
        <textarea rows={3} value={v.consequences} onChange={set('consequences')} />
      </Field>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || !v.title.trim()}>
          Log as proposed
        </button>
      </div>
    </form>
  );
}
