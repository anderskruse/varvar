// Live updates: watch each repo's project files and git metadata, refresh the
// affected summary, and poll periodically for working-tree edits that git
// metadata doesn't reveal.
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Hub, RepoRef } from './hub.js';

const DEEP = ['.project', 'backlog', '.git/refs/heads', '.git/refs/remotes', '.git/worktrees'];
const SHALLOW = ['', '.git/HEAD', '.git/index', '.git/packed-refs', '.git/FETCH_HEAD'];

export interface WatcherOptions {
  pollMs?: number;
  rescanMs?: number;
  debounceMs?: number;
}

export class RepoWatcher {
  private deep: FSWatcher | null = null;
  private shallow: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();
  private poll: NodeJS.Timeout | null = null;
  private rescan: NodeJS.Timeout | null = null;
  private watched: RepoRef[] = [];

  constructor(
    private hub: Hub,
    private opts: WatcherOptions = {},
  ) {}

  async start(): Promise<void> {
    await this.rewatch();
    this.hub.on('event', (e) => {
      if (e.type === 'projects') void this.rewatch();
    });
    const pollMs = this.opts.pollMs ?? 60_000;
    const rescanMs = this.opts.rescanMs ?? 10 * 60_000;
    if (pollMs > 0) this.poll = setInterval(() => void this.hub.refreshAll().catch(() => {}), pollMs);
    if (rescanMs > 0) this.rescan = setInterval(() => void this.hub.refreshAll({ rediscover: true }).catch(() => {}), rescanMs);
  }

  private repoFor(file: string): RepoRef | undefined {
    let best: RepoRef | undefined;
    for (const r of this.watched) {
      if ((file === r.path || file.startsWith(r.path + path.sep)) && (!best || r.path.length > best.path.length)) best = r;
    }
    return best;
  }

  private onChange = (file: string) => {
    if (/\.tmp$|~$|\.swp$|\.lock$/.test(file)) return;
    const repo = this.repoFor(file);
    if (!repo) return;
    const prev = this.timers.get(repo.path);
    if (prev) clearTimeout(prev);
    this.timers.set(
      repo.path,
      setTimeout(() => {
        this.timers.delete(repo.path);
        void this.hub.refreshRepo(repo).catch(() => {});
      }, this.opts.debounceMs ?? 300),
    );
  };

  private async rewatch(): Promise<void> {
    const repos = this.hub.allRepos();
    const same = repos.length === this.watched.length && repos.every((r, i) => r.path === this.watched[i]?.path);
    if (same && this.deep) return;
    await this.closeWatchers();
    this.watched = repos;
    const deepPaths = repos.flatMap((r) => DEEP.map((d) => path.join(r.path, d)));
    const shallowPaths = repos.flatMap((r) => SHALLOW.map((d) => path.join(r.path, d)));
    const ignored = (p: string) => /[\\/](node_modules|\.git[\\/]objects|\.git[\\/]logs)([\\/]|$)/.test(p);
    try {
      this.deep = watch(deepPaths, { ignoreInitial: true, depth: 6, ignored, persistent: true });
      this.shallow = watch(shallowPaths, { ignoreInitial: true, depth: 0, ignored, persistent: true });
      for (const w of [this.deep, this.shallow]) {
        w.on('all', (_event, file) => this.onChange(file));
        w.on('error', (err) => process.stderr.write(`varvar: watcher error: ${String(err)}\n`));
      }
    } catch (e) {
      process.stderr.write(`varvar: file watching disabled (${(e as Error).message}); polling only\n`);
    }
  }

  private async closeWatchers() {
    await Promise.all([this.deep?.close(), this.shallow?.close()]);
    this.deep = this.shallow = null;
  }

  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    if (this.rescan) clearInterval(this.rescan);
    for (const t of this.timers.values()) clearTimeout(t);
    await this.closeWatchers();
  }
}
