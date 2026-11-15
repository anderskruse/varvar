// Picks the data source from varvar-config.json, which is the only thing that
// differs between local, GitHub and snapshot deployments of the same build.
import type { DataSource } from '@shared/datasource';
import { LocalSource } from './local';
import { SnapshotSource } from './snapshot';

export interface HubClientConfig {
  source: 'local' | 'github' | 'snapshot';
  /** snapshot: URL of snapshot.json, relative to the page. */
  snapshotUrl?: string;
  /** github: the Cloudflare Worker that exchanges the login code for a token. */
  workerUrl?: string;
  /** github: the GitHub App's client id. */
  clientId?: string;
}

export class UnsupportedSourceError extends Error {}

export async function loadConfig(): Promise<HubClientConfig> {
  try {
    const res = await fetch('varvar-config.json', { cache: 'no-store' });
    if (res.ok) return (await res.json()) as HubClientConfig;
  } catch {
    /* fall through */
  }
  // No config file: a static host with a snapshot next to the page, or the hub itself.
  try {
    const res = await fetch('snapshot.json', { method: 'HEAD' });
    if (res.ok) return { source: 'snapshot' };
  } catch {
    /* fall through */
  }
  return { source: 'local' };
}

export async function createSource(cfg: HubClientConfig): Promise<DataSource> {
  switch (cfg.source) {
    case 'local':
      return new LocalSource();
    case 'snapshot': {
      const s = new SnapshotSource(cfg.snapshotUrl ?? 'snapshot.json');
      await s.ready();
      return s;
    }
    case 'github':
      // Planned: GitHub login through the Cloudflare Worker, then the shared
      // readers in src/shared/project.ts over the GitHub API (read-only).
      throw new UnsupportedSourceError(
        'GitHub mode is not built yet. This build supports local mode and snapshots (varvar export).',
      );
    default:
      throw new UnsupportedSourceError(`Unknown source "${String((cfg as { source: unknown }).source)}" in varvar-config.json`);
  }
}
