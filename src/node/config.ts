import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export interface HubConfig {
  /** Folders scanned for git repos. */
  roots: string[];
  /** Extra individual repos outside the roots. */
  repos: string[];
  /** Glob patterns (picomatch) matched against folder names and paths; matches are skipped. */
  ignore: string[];
  /** How deep to look for repos below each root. */
  max_depth: number;
  /** Active projects with no commit for this many days are stale. */
  stale_days: number;
  port: number;
  open_browser: boolean;
  /** Extra Host header values the server accepts (e.g. a forwarded port's hostname). */
  allowed_hosts: string[];
}

export const DEFAULT_IGNORE = [
  'node_modules',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'dist',
  'build',
  'target',
  '.Trash',
  'Library',
];

const DEFAULTS: HubConfig = {
  roots: [],
  repos: [],
  ignore: DEFAULT_IGNORE,
  max_depth: 3,
  stale_days: 30,
  port: 4319,
  open_browser: true,
  allowed_hosts: [],
};

/** ~/.varvar, or $VARVAR_HOME. */
export function hubHome(): string {
  return process.env.VARVAR_HOME ? path.resolve(process.env.VARVAR_HOME) : path.join(os.homedir(), '.varvar');
}

export function configPath(): string {
  return path.join(hubHome(), 'config.yaml');
}

export function cachePath(): string {
  return path.join(hubHome(), 'cache.db');
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function guessRoots(): string[] {
  const candidates = ['~/code', '~/src', '~/projects', '~/dev', '~/repos', '~/git', '/workspaces'];
  return candidates.filter((c) => {
    try {
      return statSync(expandHome(c)).isDirectory();
    } catch {
      return false;
    }
  });
}

function defaultConfigText(roots: string[]): string {
  return `# varvar settings. varvar keeps no other data; the cache next to this file can be deleted any time.

# Folders to scan for git repos.
roots:
${(roots.length ? roots : ['~/code']).map((r) => `  - ${r}`).join('\n')}

# Individual repos outside those folders.
repos: []

# Folder names or path globs to skip while scanning.
ignore:
${DEFAULT_IGNORE.map((i) => `  - ${i}`).join('\n')}

# How many folder levels below each root to look for repos.
max_depth: ${DEFAULTS.max_depth}

# Active projects without a commit for this many days are marked stale.
stale_days: ${DEFAULTS.stale_days}

# Local web server. It only ever binds to 127.0.0.1.
port: ${DEFAULTS.port}
open_browser: true

# Extra Host header values to accept, e.g. a forwarded port's hostname.
allowed_hosts: []
`;
}

export interface LoadedConfig extends HubConfig {
  file: string;
  created: boolean;
}

/** Load ~/.varvar/config.yaml, creating it with sensible roots on first run. */
export function loadConfig(opts: { create?: boolean } = {}): LoadedConfig {
  const file = configPath();
  let created = false;
  let raw: Partial<HubConfig> = {};
  if (existsSync(file)) {
    raw = (YAML.parse(readFileSync(file, 'utf8')) as Partial<HubConfig>) ?? {};
  } else if (opts.create !== false) {
    mkdirSync(path.dirname(file), { recursive: true });
    const text = defaultConfigText(guessRoots());
    writeFileSync(file, text);
    raw = YAML.parse(text) as Partial<HubConfig>;
    created = true;
  }
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const cfg: HubConfig = {
    roots: list(raw.roots).map(expandHome).map((p) => path.resolve(p)),
    repos: list(raw.repos).map(expandHome).map((p) => path.resolve(p)),
    ignore: raw.ignore === undefined ? DEFAULTS.ignore : list(raw.ignore),
    max_depth: Number(raw.max_depth) || DEFAULTS.max_depth,
    stale_days: Number(raw.stale_days) || DEFAULTS.stale_days,
    port: Number(raw.port) || DEFAULTS.port,
    open_browser: raw.open_browser === undefined ? DEFAULTS.open_browser : Boolean(raw.open_browser),
    allowed_hosts: list(raw.allowed_hosts),
  };
  return { ...cfg, file, created };
}
