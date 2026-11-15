// The varvar skill: the same handoff workflow as the MCP tools, done by
// reading and writing the files directly. For sessions where the MCP server
// isn't registered (cloud sessions, other machines, agents without MCP).

export const SKILL_DIR = '.claude/skills/varvar';
export const SKILL_FILE = `${SKILL_DIR}/SKILL.md`;

/** The example handoff in the skill. Tests parse it, so keep it a valid handoff. */
export const SKILL_HANDOFF_EXAMPLE = `---
date: 2026-11-01T14:30
agent: claude-code
branch: main
commit: 0de7eb4
---

## Done
- What changed this session, and how it was verified

## Next
- The most important next step first

## Open questions
- Anything the user should decide

## Gotchas
- Traps the next session should know about
`;

export const SKILL_MD = `---
name: varvar
description: Read and write this repo's varvar project notes (handoffs, decisions, tasks) as plain files. Use at the start and end of a session when the varvar MCP tools (get_status, get_handoff, write_handoff, log_decision, add_task) are not available.
---

# varvar notes without the MCP server

The varvar MCP tools are a convenience; everything they do is files in this repo. When the tools are missing, do the same by hand.

Only write under \`.project/\` and \`backlog/\`. Never commit, push or merge: the user commits notes from the varvar UI.

## At the start

1. Read \`.project/project.yaml\` (name, summary, status, next_step).
2. Read the newest handoff: \`ls .project/handoffs/*.md | tail -1\` (file names sort by time).
3. See what happened since: \`git log --oneline <commit from the handoff>..HEAD\`.
4. Optional: \`ls .project/decisions/\` for lasting choices, \`npx backlog.md task list --plain\` for open tasks.

## Before you finish: write a handoff

Create a new file (never edit an old one) named with the local time and your agent name:

\`\`\`sh
.project/handoffs/$(date +%Y-%m-%d-%H%M)-claude-code.md
\`\`\`

If that name exists, add \`-2\`. Fill \`date\` with \`date +%Y-%m-%dT%H:%M\`, \`branch\` with \`git branch --show-current\` and \`commit\` with \`git rev-parse --short HEAD\`:

\`\`\`markdown
${SKILL_HANDOFF_EXAMPLE}\`\`\`

Keep all four sections, use \`- None\` for an empty one, and say so in Next if the work is unfinished.

## Lasting choices: log a decision

Create \`.project/decisions/NNNN-short-title.md\`, where NNNN is one more than the highest existing number:

\`\`\`markdown
---
status: proposed
date: 2026-11-01
author: claude-code
---

# Short title

## Context

Why the decision was needed.

## Decision

What was decided.

## Consequences

What becomes easier or harder.
\`\`\`

## Work items: add a task

\`\`\`sh
npx backlog.md task create "Title" -d "What and why" --plain
\`\`\`

Ideas that aren't tasks yet go in the handoff's Open questions.
`;
