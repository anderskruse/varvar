# varvar

A local web app and MCP server that show every git repo's state in one place. The spec is the source of truth for scope; the README describes what is built.

## Working here
- Node 20.19+ and TypeScript, ES modules. `npm install`, then `npm test`, `npm run typecheck`, `npm run build`.
- `npm run dev` runs the hub API (tsx watch, :4319) and the Vite dev server together.
- `src/shared/` must stay browser-safe (no Node imports): the web UI and a future GitHub mode parse files with it.
- All file formats live in `src/shared/` (handoff, decision, backlog, brainstorm, projectMeta). Change a format there and add a test in `test/formats.test.ts`. The varvar skill (`src/shared/skill.ts`) teaches agents the handoff and decision formats by example; update it too.
- Every write goes through `src/node/writes.ts`, which enforces the allowed folders. Agents (MCP) may only write `.project/` and `backlog/`.
- Tasks must stay readable by Backlog.md's own CLI. Check with `npx backlog.md task list --plain` after changing `src/shared/backlog.ts`.
- MCP responses must stay under about 4,000 characters (`cap()` in `src/mcp/format.ts`) and end with a hint on how to get more.
- Never add code that commits on its own, pushes, or merges. Only the "Commit project notes" button commits, and only note files.
- Tests create throwaway git repos in the OS temp dir; set `VARVAR_HOME` to keep tests away from `~/.varvar`.

## varvar
- At the start, call get_status and get_handoff for this repo.
- Before you finish, call write_handoff (done, next, open questions, gotchas).
- Record lasting choices with log_decision, not only in chat.
- Put new ideas in add_brainstorm_note and work items in add_task.
- Without these tools (no varvar MCP server), follow the varvar skill in .claude/skills/varvar/SKILL.md: it does the same with plain files.
