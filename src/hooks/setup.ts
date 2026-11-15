// `varvar setup claude`: register the MCP server and the handoff hooks with Claude Code.
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not find the varvar package root');
    dir = parent;
  }
  return dir;
}

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Absolute command that runs this hub, independent of PATH. */
export function hubCommandParts(): string[] {
  return [process.execPath, path.join(packageRoot(), 'bin', 'varvar.js')];
}

export function hubCommand(): string {
  return hubCommandParts().map(q).join(' ');
}

interface HookHandler {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
}
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

export function hubHooks(cmd: string): Record<string, HookGroup[]> {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: `${cmd} hook session-start`, timeout: 15 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `${cmd} hook stop`, timeout: 30 }] }],
    // SessionEnd hooks get 1.5 s by default; a per-hook timeout raises the budget.
    SessionEnd: [{ hooks: [{ type: 'command', command: `${cmd} hook session-end`, timeout: 15 }] }],
  };
}

const isHubHook = (h: HookHandler) => / hook (session-start|stop|session-end)$/.test(h.command) && /(?:hub|varvar)(\.js)?['"]? hook /.test(h.command);

/** Add our hooks, replacing earlier varvar (or Project Hub) entries and keeping everything else. */
export function mergeHooks(settings: Settings, hooks: Record<string, HookGroup[]>): Settings {
  const out: Settings = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  for (const [event, groups] of Object.entries(hooks)) {
    const existing = (out.hooks![event] ?? [])
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isHubHook(h)) }))
      .filter((g) => g.hooks.length);
    out.hooks![event] = [...existing, ...groups];
  }
  return out;
}

export interface SetupResult {
  settingsFile: string;
  settingsJson: string;
  mcpFile: string | null;
  mcpJson: string | null;
  mcpCommand: string | null;
  written: boolean;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not parse ${file}: ${(e as Error).message}`);
  }
}

export async function setupClaude(opts: { scope: 'user' | 'project'; repo: string; write: boolean; home?: string }): Promise<SetupResult> {
  const cmd = hubCommand();
  const home = opts.home ?? os.homedir();
  const settingsFile = opts.scope === 'user' ? path.join(home, '.claude', 'settings.json') : path.join(opts.repo, '.claude', 'settings.json');
  const settings = mergeHooks((await readJson(settingsFile)) as Settings, hubHooks(cmd));
  const settingsJson = JSON.stringify(settings, null, 2) + '\n';

  let mcpFile: string | null = null;
  let mcpJson: string | null = null;
  let mcpCommand: string | null = null;
  const [node, bin] = hubCommandParts();
  if (opts.scope === 'project') {
    mcpFile = path.join(opts.repo, '.mcp.json');
    const mcp = await readJson(mcpFile);
    const servers = { ...((mcp.mcpServers as Record<string, unknown>) ?? {}), varvar: { command: node, args: [bin, 'mcp'] } };
    mcpJson = JSON.stringify({ ...mcp, mcpServers: servers }, null, 2) + '\n';
  } else {
    mcpCommand = `claude mcp add --scope user varvar -- ${q(node)} ${q(bin)} mcp`;
  }

  if (opts.write) {
    await fs.mkdir(path.dirname(settingsFile), { recursive: true });
    await fs.writeFile(settingsFile, settingsJson);
    if (mcpFile && mcpJson) await fs.writeFile(mcpFile, mcpJson);
  }
  return { settingsFile, settingsJson, mcpFile, mcpJson, mcpCommand, written: opts.write };
}
