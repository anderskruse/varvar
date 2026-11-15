// The one interface the UI uses for all data. Local (hub server), GitHub and
// snapshot modes implement it; the UI hides controls a source can't support.
import type { HandoffInput } from './handoff.js';
import type { NewTaskInput, TaskPatch } from './backlog.js';
import type {
  BrainNode,
  Brainstorm,
  HistoryItem,
  HubEvent,
  ProjectDetail,
  ProjectMeta,
  ProjectSummary,
} from './types.js';

export interface Capabilities {
  write: boolean;
  agents: boolean;
  uncommitted: boolean;
  /** Pushes change events (file watcher). */
  live: boolean;
}

export type SourceKind = 'local' | 'github' | 'snapshot';

export interface DataSource {
  readonly kind: SourceKind;
  readonly label: string;
  readonly capabilities: Capabilities;
  listProjects(): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<ProjectDetail>;
  readFile(project: string, path: string): Promise<string>;
  history(project: string, since?: string): Promise<HistoryItem[]>;
  /** Present when capabilities.live. Returns an unsubscribe function. */
  subscribe?(cb: (e: HubEvent) => void): () => void;
  rescan?(): Promise<void>;
  /** Present when capabilities.write. */
  writer?: DataSourceWriter;
}

export type HandoffFormInput = Pick<HandoffInput, 'done' | 'next' | 'open_questions' | 'gotchas'> & { agent?: string };

export interface DecisionFormInput {
  title: string;
  context: string;
  decision: string;
  consequences: string;
}

export type TaskFormInput = Pick<NewTaskInput, 'title' | 'description' | 'priority' | 'labels' | 'acceptanceCriteria'> & {
  status?: string;
};

export interface WriteResult {
  path: string;
}

export interface DataSourceWriter {
  initialise(project: string): Promise<{ created: string[] }>;
  saveProjectMeta(project: string, patch: Partial<ProjectMeta>): Promise<WriteResult>;
  writeHandoff(project: string, input: HandoffFormInput): Promise<WriteResult>;
  draftHandoff(project: string): Promise<WriteResult | null>;
  markHandoffReviewed(project: string, file: string): Promise<WriteResult>;
  saveAgentsMd(project: string, content: string, baseHash: string | null): Promise<WriteResult>;
  fixClaudePointer(project: string): Promise<WriteResult>;
  addHubSnippet(project: string): Promise<WriteResult>;
  addTask(project: string, input: TaskFormInput): Promise<WriteResult & { id: string }>;
  updateTask(project: string, id: string, patch: TaskPatch): Promise<WriteResult>;
  logDecision(project: string, input: DecisionFormInput): Promise<WriteResult & { id: string }>;
  updateDecision(project: string, id: string, patch: { status: string }): Promise<WriteResult>;
  saveBrainstorm(project: string, brainstorm: Brainstorm, knownIds: string[]): Promise<Brainstorm>;
  promoteNode(project: string, nodeId: string, to: 'task' | 'decision'): Promise<{ node: BrainNode; id: string }>;
  commitNotes(project: string): Promise<{ sha: string; message: string; files: string[] }>;
}

/** Small, stable hash for optimistic concurrency on text edits (not security). */
export function contentHash(text: string | null): string | null {
  if (text === null) return null;
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2, 31) + c) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}-${text.length}`;
}
