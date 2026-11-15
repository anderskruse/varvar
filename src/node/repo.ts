import path from 'node:path';
import { NOTE_PATHS, WORK_PATHSPEC } from '../shared/agents.js';
import { buildDetail, buildSummary, readProjectFiles, readProjectFilesFull, type ProjectFiles } from '../shared/project.js';
import type { GitSignals, ProjectDetail, ProjectSummary } from '../shared/types.js';
import { fsReader } from './fsutil.js';
import { countCommits, gitSignals, isAncestor, log, remoteUrl, shortRemote, status } from './git.js';

const EMPTY_GIT: GitSignals = {
  lastCommit: null,
  branch: null,
  detached: false,
  defaultBranch: null,
  upstream: null,
  ahead: null,
  behind: null,
  uncommitted: null,
  branches: [],
  worktrees: [],
};

/**
 * Commits on HEAD since the newest handoff (by its recorded commit, else its
 * date). Commits that only touch project notes don't count: committing the
 * handoff itself is not new work.
 */
export async function commitsSinceHandoff(repo: string, files: ProjectFiles): Promise<number | null> {
  const h = files.latestHandoff;
  if (!h) return null;
  if (h.commit && /^[0-9a-f]{4,40}$/i.test(h.commit) && (await isAncestor(repo, h.commit))) {
    return countCommits(repo, `${h.commit}..HEAD`, WORK_PATHSPEC);
  }
  if (h.date) {
    const entries = await log(repo, { since: h.date, max: 500, paths: WORK_PATHSPEC });
    return entries.length;
  }
  return null;
}

export async function summarizeRepo(repo: string, id: string, staleDays: number): Promise<ProjectSummary> {
  const dirName = path.basename(repo);
  let files: ProjectFiles;
  let git: GitSignals = EMPTY_GIT;
  let error: string | null = null;
  try {
    [files, git] = await Promise.all([readProjectFiles(fsReader(repo), dirName), gitSignals(repo)]);
  } catch (e) {
    error = (e as Error).message;
    files = await readProjectFiles(fsReader(repo), dirName).catch(
      (): ProjectFiles => ({
        initialised: false,
        meta: null,
        handoffFiles: [],
        latestHandoff: null,
        backlog: { projectName: null, statuses: [], defaultStatus: 'To Do', taskPrefix: 'task', zeroPaddedIds: 0 },
        hasBacklog: false,
        tasks: [],
        agentsMd: null,
        claudeMd: null,
      }),
    );
  }
  const [since, remote] = await Promise.all([commitsSinceHandoff(repo, files).catch(() => null), remoteUrl(repo)]);
  return buildSummary({
    id,
    dirName,
    path: repo,
    remote: shortRemote(remote),
    files,
    git,
    commitsSinceHandoff: since,
    staleDays,
    error,
  });
}

export async function notesDirty(repo: string): Promise<string[]> {
  const st = await status(repo, NOTE_PATHS);
  return st.entries.map((e) => e.path);
}

export async function detailRepo(repo: string, summary: ProjectSummary): Promise<ProjectDetail> {
  const files = await readProjectFilesFull(fsReader(repo), path.basename(repo));
  const dirty = await notesDirty(repo).catch(() => null);
  return buildDetail(summary, files, dirty);
}
