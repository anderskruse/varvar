// Small Markdown helpers. We only need headings, sections and bullet lists.

export interface Section {
  heading: string;
  level: number;
  content: string;
}

/** Split Markdown into sections by headings of the given level (default ##). */
export function splitSections(body: string, level = 2): Section[] {
  const lines = body.split('\n');
  const sections: Section[] = [];
  const re = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`);
  let current: Section | null = null;
  let inFence = false;
  const pre: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : re.exec(line);
    if (m) {
      if (current) sections.push(finish(current));
      current = { heading: m[1].trim(), level, content: '' };
      continue;
    }
    if (current) current.content += line + '\n';
    else pre.push(line);
  }
  if (current) sections.push(finish(current));
  return sections;
}

function finish(s: Section): Section {
  return { ...s, content: s.content.replace(/^\n+|\s+$/g, '') };
}

export function normalizeHeading(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Find a section by heading, case- and punctuation-insensitive. */
export function getSection(body: string, ...names: string[]): string {
  const wanted = names.map(normalizeHeading);
  for (const s of splitSections(body)) {
    if (wanted.includes(normalizeHeading(s.heading))) return s.content;
  }
  return '';
}

/** First H1 heading text, if any. */
export function firstHeading(body: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return m ? m[1].trim() : null;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;

/** Items of a bullet list; plain paragraphs count as one item each. Placeholder "…" items are dropped. */
export function listItems(text: string): string[] {
  const items: string[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    if (BULLET.test(raw)) {
      items.push(raw.replace(BULLET, '').trim());
    } else if (/^\s{2,}\S/.test(raw) && items.length) {
      items[items.length - 1] += ' ' + raw.trim();
    } else {
      items.push(raw.trim());
    }
  }
  return items.filter((i) => i && !/^(…|\.\.\.|-|none\.?|n\/a)$/i.test(i));
}

/**
 * Accept either a list of strings or free text and return a Markdown bullet list.
 * Free text that already contains bullets is kept as is.
 */
export function toBullets(input: string | string[] | undefined | null): string {
  if (input === undefined || input === null) return '- None';
  if (Array.isArray(input)) {
    const clean = input.map((s) => s.trim()).filter(Boolean);
    return clean.length ? clean.map((s) => `- ${s.replace(/\n+/g, ' ')}`).join('\n') : '- None';
  }
  const text = input.trim();
  if (!text) return '- None';
  if (text.split('\n').some((l) => BULLET.test(l))) return text;
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l}`)
    .join('\n');
}

/** Collapse Markdown to a single plain line, for summaries. */
export function oneLine(text: string, max = 160): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/[#>*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(flat, max);
}

/** First sentence of a block of text. */
export function firstSentence(text: string, max = 200): string {
  const line = oneLine(text, 2000);
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return truncate(m ? m[1] : line, max);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function slugify(s: string, max = 50): string {
  const slug = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug || 'untitled';
  // Cut at a word boundary when one is reasonably close.
  const cut = slug.slice(0, max + 1).lastIndexOf('-');
  return (cut > max / 2 ? slug.slice(0, cut) : slug.slice(0, max)).replace(/-+$/g, '') || 'untitled';
}
