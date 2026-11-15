// AGENTS.md (canonical agent instructions) and the CLAUDE.md pointer.
import { SKILL_DIR } from './skill.js';

export const AGENTS_MD = 'AGENTS.md';
export const CLAUDE_MD = 'CLAUDE.md';

export const HUB_SNIPPET = `## varvar
- At the start, call get_status and get_handoff for this repo.
- Before you finish, call write_handoff (done, next, open questions, gotchas).
- Record lasting choices with log_decision, not only in chat.
- Put new ideas in add_brainstorm_note and work items in add_task.
- Without these tools (no varvar MCP server), follow the varvar skill in .claude/skills/varvar/SKILL.md: it does the same with plain files.
`;

export const CLAUDE_POINTER = `# CLAUDE.md

Agent instructions for this repo live in AGENTS.md, shared by every coding agent.

@AGENTS.md
`;

export function agentsTemplate(name: string, summary: string): string {
  return `# ${name}

${summary.trim() || 'Instructions for coding agents working in this repository.'}

${HUB_SNIPPET}`;
}

export function hasHubSnippet(agentsMd: string | null): boolean {
  return !!agentsMd && /^##\s+(?:varvar|Project Hub)\s*$/m.test(agentsMd);
}

export function addHubSnippet(agentsMd: string): string {
  if (hasHubSnippet(agentsMd)) return agentsMd;
  return `${agentsMd.replace(/\s+$/, '')}\n\n${HUB_SNIPPET}`;
}

/** True when CLAUDE.md imports or references AGENTS.md. */
export function claudePointsToAgents(claudeMd: string | null): boolean {
  if (!claudeMd) return false;
  return /@(?:\.\/)?AGENTS\.md\b/.test(claudeMd) || /\bAGENTS\.md\b/.test(claudeMd);
}

/** Add the import to an existing CLAUDE.md without removing anything. */
export function addClaudePointer(claudeMd: string | null): string {
  if (!claudeMd?.trim()) return CLAUDE_POINTER;
  if (/@(?:\.\/)?AGENTS\.md\b/.test(claudeMd)) return claudeMd;
  return `${claudeMd.replace(/\s+$/, '')}\n\n@AGENTS.md\n`;
}

/** Files the "Commit project notes" button commits. */
export const NOTE_PATHS = ['.project', 'backlog', AGENTS_MD, CLAUDE_MD, SKILL_DIR];

/** Pathspec for "real work": everything except the note files, so committing notes doesn't count as work. */
export const WORK_PATHSPEC = ['.', ...NOTE_PATHS.map((p) => `:(exclude)${p}`)];
