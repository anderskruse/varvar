// Reading and writing tasks in the Backlog.md file format, so Backlog.md's own
// CLI, board and MCP server keep working on the same files.
import YAML from 'yaml';
import { asString, asStringArray, normalizeNewlines, parseFrontMatter, patchFrontMatter } from './frontmatter.js';
import { getSection } from './markdown.js';
import type { AcceptanceCriterion, Task, TaskFolder } from './types.js';

export const BACKLOG_DIR = 'backlog';
export const TASK_FOLDERS: Record<TaskFolder, string> = {
  tasks: 'backlog/tasks',
  drafts: 'backlog/drafts',
  completed: 'backlog/completed',
  archive: 'backlog/archive/tasks',
};

export interface BacklogConfig {
  projectName: string | null;
  statuses: string[];
  defaultStatus: string;
  taskPrefix: string;
  zeroPaddedIds: number;
}

export const DEFAULT_BACKLOG_CONFIG: BacklogConfig = {
  projectName: null,
  statuses: ['To Do', 'In Progress', 'Done'],
  defaultStatus: 'To Do',
  taskPrefix: 'task',
  zeroPaddedIds: 0,
};

export function parseBacklogConfig(text: string | null): BacklogConfig {
  if (!text) return { ...DEFAULT_BACKLOG_CONFIG };
  let data: Record<string, unknown> = {};
  try {
    data = (YAML.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    data = {};
  }
  const statuses = asStringArray(data.statuses);
  const cfg: BacklogConfig = {
    projectName: asString(data.project_name),
    statuses: statuses.length ? statuses : DEFAULT_BACKLOG_CONFIG.statuses,
    defaultStatus: asString(data.default_status) ?? (statuses[0] || DEFAULT_BACKLOG_CONFIG.defaultStatus),
    taskPrefix: (asString(data.task_prefix) ?? 'task').replace(/[^a-zA-Z]/g, '') || 'task',
    zeroPaddedIds: Number(data.zero_padded_ids) || 0,
  };
  return cfg;
}

/** Config written when the hub creates backlog/ in a repo that has none. Mirrors `backlog init --defaults`. */
export function defaultBacklogConfigText(projectName: string): string {
  return [
    `project_name: ${JSON.stringify(projectName)}`,
    'default_status: "To Do"',
    'statuses: ["To Do", "In Progress", "Done"]',
    'labels: []',
    'date_format: yyyy-mm-dd',
    'max_column_width: 20',
    'auto_open_browser: true',
    'default_port: 6420',
    'remote_operations: true',
    'auto_commit: false',
    'bypass_git_hooks: false',
    'check_active_branches: true',
    'active_branch_days: 30',
    'task_prefix: "task"',
    '',
  ].join('\n');
}

export function isDoneStatus(status: string, cfg: BacklogConfig): boolean {
  const s = status.trim().toLowerCase();
  const last = cfg.statuses[cfg.statuses.length - 1]?.toLowerCase();
  return s === 'done' || s === last;
}

export function isOpenTask(t: Task, cfg: BacklogConfig): boolean {
  return t.folder === 'tasks' && !isDoneStatus(t.status, cfg);
}

// ---------- ids and file names ----------

export function formatTaskId(n: number | string, cfg: Pick<BacklogConfig, 'taskPrefix' | 'zeroPaddedIds'>): string {
  const num = typeof n === 'number' && cfg.zeroPaddedIds ? String(n).padStart(cfg.zeroPaddedIds, '0') : String(n);
  return `${cfg.taskPrefix.toUpperCase()}-${num}`;
}

/** "3", "task-3", "TASK-3", "task-3 - Title.md" → "TASK-3" (keeps sub-task suffixes like 1.1). */
export function normalizeTaskId(ref: string, cfg: Pick<BacklogConfig, 'taskPrefix' | 'zeroPaddedIds'>): string {
  const m = /(\d+(?:\.\d+)*)/.exec(ref.trim());
  if (!m) return ref.trim().toUpperCase();
  return `${cfg.taskPrefix.toUpperCase()}-${m[1]}`;
}

export function taskNumber(id: string): number | null {
  const m = /-(\d+)(?:\.\d+)*$/.exec(id) ?? /^(\d+)/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Same id, ignoring case and zero padding. */
export function sameTaskId(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .toUpperCase()
      .replace(/-0+(\d)/, '-$1');
  return norm(a) === norm(b);
}

export function nextTaskNumber(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const n = taskNumber(id);
    if (n !== null) max = Math.max(max, n);
  }
  return max + 1;
}

/** Backlog.md style: "First task: with/slash?" → "First-task-with-slash". */
export function sanitizeTaskTitle(title: string): string {
  return (
    title
      .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'task'
  );
}

export function taskFileName(id: string, title: string): string {
  return `${id.toLowerCase()} - ${sanitizeTaskTitle(title)}.md`;
}

/** Task id from a file name like "task-3 - Title.md". */
export function idFromTaskFile(file: string): string | null {
  const base = file.split('/').pop() ?? file;
  const m = /^([a-zA-Z]+-\d+(?:\.\d+)*)/.exec(base);
  return m ? m[1].toUpperCase() : null;
}

// ---------- parsing ----------

const MARKED = (name: string) =>
  new RegExp(`<!--\\s*SECTION:${name}:BEGIN\\s*-->\\n?([\\s\\S]*?)\\n?<!--\\s*SECTION:${name}:END\\s*-->`);

function markedSection(body: string, name: string, heading: string): string {
  const m = MARKED(name).exec(body);
  if (m) return m[1].trim();
  return getSection(body, heading)
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function parseCriteria(body: string): AcceptanceCriterion[] {
  const block = /<!--\s*AC:BEGIN\s*-->([\s\S]*?)<!--\s*AC:END\s*-->/.exec(body)?.[1] ?? getSection(body, 'Acceptance Criteria');
  const out: AcceptanceCriterion[] = [];
  for (const line of block.split('\n')) {
    const m = /^\s*-\s*\[([ xX])\]\s*(?:#(\d+)\s+)?(.*)$/.exec(line);
    if (m) out.push({ index: m[2] ? Number(m[2]) : out.length + 1, checked: m[1] !== ' ', text: m[3].trim() });
  }
  return out;
}

export function parseTask(file: string, text: string, folder: TaskFolder): Task {
  const { data, body } = parseFrontMatter<Record<string, unknown>>(text);
  const id = asString(data.id)?.toUpperCase() ?? idFromTaskFile(file) ?? file;
  const ordinal = data.ordinal === undefined || data.ordinal === null ? null : Number(data.ordinal);
  return {
    id,
    title: asString(data.title) ?? id,
    status: asString(data.status) ?? 'To Do',
    priority: asString(data.priority),
    labels: asStringArray(data.labels),
    assignee: asStringArray(data.assignee),
    reporter: asString(data.reporter),
    created: asString(data.created_date),
    updated: asString(data.updated_date),
    parent: asString(data.parent_task_id ?? data.parent),
    dependencies: asStringArray(data.dependencies),
    ordinal: Number.isFinite(ordinal) ? ordinal : null,
    description: markedSection(body, 'DESCRIPTION', 'Description'),
    acceptanceCriteria: parseCriteria(body),
    file,
    folder,
  };
}

// ---------- writing ----------

/** Backlog.md writes "2026-11-01T21:44:00Z". */
export function backlogTimestamp(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 16)}:00Z`;
}

export interface NewTaskInput {
  id: string;
  title: string;
  status: string;
  description?: string;
  priority?: string | null;
  labels?: string[];
  assignee?: string[];
  reporter?: string | null;
  acceptanceCriteria?: string[];
  parent?: string | null;
  ordinal?: number;
  date?: Date;
}

function yamlFront(data: Record<string, unknown>, quoted: string[]): string {
  const doc = new YAML.Document(data);
  for (const key of quoted) {
    const node = doc.get(key, true);
    if (YAML.isScalar(node)) node.type = 'QUOTE_SINGLE';
  }
  return doc.toString({ lineWidth: 0 });
}

export function serializeNewTask(input: NewTaskInput): string {
  const created = backlogTimestamp(input.date);
  const front: Record<string, unknown> = {
    id: input.id,
    title: input.title.trim(),
    status: input.status,
    assignee: input.assignee ?? [],
  };
  if (input.reporter) front.reporter = input.reporter;
  front.created_date = created;
  front.labels = input.labels ?? [];
  front.dependencies = [];
  if (input.parent) front.parent_task_id = input.parent;
  if (input.priority) front.priority = input.priority;
  if (input.ordinal !== undefined) front.ordinal = input.ordinal;

  const parts: string[] = [];
  const desc = input.description?.trim();
  if (desc) {
    parts.push('## Description', '', '<!-- SECTION:DESCRIPTION:BEGIN -->', desc, '<!-- SECTION:DESCRIPTION:END -->', '');
  }
  const ac = (input.acceptanceCriteria ?? []).map((s) => s.trim()).filter(Boolean);
  if (ac.length) {
    parts.push('## Acceptance Criteria', '<!-- AC:BEGIN -->', ...ac.map((c, i) => `- [ ] #${i + 1} ${c}`), '<!-- AC:END -->', '');
  }
  return `---\n${yamlFront(front, ['created_date'])}---\n\n${parts.join('\n')}\n`.replace(/\n{3,}$/, '\n\n');
}

export interface TaskPatch {
  status?: string;
  title?: string;
  priority?: string | null;
  labels?: string[];
  assignee?: string[];
  /** Appended to the Implementation Notes section. */
  notes?: string;
  date?: Date;
}

export function patchTask(text: string, patch: TaskPatch): string {
  const fm: Record<string, unknown> = {};
  if (patch.status !== undefined) fm.status = patch.status;
  if (patch.title !== undefined) fm.title = patch.title.trim();
  if (patch.priority !== undefined) fm.priority = patch.priority || undefined;
  if (patch.labels !== undefined) fm.labels = patch.labels;
  if (patch.assignee !== undefined) fm.assignee = patch.assignee;
  let out = normalizeNewlines(text);
  if (Object.keys(fm).length || patch.notes) {
    fm.updated_date = backlogTimestamp(patch.date);
    out = patchFrontMatter(out, fm);
    out = requoteFront(out, ['created_date', 'updated_date']);
  }
  if (patch.notes?.trim()) out = appendNotes(out, patch.notes.trim());
  return out;
}

/** Keep Backlog.md's quoting of date fields after a patch. */
function requoteFront(text: string, keys: string[]): string {
  return text.replace(/^---\n([\s\S]*?)\n---/, (all, yaml: string) => {
    const lines = yaml.split('\n').map((line) => {
      for (const k of keys) {
        const m = new RegExp(`^${k}:\\s+([^'"\\s].*)$`).exec(line);
        if (m) return `${k}: '${m[1]}'`;
      }
      return line;
    });
    return `---\n${lines.join('\n')}\n---`;
  });
}

function appendNotes(text: string, note: string): string {
  const block = /(<!--\s*SECTION:NOTES:BEGIN\s*-->)([\s\S]*?)(<!--\s*SECTION:NOTES:END\s*-->)/;
  if (block.test(text)) {
    return text.replace(block, (_all, begin: string, inner: string, end: string) => {
      const existing = inner.trim();
      return `${begin}\n${existing ? `${existing}\n\n` : ''}${note}\n${end}`;
    });
  }
  const trimmed = text.replace(/\s+$/, '');
  return `${trimmed}\n\n## Implementation Notes\n\n<!-- SECTION:NOTES:BEGIN -->\n${note}\n<!-- SECTION:NOTES:END -->\n`;
}

/** Sort for boards: ordinal first, then id number. */
export function compareTasks(a: Task, b: Task): number {
  const oa = a.ordinal ?? Number.MAX_SAFE_INTEGER;
  const ob = b.ordinal ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return (taskNumber(a.id) ?? 0) - (taskNumber(b.id) ?? 0);
}
