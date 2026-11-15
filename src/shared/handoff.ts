import { asString, parseFrontMatter, stringifyFrontMatter } from './frontmatter.js';
import { getSection, listItems, slugify, toBullets } from './markdown.js';
import { fileStamp, localMinute } from './dates.js';
import type { Handoff, HandoffRef } from './types.js';

export const HANDOFF_DIR = '.project/handoffs';

export interface HandoffInput {
  agent: string;
  done?: string | string[];
  next?: string | string[];
  open_questions?: string | string[];
  gotchas?: string | string[];
  branch?: string | null;
  commit?: string | null;
  /** Drafted by the hub, not by the agent. */
  auto?: boolean;
  date?: Date;
}

const FILE_RE = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(?:\d{2})?-(.+?)(?:-\d+)?\.md$/;

/** Handoff file name: "2026-11-01-1430-claude-code.md". */
export function handoffFileName(date: Date, agent: string): string {
  return `${fileStamp(date)}-${slugify(agent, 40)}.md`;
}

/** Newest first. File names start with a sortable timestamp. */
export function sortHandoffFiles(files: string[]): string[] {
  return files.filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** Date and agent guessed from a handoff file name, for listing without reading every file. */
export function refFromFileName(file: string): HandoffRef {
  const m = FILE_RE.exec(file);
  return {
    file,
    date: m ? `${m[1]}T${m[2]}:${m[3]}` : '',
    agent: m ? m[4] : '',
    auto: false,
    reviewed: true,
  };
}

export function parseHandoff(file: string, text: string): Handoff {
  const { data, body } = parseFrontMatter<Record<string, unknown>>(text);
  const fromName = refFromFileName(file);
  const auto = data.auto === true || data.auto === 'true';
  return {
    file,
    date: asString(data.date) ?? fromName.date,
    agent: asString(data.agent) ?? fromName.agent,
    branch: asString(data.branch),
    commit: asString(data.commit),
    auto,
    reviewed: auto ? data.reviewed === true || data.reviewed === 'true' : true,
    sections: {
      done: getSection(body, 'Done'),
      next: getSection(body, 'Next', 'Next steps'),
      open_questions: getSection(body, 'Open questions', 'Questions'),
      gotchas: getSection(body, 'Gotchas'),
    },
    body,
  };
}

export function serializeHandoff(input: HandoffInput): string {
  const date = input.date ?? new Date();
  const front: Record<string, unknown> = {
    date: localMinute(date),
    agent: input.agent,
    branch: input.branch ?? undefined,
    commit: input.commit ?? undefined,
  };
  if (input.auto) {
    front.auto = true;
    front.reviewed = false;
  }
  const body = [
    '## Done',
    toBullets(input.done),
    '',
    '## Next',
    toBullets(input.next),
    '',
    '## Open questions',
    toBullets(input.open_questions),
    '',
    '## Gotchas',
    toBullets(input.gotchas),
    '',
  ].join('\n');
  return stringifyFrontMatter(front, body);
}

/** The first item of the Next section, used as the project's next step. */
export function nextStepFromHandoff(h: Handoff): string | null {
  const items = listItems(h.sections.next);
  return items[0] ?? null;
}

export function toRef(h: Handoff): HandoffRef {
  return { file: h.file, date: h.date, agent: h.agent, auto: h.auto, reviewed: h.reviewed };
}
