import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openCache } from '../src/node/cache.js';
import { Hub } from '../src/node/hub.js';
import { createMcpServer } from '../src/mcp/server.js';
import { RESPONSE_CAP } from '../src/mcp/format.js';
import { makeRepo, tmp } from './helpers.js';

let root: string;
let repo: string;
let other: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content as { text: string }[])[0].text, isError: !!r.isError };
}

beforeAll(async () => {
  root = await fs.realpath(tmp('hub-mcp-'));
  repo = makeRepo(root, 'app', [{ 'README.md': '# app\n' }, { 'src/main.ts': 'x' }]);
  other = makeRepo(root, 'library', [{ 'lib.ts': 'export {}' }]);
  await fs.mkdir(path.join(repo, '.project'), { recursive: true });
  await fs.writeFile(path.join(repo, '.project/project.yaml'), 'name: App\nstatus: active\n');
  const hub = new Hub(
    { roots: [root], repos: [], ignore: [], max_depth: 2, stale_days: 30, port: 0, open_browser: false, allowed_hosts: [] },
    openCache(null),
  );
  const server = createMcpServer(hub, { cwd: path.join(repo, 'src') });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes the spec tools', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'add_brainstorm_note',
        'add_task',
        'changes_since',
        'get_brainstorm',
        'get_decision',
        'get_decisions',
        'get_handoff',
        'get_status',
        'get_task',
        'get_tasks',
        'list_projects',
        'log_decision',
        'search_history',
        'update_task',
        'write_handoff',
      ].sort(),
    );
  });

  it('defaults to the repo of the working directory', async () => {
    const r = await call('get_status');
    expect(r.text).toContain('# App (app)');
    expect(r.text).toContain('Latest handoff: none');
    const lib = await call('get_status', { project: 'library' });
    expect(lib.text).toContain('not initialised');
  });

  it('lists projects one line each', async () => {
    const r = await call('list_projects');
    expect(r.text.split('\n')[0]).toBe('2 projects:');
    expect(r.text).toMatch(/^app \| App \| active \| .*commit 2/m);
  });

  it('writes and reads handoffs, recording the client as agent', async () => {
    const w = await call('write_handoff', { done: ['Wired MCP'], next: ['Write the UI'], open_questions: 'Name?', gotchas: [] });
    expect(w.text).toMatch(/^Wrote \.project\/handoffs\/\d{4}-\d{2}-\d{2}-\d{4}-test-agent\.md/);
    const r = await call('get_handoff');
    expect(r.text).toContain('agent: test-agent');
    expect(r.text).toContain('## Next\n- Write the UI');
    const s = await call('get_status');
    expect(s.text).toContain('Next step: Write the UI (from handoff)');
  });

  it('manages tasks, decisions and the brainstorm', async () => {
    expect((await call('add_task', { title: 'First', priority: 'high', labels: ['ui'] })).text).toContain('Created TASK-1');
    await call('update_task', { id: 'TASK-1', status: 'In Progress', notes: 'started' });
    expect((await call('get_tasks')).text).toContain('In Progress (1):\nTASK-1 [In Progress] First (high) #ui');
    expect((await call('get_task', { id: '1' })).text).toContain('started');

    expect((await call('log_decision', { title: 'Use SSE', context: 'c', decision: 'Use SSE for live updates.', consequences: 'x' })).text).toContain(
      'Logged decision 0001 (proposed)',
    );
    expect((await call('get_decisions', { status: 'proposed' })).text).toContain('0001 [proposed]');
    expect((await call('get_decision', { id: '0001' })).text).toContain('Use SSE for live updates.');

    const note = await call('add_brainstorm_note', { text: 'Try worktrees', kind: 'idea' });
    expect(note.text).toContain('to the brainstorm Inbox');
    const outline = await call('get_brainstorm');
    expect(outline.text).toContain('[idea] Try worktrees (by test-agent)');
  });

  it('summarises changes without diffs and searches across repos', async () => {
    const c = await call('changes_since', { since: '2000-01-01' });
    expect(c.text).toContain('commit 2');
    expect(c.text).toContain('- src/main.ts');
    const s = await call('search_history', { query: 'live updates' });
    expect(s.text).toContain('## app');
    expect(s.text).toContain('decision 0001');
  });

  it('caps long responses and says how to get more', async () => {
    for (let i = 0; i < 60; i++) await call('add_task', { title: `Task number ${i} with a reasonably long title to fill space` });
    const r = await call('get_tasks');
    expect(r.text.length).toBeLessThanOrEqual(RESPONSE_CAP);
    expect(r.text).toMatch(/truncated: \d+ more characters\. Filter by status/);
  });

  it('reports bad input as tool errors', async () => {
    const r = await call('get_status', { project: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Unknown project');
    expect((await call('get_decision', { id: '99' })).isError).toBe(true);
  });
});
