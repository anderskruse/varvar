// Snapshot mode: a read-only view from `varvar export` output, for a static host.
import type { Capabilities, DataSource } from '@shared/datasource';
import type { HistoryItem, ProjectDetail, ProjectSummary } from '@shared/types';

interface Snapshot {
  version: 1;
  exportedAt: string;
  projects: ProjectSummary[];
  details: Record<string, ProjectDetail>;
  history: Record<string, HistoryItem[]>;
  files: Record<string, Record<string, string>>;
}

export class SnapshotSource implements DataSource {
  readonly kind = 'snapshot' as const;
  readonly capabilities: Capabilities = { write: false, agents: false, uncommitted: true, live: false };
  private data: Promise<Snapshot>;
  label = 'Snapshot';

  constructor(url: string) {
    this.data = fetch(url).then(async (r) => {
      if (!r.ok) throw new Error(`Could not load ${url} (${r.status})`);
      const snap = (await r.json()) as Snapshot;
      this.label = `Snapshot · ${new Date(snap.exportedAt).toLocaleString()}`;
      return snap;
    });
  }

  async ready(): Promise<void> {
    await this.data;
  }

  async listProjects() {
    return (await this.data).projects;
  }

  async getProject(id: string) {
    const d = (await this.data).details[id];
    if (!d) throw new Error(`No project ${id} in this snapshot`);
    return d;
  }

  async readFile(id: string, path: string) {
    const f = (await this.data).files[id]?.[path];
    if (f === undefined) throw new Error(`${path} is not included in this snapshot`);
    return f;
  }

  async history(id: string, since?: string) {
    const items = (await this.data).history[id] ?? [];
    return since ? items.filter((i) => i.date >= since) : items;
  }
}
