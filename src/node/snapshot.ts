// `varvar export`: a read-only snapshot for the static snapshot mode.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HANDOFF_DIR } from '../shared/handoff.js';
import type { HistoryItem, ProjectDetail, ProjectSummary } from '../shared/types.js';
import { readText } from './fsutil.js';
import { history } from './history.js';
import { mapLimit, type Hub } from './hub.js';
import { detailRepo } from './repo.js';

export interface Snapshot {
  version: 1;
  exportedAt: string;
  projects: ProjectSummary[];
  details: Record<string, ProjectDetail>;
  history: Record<string, HistoryItem[]>;
  /** Extra files the UI may read (older handoffs), keyed by project id then repo-relative path. */
  files: Record<string, Record<string, string>>;
}

/** Local paths are dropped: a snapshot may be hosted. */
function scrub(s: ProjectSummary): ProjectSummary {
  return {
    ...s,
    path: null,
    git: { ...s.git, worktrees: s.git.worktrees?.map((w) => ({ ...w, path: path.basename(w.path) })) ?? null },
  };
}

export async function exportSnapshot(hub: Hub, out: string, maxHandoffs = 100): Promise<number> {
  const summaries = await hub.listProjects({ fresh: true });
  const repos = hub.allRepos();
  const snap: Snapshot = { version: 1, exportedAt: new Date().toISOString(), projects: [], details: {}, history: {}, files: {} };
  await mapLimit(summaries, 4, async (s) => {
    const repo = repos.find((r) => r.id === s.id);
    if (!repo) return;
    const clean = scrub(s);
    const detail = await detailRepo(repo.path, s);
    snap.projects.push(clean);
    snap.details[s.id] = { ...detail, summary: clean };
    snap.history[s.id] = await history(repo.path);
    const files: Record<string, string> = {};
    for (const h of detail.handoffs.slice(0, maxHandoffs)) {
      const rel = `${HANDOFF_DIR}/${h.file}`;
      const text = await readText(path.join(repo.path, rel));
      if (text !== null) files[rel] = text;
    }
    snap.files[s.id] = files;
  });
  snap.projects.sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''));
  await fs.writeFile(out, JSON.stringify(snap));
  return snap.projects.length;
}
