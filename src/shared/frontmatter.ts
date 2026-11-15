import YAML from 'yaml';

const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

export interface FrontMatter<T> {
  data: T;
  body: string;
  hasFrontMatter: boolean;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Split a Markdown file into YAML front matter and body. Invalid YAML yields empty data. */
export function parseFrontMatter<T extends object = Record<string, unknown>>(text: string): FrontMatter<Partial<T>> {
  const src = normalizeNewlines(text);
  const m = FRONT_MATTER.exec(src);
  if (!m) return { data: {}, body: src, hasFrontMatter: false };
  let data: unknown = {};
  try {
    // YAML 1.2 core schema: dates stay strings, which is what we want.
    data = YAML.parse(m[1]) ?? {};
  } catch {
    data = {};
  }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  return { data: data as Partial<T>, body: src.slice(m[0].length), hasFrontMatter: true };
}

/** Render front matter + body. Keys keep insertion order; undefined values are dropped. */
export function stringifyFrontMatter(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = v;
  const yaml = YAML.stringify(clean, { lineWidth: 0 });
  const trimmed = body.replace(/^\n+/, '');
  return `---\n${yaml}---\n\n${trimmed}${trimmed.endsWith('\n') ? '' : '\n'}`;
}

/**
 * Update front matter fields in place, keeping comments, key order and the body untouched.
 * A value of undefined deletes the key.
 */
export function patchFrontMatter(text: string, patch: Record<string, unknown>): string {
  const src = normalizeNewlines(text);
  const m = FRONT_MATTER.exec(src);
  if (!m) return stringifyFrontMatter(patch, src);
  const doc = YAML.parseDocument(m[1]);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) doc.delete(k);
    else doc.set(k, v);
  }
  const yaml = doc.toString({ lineWidth: 0 });
  return `---\n${yaml}---\n${src.slice(m[0].length)}`;
}

export function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return null;
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter((s): s is string => !!s);
  const s = asString(v);
  if (!s) return [];
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}
