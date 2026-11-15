#!/usr/bin/env node
// varvar command line.
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { relativeTime } from './shared/dates.js';
import { cachePath, loadConfig, type HubConfig } from './node/config.js';
import { openCache } from './node/cache.js';
import { Hub } from './node/hub.js';
import { AGENT_WRITABLE, UI_WRITABLE, draftAutoHandoff, initialise } from './node/writes.js';
import { repoRoot } from './node/git.js';

const VERSION = '0.1.0';

const HELP = `varvar ${VERSION}

Usage:
  varvar [serve] [--port N] [--no-open]   Start the local web app (http://localhost:4319)
  varvar mcp [--repo PATH]                Run the MCP server over stdio (default project: repo in cwd)
  varvar list                             Print the overview in the terminal
  varvar init [PATH]                      Create .project/, AGENTS.md, the CLAUDE.md pointer and the varvar skill
  varvar handoff draft [PATH]             Draft an "auto, unreviewed" handoff from recent commits
  varvar setup claude [--scope user|project] [--write]
                                          Register the MCP server and handoff hooks with Claude Code
  varvar hook <session-start|stop|session-end>
                                          Claude Code hook entry points (reads JSON on stdin)
  varvar export [--out FILE]              Write snapshot.json for the read-only snapshot mode
  varvar cache clear                      Delete the cache (it is rebuilt on the next scan)
  varvar config                           Show the config file path and settings

Settings: ~/.varvar/config.yaml (override the folder with VARVAR_HOME).`;

function makeHub(cfg: HubConfig, useCache = true): Hub {
  return new Hub(cfg, openCache(useCache ? cachePath() : null));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function repoArg(p: string | undefined): Promise<string> {
  const root = await repoRoot(path.resolve(p ?? '.'));
  if (!root) throw new Error(`${path.resolve(p ?? '.')} is not inside a git repo`);
  return root;
}

async function main(argv: string[]): Promise<void> {
  const [cmd = 'serve', ...rest] = argv;

  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(HELP);
    return;
  }
  if (cmd === '-v' || cmd === '--version') {
    console.log(VERSION);
    return;
  }

  if (cmd === 'serve' || cmd.startsWith('--')) {
    const args = cmd.startsWith('--') ? [cmd, ...rest] : rest;
    const { values } = parseArgs({
      args,
      options: { port: { type: 'string' }, 'no-open': { type: 'boolean' }, 'no-watch': { type: 'boolean' } },
    });
    const cfg = loadConfig();
    if (cfg.created) console.log(`Created ${cfg.file} — scanning ${cfg.roots.join(', ') || '(no roots yet)'}`);
    const { startServer } = await import('./server/start.js');
    const port = Number(values.port) || cfg.port;
    const hub = makeHub(cfg);
    const { url, close } = await startServer({
      hub,
      port,
      open: cfg.open_browser && !values['no-open'],
      allowedHosts: [...cfg.allowed_hosts, ...(process.env.HUB_ALLOWED_HOSTS?.split(',').filter(Boolean) ?? [])],
      watch: !values['no-watch'],
    });
    console.log(`varvar running at ${url}  (Ctrl+C to stop)`);
    const stop = () => void close().finally(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'mcp') {
    const { values } = parseArgs({ args: rest, options: { repo: { type: 'string' }, agent: { type: 'string' } } });
    const { createMcpServer } = await import('./mcp/server.js');
    const cfg = loadConfig({ create: false });
    const hub = makeHub(cfg);
    const server = createMcpServer(hub, {
      cwd: path.resolve(values.repo ?? process.cwd()),
      agentName: values.agent ?? process.env.HUB_AGENT,
      version: VERSION,
    });
    await server.connect(new StdioServerTransport());
    return;
  }

  if (cmd === 'list' || cmd === 'ls') {
    const hub = makeHub(loadConfig());
    const list = await hub.listProjects({ fresh: true });
    list.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
    for (const s of list) {
      const g = s.git;
      const dirty = g.uncommitted?.total ? ` ●${g.uncommitted.total}` : '';
      const sync = g.ahead || g.behind ? ` ↑${g.ahead ?? 0}↓${g.behind ?? 0}` : '';
      const status = s.initialised ? (s.status ?? '') : 'uninitialised';
      console.log(
        `${s.stale ? '!' : ' '} ${s.id.padEnd(24)} ${status.padEnd(13)} ${(g.branch ?? '-').padEnd(18)}${sync}${dirty}  ${relativeTime(g.lastCommit?.date)}${s.nextStep ? `  → ${s.nextStep.text}` : ''}`,
      );
    }
    if (!list.length) console.log(`No repos found under ${hub.config.roots.join(', ') || '(no roots configured)'}.`);
    hub.cache.close();
    return;
  }

  if (cmd === 'init') {
    const repo = await repoArg(rest[0]);
    const res = await initialise({ repo, allowed: UI_WRITABLE });
    for (const f of res.created) console.log(`created  ${f}`);
    for (const f of res.changed) console.log(`updated  ${f}`);
    if (!res.created.length && !res.changed.length) console.log('Already initialised.');
    return;
  }

  if (cmd === 'handoff') {
    const [sub, p] = rest;
    if (sub !== 'draft') throw new Error('Usage: varvar handoff draft [PATH]');
    const repo = await repoArg(p);
    const file = await draftAutoHandoff({ repo, allowed: AGENT_WRITABLE }, { agent: 'varvar', reason: 'drafted with varvar handoff draft' });
    console.log(file ? `Wrote ${file}` : 'Nothing to report: no commits or changes since the last handoff.');
    return;
  }

  if (cmd === 'hook') {
    const { runHook } = await import('./hooks/claude.js');
    try {
      const out = await runHook(rest[0] ?? '', await readStdin());
      if (out) process.stdout.write(out + '\n');
    } catch (e) {
      // Never break the agent's session because of varvar.
      process.stderr.write(`varvar hook: ${(e as Error).message}\n`);
    }
    return;
  }

  if (cmd === 'setup') {
    const [target, ...more] = rest;
    if (target !== 'claude') throw new Error('Usage: varvar setup claude [--scope user|project] [--write]');
    const { values } = parseArgs({ args: more, options: { scope: { type: 'string' }, write: { type: 'boolean' }, repo: { type: 'string' } } });
    const scope = values.scope === 'project' ? 'project' : 'user';
    const { setupClaude } = await import('./hooks/setup.js');
    const repo = scope === 'project' ? await repoArg(values.repo) : process.cwd();
    const res = await setupClaude({ scope, repo, write: !!values.write });
    console.log(`${res.written ? 'Wrote' : 'Would write'} ${res.settingsFile}:\n${res.settingsJson}`);
    if (res.mcpFile) console.log(`${res.written ? 'Wrote' : 'Would write'} ${res.mcpFile}:\n${res.mcpJson}`);
    if (res.mcpCommand) console.log(`Register the MCP server for all repos with:\n  ${res.mcpCommand}\n`);
    if (!res.written) console.log('Nothing written. Re-run with --write to apply.');
    return;
  }

  if (cmd === 'export') {
    const { values } = parseArgs({ args: rest, options: { out: { type: 'string' } } });
    const { exportSnapshot } = await import('./node/snapshot.js');
    const hub = makeHub(loadConfig());
    const out = path.resolve(values.out ?? 'snapshot.json');
    const n = await exportSnapshot(hub, out);
    console.log(`Wrote ${out} (${n} projects). Serve it next to the built UI with varvar-config.json {"source":"snapshot"}.`);
    hub.cache.close();
    return;
  }

  if (cmd === 'cache') {
    if (rest[0] !== 'clear') throw new Error('Usage: varvar cache clear');
    const file = cachePath();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) rmSync(f);
    console.log(`Deleted ${file}`);
    return;
  }

  if (cmd === 'config') {
    const cfg = loadConfig();
    console.log(`${cfg.file}${cfg.created ? ' (just created)' : ''}`);
    console.log(JSON.stringify({ ...cfg, file: undefined, created: undefined }, null, 2));
    return;
  }

  console.error(`Unknown command "${cmd}".\n\n${HELP}`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`varvar: ${(e as Error).message}`);
  process.exit(1);
});
