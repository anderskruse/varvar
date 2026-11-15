import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Hub } from '../node/hub.js';
import { RepoWatcher } from '../node/watcher.js';
import { createApp } from './app.js';

export function webRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'dist', 'web');
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available */
  }
}

export interface StartOptions {
  hub: Hub;
  port: number;
  open: boolean;
  allowedHosts: string[];
  watch?: boolean;
}

export async function startServer(opts: StartOptions): Promise<{ server: ServerType; url: string; close: () => Promise<void> }> {
  const app = createApp(opts.hub, { port: opts.port, allowedHosts: opts.allowedHosts });
  const root = webRoot();
  if (root) {
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ root, path: 'index.html' }));
  } else {
    app.get('/', (c) => c.text('The UI is not built. Run `npm run build:web`, or use `npm run dev` for the Vite dev server.'));
  }

  const watcher = opts.watch === false ? null : new RepoWatcher(opts.hub);
  const server = await new Promise<ServerType>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port, hostname: '127.0.0.1' }, () => resolve(s));
    s.on('error', reject);
  });
  const url = `http://localhost:${opts.port}/`;

  // Serve cached summaries immediately; refresh in the background.
  void opts.hub
    .refreshAll({ rediscover: !opts.hub.cache.getRepos() })
    .then(() => watcher?.start())
    .catch((e) => process.stderr.write(`varvar: scan failed: ${(e as Error).message}\n`));

  if (opts.open) openBrowser(url);
  return {
    server,
    url,
    close: async () => {
      await watcher?.stop();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
