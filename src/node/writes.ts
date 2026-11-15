// Every write the hub or an agent can make. Each one writes a single file in
// the formats from the spec; nothing here commits, pushes or runs commands
// other than read-only git queries.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AGENTS_MD,
  CLAUDE_MD,
  WORK_PATHSPEC,
  addClaudePointer,
  addHubSnippet as withSnippet,
  agentsTemplate,
  claudePointsToAgents,
  hasHubSnippet,
} from '../shared/agents.js';
import {
  BACKLOG_DIR,
  TASK_FOLDERS,
  defaultBacklogConfigText,
  formatTaskId,
  idFromTaskFile,
  nextTaskNumber,
  parseBacklogConfig,
  parseTask,
  patchTask,
  sameTaskId,
  serializeNewTask,
  taskFileName,
  type TaskPatch,
} from '../shared/backlog.js';
import { BRAINSTORM_FILE, addNote, emptyBrainstorm, mergeBrainstorm, parseBrainstorm, serializeBrainstorm } from '../shared/brainstorm.js';
import { contentHash } from '../shared/datasource.js';
import {
  DECISION_DIR,
  decisionFileName,
  formatDecisionId,
  isDecisionFile,
  nextDecisionNumber,
  parseDecision,
  parseDecisionRef,
  serializeDecision,
} from '../shared/decision.js';
import { patchFrontMatter } from '../shared/frontmatter.js';
import { HANDOFF_DIR, handoffFileName, parseHandoff, serializeHandoff, sortHandoffFiles, type HandoffInput } from '../shared/handoff.js';
import { listItems, oneLine, truncate } from '../shared/markdown.js';
import { PROJECT_DIR, PROJECT_YAML, parseProjectMeta, patchProjectMeta, serializeProjectMeta } from '../shared/projectMeta.js';
import { SKILL_DIR, SKILL_FILE, SKILL_MD } from '../shared/skill.js';
import type { BrainNode, Brainstorm, NodeKind, ProjectMeta } from '../shared/types.js';
import { atomicWrite, exists, readText, resolveWritable, withLock, writeNew } from './fsutil.js';
import { currentBranch, git, headSha, isAncestor, log, status } from './git.js';

/** Agents may only write here. */
export const AGENT_WRITABLE = [PROJECT_DIR, BACKLOG_DIR];
/** The UI may also edit the agent instruction files and the varvar skill. */
export const UI_WRITABLE = [PROJECT_DIR, BACKLOG_DIR, AGENTS_MD, CLAUDE_MD, SKILL_DIR];

export interface WriteCtx {
  repo: string;
  allowed: string[];
  now?: Date;
}

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

const now = (ctx: WriteCtx) => ctx.now ?? new Date();

export function cleanAgentName(name: string | null | undefined): string {
  const clean = String(name ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || 'unknown-agent';
}

async function writeFile(ctx: WriteCtx, rel: string, content: string): Promise<string> {
  const abs = await resolveWritable(ctx.repo, rel, ctx.allowed);
  await atomicWrite(abs, content);
  return rel;
}

/** Write a new file, adding -2, -3… before the extension if the name is taken. */
async function writeUnique(ctx: WriteCtx, dir: string, name: string, content: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 100; i++) {
    const rel = `${dir}/${i === 1 ? name : `${stem}-${i}${ext}`}`;
    const abs = await resolveWritable(ctx.repo, rel, ctx.allowed);
    if (await writeNew(abs, content)) return rel;
  }
  throw new Error(`Could not find a free file name for ${name}`);
}

const readRel = (ctx: WriteCtx, rel: string) => readText(path.join(ctx.repo, rel));

async function listDir(ctx: WriteCtx, rel: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.join(ctx.repo, rel))).filter((f) => !f.startsWith('.'));
  } catch {
    return [];
  }
}

// ---------- project.yaml ----------

export async function saveProjectMeta(ctx: WriteCtx, patch: Partial<ProjectMeta>): Promise<string> {
  const text = await readRel(ctx, PROJECT_YAML);
  return writeFile(ctx, PROJECT_YAML, patchProjectMeta(text, patch, path.basename(ctx.repo)));
}

// ---------- handoffs ----------

export async function writeHandoff(ctx: WriteCtx, input: Omit<HandoffInput, 'branch' | 'commit' | 'date'>): Promise<string> {
  const date = now(ctx);
  const [branch, sha] = await Promise.all([currentBranch(ctx.repo), headSha(ctx.repo)]);
  const agent = cleanAgentName(input.agent);
  const content = serializeHandoff({ ...input, agent, branch, commit: sha?.slice(0, 7) ?? null, date });
  return writeUnique(ctx, HANDOFF_DIR, handoffFileName(date, agent), content);
}

export async function markHandoffReviewed(ctx: WriteCtx, file: string): Promise<string> {
  if (file.includes('/')) throw new NotFoundError(`Bad handoff file: ${file}`);
  const rel = `${HANDOFF_DIR}/${file}`;
  const text = await readRel(ctx, rel);
  if (text === null) throw new NotFoundError(`No handoff ${file}`);
  return writeFile(ctx, rel, patchFrontMatter(text, { reviewed: true }));
}

/**
 * Draft a handoff from the commits since the newest handoff. Used when a
 * session ends without one. Returns null when there's nothing to report.
 */
export async function draftAutoHandoff(
  ctx: WriteCtx,
  opts: { agent?: string; reason?: string } = {},
): Promise<string | null> {
  const files = sortHandoffFiles(await listDir(ctx, HANDOFF_DIR));
  const latestText = files[0] ? await readRel(ctx, `${HANDOFF_DIR}/${files[0]}`) : null;
  const latest = latestText !== null && files[0] ? parseHandoff(files[0], latestText) : null;

  // Commits that only touch project notes (e.g. the handoff itself) are not work to report.
  const paths = WORK_PATHSPEC;
  let commits;
  if (latest?.commit && (await isAncestor(ctx.repo, latest.commit))) {
    commits = await log(ctx.repo, { range: `${latest.commit}..HEAD`, max: 50, files: true, paths });
  } else if (latest?.date) {
    commits = await log(ctx.repo, { since: latest.date, max: 50, files: true, paths });
  } else {
    commits = await log(ctx.repo, { max: 10, files: true, paths });
  }
  const st = await status(ctx.repo);
  const uncommitted = st.entries.filter(
    (e) => !e.path.startsWith(`${PROJECT_DIR}/`) && !e.path.startsWith(`${BACKLOG_DIR}/`) && e.path !== AGENTS_MD && e.path !== CLAUDE_MD,
  );
  if (!commits.length && !uncommitted.length) return null;

  const done = commits.length
    ? commits.map((c) => `${c.subject} (${c.short})`)
    : ['No commits since the last handoff.'];
  const next: string[] = [];
  if (uncommitted.length) {
    const shown = uncommitted.slice(0, 8).map((e) => e.path);
    next.push(
      `Review ${uncommitted.length} uncommitted change${uncommitted.length === 1 ? '' : 's'}: ${shown.join(', ')}${uncommitted.length > shown.length ? ', …' : ''}`,
    );
  }
  if (latest) {
    const carried = listItems(latest.sections.next).slice(0, 5);
    if (carried.length) next.push(...carried.map((c) => `(from previous handoff) ${c}`));
  }
  if (!next.length) next.push('Check the commits above and write a proper handoff.');
  const touched = new Map<string, number>();
  for (const c of commits) for (const f of c.files ?? []) touched.set(f, (touched.get(f) ?? 0) + 1);
  const top = [...touched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const gotchas = [
    `Auto-drafted by varvar${opts.reason ? ` (${opts.reason})` : ''}; the agent did not write a handoff. Not reviewed.`,
  ];
  if (top.length) gotchas.push(`Files touched most: ${top.map(([f, n]) => (n > 1 ? `${f} (${n})` : f)).join(', ')}`);

  return writeHandoff(ctx, {
    agent: opts.agent ?? 'varvar',
    done,
    next,
    open_questions: ['What was the intent behind these changes, and is anything half-finished?'],
    gotchas,
    auto: true,
  });
}

// ---------- decisions ----------

export async function logDecision(
  ctx: WriteCtx,
  input: { title: string; context: string; decision: string; consequences: string; author: string; status?: string },
): Promise<{ path: string; id: string }> {
  if (!input.title.trim()) throw new Error('A decision needs a title');
  return withLock(path.join(ctx.repo, DECISION_DIR), async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const n = nextDecisionNumber(await listDir(ctx, DECISION_DIR)) + attempt;
      const rel = `${DECISION_DIR}/${decisionFileName(n, input.title)}`;
      const abs = await resolveWritable(ctx.repo, rel, ctx.allowed);
      const content = serializeDecision({ ...input, number: n, author: cleanAgentName(input.author), date: now(ctx) });
      if (await writeNew(abs, content)) return { path: rel, id: formatDecisionId(n) };
    }
    throw new Error('Could not allocate a decision number');
  });
}

export async function findDecisionFile(ctx: Pick<WriteCtx, 'repo'>, ref: string): Promise<string | null> {
  const n = parseDecisionRef(ref);
  if (n === null) return null;
  const files = (await listDir(ctx as WriteCtx, DECISION_DIR)).filter(isDecisionFile);
  return files.find((f) => Number(/^(\d+)/.exec(f)?.[1]) === n) ?? null;
}

export async function updateDecision(ctx: WriteCtx, ref: string, patch: { status: string; supersededBy?: string }): Promise<string> {
  const file = await findDecisionFile(ctx, ref);
  if (!file) throw new NotFoundError(`No decision ${ref}`);
  const rel = `${DECISION_DIR}/${file}`;
  const text = (await readRel(ctx, rel)) ?? '';
  const fm: Record<string, unknown> = { status: patch.status };
  if (patch.supersededBy) fm.superseded_by = patch.supersededBy;
  return writeFile(ctx, rel, patchFrontMatter(text, fm));
}

export async function readDecision(repo: string, ref: string) {
  const file = await findDecisionFile({ repo }, ref);
  if (!file) return null;
  const text = await readText(path.join(repo, DECISION_DIR, file));
  return text === null ? null : parseDecision(file, text);
}

// ---------- tasks (Backlog.md) ----------

async function ensureBacklog(ctx: WriteCtx): Promise<void> {
  const cfgRel = `${BACKLOG_DIR}/config.yml`;
  if (!(await exists(path.join(ctx.repo, cfgRel)))) {
    const meta = parseProjectMeta(await readRel(ctx, PROJECT_YAML), path.basename(ctx.repo));
    const abs = await resolveWritable(ctx.repo, cfgRel, ctx.allowed);
    await writeNew(abs, defaultBacklogConfigText(meta.name));
  }
  await fs.mkdir(await resolveWritable(ctx.repo, TASK_FOLDERS.tasks, ctx.allowed), { recursive: true });
}

/** Task ids used on disk and on other local branches (Backlog.md checks branches too). */
async function usedTaskIds(ctx: WriteCtx): Promise<string[]> {
  const ids: string[] = [];
  for (const dir of Object.values(TASK_FOLDERS)) {
    for (const f of await listDir(ctx, dir)) {
      const id = idFromTaskFile(f);
      if (id) ids.push(id);
    }
  }
  try {
    const refs = (await git(ctx.repo, ['for-each-ref', '--sort=-committerdate', '--count=30', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
    for (const ref of refs) {
      const out = await git(ctx.repo, ['ls-tree', '-r', '--name-only', ref, '--', ...Object.values(TASK_FOLDERS)]).catch(() => '');
      for (const line of out.split('\n')) {
        const id = idFromTaskFile(line);
        if (id) ids.push(id);
      }
    }
  } catch {
    /* no commits yet */
  }
  return ids;
}

async function maxOrdinal(ctx: WriteCtx): Promise<number> {
  let max = 0;
  for (const f of await listDir(ctx, TASK_FOLDERS.tasks)) {
    const text = await readRel(ctx, `${TASK_FOLDERS.tasks}/${f}`);
    const m = text ? /^ordinal:\s*(\d+)/m.exec(text) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

export interface AddTaskInput {
  title: string;
  description?: string;
  status?: string;
  priority?: string | null;
  labels?: string[];
  acceptanceCriteria?: string[];
  reporter: string;
  parent?: string | null;
}

export async function addTask(ctx: WriteCtx, input: AddTaskInput): Promise<{ path: string; id: string }> {
  if (!input.title.trim()) throw new Error('A task needs a title');
  await ensureBacklog(ctx);
  const cfg = parseBacklogConfig(await readRel(ctx, `${BACKLOG_DIR}/config.yml`));
  return withLock(path.join(ctx.repo, TASK_FOLDERS.tasks), async () => {
    const used = await usedTaskIds(ctx);
    const ordinal = (await maxOrdinal(ctx)) + 1000;
    const statusName = input.status
      ? (cfg.statuses.find((s) => s.toLowerCase() === input.status!.toLowerCase()) ?? input.status)
      : cfg.defaultStatus;
    for (let attempt = 0; attempt < 20; attempt++) {
      const id = formatTaskId(nextTaskNumber(used) + attempt, cfg);
      const rel = `${TASK_FOLDERS.tasks}/${taskFileName(id, input.title)}`;
      const abs = await resolveWritable(ctx.repo, rel, ctx.allowed);
      const content = serializeNewTask({
        id,
        title: input.title,
        status: statusName,
        description: input.description,
        priority: input.priority,
        labels: input.labels,
        acceptanceCriteria: input.acceptanceCriteria,
        reporter: cleanAgentName(input.reporter),
        parent: input.parent,
        ordinal,
        date: now(ctx),
      });
      if (await writeNew(abs, content)) return { path: rel, id };
    }
    throw new Error('Could not allocate a task id');
  });
}

export async function findTaskFile(repo: string, ref: string): Promise<string | null> {
  const ctx = { repo, allowed: [] } as WriteCtx;
  const cfg = parseBacklogConfig(await readRel(ctx, `${BACKLOG_DIR}/config.yml`));
  const id = /\d/.test(ref) ? formatTaskId(/(\d+(?:\.\d+)*)/.exec(ref)![1], { ...cfg, zeroPaddedIds: 0 }) : ref;
  for (const dir of Object.values(TASK_FOLDERS)) {
    for (const f of await listDir(ctx, dir)) {
      const fid = idFromTaskFile(f);
      if (fid && sameTaskId(fid, id)) return `${dir}/${f}`;
    }
  }
  return null;
}

export async function updateTask(ctx: WriteCtx, ref: string, patch: TaskPatch): Promise<string> {
  const rel = await findTaskFile(ctx.repo, ref);
  if (!rel) throw new NotFoundError(`No task ${ref}`);
  const text = (await readRel(ctx, rel)) ?? '';
  let p = patch;
  if (patch.status) {
    const cfg = parseBacklogConfig(await readRel(ctx, `${BACKLOG_DIR}/config.yml`));
    const match = cfg.statuses.find((s) => s.toLowerCase() === patch.status!.toLowerCase());
    p = { ...patch, status: match ?? patch.status };
  }
  return writeFile(ctx, rel, patchTask(text, { ...p, date: now(ctx) }));
}

export async function readTask(repo: string, ref: string) {
  const rel = await findTaskFile(repo, ref);
  if (!rel) return null;
  const text = await readText(path.join(repo, rel));
  const folder = (Object.entries(TASK_FOLDERS).find(([, dir]) => rel.startsWith(dir + '/'))?.[0] ?? 'tasks') as keyof typeof TASK_FOLDERS;
  return text === null ? null : { task: parseTask(rel, text, folder), text };
}

// ---------- brainstorm ----------

async function readBrainstorm(ctx: WriteCtx): Promise<Brainstorm> {
  const text = await readRel(ctx, BRAINSTORM_FILE);
  return text === null ? emptyBrainstorm() : parseBrainstorm(text);
}

function brainLock(ctx: WriteCtx) {
  return path.join(ctx.repo, BRAINSTORM_FILE);
}

export async function addBrainstormNote(
  ctx: WriteCtx,
  input: { text: string; kind: NodeKind; author: string; linkFrom?: string; linkLabel?: string },
): Promise<{ path: string; node: BrainNode }> {
  if (!input.text.trim()) throw new Error('A note needs text');
  return withLock(brainLock(ctx), async () => {
    const b = await readBrainstorm(ctx);
    if (input.linkFrom && !b.nodes.some((n) => n.id === input.linkFrom)) throw new NotFoundError(`No node ${input.linkFrom}`);
    const { brainstorm, node } = addNote(b, { ...input, author: cleanAgentName(input.author), inbox: true }, now(ctx));
    const rel = await writeFile(ctx, BRAINSTORM_FILE, serializeBrainstorm(brainstorm));
    return { path: rel, node };
  });
}

export async function saveBrainstorm(ctx: WriteCtx, incoming: Brainstorm, knownIds: string[]): Promise<Brainstorm> {
  return withLock(brainLock(ctx), async () => {
    const current = await readBrainstorm(ctx);
    const merged = parseBrainstorm(serializeBrainstorm(mergeBrainstorm(current, incoming, knownIds)));
    await writeFile(ctx, BRAINSTORM_FILE, serializeBrainstorm(merged));
    return merged;
  });
}

/** Turn a canvas node into a Backlog.md task or a proposed ADR, and link the node to it. */
export async function promoteNode(
  ctx: WriteCtx,
  nodeId: string,
  to: 'task' | 'decision',
  author: string,
): Promise<{ node: BrainNode; id: string; path: string }> {
  const b = await readBrainstorm(ctx);
  const node = b.nodes.find((n) => n.id === nodeId);
  if (!node) throw new NotFoundError(`No node ${nodeId}`);
  if (node.promoted) throw new ConflictError(`Node already became ${node.promoted.type} ${node.promoted.id}`);
  const title = truncate(oneLine(node.text.split('\n')[0] || node.text, 200), 120) || 'Untitled';
  const rest = node.text.includes('\n') ? node.text.slice(node.text.indexOf('\n') + 1).trim() : '';
  const origin = `From brainstorm node ${node.id} (${node.kind}).`;
  const created =
    to === 'task'
      ? await addTask(ctx, {
          title,
          description: [rest, origin].filter(Boolean).join('\n\n'),
          labels: node.kind === 'risk' ? ['risk'] : [],
          reporter: author,
        })
      : await logDecision(ctx, {
          title,
          context: [rest, origin].filter(Boolean).join('\n\n'),
          decision: '',
          consequences: '',
          author,
        });
  const id = created.id;
  const updated = await withLock(brainLock(ctx), async () => {
    const fresh = await readBrainstorm(ctx);
    const nodes = fresh.nodes.map((n) => (n.id === nodeId ? { ...n, promoted: { type: to, id } } : n));
    await writeFile(ctx, BRAINSTORM_FILE, serializeBrainstorm({ version: 1, nodes }));
    return nodes.find((n) => n.id === nodeId)!;
  });
  return { node: updated, id, path: created.path };
}

// ---------- agent files ----------

export async function saveAgentsMd(ctx: WriteCtx, content: string, baseHash: string | null): Promise<string> {
  const current = await readRel(ctx, AGENTS_MD);
  if (baseHash !== undefined && contentHash(current) !== baseHash) {
    throw new ConflictError('AGENTS.md changed on disk since you opened it. Reload and try again.');
  }
  return writeFile(ctx, AGENTS_MD, content.endsWith('\n') ? content : content + '\n');
}

export async function fixClaudePointer(ctx: WriteCtx): Promise<string> {
  const current = await readRel(ctx, CLAUDE_MD);
  return writeFile(ctx, CLAUDE_MD, addClaudePointer(current));
}

export async function addHubSnippet(ctx: WriteCtx): Promise<string> {
  const current = await readRel(ctx, AGENTS_MD);
  const meta = parseProjectMeta(await readRel(ctx, PROJECT_YAML), path.basename(ctx.repo));
  return writeFile(ctx, AGENTS_MD, current === null ? agentsTemplate(meta.name, meta.summary) : withSnippet(current));
}

// ---------- initialise ----------

/**
 * Create .project/, AGENTS.md, the CLAUDE.md pointer and the varvar skill. Never removes
 * content: an existing CLAUDE.md without AGENTS.md is moved into AGENTS.md
 * and replaced by the pointer.
 */
export async function initialise(ctx: WriteCtx): Promise<{ created: string[]; changed: string[] }> {
  const created: string[] = [];
  const changed: string[] = [];
  const name = path.basename(ctx.repo);

  const yamlAbs = await resolveWritable(ctx.repo, PROJECT_YAML, ctx.allowed);
  if (await writeNew(yamlAbs, serializeProjectMeta({ name, summary: '', status: 'active', tags: [], next_step: '' }))) {
    created.push(PROJECT_YAML);
  }
  for (const dir of [HANDOFF_DIR, DECISION_DIR]) {
    const keep = `${dir}/.gitkeep`;
    if (await writeNew(await resolveWritable(ctx.repo, keep, ctx.allowed), '')) created.push(keep);
  }
  const brainAbs = await resolveWritable(ctx.repo, BRAINSTORM_FILE, ctx.allowed);
  if (await writeNew(brainAbs, serializeBrainstorm(emptyBrainstorm()))) created.push(BRAINSTORM_FILE);
  if (await writeNew(await resolveWritable(ctx.repo, SKILL_FILE, ctx.allowed), SKILL_MD)) created.push(SKILL_FILE);

  const meta = parseProjectMeta(await readRel(ctx, PROJECT_YAML), name);
  const agents = await readRel(ctx, AGENTS_MD);
  const claude = await readRel(ctx, CLAUDE_MD);
  if (agents === null) {
    const movedClaude = claude?.trim() && !claudePointsToAgents(claude) ? claude : null;
    const content = movedClaude ? withSnippet(movedClaude) : agentsTemplate(meta.name, meta.summary);
    await writeFile(ctx, AGENTS_MD, content);
    created.push(AGENTS_MD);
    if (movedClaude) {
      await writeFile(ctx, CLAUDE_MD, addClaudePointer(null));
      changed.push(CLAUDE_MD);
    }
  } else if (!hasHubSnippet(agents)) {
    await writeFile(ctx, AGENTS_MD, withSnippet(agents));
    changed.push(AGENTS_MD);
  }
  const claudeNow = await readRel(ctx, CLAUDE_MD);
  if (claudeNow === null) {
    await writeFile(ctx, CLAUDE_MD, addClaudePointer(null));
    created.push(CLAUDE_MD);
  } else if (!claudePointsToAgents(claudeNow)) {
    await writeFile(ctx, CLAUDE_MD, addClaudePointer(claudeNow));
    changed.push(CLAUDE_MD);
  }
  return { created, changed };
}
