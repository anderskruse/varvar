import YAML from 'yaml';
import { asString, asStringArray } from './frontmatter.js';
import { PROJECT_STATUSES, type ProjectMeta, type ProjectStatus } from './types.js';

export const PROJECT_DIR = '.project';
export const PROJECT_YAML = '.project/project.yaml';

export function parseProjectMeta(text: string | null, fallbackName: string): ProjectMeta {
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = (YAML.parse(text) as Record<string, unknown>) ?? {};
    } catch {
      data = {};
    }
  }
  const status = (asString(data.status) ?? 'active').toLowerCase() as ProjectStatus;
  return {
    name: asString(data.name) ?? fallbackName,
    summary: asString(data.summary) ?? '',
    status: PROJECT_STATUSES.includes(status) ? status : 'active',
    tags: asStringArray(data.tags),
    next_step: asString(data.next_step) ?? '',
  };
}

export function serializeProjectMeta(meta: ProjectMeta): string {
  return YAML.stringify(
    {
      name: meta.name,
      summary: meta.summary,
      status: meta.status,
      tags: meta.tags,
      next_step: meta.next_step,
    },
    { lineWidth: 0 },
  );
}

/** Update fields while keeping comments and any extra keys the user added. */
export function patchProjectMeta(text: string | null, patch: Partial<ProjectMeta>, fallbackName: string): string {
  if (!text?.trim()) return serializeProjectMeta({ ...parseProjectMeta(null, fallbackName), ...patch });
  const doc = YAML.parseDocument(text);
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) doc.set(k, v);
  return doc.toString({ lineWidth: 0 });
}
