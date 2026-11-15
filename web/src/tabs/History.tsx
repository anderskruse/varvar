import { useMemo, useState } from 'react';
import type { HistoryItem, HistoryKind } from '@shared/types';
import { useLoader, useSource } from '../lib/app';
import { href } from '../lib/router';
import { Empty, Spinner } from '../components/ui';
import type { TabProps } from '../pages/Project';

const ICON: Record<HistoryKind, string> = { commit: '●', handoff: '⇄', decision: '◆' };

export function HistoryTab({ detail }: TabProps) {
  const source = useSource();
  const id = detail.summary.id;
  // Reload when the project changes (new commits, handoffs, decisions).
  const stamp = `${detail.summary.git.lastCommit?.sha}|${detail.handoffs.length}|${detail.decisions.length}`;
  const { data, error } = useLoader(() => source.history(id), [source, id, stamp]);
  const [kinds, setKinds] = useState<Set<HistoryKind>>(new Set(['commit', 'handoff', 'decision']));

  const days = useMemo(() => {
    const groups = new Map<string, HistoryItem[]>();
    for (const i of (data ?? []).filter((x) => kinds.has(x.kind))) {
      const day = (i.date || '').slice(0, 10) || 'undated';
      groups.set(day, [...(groups.get(day) ?? []), i]);
    }
    return [...groups.entries()];
  }, [data, kinds]);

  const toggle = (k: HistoryKind) => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setKinds(next);
  };

  if (error) return <div className="alert alert-error">{error}</div>;
  if (!data) return <Spinner />;
  if (!data.length) return <Empty title="No history yet" />;

  const linkFor = (i: HistoryItem) =>
    i.kind === 'handoff'
      ? href({ page: 'project', id, tab: 'handoff', item: i.ref })
      : i.kind === 'decision'
        ? href({ page: 'project', id, tab: 'decisions', item: i.ref })
        : null;

  return (
    <div className="history">
      <div className="seg">
        {(['commit', 'handoff', 'decision'] as HistoryKind[]).map((k) => (
          <button key={k} className={kinds.has(k) ? 'on' : ''} onClick={() => toggle(k)}>
            <span className={`hk hk-${k}`}>{ICON[k]}</span> {k}s <span className="count">{data.filter((i) => i.kind === k).length}</span>
          </button>
        ))}
      </div>
      <ol className="timeline">
        {days.map(([day, items]) => (
          <li key={day} className="tl-day">
            <h3>{day}</h3>
            <ol>
              {items.map((i) => {
                const link = linkFor(i);
                const title = link ? <a href={link}>{i.title}</a> : i.title;
                return (
                  <li key={`${i.kind}-${i.ref}`} className={`tl-item tl-${i.kind}`}>
                    <span className={`hk hk-${i.kind}`} aria-label={i.kind}>
                      {ICON[i.kind]}
                    </span>
                    <span className="tl-time">{i.date.length > 10 ? i.date.slice(11, 16) : ''}</span>
                    <span className="tl-title">
                      {title}
                      {i.detail && <span className="tl-detail">{i.detail}</span>}
                    </span>
                    <span className="tl-ref muted">
                      {i.kind === 'commit' ? <code>{i.ref.slice(0, 7)}</code> : null} {i.author}
                    </span>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>
    </div>
  );
}
