// The hub's MCP server: the same view of projects the UI has, for agents.
// Reads are open; writes go only to .project/ and backlog/. No tool commits,
// pushes or runs shell commands.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { brainstormOutline, parseBrainstorm, BRAINSTORM_FILE } from '../shared/brainstorm.js';
import { compareTasks, isDoneStatus, parseBacklogConfig } from '../shared/backlog.js';
import { HANDOFF_DIR, parseHandoff, sortHandoffFiles } from '../shared/handoff.js';
import { NODE_KINDS, type NodeKind } from '../shared/types.js';
import { readText } from '../node/fsutil.js';
import { formatHit, readDecisions, readTasks, resolveSince, commitsSince, searchRepo, type SearchHit } from '../node/history.js';
import { mapLimit, type Hub, type RepoRef } from '../node/hub.js';
import { status as gitStatus } from '../node/git.js';
import {
  AGENT_WRITABLE,
  addBrainstormNote,
  addTask,
  cleanAgentName,
  logDecision,
  readDecision,
  readTask,
  updateTask,
  writeHandoff,
  type WriteCtx,
} from '../node/writes.js';
import { cap, decisionLine, decisionText, handoffText, projectLine, statusText, taskLine } from './format.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';

export interface McpOptions {
  /** Directory whose repo is the default project (the agent's working directory). */
  cwd: string;
  /** Fallback agent name when the client doesn't identify itself. */
  agentName?: string;
  version?: string;
}

const INSTRUCTIONS = `varvar gives you the state and history of this repo (and the user's other repos).
- At the start of a session, call get_status and get_handoff for this repo.
- Before you finish, call write_handoff with done, next, open questions and gotchas.
- Record lasting choices with log_decision, new ideas with add_brainstorm_note, work items with add_task.
- "project" defaults to the repo in your working directory; pass a project id from list_projects for other repos.
Responses are short summaries; follow the hints at the end of a response to get more.`;

type Text = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): Text => ({ content: [{ type: 'text', text: t }], isError: true });

const listOrText = z.union([z.string(), z.array(z.string())]);
const projectArg = z
  .string()
  .optional()
  .describe('Project id, name or path. Defaults to the repo in the working directory.');

export function createMcpServer(hub: Hub, opts: McpOptions): McpServer {
  const server = new McpServer({ name: 'varvar', version: opts.version ?? '0.1.0' }, { instructions: INSTRUCTIONS });

  const agentName = (explicit?: string) =>
    cleanAgentName(explicit || opts.agentName || server.server.getClientVersion()?.name || 'unknown-agent');

  async function project(ref?: string): Promise<RepoRef> {
    if (ref?.trim()) return hub.mustResolve(ref);
    const r = await hub.resolvePath(opts.cwd);
    if (!r) throw new Error(`The working directory ${opts.cwd} is not inside a git repo. Pass "project" (see list_projects).`);
    return r;
  }

  const writeCtx = (r: RepoRef): WriteCtx => ({ repo: r.path, allowed: AGENT_WRITABLE });

  /** Wrap a tool body: errors become tool errors, not protocol errors. */
  const run =
    <A>(fn: (args: A) => Promise<string>) =>
    async (args: A): Promise<Text> => {
      try {
        return text(await fn(args));
      } catch (e) {
        return fail((e as Error).message);
      }
    };

  // ---------------- reads ----------------

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        'All git repos varvar knows, one line each: id | name | status | last commit | next step. Sorted by last activity.',
      inputSchema: {
        filter: z.string().optional().describe('Substring to match against id, name, summary or tags.'),
        status: z.enum(['active', 'paused', 'archived', 'uninitialised', 'stale']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ filter, status }) => {
      let list = await hub.listProjects({ maxAgeMs: 60_000 });
      if (filter) {
        const f = filter.toLowerCase();
        list = list.filter((s) => [s.id, s.name, s.summary, ...s.tags].some((x) => x.toLowerCase().includes(f)));
      }
      if (status === 'uninitialised') list = list.filter((s) => !s.initialised);
      else if (status === 'stale') list = list.filter((s) => s.stale);
      else if (status) list = list.filter((s) => s.status === status);
      list.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
      if (!list.length) return 'No projects match.';
      const body = list.map(projectLine).join('\n');
      return cap(`${list.length} project${list.length === 1 ? '' : 's'}:\n${body}`, 'Use filter or status to narrow the list.');
    }),
  );

  server.registerTool(
    'get_status',
    {
      title: 'Project status',
      description: 'Git signals (branch, sync, uncommitted work, open branches), the next step, latest handoff and open task count.',
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref }) => {
      const r = await project(ref);
      const s = await hub.refreshRepo(r);
      return cap(statusText(s), 'Call get_handoff, get_tasks or changes_since for details.');
    }),
  );

  server.registerTool(
    'get_handoff',
    {
      title: 'Latest handoff(s)',
      description: 'The newest handoff in full (what was done, what is next, open questions, gotchas). count > 1 returns older ones too.',
      inputSchema: {
        project: projectArg,
        count: z.number().int().min(1).max(10).optional().describe('How many handoffs, newest first. Default 1.'),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref, count }) => {
      const r = await project(ref);
      const files = sortHandoffFiles(await fs.readdir(path.join(r.path, HANDOFF_DIR)).catch(() => [] as string[]));
      if (!files.length) return 'No handoffs yet. Use get_status and changes_since to orient yourself.';
      const n = count ?? 1;
      const out: string[] = [];
      for (const f of files.slice(0, n)) {
        const t = await readText(path.join(r.path, HANDOFF_DIR, f));
        if (t !== null) out.push(handoffText(parseHandoff(f, t)));
      }
      const more = files.length > n ? `\n\n(${files.length - n} older handoff${files.length - n === 1 ? '' : 's'}; pass count to see more.)` : '';
      return cap(out.join('\n\n---\n\n') + more, 'Use a smaller count.');
    }),
  );

  server.registerTool(
    'changes_since',
    {
      title: 'Changes since',
      description:
        'Commit summaries and the files they touched since a date, a commit, or the last handoff (default). Also lists uncommitted files. No diffs.',
      inputSchema: {
        project: projectArg,
        since: z.string().optional().describe('"last_handoff" (default), a commit sha/ref, or a date like 2026-10-01 or "3 days ago".'),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref, since }) => {
      const r = await project(ref);
      const spec = await resolveSince(r.path, since);
      const commits = await commitsSince(r.path, spec, 200, true);
      const lines: string[] = [`Since ${spec.label}: ${commits.length}${commits.length === 200 ? '+' : ''} commit${commits.length === 1 ? '' : 's'}`];
      for (const c of commits.slice(0, 40)) {
        lines.push(`- ${c.short} ${c.date.slice(0, 16)} ${c.author}: ${c.subject} (${c.files?.length ?? 0} files)`);
      }
      if (commits.length > 40) lines.push(`- … ${commits.length - 40} older commits not shown`);
      const touched = new Map<string, number>();
      for (const c of commits) for (const f of c.files ?? []) touched.set(f, (touched.get(f) ?? 0) + 1);
      if (touched.size) {
        const top = [...touched.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        lines.push('', `Files touched (${touched.size}):`);
        lines.push(...top.slice(0, 40).map(([f, n]) => `- ${f}${n > 1 ? ` (${n} commits)` : ''}`));
        if (top.length > 40) lines.push(`- … ${top.length - 40} more`);
      }
      const st = await gitStatus(r.path).catch(() => null);
      if (st?.entries.length) {
        lines.push('', `Uncommitted (${st.entries.length}):`, ...st.entries.slice(0, 20).map((e) => `- ${e.xy.trim() || '?'} ${e.path}`));
      }
      return cap(lines.join('\n'), 'Pass a later "since" to narrow the range.');
    }),
  );

  server.registerTool(
    'get_decisions',
    {
      title: 'Decisions',
      description: 'Architecture decisions, newest first: id, status, title and the decision in one line. Use get_decision for the full text.',
      inputSchema: {
        project: projectArg,
        status: z.enum(['proposed', 'accepted', 'superseded', 'rejected']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref, status }) => {
      const r = await project(ref);
      let ds = await readDecisions(r.path);
      if (status) ds = ds.filter((d) => d.status === status);
      if (!ds.length) return status ? `No ${status} decisions.` : 'No decisions recorded yet. Use log_decision to add one.';
      return cap(ds.map(decisionLine).join('\n'), 'Filter by status, or call get_decision for one.');
    }),
  );

  server.registerTool(
    'get_decision',
    {
      title: 'Decision',
      description: 'Full text of one decision.',
      inputSchema: { project: projectArg, id: z.string().describe('Decision number, e.g. "3" or "0003".') },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref, id }) => {
      const r = await project(ref);
      const d = await readDecision(r.path, id);
      if (!d) throw new Error(`No decision ${id}. Call get_decisions to list them.`);
      return cap(decisionText(d), `Read .project/decisions/${d.file} directly for the rest.`);
    }),
  );

  server.registerTool(
    'get_tasks',
    {
      title: 'Tasks',
      description: 'Backlog.md tasks, one line each: id [status] title (priority) #labels. Done tasks are hidden unless status is given.',
      inputSchema: {
        project: projectArg,
        status: z.string().optional().describe('Only tasks with this status, e.g. "To Do", "In Progress", "Done".'),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref, status }) => {
      const r = await project(ref);
      const cfg = parseBacklogConfig(await readText(path.join(r.path, 'backlog/config.yml')));
      let tasks = (await readTasks(r.path)).sort(compareTasks);
      if (!tasks.length) return 'No tasks. Use add_task to create one.';
      if (status) tasks = tasks.filter((t) => t.status.toLowerCase() === status.toLowerCase());
      else tasks = tasks.filter((t) => !isDoneStatus(t.status, cfg));
      const groups = new Map<string, string[]>();
      for (const t of tasks) groups.set(t.status, [...(groups.get(t.status) ?? []), taskLine(t)]);
      const order = [...cfg.statuses, ...[...groups.keys()].filter((k) => !cfg.statuses.includes(k))];
      const out = order.filter((s) => groups.has(s)).map((s) => `${s} (${groups.get(s)!.length}):\n${groups.get(s)!.join('\n')}`);
      if (!out.length) return status ? `No tasks with status "${status}".` : 'All tasks are done.';
      return cap(out.join('\n\n'), 'Filter by status, or call get_task for one task.');
    }),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Task',
      description: 'Full text of one Backlog.md task.',
      inputSchema: { project: projectArg, id: z.string().describe('Task id, e.g. "TASK-3" or "3".') },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref, id }) => {
      const r = await project(ref);
      const t = await readTask(r.path, id);
      if (!t) throw new Error(`No task ${id}. Call get_tasks to list them.`);
      return cap(`${t.task.file}\n\n${t.text.trim()}`, `Read ${t.task.file} directly for the rest.`);
    }),
  );

  server.registerTool(
    'get_brainstorm',
    {
      title: 'Brainstorm canvas',
      description: "The project's brainstorm canvas as an indented outline (ideas, questions, risks, notes and their links), plus Inbox notes.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    run(async ({ project: ref }) => {
      const r = await project(ref);
      const t = await readText(path.join(r.path, BRAINSTORM_FILE));
      if (t === null) return 'No brainstorm canvas yet. Use add_brainstorm_note to start one.';
      return cap(brainstormOutline(parseBrainstorm(t)), 'The full canvas is in .project/brainstorm.json.');
    }),
  );

  server.registerTool(
    'search_history',
    {
      title: 'Search history',
      description:
        'Search commits, handoffs, decisions and tasks for a phrase. Searches all repos when project is omitted, so you can reuse what worked elsewhere.',
      inputSchema: {
        query: z.string().min(2),
        project: z.string().optional().describe('Limit to one project (id, name or path). Omit to search every repo.'),
      },
      annotations: { readOnlyHint: true },
    },
    run(async ({ query, project: ref }) => {
      const repos = ref ? [await hub.mustResolve(ref)] : await hub.discover();
      const results = await mapLimit(repos, 6, async (r) => ({ r, hits: await searchRepo(r.path, query, ref ? 20 : 5).catch(() => [] as SearchHit[]) }));
      const blocks = results
        .filter((x) => x.hits.length)
        .map((x) => `## ${x.r.id}\n${x.hits.map(formatHit).join('\n')}`);
      if (!blocks.length) return `No matches for "${query}"${ref ? '' : ` in ${repos.length} repos`}.`;
      return cap(blocks.join('\n\n'), 'Narrow with project, or use a more specific query. Open hits with get_handoff, get_decision or get_task.');
    }),
  );

  // ---------------- writes ----------------

  server.registerTool(
    'write_handoff',
    {
      title: 'Write handoff',
      description:
        'Write a new handoff for the next session (human or agent). Call before you finish. Each field takes a list of short bullet points (or Markdown text).',
      inputSchema: {
        project: projectArg,
        done: listOrText.describe('What was done this session.'),
        next: listOrText.describe('Concrete next steps, most important first.'),
        open_questions: listOrText.optional().describe('Unresolved questions for the user or the next agent.'),
        gotchas: listOrText.optional().describe('Traps, surprises, things that look wrong but are intended.'),
        agent: z.string().optional().describe('Your name, e.g. "claude-code". Defaults to the MCP client name.'),
      },
    },
    run(async (a) => {
      const r = await project(a.project);
      const file = await writeHandoff(writeCtx(r), {
        agent: agentName(a.agent),
        done: a.done,
        next: a.next,
        open_questions: a.open_questions,
        gotchas: a.gotchas,
      });
      return `Wrote ${file}. It is not committed; the user commits project notes.`;
    }),
  );

  server.registerTool(
    'add_task',
    {
      title: 'Add task',
      description: 'Create a Backlog.md task in backlog/tasks/.',
      inputSchema: {
        project: projectArg,
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.string().optional().describe('Defaults to the backlog default status (usually "To Do").'),
        priority: z.enum(['high', 'medium', 'low']).optional(),
        labels: z.array(z.string()).optional(),
        acceptance_criteria: z.array(z.string()).optional(),
        parent: z.string().optional().describe('Parent task id for a sub-task.'),
        agent: z.string().optional(),
      },
    },
    run(async (a) => {
      const r = await project(a.project);
      const res = await addTask(writeCtx(r), {
        title: a.title,
        description: a.description,
        status: a.status,
        priority: a.priority,
        labels: a.labels,
        acceptanceCriteria: a.acceptance_criteria,
        parent: a.parent,
        reporter: agentName(a.agent),
      });
      return `Created ${res.id} in ${res.path}.`;
    }),
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update task',
      description: 'Change a task\'s status, title, priority or labels, or append implementation notes.',
      inputSchema: {
        project: projectArg,
        id: z.string(),
        status: z.string().optional(),
        title: z.string().optional(),
        priority: z.enum(['high', 'medium', 'low']).optional(),
        labels: z.array(z.string()).optional(),
        notes: z.string().optional().describe('Appended to the Implementation Notes section.'),
        agent: z.string().optional(),
      },
    },
    run(async (a) => {
      const r = await project(a.project);
      const by = agentName(a.agent);
      const notes = a.notes ? `${a.notes.trim()}\n\n_(${by}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')})_` : undefined;
      const file = await updateTask(writeCtx(r), a.id, {
        status: a.status,
        title: a.title,
        priority: a.priority,
        labels: a.labels,
        notes,
      });
      return `Updated ${file}.`;
    }),
  );

  server.registerTool(
    'log_decision',
    {
      title: 'Log decision',
      description: 'Record a lasting decision as a new ADR with status "proposed" for the user to accept.',
      inputSchema: {
        project: projectArg,
        title: z.string().min(3).describe('Short imperative title, e.g. "Use React Flow for the canvas".'),
        context: z.string().describe('Why a decision was needed: the forces and constraints.'),
        decision: z.string().describe('What was decided. Start with a one-sentence summary.'),
        consequences: z.string().describe('What becomes easier or harder as a result.'),
        agent: z.string().optional(),
      },
    },
    run(async (a) => {
      const r = await project(a.project);
      const res = await logDecision(writeCtx(r), { ...a, author: agentName(a.agent) });
      return `Logged decision ${res.id} (proposed) in ${res.path}.`;
    }),
  );

  server.registerTool(
    'add_brainstorm_note',
    {
      title: 'Add brainstorm note',
      description: "Add an idea, question, risk or note to the project's brainstorm canvas. It lands in the Inbox for the user to place or discard.",
      inputSchema: {
        project: projectArg,
        text: z.string().min(1),
        kind: z.enum(NODE_KINDS as [NodeKind, ...NodeKind[]]).default('idea'),
        link_from: z.string().optional().describe('Id of an existing node (from get_brainstorm) this note follows from.'),
        link_label: z.string().optional().describe('Short label for that link.'),
        agent: z.string().optional(),
      },
    },
    run(async (a) => {
      const r = await project(a.project);
      const res = await addBrainstormNote(writeCtx(r), {
        text: a.text,
        kind: a.kind ?? 'idea',
        author: agentName(a.agent),
        linkFrom: a.link_from,
        linkLabel: a.link_label,
      });
      return `Added ${res.node.kind} ${res.node.id} to the brainstorm Inbox.`;
    }),
  );

  return server;
}

