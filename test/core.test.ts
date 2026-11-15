import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCache } from '../src/node/cache.js';
import { commitNotes } from '../src/node/commit.js';
import type { HubConfig } from '../src/node/config.js';
import { Hub } from '../src/node/hub.js';
import { history } from '../src/node/history.js';
import { summarizeRepo } from '../src/node/repo.js';
import { findRepos } from '../src/node/scan.js';
import {
  AGENT_WRITABLE,
  UI_WRITABLE,
  addBrainstormNote,
  addTask,
  draftAutoHandoff,
  initialise,
  saveAgentsMd,
  logDecision,
  saveBrainstorm,
  updateTask,
  writeHandoff,
} from '../src/node/writes.js';
import { parseBrainstorm } from '../src/shared/brainstorm.js';
import { makeRepo, sh, tmp, write } from './helpers.js';

let root: string;
const cfg = (): HubConfig => ({
  roots: [root],
  repos: [],
  ignore: ['node_modules', 'ignored-*'],
  max_depth: 3,
  stale_days: 30,
  port: 0,
  open_browser: false,
  allowed_hosts: [],
});

beforeAll(async () => {
  root = await fs.realpath(tmp('hub-core-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scanning', () => {
  it('finds repos, skips ignored folders, nested repos and linked worktrees', async () => {
    const a = makeRepo(root, 'scan/a');
    makeRepo(root, 'scan/group/b');
    makeRepo(root, 'scan/node_modules/dep');
    makeRepo(root, 'scan/ignored-thing');
    makeRepo(root, 'scan/a/inner'); // inside a repo: not descended into
    sh(a, 'worktree', 'add', '-q', path.join(root, 'scan/a-wt'), '-b', 'wt-branch');
    const found = await findRepos({ ...cfg(), roots: [path.join(root, 'scan')] });
    expect(found.map((p) => path.relative(root, p)).sort()).toEqual(['scan/a', 'scan/group/b']);
  });
});

describe('git signals', () => {
  it('reports sync, uncommitted work, open branches, worktrees and staleness', async () => {
    const remote = path.join(root, 'sig/remote.git');
    await fs.mkdir(remote, { recursive: true });
    sh(remote, 'init', '-q', '--bare', '-b', 'main');
    const repo = makeRepo(root, 'sig/repo', [{ 'a.txt': '1' }]);
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', '-u', 'origin', 'main');
    write(repo, 'a.txt', '2');
    sh(repo, 'commit', '-qam', 'ahead by one');
    sh(repo, 'checkout', '-qb', 'feature/x');
    write(repo, 'b.txt', 'b');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'feature work');
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'branch', 'merged-already');
    sh(repo, 'worktree', 'add', '-q', path.join(root, 'sig/repo-wt'), 'feature/x');
    write(repo, 'a.txt', 'dirty');
    write(repo, 'new.txt', 'untracked');
    write(repo, '.project/project.yaml', 'name: Signals\nstatus: active\ntags: [demo]\nnext_step: Ship it\n');

    const s = await summarizeRepo(repo, 'repo', 30);
    expect(s.name).toBe('Signals');
    expect(s.git.branch).toBe('main');
    expect(s.git.upstream).toBe('origin/main');
    expect(s.git.ahead).toBe(1);
    expect(s.git.behind).toBe(0);
    expect(s.git.uncommitted).toMatchObject({ unstaged: 1, untracked: 2, total: 3 });
    const open = s.git.branches.filter((b) => !b.current && !b.merged);
    expect(open.map((b) => b.name)).toEqual(['feature/x']);
    expect(s.git.worktrees?.filter((w) => !w.main).map((w) => w.branch)).toEqual(['feature/x']);
    expect(s.nextStep).toEqual({ text: 'Ship it', source: 'project.yaml' });
    expect(s.stale).toBe(false);
    expect(s.tags).toEqual(['demo']);

    const old = makeRepo(root, 'sig/old', []);
    write(old, 'x', 'x');
    sh(old, 'add', '.');
    execOld(old);
    write(old, '.project/project.yaml', 'status: active\n');
    expect((await summarizeRepo(old, 'old', 30)).stale).toBe(true);
    write(old, '.project/project.yaml', 'status: paused\n');
    expect((await summarizeRepo(old, 'old', 30)).stale).toBe(false);
  });
});

function execOld(repo: string) {
  const date = '2025-01-01T10:00:00';
  execFileSync('git', ['commit', '-qm', 'old', '--date', date], {
    cwd: repo,
    env: { ...process.env, GIT_COMMITTER_DATE: date },
  });
}

describe('cache', () => {
  it('rebuilds the same view after the cache is deleted', async () => {
    const r = path.join(root, 'cache-roots');
    makeRepo(r, 'one');
    makeRepo(r, 'two');
    const file = path.join(root, 'cache.db');
    const conf = { ...cfg(), roots: [r] };
    const strip = (list: { scannedAt: string }[]) => list.map(({ scannedAt: _, ...rest }) => rest);

    const h1 = new Hub(conf, openCache(file));
    const first = strip(await h1.listProjects({ fresh: true }));
    h1.cache.close();
    // Served from cache without rescanning.
    const h2 = new Hub(conf, openCache(file));
    expect(strip(h2.cachedSummaries().length ? h2.cachedSummaries() : await h2.listProjects())).toEqual(first);
    h2.cache.close();

    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f);
    const h3 = new Hub(conf, openCache(file));
    expect(h3.cachedSummaries()).toEqual([]);
    expect(strip(await h3.listProjects())).toEqual(first);
    h3.cache.close();
  });
});

const saveAgents = (repo: string) => saveAgentsMd({ repo, allowed: AGENT_WRITABLE }, 'x', null);

describe('writes', () => {
  it('limits agents to .project/ and backlog/', async () => {
    const repo = makeRepo(root, 'guard');
    await expect(saveAgents(repo)).rejects.toThrow(/Writes are limited to \.project, backlog/);
    // A symlinked .project pointing outside the repo is refused.
    const repo2 = makeRepo(root, 'guard2');
    const ctx = { repo: repo2, allowed: AGENT_WRITABLE };
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    symlinkSync(outside, path.join(repo2, '.project'));
    await expect(writeHandoff(ctx, { agent: 'x', done: 'a', next: 'b' })).rejects.toThrow(/outside the repo/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('initialise moves an existing CLAUDE.md into AGENTS.md', async () => {
    const repo = makeRepo(root, 'init', [{ 'CLAUDE.md': '# Rules\nUse tabs.\n' }]);
    const res = await initialise({ repo, allowed: UI_WRITABLE });
    expect(res.created).toContain('AGENTS.md');
    expect(res.changed).toContain('CLAUDE.md');
    expect(res.created).toContain('.claude/skills/varvar/SKILL.md');
    const agents = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('Use tabs.');
    expect(agents).toContain('## varvar');
    expect(await fs.readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).toContain('@AGENTS.md');
    expect((await initialise({ repo, allowed: UI_WRITABLE })).created).toEqual([]);
  });

  it('allocates unique decision numbers and task ids under concurrency', async () => {
    const repo = makeRepo(root, 'concurrent');
    const ctx = { repo, allowed: AGENT_WRITABLE };
    const ds = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => logDecision(ctx, { title: `Decision ${i}`, context: '', decision: 'x', consequences: '', author: 'a' })),
    );
    expect(new Set(ds.map((d) => d.id)).size).toBe(5);
    const ts = await Promise.all([1, 2, 3, 4].map((i) => addTask(ctx, { title: `Task ${i}`, reporter: 'a' })));
    expect(ts.map((t) => t.id).sort()).toEqual(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4']);
    expect(await fs.readFile(path.join(repo, 'backlog/config.yml'), 'utf8')).toContain('task_prefix: "task"');
  });

  it('continues task ids used on other branches', async () => {
    const repo = makeRepo(root, 'branches');
    const ctx = { repo, allowed: AGENT_WRITABLE };
    sh(repo, 'checkout', '-qb', 'other');
    await addTask(ctx, { title: 'On a branch', reporter: 'a' });
    await addTask(ctx, { title: 'Also on a branch', reporter: 'a' });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'tasks');
    sh(repo, 'checkout', '-q', 'main');
    expect(existsSync(path.join(repo, 'backlog/tasks'))).toBe(false);
    const t = await addTask(ctx, { title: 'On main', reporter: 'a' });
    expect(t.id).toBe('TASK-3');
    await updateTask(ctx, '3', { status: 'in progress' });
    expect(await fs.readFile(path.join(repo, t.path), 'utf8')).toContain('status: In Progress');
  });

  it('keeps agent notes written while the canvas is being saved', async () => {
    const repo = makeRepo(root, 'canvas');
    const ctx = { repo, allowed: AGENT_WRITABLE };
    const first = await addBrainstormNote(ctx, { text: 'first', kind: 'idea', author: 'a' });
    const second = await addBrainstormNote(ctx, { text: 'second', kind: 'risk', author: 'b' });
    // The UI only knew about the first note, and moved it onto the canvas.
    const saved = await saveBrainstorm(
      { repo, allowed: UI_WRITABLE },
      { version: 1, nodes: [{ ...first.node, inbox: undefined, x: 100, y: 50 }] },
      [first.node.id],
    );
    expect(saved.nodes.map((n) => n.id).sort()).toEqual([first.node.id, second.node.id].sort());
    const onDisk = parseBrainstorm(await fs.readFile(path.join(repo, '.project/brainstorm.json'), 'utf8'));
    expect(onDisk.nodes.find((n) => n.id === first.node.id)).toMatchObject({ x: 100, y: 50 });
    expect(onDisk.nodes.find((n) => n.id === second.node.id)).toMatchObject({ inbox: true, author: 'b' });
  });

  it('drafts an auto handoff from commits since the last handoff', async () => {
    const repo = makeRepo(root, 'draft');
    const ctx = { repo, allowed: AGENT_WRITABLE };
    await writeHandoff(ctx, { agent: 'claude-code', done: 'setup', next: 'write the parser' });
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'handoff');
    // Committing the handoff itself is not new work.
    expect(await draftAutoHandoff(ctx)).toBeNull();
    expect((await summarizeRepo(repo, 'draft', 30)).commitsSinceHandoff).toBe(0);
    write(repo, 'parser.ts', 'x');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'Add parser');
    const file = (await draftAutoHandoff(ctx, { agent: 'claude-code' }))!;
    const text = await fs.readFile(path.join(repo, file), 'utf8');
    expect(text).toContain('auto: true');
    expect(text).toContain('reviewed: false');
    expect(text).toContain('- Add parser (');
    expect(text).toContain('(from previous handoff) write the parser');
    expect(text).not.toContain('- handoff (');
    expect((await summarizeRepo(repo, 'draft', 30)).commitsSinceHandoff).toBe(1);
  });

  it('commits only project notes and leaves other staged work alone', async () => {
    const repo = makeRepo(root, 'commit');
    await initialise({ repo, allowed: UI_WRITABLE });
    await writeHandoff({ repo, allowed: AGENT_WRITABLE }, { agent: 'x', done: 'a', next: 'b' });
    write(repo, 'README.md', 'staged change');
    sh(repo, 'add', 'README.md');
    write(repo, 'scratch.txt', 'untracked');
    const res = await commitNotes(repo);
    expect(res.message).toMatch(/^Update project notes: handoff .*AGENTS\.md, CLAUDE\.md, varvar skill$/);
    const committed = sh(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    expect(committed).not.toContain('README.md');
    expect(committed).toContain('AGENTS.md');
    expect(committed).toContain('.claude/skills/varvar/SKILL.md');
    expect(sh(repo, 'status', '--short')).toBe('M  README.md\n?? scratch.txt\n');
    await expect(commitNotes(repo)).rejects.toThrow(/No changes/);
  });

  it('merges commits, handoffs and decisions into one timeline', async () => {
    const repo = makeRepo(root, 'timeline');
    const ctx = { repo, allowed: AGENT_WRITABLE };
    await writeHandoff(ctx, { agent: 'codex', done: 'x', next: 'y' });
    await logDecision(ctx, { title: 'Pick SSE', context: '', decision: 'SSE.', consequences: '', author: 'a' });
    const items = await history(repo);
    expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['commit', 'handoff', 'decision']));
    const times = items.map((i) => new Date(i.date).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
