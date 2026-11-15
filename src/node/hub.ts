// The hub's view of all repos: discovery, summaries, details and history.
// Shared by the web server (with a watcher) and the MCP server (without).
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { assignIds } from '../shared/project.js';
import type { HistoryItem, HubEvent, ProjectDetail, ProjectSummary } from '../shared/types.js';
import type { Cache } from './cache.js';
import type { HubConfig } from './config.js';
import { resolveReadable } from './fsutil.js';
import { repoRoot } from './git.js';
import { history } from './history.js';
import { detailRepo, summarizeRepo } from './repo.js';
import { findRepos } from './scan.js';

export interface RepoRef {
  id: string;
  path: string;
}

export class NotFound extends Error {}

const MAX_READ = 1024 * 1024;

/** Run tasks with limited concurrency. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function comparable(s: ProjectSummary): string {
  const { scannedAt: _s, ...rest } = s;
  return JSON.stringify(rest);
}

export class Hub extends EventEmitter<{ event: [HubEvent] }> {
  private repos: RepoRef[] = [];
  private extra: RepoRef[] = [];
  private summaries = new Map<string, ProjectSummary>();
  private scanning: Promise<ProjectSummary[]> | null = null;
  lastScan: number | null = null;

  constructor(
    readonly config: HubConfig,
    readonly cache: Cache,
  ) {
    super();
    for (const s of cache.getSummaries()) if (s.path) this.summaries.set(s.path, s);
  }

  private setRepos(paths: string[]) {
    const ids = assignIds(paths);
    this.repos = paths.map((p) => ({ id: ids.get(p)!, path: p }));
    const keep = new Set(paths);
    for (const p of this.summaries.keys()) if (!keep.has(p) && !this.extra.some((e) => e.path === p)) this.summaries.delete(p);
  }

  /** Repo list; uses the cached list unless forced or empty. */
  async discover(force = false): Promise<RepoRef[]> {
    if (!force && this.repos.length) return this.repos;
    if (!force) {
      const cached = this.cache.getRepos();
      if (cached?.paths.length) {
        this.setRepos(cached.paths);
        return this.repos;
      }
    }
    const paths = await findRepos(this.config);
    this.cache.setRepos(paths);
    this.setRepos(paths);
    return this.repos;
  }

  allRepos(): RepoRef[] {
    const known = new Set(this.repos.map((r) => r.path));
    return [...this.repos, ...this.extra.filter((e) => !known.has(e.path))];
  }

  /** Summaries from memory/cache, without touching git. Ids follow the current repo list. */
  cachedSummaries(): ProjectSummary[] {
    return this.allRepos()
      .map((r) => {
        const s = this.summaries.get(r.path);
        return s ? { ...s, id: r.id } : null;
      })
      .filter((s): s is ProjectSummary => !!s);
  }

  async refreshRepo(ref: RepoRef, emit = true): Promise<ProjectSummary> {
    const s = await summarizeRepo(ref.path, ref.id, this.config.stale_days);
    const prev = this.summaries.get(ref.path);
    this.summaries.set(ref.path, s);
    this.cache.putSummary(ref.path, s);
    if (emit && (!prev || comparable(prev) !== comparable(s))) this.emit('event', { type: 'project', id: ref.id });
    return s;
  }

  /** Recompute every summary. `rediscover` rescans the folders first. */
  async refreshAll(opts: { rediscover?: boolean } = {}): Promise<ProjectSummary[]> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      this.emit('event', { type: 'scan', state: 'started' });
      try {
        const before = new Set(this.repos.map((r) => r.path));
        await this.discover(opts.rediscover);
        const changedSet = this.repos.length !== before.size || this.repos.some((r) => !before.has(r.path));
        let changed = changedSet;
        const results = await mapLimit(this.allRepos(), 6, async (r) => {
          const prev = this.summaries.get(r.path);
          const s = await this.refreshRepo(r, false);
          if (!prev || comparable(prev) !== comparable(s)) changed = true;
          return s;
        });
        this.lastScan = Date.now();
        if (changed) this.emit('event', { type: 'projects' });
        return results;
      } finally {
        this.emit('event', { type: 'scan', state: 'finished' });
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /**
   * All summaries. With `maxAgeMs`, cached summaries (possibly written by
   * another hub process) are used when they are all at least that fresh.
   */
  async listProjects(opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<ProjectSummary[]> {
    await this.discover();
    if (opts.maxAgeMs !== undefined) {
      for (const s of this.cache.getSummaries()) if (s.path) this.summaries.set(s.path, s);
    }
    const cached = this.cachedSummaries();
    const complete = cached.length >= this.allRepos().length;
    const fresh =
      opts.maxAgeMs === undefined || cached.every((s) => Date.now() - new Date(s.scannedAt).getTime() <= opts.maxAgeMs!);
    if (opts.fresh || !complete || !fresh) return this.refreshAll();
    return cached;
  }

  /**
   * Find a repo by id, name, folder name, or any path inside it. Paths of git
   * repos outside the configured roots are accepted too (e.g. the agent's cwd).
   */
  async resolve(ref: string): Promise<RepoRef | null> {
    await this.discover();
    const all = this.allRepos();
    const lower = ref.trim().toLowerCase();
    const byId = all.find((r) => r.id === ref || r.id === lower);
    if (byId) return byId;
    const byName = all.filter(
      (r) => this.summaries.get(r.path)?.name.toLowerCase() === lower || path.basename(r.path).toLowerCase() === lower,
    );
    if (byName.length === 1) return byName[0];
    if (ref.includes('/') || ref.includes(path.sep) || ref.startsWith('.')) {
      return this.resolvePath(path.resolve(ref));
    }
    return null;
  }

  async resolvePath(p: string): Promise<RepoRef | null> {
    await this.discover();
    let real: string;
    try {
      real = await fs.realpath(p);
    } catch {
      return null;
    }
    const root = await repoRoot(real);
    if (!root) return null;
    const realRoot = await fs.realpath(root);
    const known = this.allRepos().find((r) => r.path === realRoot);
    if (known) return known;
    const ids = assignIds([...this.allRepos().map((r) => r.path), realRoot]);
    const ref = { id: ids.get(realRoot)!, path: realRoot };
    this.extra.push(ref);
    return ref;
  }

  async mustResolve(ref: string): Promise<RepoRef> {
    const r = await this.resolve(ref);
    if (!r) throw new NotFound(`Unknown project "${ref}". Use list_projects to see project ids.`);
    return r;
  }

  async getSummary(ref: string): Promise<ProjectSummary> {
    return this.refreshRepo(await this.mustResolve(ref));
  }

  async getDetail(ref: string): Promise<ProjectDetail> {
    const r = await this.mustResolve(ref);
    const summary = await this.refreshRepo(r);
    return detailRepo(r.path, summary);
  }

  async readFile(ref: string, rel: string): Promise<string> {
    const r = await this.mustResolve(ref);
    const abs = await resolveReadable(r.path, rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new NotFound(`${rel} is not a file`);
    if (st.size > MAX_READ) throw new Error(`${rel} is larger than 1 MB`);
    return fs.readFile(abs, 'utf8');
  }

  async history(ref: string, since?: string): Promise<HistoryItem[]> {
    const r = await this.mustResolve(ref);
    return history(r.path, since);
  }

  /** Called after the hub itself wrote into a repo. */
  async touched(ref: RepoRef): Promise<void> {
    await this.refreshRepo(ref);
  }
}
