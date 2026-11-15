import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hubHooks, mergeHooks } from '../src/hooks/setup.js';
import { makeRepo, sh, tmp, write } from './helpers.js';

let root: string;
let runHook: (event: string, stdin: string) => Promise<string>;

beforeAll(async () => {
  root = await fs.realpath(tmp('hub-hooks-'));
  process.env.VARVAR_HOME = path.join(root, 'home');
  ({ runHook } = await import('../src/hooks/claude.js'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const input = (event: string, cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 'sess-1', cwd, hook_event_name: event, ...extra });

async function handoffs(repo: string) {
  return (await fs.readdir(path.join(repo, '.project/handoffs'))).filter((f) => f.endsWith('.md'));
}

describe('Claude Code hooks', () => {
  it('do nothing in repos without .project/', async () => {
    const repo = makeRepo(root, 'plain');
    expect(await runHook('session-start', input('SessionStart', repo))).toBe('');
    expect(await runHook('stop', input('Stop', repo))).toBe('');
  });

  it('enforce a handoff only after the session changed something', async () => {
    const repo = makeRepo(root, 'proj');
    write(repo, '.project/project.yaml', 'name: proj\n');
    await fs.mkdir(path.join(repo, '.project/handoffs'), { recursive: true });

    const start = JSON.parse(await runHook('session-start', input('SessionStart', repo, { source: 'startup' })));
    expect(start.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(start.hookSpecificOutput.additionalContext).toContain('no handoff yet');

    // A question-and-answer turn: nothing changed, so stopping is fine.
    expect(await runHook('stop', input('Stop', repo))).toBe('');

    // Work happened (notes alone don't count).
    write(repo, 'backlog/tasks/task-1 - x.md', '---\nid: TASK-1\n---\n');
    expect(await runHook('stop', input('Stop', repo))).toBe('');
    write(repo, 'feature.ts', 'export const x = 1;\n');
    const blocked = JSON.parse(await runHook('stop', input('Stop', repo)));
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('write_handoff');

    // Already continuing because of this hook: never block twice in a row.
    expect(await runHook('stop', input('Stop', repo, { stop_hook_active: true }))).toBe('');
    // Waiting on background work is not the end of the session.
    expect(await runHook('stop', input('Stop', repo, { background_tasks: [{ id: 't', type: 'shell' }] }))).toBe('');

    // Gives up after a couple of blocks; SessionEnd will draft a handoff instead.
    JSON.parse(await runHook('stop', input('Stop', repo)));
    expect(await runHook('stop', input('Stop', repo))).toBe('');

    // Session ends without a handoff: the hub drafts one.
    await runHook('session-end', input('SessionEnd', repo, { reason: 'prompt_input_exit' }));
    const files = await handoffs(repo);
    expect(files).toHaveLength(1);
    const text = await fs.readFile(path.join(repo, '.project/handoffs', files[0]), 'utf8');
    expect(text).toContain('agent: claude-code');
    expect(text).toContain('auto: true');
    expect(text).toContain('feature.ts');
  });

  it('let the session stop once a handoff exists', async () => {
    const repo = makeRepo(root, 'proj2');
    write(repo, '.project/project.yaml', 'name: proj2\n');
    await runHook('session-start', input('SessionStart', repo));
    write(repo, 'a.ts', 'x');
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-qm', 'work');
    expect(JSON.parse(await runHook('stop', input('Stop', repo))).decision).toBe('block');
    write(repo, '.project/handoffs/2099-01-01-0000-claude-code.md', '---\nagent: claude-code\n---\n## Next\n- x\n');
    // A future-dated name still needs a fresh mtime; this one was just written.
    expect(await runHook('stop', input('Stop', repo))).toBe('');
    await runHook('session-end', input('SessionEnd', repo));
    expect(await handoffs(repo)).toHaveLength(1);
  });

  it('install idempotently next to other hooks', () => {
    const cmd = "/usr/bin/node '/opt/hub/bin/hub.js'";
    const foreign = { hooks: [{ type: 'command' as const, command: 'say done' }] };
    const once = mergeHooks({ model: 'x', hooks: { Stop: [foreign] } }, hubHooks(cmd));
    const twice = mergeHooks(once, hubHooks(cmd));
    expect(twice).toEqual(once);
    expect(twice.model).toBe('x');
    expect(twice.hooks!.Stop).toHaveLength(2);
    expect(twice.hooks!.Stop[0]).toEqual(foreign);
    expect(twice.hooks!.SessionEnd[0].hooks[0]).toMatchObject({ command: `${cmd} hook session-end`, timeout: 15 });
    // Moving from the old bin/hub.js to bin/varvar.js replaces the old entries.
    const renamed = mergeHooks(once, hubHooks("/usr/bin/node '/opt/varvar/bin/varvar.js'"));
    expect(renamed.hooks!.Stop).toHaveLength(2);
    expect(renamed.hooks!.Stop[1].hooks[0].command).toContain('varvar.js');
  });
});
