import { promises as fs, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { openCache } from '../src/node/cache.js';
import { Hub } from '../src/node/hub.js';
import { createApp } from '../src/server/app.js';
import type { ProjectDetail, ProjectSummary } from '../src/shared/types.js';
import { makeRepo, tmp } from './helpers.js';

let root: string;
let app: Hono;
const PORT = 4319;

const req = (url: string, init: RequestInit & { host?: string } = {}) =>
  app.request(`http://localhost:${PORT}${url}`, {
    ...init,
    headers: { host: init.host ?? `localhost:${PORT}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) },
  });

beforeAll(async () => {
  root = await fs.realpath(tmp('hub-server-'));
  makeRepo(root, 'site');
  const hub = new Hub(
    { roots: [root], repos: [], ignore: [], max_depth: 2, stale_days: 30, port: PORT, open_browser: false, allowed_hosts: [] },
    openCache(null),
  );
  app = createApp(hub, { port: PORT });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('hub API', () => {
  it('refuses foreign hosts and cross-site writes', async () => {
    expect((await req('/api/projects', { host: 'attacker.example' })).status).toBe(403);
    expect((await req('/api/rescan', { method: 'POST', body: '{}', headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    expect((await req('/api/rescan', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect((await req('/api/rescan', { method: 'POST', body: '{}', headers: { origin: `http://localhost:${PORT}` } })).status).toBe(200);
  });

  it('initialises a repo and edits its notes', async () => {
    const list = (await (await req('/api/projects')).json()) as ProjectSummary[];
    expect(list.map((p) => p.id)).toEqual(['site']);
    expect(list[0].initialised).toBe(false);

    expect((await req('/api/projects/site/init', { method: 'POST', body: '{}' })).status).toBe(200);
    const detail = (await (await req('/api/projects/site')).json()) as ProjectDetail;
    expect(detail.summary.initialised).toBe(true);
    expect(detail.summary.agents).toMatchObject({ agentsMd: true, claudePointer: true, snippet: true });

    const task = await req('/api/projects/site/tasks', { method: 'POST', body: JSON.stringify({ title: 'From the UI' }) });
    expect(await task.json()).toMatchObject({ id: 'TASK-1' });
    expect((await req('/api/projects/site/tasks/TASK-1', { method: 'PATCH', body: JSON.stringify({ status: 'done' }) })).status).toBe(200);
    const after = (await (await req('/api/projects/site')).json()) as ProjectDetail;
    expect(after.tasks[0].status).toBe('Done');
    expect(after.summary.openTasks).toBe(0);
  });

  it('rejects stale AGENTS.md edits and bad input', async () => {
    const conflict = await req('/api/projects/site/agents-md', { method: 'PUT', body: JSON.stringify({ content: 'x', baseHash: 'stale' }) });
    expect(conflict.status).toBe(409);
    const bad = await req('/api/projects/site/decisions', { method: 'POST', body: JSON.stringify({ title: '' }) });
    expect(bad.status).toBe(400);
    expect((await req('/api/projects/site/file?path=../../etc/passwd')).status).toBe(400);
    expect((await req('/api/projects/nope')).status).toBe(404);
  });

  it('merges canvas saves with notes it has not seen', async () => {
    const agentNode = { id: 'n-agent', text: 'agent idea', kind: 'idea', x: 0, y: 0, links: [], inbox: true };
    await fs.writeFile(path.join(root, 'site/.project/brainstorm.json'), JSON.stringify({ version: 1, nodes: [agentNode] }));
    const mine = { id: 'n-mine', text: 'mine', kind: 'risk', x: 5, y: 5, links: [] };
    const res = await req('/api/projects/site/brainstorm', {
      method: 'PUT',
      body: JSON.stringify({ brainstorm: { version: 1, nodes: [mine] }, knownIds: ['n-mine'] }),
    });
    const saved = (await res.json()) as { nodes: { id: string }[] };
    expect(saved.nodes.map((n) => n.id).sort()).toEqual(['n-agent', 'n-mine']);
  });
});
