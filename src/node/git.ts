import { execFile } from 'node:child_process';
import type { BranchInfo, CommitInfo, GitSignals, UncommittedInfo, WorktreeInfo } from '../shared/types.js';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const ENV = {
  ...process.env,
  // Never take optional locks: `git status` must not rewrite the index, or our
  // own refreshes would trigger the file watcher in a loop.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};

export function git(cwd: string, args: string[], opts: { timeout?: number; input?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, env: ENV, maxBuffer: 32 * 1024 * 1024, timeout: opts.timeout ?? 20_000 },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : null;
          reject(new GitError(`git ${args.join(' ')} failed: ${String(stderr).trim() || err.message}`, String(stderr), code));
        } else resolve(String(stdout));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

const US = '\x1f';
const COMMIT_FORMAT = ['%H', '%h', '%cI', '%an', '%s'].join('%x1f');

function parseCommitLine(line: string): CommitInfo | null {
  const [sha, short, date, author, subject] = line.split(US);
  if (!sha || !date) return null;
  return { sha, short, date, author: author ?? '', subject: subject ?? '' };
}

export async function lastCommit(cwd: string): Promise<CommitInfo | null> {
  const out = await tryGit(cwd, ['log', '-1', `--format=${COMMIT_FORMAT}`]);
  return out ? parseCommitLine(out.trim()) : null;
}

export async function headSha(cwd: string): Promise<string | null> {
  const out = await tryGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
  return out?.trim() || null;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const out = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return out?.trim() || null;
}

export interface StatusInfo {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  uncommitted: UncommittedInfo;
  /** Raw changed paths with XY codes, for fingerprints. */
  entries: { xy: string; path: string }[];
}

export function parseStatusV2(out: string, maxFiles = 20): StatusInfo {
  const info: StatusInfo = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: null,
    behind: null,
    uncommitted: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, files: [], total: 0 },
    entries: [],
  };
  const u = info.uncommitted;
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length);
      if (head === '(detached)') info.detached = true;
      else info.branch = head;
    } else if (line.startsWith('# branch.upstream ')) {
      info.upstream = line.slice('# branch.upstream '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        info.ahead = Number(m[1]);
        info.behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1];
      // Ordinary: 9 fields before path; renamed: 10 fields, then "path\torig".
      const pathPart = line.startsWith('1 ') ? parts.slice(8).join(' ') : parts.slice(9).join(' ').split('\t')[0];
      if (xy[0] !== '.') u.staged++;
      if (xy[1] !== '.') u.unstaged++;
      info.entries.push({ xy, path: pathPart });
    } else if (line.startsWith('u ')) {
      const parts = line.split(' ');
      u.conflicted++;
      info.entries.push({ xy: parts[1], path: parts.slice(10).join(' ') });
    } else if (line.startsWith('? ')) {
      u.untracked++;
      info.entries.push({ xy: '??', path: line.slice(2) });
    }
  }
  u.total = info.entries.length;
  u.files = info.entries.slice(0, maxFiles).map((e) => e.path);
  return info;
}

export async function status(cwd: string, pathspec: string[] = []): Promise<StatusInfo> {
  const args = ['status', '--porcelain=v2', '--branch', '--untracked-files=all'];
  if (pathspec.length) args.push('--', ...pathspec);
  return parseStatusV2(await git(cwd, args));
}

export async function defaultBranch(cwd: string, localNames: string[]): Promise<string | null> {
  const origin = await tryGit(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (origin?.trim()) {
    const name = origin.trim().replace(/^origin\//, '');
    if (localNames.includes(name)) return name;
  }
  for (const name of ['main', 'master', 'trunk', 'develop']) if (localNames.includes(name)) return name;
  return localNames[0] ?? null;
}

export async function branches(cwd: string, current: string | null): Promise<{ list: BranchInfo[]; defaultBranch: string | null }> {
  const fmt = ['%(refname:short)', '%(committerdate:iso-strict)', '%(upstream:short)', '%(upstream:track)', '%(subject)'].join('%1f');
  const out = await tryGit(cwd, ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads']);
  if (!out) return { list: [], defaultBranch: null };
  const list: BranchInfo[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, date, upstream, track, subject] = line.split(US);
    const ahead = /ahead (\d+)/.exec(track ?? '');
    const behind = /behind (\d+)/.exec(track ?? '');
    list.push({
      name,
      date: date || null,
      subject: subject ?? '',
      upstream: upstream || null,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      gone: (track ?? '').includes('gone'),
      current: name === current,
      merged: false,
    });
  }
  const def = await defaultBranch(cwd, list.map((b) => b.name));
  if (def) {
    const merged = await tryGit(cwd, ['for-each-ref', '--merged', def, '--format=%(refname:short)', 'refs/heads']);
    const set = new Set((merged ?? '').split('\n').filter(Boolean));
    for (const b of list) b.merged = set.has(b.name);
  }
  return { list, defaultBranch: def };
}

export function parseWorktrees(out: string): WorktreeInfo[] {
  const list: WorktreeInfo[] = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines.length) continue;
    const wt: WorktreeInfo = { path: '', branch: null, head: null, main: list.length === 0, locked: false, prunable: false };
    for (const l of lines) {
      if (l.startsWith('worktree ')) wt.path = l.slice(9);
      else if (l.startsWith('HEAD ')) wt.head = l.slice(5);
      else if (l.startsWith('branch ')) wt.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l.startsWith('locked')) wt.locked = true;
      else if (l.startsWith('prunable')) wt.prunable = true;
    }
    if (wt.path) list.push(wt);
  }
  return list;
}

export async function worktrees(cwd: string): Promise<WorktreeInfo[]> {
  const out = await tryGit(cwd, ['worktree', 'list', '--porcelain']);
  return out ? parseWorktrees(out) : [];
}

export async function remoteUrl(cwd: string): Promise<string | null> {
  const out = await tryGit(cwd, ['remote', 'get-url', 'origin']);
  return out?.trim() || null;
}

/** "https://github.com/a/b.git" or "git@github.com:a/b.git" → "github.com/a/b". */
export function shortRemote(url: string | null): string | null {
  if (!url) return null;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : url;
}

export async function gitSignals(cwd: string): Promise<GitSignals> {
  const [commit, st, wts] = await Promise.all([lastCommit(cwd), status(cwd).catch(() => null), worktrees(cwd)]);
  const branch = st?.branch ?? null;
  const bs = await branches(cwd, branch);
  return {
    lastCommit: commit,
    branch,
    detached: st?.detached ?? false,
    defaultBranch: bs.defaultBranch,
    upstream: st?.upstream ?? null,
    ahead: st?.ahead ?? null,
    behind: st?.behind ?? null,
    uncommitted: st?.uncommitted ?? null,
    branches: bs.list,
    worktrees: wts,
  };
}

export interface LogEntry extends CommitInfo {
  files?: string[];
}

/**
 * Commits on HEAD, newest first. `range` may be "abc123..HEAD"; `since` a date.
 * With `files`, includes the paths each commit touched (no diffs).
 */
export async function log(
  cwd: string,
  opts: { range?: string; since?: string; max?: number; files?: boolean; grep?: string; all?: boolean; paths?: string[] } = {},
): Promise<LogEntry[]> {
  const args = ['log', `--format=%x1e${COMMIT_FORMAT}`];
  if (opts.max) args.push(`-n${opts.max}`);
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.files) args.push('--name-only');
  if (opts.grep) args.push('-i', '--fixed-strings', `--grep=${opts.grep}`);
  if (opts.all) args.push('--all');
  if (opts.range) args.push(opts.range);
  if (opts.paths?.length) args.push('--', ...opts.paths);
  const out = await tryGit(cwd, args);
  if (!out) return [];
  const entries: LogEntry[] = [];
  for (const chunk of out.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [head, ...rest] = chunk.split('\n');
    const c = parseCommitLine(head);
    if (!c) continue;
    entries.push(opts.files ? { ...c, files: rest.map((l) => l.trim()).filter(Boolean) } : c);
  }
  return entries;
}

export async function countCommits(cwd: string, range: string, paths: string[] = []): Promise<number | null> {
  const out = await tryGit(cwd, ['rev-list', '--count', range, ...(paths.length ? ['--', ...paths] : [])]);
  return out ? Number(out.trim()) : null;
}

export async function isAncestor(cwd: string, commit: string, of = 'HEAD'): Promise<boolean> {
  try {
    await git(cwd, ['merge-base', '--is-ancestor', commit, of]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommit(cwd: string, ref: string): Promise<string | null> {
  const out = await tryGit(cwd, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return out?.trim() || null;
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const out = await tryGit(cwd, ['rev-parse', '--show-toplevel']);
  return out?.trim() || null;
}

export async function userName(cwd: string): Promise<string | null> {
  const out = await tryGit(cwd, ['config', 'user.name']);
  return out?.trim() || null;
}
