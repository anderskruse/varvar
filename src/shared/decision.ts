import { asString, parseFrontMatter, stringifyFrontMatter } from './frontmatter.js';
import { firstHeading, firstSentence, getSection, slugify } from './markdown.js';
import { localDay } from './dates.js';
import type { Decision } from './types.js';

export const DECISION_DIR = '.project/decisions';

export interface DecisionInput {
  number: number;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status?: string;
  author?: string;
  date?: Date;
}

const FILE_RE = /^(\d{1,6})-(.+)\.md$/;

export function formatDecisionId(n: number): string {
  return String(n).padStart(4, '0');
}

export function decisionFileName(n: number, title: string): string {
  return `${formatDecisionId(n)}-${slugify(title)}.md`;
}

export function isDecisionFile(file: string): boolean {
  return FILE_RE.test(file);
}

export function nextDecisionNumber(files: string[]): number {
  let max = 0;
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export function parseDecision(file: string, text: string): Decision {
  const { data, body } = parseFrontMatter<Record<string, unknown>>(text);
  const m = FILE_RE.exec(file);
  const number = m ? Number(m[1]) : 0;
  const heading = firstHeading(body);
  const title =
    asString(data.title) ??
    (heading ? heading.replace(/^\d+[.:]\s*/, '') : m ? m[2].replace(/-/g, ' ') : file);
  const decision = getSection(body, 'Decision');
  return {
    id: formatDecisionId(number),
    number,
    file,
    title,
    status: (asString(data.status) ?? 'proposed').toLowerCase(),
    date: asString(data.date) ?? '',
    author: asString(data.author) ?? asString(data.agent),
    supersededBy: asString(data.superseded_by),
    sections: {
      context: getSection(body, 'Context'),
      decision,
      consequences: getSection(body, 'Consequences'),
    },
    summary: firstSentence(decision || body, 200),
    body,
  };
}

export function serializeDecision(input: DecisionInput): string {
  const front = {
    status: input.status ?? 'proposed',
    date: localDay(input.date ?? new Date()),
    author: input.author,
  };
  const body = [
    `# ${input.title.trim()}`,
    '',
    '## Context',
    '',
    input.context.trim() || '_Why is this decision needed?_',
    '',
    '## Decision',
    '',
    input.decision.trim() || '_What was decided?_',
    '',
    '## Consequences',
    '',
    input.consequences.trim() || '_What becomes easier or harder?_',
    '',
  ].join('\n');
  return stringifyFrontMatter(front, body);
}

/** Accepts "3", "0003", "ADR-3", "0003-use-x" or a file name. */
export function parseDecisionRef(ref: string): number | null {
  const m = /(\d{1,6})/.exec(ref);
  return m ? Number(m[1]) : null;
}
