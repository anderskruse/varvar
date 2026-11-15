// The local hub API. Binds to 127.0.0.1 only; rejects requests whose Host or
// Origin isn't the hub itself (DNS rebinding and cross-site requests).
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { NODE_KINDS, PROJECT_STATUSES, type HubEvent } from '../shared/types.js';
import { PathError } from '../node/fsutil.js';
import { NotFound, type Hub, type RepoRef } from '../node/hub.js';
import { commitNotes } from '../node/commit.js';
import { userName } from '../node/git.js';
import {
  ConflictError,
  NotFoundError,
  UI_WRITABLE,
  addHubSnippet,
  addTask,
  draftAutoHandoff,
  fixClaudePointer,
  initialise,
  logDecision,
  markHandoffReviewed,
  promoteNode,
  saveAgentsMd,
  saveBrainstorm,
  saveProjectMeta,
  updateDecision,
  updateTask,
  writeHandoff,
  type WriteCtx,
} from '../node/writes.js';

export interface AppOptions {
  port: number;
  allowedHosts?: string[];
  /** Serve the built UI from here (optional; tests skip it). */
  staticRoot?: string | null;
}

const listOrText = z.union([z.string(), z.array(z.string())]).optional();
const schemas = {
  meta: z.object({
    name: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(PROJECT_STATUSES as [string, ...string[]]).optional(),
    tags: z.array(z.string()).optional(),
    next_step: z.string().optional(),
  }),
  handoff: z.object({ done: listOrText, next: listOrText, open_questions: listOrText, gotchas: listOrText, agent: z.string().optional() }),
  agentsMd: z.object({ content: z.string(), baseHash: z.string().nullable() }),
  task: z.object({
    title: z.string().min(1),
    description: z.string().optional(),
    status: z.string().optional(),
    priority: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    acceptanceCriteria: z.array(z.string()).optional(),
  }),
  taskPatch: z.object({
    status: z.string().optional(),
    title: z.string().optional(),
    priority: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    notes: z.string().optional(),
  }),
  decision: z.object({ title: z.string().min(1), context: z.string(), decision: z.string(), consequences: z.string() }),
  decisionPatch: z.object({ status: z.string().min(1) }),
  brainstorm: z.object({
    brainstorm: z.object({
      version: z.literal(1).optional(),
      nodes: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          kind: z.enum(NODE_KINDS as [string, ...string[]]),
          x: z.number(),
          y: z.number(),
          links: z.array(z.object({ to: z.string(), label: z.string().optional() })),
          inbox: z.boolean().optional(),
          author: z.string().optional(),
          created: z.string().optional(),
          promoted: z.object({ type: z.enum(['task', 'decision']), id: z.string() }).optional(),
        }),
      ),
    }),
    knownIds: z.array(z.string()),
  }),
  promote: z.object({ nodeId: z.string(), to: z.enum(['task', 'decision']) }),
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(hub: Hub, opts: AppOptions): Hono {
  const app = new Hono();
  const hosts = new Set(
    ['localhost', '127.0.0.1', '[::1]'].flatMap((h) => [h, `${h}:${opts.port}`]).concat(opts.allowedHosts ?? []),
  );

  app.use('*', async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!hosts.has(host)) return c.text(`Host ${host} not allowed. Add it to allowed_hosts in ~/.varvar/config.yaml.`, 403);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin) {
        let ok = false;
        try {
          ok = hosts.has(new URL(origin).host);
        } catch {
          ok = false;
        }
        if (!ok) return c.text('Cross-origin request refused', 403);
      }
      if (!(c.req.header('content-type') ?? '').includes('application/json')) {
        return c.text('Expected application/json', 415);
      }
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    if (err instanceof NotFound || err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof PathError) return c.json({ error: err.message }, 400);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
    return c.json({ error: err.message }, 500);
  });

  const body = async <T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HttpError(400, 'Invalid JSON body');
    }
    return schema.parse(json);
  };

  const repo = (c: Context) => hub.mustResolve(c.req.param('id') ?? '');
  const ctx = (r: RepoRef): WriteCtx => ({ repo: r.path, allowed: UI_WRITABLE });
  const human = async (r: RepoRef) => (await userName(r.path)) ?? 'human';
  /** After a write: refresh the summary right away (the watcher would too, a bit later). */
  const done = async <T>(r: RepoRef, result: T): Promise<T> => {
    await hub.touched(r).catch(() => {});
    return result;
  };

  app.get('/varvar-config.json', (c) => c.json({ source: 'local' }));

  app.get('/api/info', (c) =>
    c.json({
      capabilities: { write: true, agents: false, uncommitted: true, live: true },
      roots: hub.config.roots,
      lastScan: hub.lastScan,
      version: '0.1.0',
    }),
  );

  app.get('/api/projects', async (c) => c.json(await hub.listProjects()));
  app.post('/api/rescan', async (c) => {
    await hub.refreshAll({ rediscover: true });
    return c.json({ ok: true, lastScan: hub.lastScan });
  });
  app.get('/api/projects/:id', async (c) => c.json(await hub.getDetail(c.req.param('id'))));
  app.get('/api/projects/:id/file', async (c) => {
    const p = c.req.query('path');
    if (!p) throw new HttpError(400, 'path is required');
    return c.text(await hub.readFile(c.req.param('id'), p));
  });
  app.get('/api/projects/:id/history', async (c) => c.json(await hub.history(c.req.param('id'), c.req.query('since') || undefined)));

  // ---- writes ----
  app.post('/api/projects/:id/init', async (c) => {
    const r = await repo(c);
    return c.json(await done(r, await initialise(ctx(r))));
  });
  app.put('/api/projects/:id/meta', async (c) => {
    const r = await repo(c);
    const patch = await body(c, schemas.meta);
    return c.json(await done(r, { path: await saveProjectMeta(ctx(r), patch as never) }));
  });
  app.post('/api/projects/:id/handoffs', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.handoff);
    const path = await writeHandoff(ctx(r), { ...b, agent: b.agent || (await human(r)) });
    return c.json(await done(r, { path }));
  });
  app.post('/api/projects/:id/handoffs/draft', async (c) => {
    const r = await repo(c);
    const path = await draftAutoHandoff(ctx(r), { agent: 'varvar', reason: 'drafted from the project page' });
    return c.json(await done(r, path ? { path } : null));
  });
  app.post('/api/projects/:id/handoffs/:file/reviewed', async (c) => {
    const r = await repo(c);
    return c.json(await done(r, { path: await markHandoffReviewed(ctx(r), c.req.param('file')) }));
  });
  app.put('/api/projects/:id/agents-md', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.agentsMd);
    return c.json(await done(r, { path: await saveAgentsMd(ctx(r), b.content, b.baseHash) }));
  });
  app.post('/api/projects/:id/claude-pointer', async (c) => {
    const r = await repo(c);
    return c.json(await done(r, { path: await fixClaudePointer(ctx(r)) }));
  });
  app.post('/api/projects/:id/hub-snippet', async (c) => {
    const r = await repo(c);
    return c.json(await done(r, { path: await addHubSnippet(ctx(r)) }));
  });
  app.post('/api/projects/:id/tasks', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.task);
    return c.json(await done(r, await addTask(ctx(r), { ...b, reporter: await human(r) })));
  });
  app.patch('/api/projects/:id/tasks/:taskId', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.taskPatch);
    return c.json(await done(r, { path: await updateTask(ctx(r), c.req.param('taskId'), b) }));
  });
  app.post('/api/projects/:id/decisions', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.decision);
    return c.json(await done(r, await logDecision(ctx(r), { ...b, author: await human(r) })));
  });
  app.patch('/api/projects/:id/decisions/:decisionId', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.decisionPatch);
    return c.json(await done(r, { path: await updateDecision(ctx(r), c.req.param('decisionId'), b) }));
  });
  app.put('/api/projects/:id/brainstorm', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.brainstorm);
    const saved = await saveBrainstorm(ctx(r), { version: 1, nodes: b.brainstorm.nodes as never }, b.knownIds);
    return c.json(await done(r, saved));
  });
  app.post('/api/projects/:id/brainstorm/promote', async (c) => {
    const r = await repo(c);
    const b = await body(c, schemas.promote);
    return c.json(await done(r, await promoteNode(ctx(r), b.nodeId, b.to, await human(r))));
  });
  app.post('/api/projects/:id/commit-notes', async (c) => {
    const r = await repo(c);
    return c.json(await done(r, await commitNotes(r.path)));
  });

  // ---- live updates ----
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const queue: HubEvent[] = [];
      let wake: (() => void) | null = null;
      const onEvent = (e: HubEvent) => {
        queue.push(e);
        wake?.();
      };
      hub.on('event', onEvent);
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        await stream.writeSSE({ event: 'hello', data: '{}' });
        while (open) {
          if (!queue.length) {
            await new Promise<void>((resolve) => {
              wake = resolve;
              setTimeout(resolve, 25_000); // keep-alive
            });
            wake = null;
          }
          if (!open) break;
          if (!queue.length) {
            await stream.writeSSE({ event: 'ping', data: '{}' });
            continue;
          }
          const e = queue.shift()!;
          await stream.writeSSE({ event: 'hub', data: JSON.stringify(e) });
        }
      } finally {
        hub.off('event', onEvent);
      }
    }),
  );

  return app;
}
