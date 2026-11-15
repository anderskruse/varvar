// A rebuildable cache: the repo list and last computed summaries, so the
// overview renders instantly while a fresh scan runs. Safe to delete.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ProjectSummary } from '../shared/types.js';

const SCHEMA_VERSION = '1';

interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

export interface Cache {
  getRepos(): { paths: string[]; scannedAt: number } | null;
  setRepos(paths: string[]): void;
  getSummaries(): ProjectSummary[];
  putSummary(repo: string, s: ProjectSummary): void;
  removeMissing(paths: string[]): void;
  close(): void;
}

class SqliteCache implements Cache {
  constructor(private db: Database) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS repos (path TEXT PRIMARY KEY, summary TEXT, updated_at INTEGER NOT NULL);
    `);
    const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as { value: string } | undefined;
    if (v?.value !== SCHEMA_VERSION) {
      db.exec('DELETE FROM repos; DELETE FROM meta;');
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema', SCHEMA_VERSION);
    }
  }

  getRepos() {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('scanned_at') as { value: string } | undefined;
    if (!row) return null;
    const paths = (this.db.prepare('SELECT path FROM repos ORDER BY path').all() as { path: string }[]).map((r) => r.path);
    return { paths, scannedAt: Number(row.value) };
  }

  setRepos(paths: string[]) {
    const tx = this.db.transaction(() => {
      this.removeMissing(paths);
      const ins = this.db.prepare('INSERT OR IGNORE INTO repos (path, summary, updated_at) VALUES (?, NULL, ?)');
      for (const p of paths) ins.run(p, Date.now());
      this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('scanned_at', String(Date.now()));
    });
    tx();
  }

  getSummaries(): ProjectSummary[] {
    const rows = this.db.prepare('SELECT summary FROM repos WHERE summary IS NOT NULL').all() as { summary: string }[];
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.summary) as ProjectSummary];
      } catch {
        return [];
      }
    });
  }

  putSummary(repo: string, s: ProjectSummary) {
    this.db
      .prepare('INSERT INTO repos (path, summary, updated_at) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at')
      .run(repo, JSON.stringify(s), Date.now());
  }

  removeMissing(paths: string[]) {
    const keep = new Set(paths);
    const all = (this.db.prepare('SELECT path FROM repos').all() as { path: string }[]).map((r) => r.path);
    const del = this.db.prepare('DELETE FROM repos WHERE path = ?');
    for (const p of all) if (!keep.has(p)) del.run(p);
  }

  close() {
    this.db.close();
  }
}

class MemoryCache implements Cache {
  private repos: { paths: string[]; scannedAt: number } | null = null;
  private summaries = new Map<string, ProjectSummary>();
  getRepos() {
    return this.repos;
  }
  setRepos(paths: string[]) {
    this.removeMissing(paths);
    this.repos = { paths, scannedAt: Date.now() };
  }
  getSummaries() {
    return [...this.summaries.values()];
  }
  putSummary(repo: string, s: ProjectSummary) {
    this.summaries.set(repo, s);
  }
  removeMissing(paths: string[]) {
    const keep = new Set(paths);
    for (const k of this.summaries.keys()) if (!keep.has(k)) this.summaries.delete(k);
  }
  close() {}
}

/** Open the SQLite cache; falls back to memory if the native module can't load. */
export function openCache(file: string | null): Cache {
  if (!file) return new MemoryCache();
  try {
    const require = createRequire(import.meta.url);
    const BetterSqlite = require('better-sqlite3') as new (file: string) => Database;
    mkdirSync(path.dirname(file), { recursive: true });
    return new SqliteCache(new BetterSqlite(file));
  } catch (e) {
    process.stderr.write(`varvar: cache disabled (${(e as Error).message})\n`);
    return new MemoryCache();
  }
}
