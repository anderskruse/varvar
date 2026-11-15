// Reads a project's files through an abstract reader, so the same logic serves
// the local hub (files on disk) and a hosted GitHub mode (files from the API).
import { AGENTS_MD, CLAUDE_MD, claudePointsToAgents, hasHubSnippet } from './agents.js';
import { compareTasks, isOpenTask, parseBacklogConfig, parseTask, TASK_FOLDERS, type BacklogConfig } from './backlog.js';
import { BRAINSTORM_FILE, parseBrainstorm } from './brainstorm.js';
import { daysBetween, toTime } from './dates.js';
import { DECISION_DIR, isDecisionFile, parseDecision } from './decision.js';
import { HANDOFF_DIR, nextStepFromHandoff, parseHandoff, refFromFileName, sortHandoffFiles, toRef } from './handoff.js';
import { PROJECT_DIR, PROJECT_YAML, parseProjectMeta } from './projectMeta.js';
import type {
  Brainstorm,
  Decision,
  GitSignals,
  Handoff,
  HandoffRef,
  ProjectDetail,
  ProjectMeta,
  ProjectSummary,
  Task,
  TaskFolder,
} from './types.js';

export interface RepoReader {
  /** Entry names directly inside a repo-relative directory; [] when missing. */
  list(dir: string): Promise<string[]>;
  /** File contents, or null when missing. */
  read(path: string): Promise<string | null>;
}

export interface ProjectFiles {
  initialised: boolean;
  meta: ProjectMeta | null;
  handoffFiles: string[];
  latestHandoff: Handoff | null;
  backlog: BacklogConfig;
  hasBacklog: boolean;
  tasks: Task[];
  agentsMd: string | null;
  claudeMd: string | null;
}

export interface ProjectFilesFull extends ProjectFiles {
  decisions: Decision[];
  brainstorm: Brainstorm | null;
  brainstormError: string | null;
}

async function readTasks(r: RepoReader, folders: TaskFolder[]): Promise<Task[]> {
  const tasks: Task[] = [];
  for (const folder of folders) {
    const dir = TASK_FOLDERS[folder];
    const files = (await r.list(dir)).filter((f) => f.endsWith('.md'));
    const texts = await Promise.all(files.map((f) => r.read(`${dir}/${f}`)));
    files.forEach((f, i) => {
      const text = texts[i];
      if (text !== null) tasks.push(parseTask(`${dir}/${f}`, text, folder));
    });
  }
  return tasks.sort(compareTasks);
}

export async function readProjectFiles(r: RepoReader, dirName: string): Promise<ProjectFiles> {
  const [projectEntries, metaText, handoffEntries, backlogEntries, backlogConfigText, agentsMd, claudeMd] = await Promise.all([
    r.list(PROJECT_DIR),
    r.read(PROJECT_YAML),
    r.list(HANDOFF_DIR),
    r.list('backlog'),
    r.read('backlog/config.yml'),
    r.read(AGENTS_MD),
    r.read(CLAUDE_MD),
  ]);
  const handoffFiles = sortHandoffFiles(handoffEntries);
  let latestHandoff: Handoff | null = null;
  if (handoffFiles[0]) {
    const text = await r.read(`${HANDOFF_DIR}/${handoffFiles[0]}`);
    if (text !== null) latestHandoff = parseHandoff(handoffFiles[0], text);
  }
  const hasBacklog = backlogEntries.length > 0;
  return {
    initialised: projectEntries.length > 0,
    meta: projectEntries.length > 0 ? parseProjectMeta(metaText, dirName) : null,
    handoffFiles,
    latestHandoff,
    backlog: parseBacklogConfig(backlogConfigText),
    hasBacklog,
    tasks: hasBacklog ? await readTasks(r, ['tasks']) : [],
    agentsMd,
    claudeMd,
  };
}

export async function readProjectFilesFull(r: RepoReader, dirName: string): Promise<ProjectFilesFull> {
  const base = await readProjectFiles(r, dirName);
  const decisionFiles = (await r.list(DECISION_DIR)).filter(isDecisionFile).sort().reverse();
  const decisionTexts = await Promise.all(decisionFiles.map((f) => r.read(`${DECISION_DIR}/${f}`)));
  const decisions = decisionFiles
    .map((f, i) => (decisionTexts[i] === null ? null : parseDecision(f, decisionTexts[i]!)))
    .filter((d): d is Decision => !!d)
    .sort((a, b) => b.number - a.number);
  const drafts = base.hasBacklog ? await readTasks(r, ['drafts']) : [];
  let brainstorm: Brainstorm | null = null;
  let brainstormError: string | null = null;
  const brainText = await r.read(BRAINSTORM_FILE);
  if (brainText !== null) {
    try {
      brainstorm = parseBrainstorm(brainText);
    } catch (e) {
      brainstormError = (e as Error).message;
    }
  }
  return { ...base, tasks: [...base.tasks, ...drafts], decisions, brainstorm, brainstormError };
}

export interface SummaryInput {
  id: string;
  dirName: string;
  path: string | null;
  remote: string | null;
  files: ProjectFiles;
  git: GitSignals;
  commitsSinceHandoff: number | null;
  staleDays: number;
  now?: number;
  error?: string | null;
}

export function buildSummary(input: SummaryInput): ProjectSummary {
  const { files, git } = input;
  const now = input.now ?? Date.now();
  const meta = files.meta;
  const handoffNext = files.latestHandoff ? nextStepFromHandoff(files.latestHandoff) : null;
  const nextStep = handoffNext
    ? { text: handoffNext, source: 'handoff' as const }
    : meta?.next_step
      ? { text: meta.next_step, source: 'project.yaml' as const }
      : null;

  const activity = [
    git.lastCommit?.date,
    files.latestHandoff?.date,
    ...git.branches.map((b) => b.date),
  ]
    .map((d) => toTime(d))
    .filter((t) => t > 0);
  const lastActivity = activity.length ? new Date(Math.max(...activity)).toISOString() : null;

  const lastCommitTime = toTime(git.lastCommit?.date);
  const stale = meta?.status === 'active' && lastCommitTime > 0 && daysBetween(now, lastCommitTime) > input.staleDays;

  const latestRef: HandoffRef | null = files.latestHandoff
    ? toRef(files.latestHandoff)
    : files.handoffFiles[0]
      ? refFromFileName(files.handoffFiles[0])
      : null;

  return {
    id: input.id,
    name: meta?.name ?? input.dirName,
    path: input.path,
    remote: input.remote,
    initialised: files.initialised,
    status: meta?.status ?? null,
    summary: meta?.summary ?? '',
    tags: meta?.tags ?? [],
    git,
    nextStep,
    openTasks: files.hasBacklog ? files.tasks.filter((t) => isOpenTask(t, files.backlog)).length : null,
    stale,
    lastActivity,
    latestHandoff: latestRef,
    commitsSinceHandoff: input.commitsSinceHandoff,
    agents: {
      agentsMd: files.agentsMd !== null,
      claudeMd: files.claudeMd !== null,
      claudePointer: claudePointsToAgents(files.claudeMd),
      snippet: hasHubSnippet(files.agentsMd),
    },
    scannedAt: new Date(now).toISOString(),
    error: input.error ?? null,
  };
}

export function buildDetail(
  summary: ProjectSummary,
  files: ProjectFilesFull,
  notesDirty: string[] | null,
): ProjectDetail {
  const refs = files.handoffFiles.map((f) =>
    files.latestHandoff && files.latestHandoff.file === f ? toRef(files.latestHandoff) : refFromFileName(f),
  );
  return {
    summary,
    meta: files.meta,
    handoffs: refs,
    latestHandoff: files.latestHandoff,
    decisions: files.decisions,
    tasks: files.tasks,
    taskStatuses: files.backlog.statuses,
    hasBacklog: files.hasBacklog,
    agentsMd: files.agentsMd,
    claudeMd: files.claudeMd,
    brainstorm: files.brainstorm,
    notesDirty,
  };
}

/** Stable, URL-safe project ids from directory names; collisions get the parent folder prefixed. */
export function assignIds(paths: string[]): Map<string, string> {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repo';
  const parts = (p: string) => p.split(/[\\/]+/).filter(Boolean);
  const sorted = [...paths].sort();
  const result = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const p of sorted) {
    const base = slug(parts(p).at(-1) ?? p);
    byBase.set(base, [...(byBase.get(base) ?? []), p]);
  }
  const used = new Set<string>();
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      result.set(group[0], base);
      used.add(base);
      continue;
    }
    for (const p of group) {
      const segs = parts(p);
      let id = base;
      for (let depth = 2; depth <= segs.length && (id === base || used.has(id)); depth++) {
        id = segs.slice(-depth).map(slug).join('--');
      }
      let n = 2;
      while (used.has(id)) id = `${base}-${n++}`;
      used.add(id);
      result.set(p, id);
    }
  }
  return result;
}
