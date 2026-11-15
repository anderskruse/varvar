// Types shared by the hub server, the MCP server and the web UI.
// Everything in src/shared must stay browser-safe: no Node imports.

export type ProjectStatus = 'active' | 'paused' | 'archived';
export const PROJECT_STATUSES: ProjectStatus[] = ['active', 'paused', 'archived'];

/** Contents of .project/project.yaml */
export interface ProjectMeta {
  name: string;
  summary: string;
  status: ProjectStatus;
  tags: string[];
  next_step: string;
}

export interface CommitInfo {
  sha: string;
  short: string;
  date: string; // ISO 8601
  author: string;
  subject: string;
}

export interface BranchInfo {
  name: string;
  date: string | null;
  subject: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  current: boolean;
  merged: boolean; // merged into the default branch
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface UncommittedInfo {
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** First few changed paths, for tooltips and agents. */
  files: string[];
  total: number;
}

export interface GitSignals {
  lastCommit: CommitInfo | null;
  branch: string | null;
  detached: boolean;
  defaultBranch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** null when the data source can't see the working tree (GitHub, snapshot of a remote). */
  uncommitted: UncommittedInfo | null;
  branches: BranchInfo[];
  /** null when the data source can't see worktrees. */
  worktrees: WorktreeInfo[] | null;
}

export interface HandoffRef {
  file: string; // file name inside .project/handoffs/
  date: string; // as written in front matter (local time, minute precision)
  agent: string;
  auto: boolean;
  reviewed: boolean;
}

export interface HandoffSections {
  done: string;
  next: string;
  open_questions: string;
  gotchas: string;
}

export interface Handoff extends HandoffRef {
  branch: string | null;
  commit: string | null;
  sections: HandoffSections;
  /** Markdown body without front matter. */
  body: string;
}

export type DecisionStatus = 'proposed' | 'accepted' | 'superseded' | 'rejected';
export const DECISION_STATUSES: DecisionStatus[] = ['proposed', 'accepted', 'superseded', 'rejected'];

export interface Decision {
  id: string; // "0001"
  number: number;
  file: string;
  title: string;
  status: string;
  date: string;
  author: string | null;
  supersededBy: string | null;
  sections: { context: string; decision: string; consequences: string };
  /** One line: the first sentence of the Decision section. */
  summary: string;
  body: string;
}

export interface AcceptanceCriterion {
  index: number;
  text: string;
  checked: boolean;
}

export type TaskFolder = 'tasks' | 'drafts' | 'completed' | 'archive';

export interface Task {
  id: string; // e.g. TASK-3
  title: string;
  status: string;
  priority: string | null;
  labels: string[];
  assignee: string[];
  reporter: string | null;
  created: string | null;
  updated: string | null;
  parent: string | null;
  dependencies: string[];
  ordinal: number | null;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  file: string; // path relative to repo root
  folder: TaskFolder;
}

export type NodeKind = 'idea' | 'question' | 'risk' | 'note';
export const NODE_KINDS: NodeKind[] = ['idea', 'question', 'risk', 'note'];

export interface BrainLink {
  to: string;
  label?: string;
}

export interface BrainNode {
  id: string;
  text: string;
  kind: NodeKind;
  x: number;
  y: number;
  links: BrainLink[];
  /** Agent notes land in the Inbox until placed on the canvas. */
  inbox?: boolean;
  author?: string;
  created?: string;
  /** What the node became, e.g. { type: 'task', id: 'TASK-12' }. */
  promoted?: { type: 'task' | 'decision'; id: string };
}

export interface Brainstorm {
  version: 1;
  nodes: BrainNode[];
}

export interface AgentFiles {
  agentsMd: boolean;
  claudeMd: boolean;
  /** CLAUDE.md exists and points to AGENTS.md. */
  claudePointer: boolean;
  /** AGENTS.md contains the varvar section. */
  snippet: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  /** Absolute path on disk; only in local mode. */
  path: string | null;
  /** Remote URL or "owner/repo" when known. */
  remote: string | null;
  initialised: boolean;
  status: ProjectStatus | null;
  summary: string;
  tags: string[];
  git: GitSignals;
  nextStep: { text: string; source: 'handoff' | 'project.yaml' } | null;
  openTasks: number | null;
  stale: boolean;
  lastActivity: string | null;
  latestHandoff: HandoffRef | null;
  /** Commits on HEAD since the newest handoff; null if unknown or no handoff. */
  commitsSinceHandoff: number | null;
  agents: AgentFiles;
  scannedAt: string;
  error: string | null;
}

export interface ProjectDetail {
  summary: ProjectSummary;
  meta: ProjectMeta | null;
  /** All handoffs, newest first. Only the newest is loaded in full. */
  handoffs: HandoffRef[];
  latestHandoff: Handoff | null;
  decisions: Decision[];
  tasks: Task[];
  taskStatuses: string[];
  hasBacklog: boolean;
  agentsMd: string | null;
  claudeMd: string | null;
  brainstorm: Brainstorm | null;
  /** Uncommitted files under the note paths (.project/, backlog/, AGENTS.md, CLAUDE.md, .claude/skills/varvar/). null if unknown. */
  notesDirty: string[] | null;
}

export type HistoryKind = 'commit' | 'handoff' | 'decision';

export interface HistoryItem {
  kind: HistoryKind;
  date: string; // ISO-ish, sortable
  title: string;
  /** Commit sha, handoff file or decision id. */
  ref: string;
  author: string | null;
  detail: string | null;
}

export type HubEvent =
  | { type: 'projects' }
  | { type: 'project'; id: string }
  | { type: 'scan'; state: 'started' | 'finished' };
