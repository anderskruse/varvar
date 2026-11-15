import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmp(prefix = 'hub-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
}

export function write(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A git repo with one commit per entry in `commits` (each a file → content map). */
export function makeRepo(root: string, name: string, commits: Record<string, string>[] = [{ 'README.md': '# hi\n' }]): string {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Tester');
  sh(repo, 'config', 'user.email', 't@example.com');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  commits.forEach((files, i) => {
    for (const [f, c] of Object.entries(files)) write(repo, f, c);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', `commit ${i + 1}`);
  });
  return repo;
}
