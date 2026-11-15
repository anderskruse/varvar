import { promises as fs } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { HubConfig } from './config.js';

export interface FoundRepo {
  path: string;
}

/** Walk the configured roots and return every git repo (a folder with a .git directory). */
export async function findRepos(cfg: Pick<HubConfig, 'roots' | 'repos' | 'ignore' | 'max_depth'>): Promise<string[]> {
  const isIgnored = picomatch(cfg.ignore, { dot: true, basename: false });
  const ignoredName = picomatch(cfg.ignore, { dot: true });
  const skip = (abs: string, name: string) => ignoredName(name) || isIgnored(abs);
  const found = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const gitEntry = entries.find((e) => e.name === '.git');
    if (gitEntry?.isDirectory()) {
      found.add(dir);
      return; // don't descend into repos
    }
    if (gitEntry?.isFile()) return; // linked worktree or submodule: shown under its main repo
    if (depth >= cfg.max_depth) return;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
        .filter((e) => !skip(path.join(dir, e.name), e.name))
        .map((e) => walk(path.join(dir, e.name), depth + 1)),
    );
  }

  for (const root of cfg.roots) {
    let real: string;
    try {
      real = await fs.realpath(root);
    } catch {
      continue;
    }
    await walk(real, 0);
  }
  for (const repo of cfg.repos) {
    try {
      const real = await fs.realpath(repo);
      const st = await fs.stat(path.join(real, '.git'));
      if (st.isDirectory()) found.add(real);
    } catch {
      /* missing repo: ignore */
    }
  }
  return [...found].sort();
}
