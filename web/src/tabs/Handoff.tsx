import { useEffect, useState } from 'react';
import { HANDOFF_DIR, parseHandoff } from '@shared/handoff';
import type { Handoff } from '@shared/types';
import { useAction, useSource } from '../lib/app';
import { href } from '../lib/router';
import { Badge, Empty, Field, Md, RelTime, Spinner } from '../components/ui';
import type { TabProps } from '../pages/Project';

export function HandoffTab({ detail, reload, item }: TabProps) {
  const source = useSource();
  const id = detail.summary.id;
  const [writing, setWriting] = useState(false);
  const [run, busy] = useAction();
  const w = source.writer;
  const selected = item && item !== detail.latestHandoff?.file ? item : null;
  const since = detail.summary.commitsSinceHandoff;

  const draft = () =>
    run(async () => {
      const r = await w!.draftHandoff(id);
      await reload();
      if (!r) throw new Error('Nothing to draft: no commits or changes since the last handoff.');
    }, 'Drafted a handoff from the commits');

  return (
    <div className="handoff-layout">
      <div className="handoff-main">
        {w && (
          <div className="row-actions">
            <button className="btn btn-primary" onClick={() => setWriting((v) => !v)}>
              {writing ? 'Cancel' : 'Write handoff'}
            </button>
            <button className="btn" disabled={busy} onClick={draft} title="Summarise the commits since the last handoff">
              Draft from commits
            </button>
          </div>
        )}
        {writing && w && (
          <HandoffForm
            onSubmit={(input) =>
              run(async () => {
                await w.writeHandoff(id, input);
                setWriting(false);
                await reload();
              }, 'Handoff written')
            }
            busy={busy}
          />
        )}
        {since ? (
          <div className="alert alert-warn">
            {since} commit{since === 1 ? '' : 's'} since this handoff — it may be out of date.
          </div>
        ) : null}
        {selected ? (
          <OlderHandoff project={id} file={selected} />
        ) : detail.latestHandoff ? (
          <HandoffView
            h={detail.latestHandoff}
            latest
            onReviewed={
              w && detail.latestHandoff.auto && !detail.latestHandoff.reviewed
                ? () =>
                    run(async () => {
                      await w.markHandoffReviewed(id, detail.latestHandoff!.file);
                      await reload();
                    })
                : undefined
            }
          />
        ) : (
          !writing && (
            <Empty title="No handoff yet">
              <p>
                Agents write one with the <code>write_handoff</code> MCP tool at the end of a session. You can write one here, or
                draft one from recent commits.
              </p>
            </Empty>
          )
        )}
      </div>
      {detail.handoffs.length > 0 && (
        <aside className="handoff-list">
          <h3>All handoffs</h3>
          <ul>
            {detail.handoffs.map((h, i) => {
              const on = selected ? selected === h.file : i === 0;
              return (
                <li key={h.file} className={on ? 'on' : ''}>
                  <a href={href({ page: 'project', id, tab: 'handoff', item: i === 0 ? null : h.file })}>
                    <span className="h-date">{h.date.replace('T', ' ')}</span>
                    <span className="h-agent">
                      {h.agent}
                      {h.auto && !h.reviewed ? ' · auto' : ''}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </aside>
      )}
    </div>
  );
}

function OlderHandoff({ project, file }: { project: string; file: string }) {
  const source = useSource();
  const [h, setH] = useState<Handoff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setH(null);
    setErr(null);
    source
      .readFile(project, `${HANDOFF_DIR}/${file}`)
      .then((t) => setH(parseHandoff(file, t)))
      .catch((e: Error) => setErr(e.message));
  }, [source, project, file]);
  if (err) return <div className="alert alert-error">{err}</div>;
  if (!h) return <Spinner />;
  return <HandoffView h={h} />;
}

const SECTIONS: { key: keyof Handoff['sections']; title: string }[] = [
  { key: 'next', title: 'Next' },
  { key: 'done', title: 'Done' },
  { key: 'open_questions', title: 'Open questions' },
  { key: 'gotchas', title: 'Gotchas' },
];

export function HandoffView({ h, latest, onReviewed }: { h: Handoff; latest?: boolean; onReviewed?: () => void }) {
  const hasSections = SECTIONS.some((s) => h.sections[s.key]);
  return (
    <article className="handoff">
      <header className="handoff-head">
        <div>
          <span className="handoff-kicker">{latest ? 'Latest handoff' : 'Handoff'}</span>
          <h2>
            <RelTime date={h.date} /> <span className="muted">by</span> {h.agent}
          </h2>
          <div className="handoff-meta">
            {h.date.replace('T', ' ')}
            {h.branch && (
              <>
                {' '}
                · ⎇ {h.branch}
              </>
            )}
            {h.commit && (
              <>
                {' '}
                · <code>{h.commit}</code>
              </>
            )}{' '}
            · <span className="muted">{h.file}</span>
          </div>
        </div>
        {h.auto && (
          <div className="handoff-auto">
            <Badge kind={h.reviewed ? 'neutral' : 'warn'}>{h.reviewed ? 'auto, reviewed' : 'auto, unreviewed'}</Badge>
            {onReviewed && (
              <button className="btn btn-small" onClick={onReviewed}>
                Mark reviewed
              </button>
            )}
          </div>
        )}
      </header>
      {hasSections ? (
        <div className="handoff-sections">
          {SECTIONS.map((s) => (
            <section key={s.key} className={`hs hs-${s.key}`}>
              <h3>{s.title}</h3>
              {h.sections[s.key] ? <Md>{h.sections[s.key]}</Md> : <p className="muted">—</p>}
            </section>
          ))}
        </div>
      ) : (
        <Md>{h.body}</Md>
      )}
    </article>
  );
}

function HandoffForm({
  onSubmit,
  busy,
}: {
  onSubmit: (v: { done: string; next: string; open_questions: string; gotchas: string }) => void;
  busy: boolean;
}) {
  const [v, setV] = useState({ done: '', next: '', open_questions: '', gotchas: '' });
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value });
  return (
    <form
      className="form-card"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(v);
      }}
    >
      <p className="muted">One item per line. Saved as a new file in .project/handoffs/ under your git user name.</p>
      <div className="grid-2">
        <Field label="Done">
          <textarea rows={5} value={v.done} onChange={set('done')} autoFocus />
        </Field>
        <Field label="Next">
          <textarea rows={5} value={v.next} onChange={set('next')} />
        </Field>
        <Field label="Open questions">
          <textarea rows={3} value={v.open_questions} onChange={set('open_questions')} />
        </Field>
        <Field label="Gotchas">
          <textarea rows={3} value={v.gotchas} onChange={set('gotchas')} />
        </Field>
      </div>
      <div className="actions">
        <button className="btn btn-primary" disabled={busy || (!v.done.trim() && !v.next.trim())}>
          Save handoff
        </button>
      </div>
    </form>
  );
}
