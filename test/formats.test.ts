import { describe, expect, it } from 'vitest';
import {
  compareTasks,
  formatTaskId,
  nextTaskNumber,
  parseBacklogConfig,
  parseTask,
  patchTask,
  sameTaskId,
  sanitizeTaskTitle,
  serializeNewTask,
  taskFileName,
} from '../src/shared/backlog.js';
import { addNote, brainstormOutline, mergeBrainstorm, parseBrainstorm, serializeBrainstorm } from '../src/shared/brainstorm.js';
import { decisionFileName, nextDecisionNumber, parseDecision, serializeDecision } from '../src/shared/decision.js';
import { parseFrontMatter, patchFrontMatter } from '../src/shared/frontmatter.js';
import { handoffFileName, nextStepFromHandoff, parseHandoff, refFromFileName, serializeHandoff, sortHandoffFiles } from '../src/shared/handoff.js';
import { listItems, toBullets } from '../src/shared/markdown.js';
import { assignIds } from '../src/shared/project.js';
import { parseProjectMeta, patchProjectMeta } from '../src/shared/projectMeta.js';
import { addClaudePointer, claudePointsToAgents, hasHubSnippet } from '../src/shared/agents.js';
import { SKILL_HANDOFF_EXAMPLE, SKILL_MD } from '../src/shared/skill.js';
import type { Brainstorm } from '../src/shared/types.js';

describe('handoffs', () => {
  const date = new Date(2026, 10, 1, 14, 30);

  it('round-trips the spec format', () => {
    const text = serializeHandoff({
      agent: 'claude-code',
      branch: 'feature/overview',
      commit: 'a1b2c3d',
      date,
      done: ['Built the scanner'],
      next: 'Build the UI\nAdd the canvas',
      open_questions: [],
      gotchas: '- Dates are local time',
    });
    expect(text).toContain('date: 2026-11-01T14:30\nagent: claude-code\nbranch: feature/overview\ncommit: a1b2c3d');
    expect(text).toMatch(/## Done\n- Built the scanner\n\n## Next\n- Build the UI\n- Add the canvas/);
    const h = parseHandoff('2026-11-01-1430-claude-code.md', text);
    expect(h).toMatchObject({ date: '2026-11-01T14:30', agent: 'claude-code', branch: 'feature/overview', commit: 'a1b2c3d', auto: false });
    expect(nextStepFromHandoff(h)).toBe('Build the UI');
    expect(listItems(h.sections.open_questions)).toEqual([]);
  });

  it('marks auto drafts unreviewed', () => {
    const h = parseHandoff('x.md', serializeHandoff({ agent: 'hub', auto: true, date, done: 'x', next: 'y' }));
    expect(h.auto).toBe(true);
    expect(h.reviewed).toBe(false);
  });

  it('names and sorts files newest first', () => {
    expect(handoffFileName(date, 'Claude Code')).toBe('2026-11-01-1430-claude-code.md');
    expect(sortHandoffFiles(['2026-10-01-0900-a.md', '2026-11-01-1430-b.md', '.gitkeep', '2026-11-01-0800-c.md'])).toEqual([
      '2026-11-01-1430-b.md',
      '2026-11-01-0800-c.md',
      '2026-10-01-0900-a.md',
    ]);
    expect(refFromFileName('2026-11-01-1430-claude-2.md')).toMatchObject({ date: '2026-11-01T14:30', agent: 'claude' });
  });

  it('tolerates hand-written handoffs', () => {
    const h = parseHandoff('notes.md', '## Next steps\n* first thing\n* second\n');
    expect(nextStepFromHandoff(h)).toBe('first thing');
  });
});

describe('decisions', () => {
  it('serializes ADRs and reads the one-line decision', () => {
    const text = serializeDecision({
      number: 1,
      title: 'Use React Flow',
      context: 'We need a node editor.',
      decision: 'Use React Flow. It is MIT.',
      consequences: 'React is required.',
      author: 'claude-code',
      date: new Date(2026, 10, 1),
    });
    const d = parseDecision(decisionFileName(1, 'Use React Flow'), text);
    expect(d).toMatchObject({ id: '0001', number: 1, title: 'Use React Flow', status: 'proposed', date: '2026-11-01', author: 'claude-code' });
    expect(d.summary).toBe('Use React Flow.');
    expect(d.file).toBe('0001-use-react-flow.md');
  });

  it('cuts long titles at a word boundary', () => {
    expect(decisionFileName(2, 'Stop hook blocks only sessions that changed the repo')).toBe('0002-stop-hook-blocks-only-sessions-that-changed-the.md');
  });

  it('numbers after the highest existing file', () => {
    expect(nextDecisionNumber(['0001-a.md', '0007-b.md', 'README.md'])).toBe(8);
  });
});

// Written by `backlog task create` (Backlog.md 1.55).
const BACKLOG_SAMPLE = `---
id: TASK-1
title: 'First task: with/slash?'
status: In Progress
assignee: []
created_date: '2026-11-01T21:44:00Z'
updated_date: '2026-11-01T21:44:00Z'
labels:
  - ui
  - core
dependencies: []
priority: high
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Some description
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Works
- [x] #2 Tested
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
note here
<!-- SECTION:NOTES:END -->
`;

describe('varvar skill', () => {
  // The skill teaches agents the formats by example; these must stay readable by the parsers.
  it('has front matter Claude Code can load', () => {
    const { data } = parseFrontMatter<Record<string, unknown>>(SKILL_MD);
    expect(data.name).toBe('varvar');
    expect(String(data.description)).toMatch(/write_handoff/);
  });

  it('shows a handoff the parser reads', () => {
    expect(SKILL_MD).toContain(SKILL_HANDOFF_EXAMPLE);
    const h = parseHandoff('2026-11-01-1430-claude-code.md', SKILL_HANDOFF_EXAMPLE);
    expect(h).toMatchObject({ date: '2026-11-01T14:30', agent: 'claude-code', branch: 'main', commit: '0de7eb4', auto: false });
    for (const s of Object.values(h.sections)) expect(listItems(s)).toHaveLength(1);
    expect(refFromFileName('2026-11-01-1430-claude-code-2.md')).toMatchObject({ date: '2026-11-01T14:30', agent: 'claude-code' });
  });

  it('shows a decision the parser reads', () => {
    const example = /```markdown\n(---\nstatus: proposed[\s\S]*?)```/.exec(SKILL_MD)?.[1] ?? '';
    const d = parseDecision('0007-short-title.md', example);
    expect(d).toMatchObject({ number: 7, title: 'Short title', status: 'proposed', author: 'claude-code' });
    expect(d.sections.decision).toBe('What was decided.');
    expect(d.sections.consequences).toBeTruthy();
  });
});

describe('Backlog.md tasks', () => {
  it('reads files written by Backlog.md', () => {
    const t = parseTask('backlog/tasks/task-1 - First-task-with-slash.md', BACKLOG_SAMPLE, 'tasks');
    expect(t).toMatchObject({
      id: 'TASK-1',
      title: 'First task: with/slash?',
      status: 'In Progress',
      priority: 'high',
      labels: ['ui', 'core'],
      description: 'Some description',
      ordinal: 1000,
    });
    expect(t.acceptanceCriteria).toEqual([
      { index: 1, text: 'Works', checked: false },
      { index: 2, text: 'Tested', checked: true },
    ]);
  });

  it('names files like Backlog.md', () => {
    expect(sanitizeTaskTitle('First task: with/slash?')).toBe('First-task-with-slash');
    expect(taskFileName('TASK-12', 'Fix æøå & stuff')).toBe('task-12 - Fix-æøå-stuff.md');
  });

  it('writes new tasks in the same shape', () => {
    const text = serializeNewTask({
      id: 'TASK-2',
      title: 'Build: overview',
      status: 'To Do',
      description: 'Cards',
      labels: ['ui'],
      reporter: 'claude-code',
      acceptanceCriteria: ['Shows cards'],
      ordinal: 2000,
      date: new Date('2026-11-01T21:44:30Z'),
    });
    expect(text).toContain("created_date: '2026-11-01T21:44:00Z'");
    expect(text).toContain('title: "Build: overview"');
    expect(text).toContain('<!-- SECTION:DESCRIPTION:BEGIN -->\nCards\n<!-- SECTION:DESCRIPTION:END -->');
    expect(text).toContain('- [ ] #1 Shows cards');
    const back = parseTask('x.md', text, 'tasks');
    expect(back).toMatchObject({ id: 'TASK-2', reporter: 'claude-code', description: 'Cards', status: 'To Do' });
  });

  it('patches status and appends notes without touching the rest', () => {
    const out = patchTask(BACKLOG_SAMPLE, { status: 'Done', notes: 'second note', date: new Date('2026-11-02T10:00:00Z') });
    expect(out).toContain('status: Done');
    expect(out).toContain("updated_date: '2026-11-02T10:00:00Z'");
    expect(out).toContain("created_date: '2026-11-01T21:44:00Z'");
    expect(out).toContain('note here\n\nsecond note\n<!-- SECTION:NOTES:END -->');
    expect(out).toContain('- [x] #2 Tested');
  });

  it('handles ids, config and ordering', () => {
    const cfg = parseBacklogConfig('statuses: ["Todo", "Doing", "Shipped"]\ntask_prefix: "back"\nzero_padded_ids: 3\n');
    expect(cfg).toMatchObject({ statuses: ['Todo', 'Doing', 'Shipped'], defaultStatus: 'Todo', taskPrefix: 'back' });
    expect(formatTaskId(7, cfg)).toBe('BACK-007');
    expect(sameTaskId('task-007', 'TASK-7')).toBe(true);
    expect(nextTaskNumber(['TASK-1', 'TASK-1.2', 'TASK-9'])).toBe(10);
    const a = parseTask('a', '---\nid: TASK-2\nordinal: 50\n---\n', 'tasks');
    const b = parseTask('b', '---\nid: TASK-1\n---\n', 'tasks');
    expect([b, a].sort(compareTasks).map((t) => t.id)).toEqual(['TASK-2', 'TASK-1']);
  });
});

describe('brainstorm', () => {
  const b: Brainstorm = {
    version: 1,
    nodes: [
      { id: 'n-2', text: 'Risk: bundle size', kind: 'risk', x: 10.4, y: 200, links: [] },
      { id: 'n-1', text: 'Use React Flow', kind: 'idea', x: 0, y: 0, links: [{ to: 'n-2', label: 'but' }, { to: 'gone' }] },
      { id: 'n-3', text: 'Agent idea', kind: 'note', x: -320, y: 0, links: [], inbox: true, author: 'codex' },
    ],
  };

  it('serializes stably with sorted keys and nodes', () => {
    const text = serializeBrainstorm(b);
    expect(serializeBrainstorm(parseBrainstorm(text))).toBe(text);
    const parsed = JSON.parse(text);
    expect(parsed.nodes.map((n: { id: string }) => n.id)).toEqual(['n-1', 'n-2', 'n-3']);
    expect(Object.keys(parsed.nodes[0])).toEqual([...Object.keys(parsed.nodes[0])].sort());
    expect(parsed.nodes[0].links).toEqual([{ label: 'but', to: 'n-2' }]); // dangling link dropped
    expect(parsed.nodes[1].x).toBe(10);
  });

  it('renders an outline without coordinates', () => {
    const out = brainstormOutline(parseBrainstorm(serializeBrainstorm(b)));
    expect(out).toContain('- [idea] Use React Flow {n-1}');
    expect(out).toContain('  - —but→ [risk] Risk: bundle size {n-2}');
    expect(out).toContain('Inbox: 1 note');
    expect(out).toContain('[note] Agent idea (by codex)');
    expect(out).not.toMatch(/\bx\b|200/);
  });

  it('survives cycles', () => {
    const cyc: Brainstorm = {
      version: 1,
      nodes: [
        { id: 'a', text: 'A', kind: 'idea', x: 0, y: 0, links: [{ to: 'b' }] },
        { id: 'b', text: 'B', kind: 'idea', x: 0, y: 10, links: [{ to: 'a' }] },
      ],
    };
    const out = brainstormOutline(cyc);
    expect(out).toContain('(see above) {a}');
  });

  it('merges: keeps notes the client never saw, drops ones it deleted', () => {
    const current = addNote(b, { text: 'new agent note', kind: 'idea', inbox: true }).brainstorm;
    const newId = current.nodes.at(-1)!.id;
    const incoming: Brainstorm = { version: 1, nodes: b.nodes.filter((n) => n.id !== 'n-3') }; // client deleted n-3
    const merged = mergeBrainstorm(current, incoming, ['n-1', 'n-2', 'n-3']);
    expect(merged.nodes.map((n) => n.id).sort()).toEqual(['n-1', 'n-2', newId].sort());
  });
});

describe('small helpers', () => {
  it('patches front matter and keeps comments', () => {
    const src = '---\n# keep me\nstatus: proposed\ndate: 2026-11-01\n---\n# Body\n';
    const out = patchFrontMatter(src, { status: 'accepted' });
    expect(out).toContain('# keep me');
    expect(out).toContain('status: accepted');
    expect(out.endsWith('# Body\n')).toBe(true);
    expect(parseFrontMatter(out).data).toMatchObject({ status: 'accepted', date: '2026-11-01' });
  });

  it('keeps extra keys in project.yaml', () => {
    const out = patchProjectMeta('name: x\n# comment\ncustom: 1\nstatus: active\n', { status: 'paused' }, 'x');
    expect(out).toContain('custom: 1');
    expect(out).toContain('# comment');
    expect(parseProjectMeta(out, 'x').status).toBe('paused');
    expect(parseProjectMeta('status: weird', 'y')).toMatchObject({ name: 'y', status: 'active', tags: [] });
  });

  it('turns text into bullets', () => {
    expect(toBullets(['a', ' ', 'b'])).toBe('- a\n- b');
    expect(toBullets('one\ntwo')).toBe('- one\n- two');
    expect(toBullets('- already\n- bullets')).toBe('- already\n- bullets');
    expect(toBullets(undefined)).toBe('- None');
  });

  it('assigns unique ids', () => {
    const ids = assignIds(['/a/code/api', '/b/work/api', '/a/code/web']);
    expect(ids.get('/a/code/web')).toBe('web');
    expect(ids.get('/a/code/api')).toBe('code--api');
    expect(ids.get('/b/work/api')).toBe('work--api');
  });

  it('checks agent files', () => {
    expect(claudePointsToAgents('@AGENTS.md')).toBe(true);
    expect(claudePointsToAgents('# Claude\nbe nice')).toBe(false);
    expect(addClaudePointer('# Claude\nbe nice\n')).toBe('# Claude\nbe nice\n\n@AGENTS.md\n');
    expect(hasHubSnippet('# X\n\n## varvar\n- call')).toBe(true);
    expect(hasHubSnippet('# X\n\n## Project Hub\n- call')).toBe(true); // repos initialised before the rename
  });
});
