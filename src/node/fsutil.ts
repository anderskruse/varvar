import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoReader } from '../shared/project.js';

export class PathError extends Error {}

/** Repo-relative POSIX path, rejecting absolute paths and any ".." segment. */
export function cleanRelPath(rel: string): string {
  const posix = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!posix || posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) throw new PathError(`Not a relative path: ${rel}`);
  const parts = posix.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new PathError(`Path may not contain "..": ${rel}`);
  return parts.join('/');
}

function within(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(prefix + '/');
}

/**
 * Resolve a repo-relative path for writing. Only paths under `allowed`
 * prefixes are accepted, and no existing component may be a symlink that
 * leads outside the repo.
 */
export async function resolveWritable(repo: string, rel: string, allowed: string[]): Promise<string> {
  const clean = cleanRelPath(rel);
  if (!allowed.some((a) => within(clean, a))) {
    throw new PathError(`Writes are limited to ${allowed.join(', ')}; refused ${clean}`);
  }
  if (clean === '.git' || clean.startsWith('.git/')) throw new PathError('Refusing to write inside .git');
  const root = await fs.realpath(repo);
  const abs = path.join(root, clean);
  // Walk up to the deepest existing ancestor and make sure it resolves inside the repo.
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== root && !real.startsWith(root + path.sep)) throw new PathError(`${clean} resolves outside the repo`);
      break;
    } catch (e) {
      if (e instanceof PathError) throw e;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return abs;
}

/** Resolve a repo-relative path for reading (anything in the repo except .git). */
export async function resolveReadable(repo: string, rel: string): Promise<string> {
  const clean = cleanRelPath(rel);
  if (clean === '.git' || clean.startsWith('.git/')) throw new PathError('Refusing to read inside .git');
  const root = await fs.realpath(repo);
  const abs = path.join(root, clean);
  const real = await fs.realpath(abs);
  if (real !== root && !real.startsWith(root + path.sep)) throw new PathError(`${clean} resolves outside the repo`);
  return real;
}

/** Write via temp file + rename so readers never see half a file. */
export async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Create a file only if it doesn't exist; returns false when it does. */
export async function writeNew(abs: string, content: string): Promise<boolean> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

export async function readText(abs: string): Promise<string | null> {
  try {
    return await fs.readFile(abs, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw e;
  }
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** Reads repo files straight from disk. */
export function fsReader(repo: string): RepoReader {
  return {
    async list(dir) {
      try {
        const entries = await fs.readdir(path.join(repo, dir));
        // Hidden entries (.gitkeep, our .tmp files) are never project content.
        return entries.filter((e) => !e.startsWith('.'));
      } catch {
        return [];
      }
    },
    read: (rel) => readText(path.join(repo, rel)),
  };
}

/**
 * Cross-process lock (hub server and MCP server may write the same file).
 * Uses an atomic mkdir in the OS temp dir; stale locks expire.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>, opts: { timeoutMs?: number; staleMs?: number } = {}): Promise<T> {
  const dir = path.join(os.tmpdir(), 'varvar-locks', createHash('sha1').update(key).digest('hex'));
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const timeout = opts.timeoutMs ?? 5000;
  const stale = opts.staleMs ?? 15000;
  const start = Date.now();
  for (;;) {
    try {
      await fs.mkdir(dir);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        const st = await fs.stat(dir);
        if (Date.now() - st.mtimeMs > stale) {
          await fs.rm(dir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeout) throw new Error(`Timed out waiting for lock on ${key}`);
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
