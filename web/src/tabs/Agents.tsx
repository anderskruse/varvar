import { useEffect, useState } from 'react';
import { contentHash } from '@shared/datasource';
import { claudePointsToAgents, hasHubSnippet } from '@shared/agents';
import { useAction, useSource } from '../lib/app';
import { Empty, Md } from '../components/ui';
import type { TabProps } from '../pages/Project';

export function AgentsTab({ detail, reload }: TabProps) {
  const source = useSource();
  const w = source.writer;
  const id = detail.summary.id;
  const [run, busy] = useAction();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(detail.agentsMd ?? '');
  const [base, setBase] = useState<string | null>(contentHash(detail.agentsMd));
  const [showClaude, setShowClaude] = useState(false);

  // Follow changes on disk while not editing.
  useEffect(() => {
    if (!editing) {
      setText(detail.agentsMd ?? '');
      setBase(contentHash(detail.agentsMd));
    }
  }, [detail.agentsMd, editing]);

  const changedOnDisk = editing && contentHash(detail.agentsMd) !== base;
  const pointerOk = claudePointsToAgents(detail.claudeMd);
  const snippetOk = hasHubSnippet(detail.agentsMd);

  return (
    <div className="agents">
      {detail.claudeMd === null ? (
        <div className="alert alert-warn">
          No CLAUDE.md. Claude Code won't read AGENTS.md on its own.
          {w && (
            <button className="btn btn-small" disabled={busy} onClick={() => run(async () => { await w.fixClaudePointer(id); await reload(); }, 'Created CLAUDE.md')}>
              Create pointer
            </button>
          )}
        </div>
      ) : !pointerOk ? (
        <div className="alert alert-warn">
          CLAUDE.md no longer points to AGENTS.md.
          {w && (
            <button className="btn btn-small" disabled={busy} onClick={() => run(async () => { await w.fixClaudePointer(id); await reload(); }, 'Added @AGENTS.md to CLAUDE.md')}>
              Add @AGENTS.md
            </button>
          )}
        </div>
      ) : null}
      {detail.agentsMd !== null && !snippetOk && (
        <div className="alert alert-warn">
          AGENTS.md has no varvar section, so agents won't read or write handoffs.
          {w && (
            <button className="btn btn-small" disabled={busy} onClick={() => run(async () => { await w.addHubSnippet(id); await reload(); }, 'Added the varvar section')}>
              Add section
            </button>
          )}
        </div>
      )}

      {detail.agentsMd === null && !editing ? (
        <Empty title="No AGENTS.md">
          <p>AGENTS.md holds the instructions every coding agent follows in this repo.</p>
          {w && (
            <button className="btn btn-primary" onClick={() => run(async () => { await w.addHubSnippet(id); await reload(); }, 'Created AGENTS.md')}>
              Create AGENTS.md
            </button>
          )}
        </Empty>
      ) : editing ? (
        <div className="editor">
          {changedOnDisk && <div className="alert alert-warn">AGENTS.md changed on disk since you started editing. Saving will be refused; copy your text and reload.</div>}
          <textarea className="code-editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} autoFocus />
          <div className="actions">
            <button className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await w!.saveAgentsMd(id, text, base);
                  setEditing(false);
                  await reload();
                }, 'Saved AGENTS.md')
              }
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="doc">
          <div className="doc-head">
            <code>AGENTS.md</code>
            {w && (
              <button className="btn btn-small" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
          </div>
          <Md>{detail.agentsMd ?? ''}</Md>
        </div>
      )}

      {detail.claudeMd !== null && (
        <div className="doc doc-secondary">
          <button className="doc-head linkish" onClick={() => setShowClaude((v) => !v)}>
            <code>CLAUDE.md</code> <span className="muted">{showClaude ? 'hide' : 'show'}</span>
          </button>
          {showClaude && <pre className="pre">{detail.claudeMd}</pre>}
        </div>
      )}
    </div>
  );
}
