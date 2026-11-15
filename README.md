# varvar

A local web app that shows all my git repos in one place and gives coding agents the same view over MCP. Each project gets a page for agent instructions, handoffs, decisions, tasks and a brainstorm canvas. Everything lives as files in the repos, so git is the history.

## Quick start

```sh
npm install
npm run build
npm link            # optional: puts `varvar` on your PATH (otherwise use `node bin/varvar.js`)

varvar              # scans your folders, starts http://localhost:4319 and opens the browser
```

The first run creates `~/.varvar/config.yaml` with the folders it found (`~/code`, `~/src`, `~/projects`, … `/workspaces`). Edit `roots` there and press **Rescan**.

## What it does

**Overview** — one card per repo, sorted by last activity: last commit, branch and ahead/behind, uncommitted work, open branches and worktrees, the next step (from the newest handoff, else `project.yaml`), open tasks, a stale flag (active but no commit in `stale_days`), and how many commits landed since the last handoff. Filter by status and tag, search, sort. Updates live through a file watcher (plus a 60-second poll for working-tree edits).

**Project page** — opens on the latest handoff, then:

| Tab | What you can do |
| --- | --- |
| Handoff | Read the newest handoff, browse older ones, write one, or draft one from the commits since the last |
| Agent instructions | View and edit `AGENTS.md`; warns when `CLAUDE.md` no longer points to it, or the varvar section is missing |
| Tasks | A Backlog.md board; create tasks and drag them between statuses (each change writes the task file) |
| Decisions | ADRs, newest first; log new ones as *proposed*, change status |
| Brainstorm | A React Flow canvas: ideas, questions, risks and notes with labelled links; agent notes land in the Inbox; promote a node to a task or a decision |
| History | Commits, handoffs and decisions in one timeline |

**Commit project notes** commits only `.project/`, `backlog/`, `AGENTS.md`, `CLAUDE.md` and the varvar skill, with a generated message, and leaves anything else you have staged alone. varvar never pushes.

## Files in each repo

```
<repo>/
├── AGENTS.md               canonical agent instructions
├── CLAUDE.md               pointer: @AGENTS.md
├── .claude/skills/varvar/  the same workflow as plain file edits, for sessions without the MCP server
├── backlog/                tasks in Backlog.md format (its CLI, board and MCP keep working)
└── .project/
    ├── project.yaml        name, summary, status (active/paused/archived), tags, next_step
    ├── handoffs/           one file per session, e.g. 2026-11-01-1430-claude-code.md; newest = current
    ├── decisions/          0001-use-react-flow.md … (front matter: status, date, author)
    └── brainstorm.json     canvas nodes and links; sorted keys, stable ids, clean diffs
```

**Initialise** (on a card, or `varvar init [path]`) creates `.project/`, `AGENTS.md` with the varvar section, the `CLAUDE.md` pointer and the varvar skill. If the repo already has a `CLAUDE.md` with content and no `AGENTS.md`, that content moves into `AGENTS.md`. Nothing is committed.

## Agents: MCP server

`varvar mcp` runs an MCP server over stdio. Its default project is the repo in the agent's working directory; pass `project` (an id from `list_projects`) to look at any other repo.

| Tool | Returns or does |
| --- | --- |
| `list_projects(filter?, status?)` | One line per repo: id, name, status, last commit, next step |
| `get_status(project?)` | Signals, next step, latest handoff, open task count |
| `get_handoff(project?, count=1)` | Newest handoff(s) in full |
| `changes_since(project?, since?)` | Commit summaries and files touched since a date, a commit or the last handoff (default); no diffs |
| `get_decisions(project?, status?)` / `get_decision(id)` | One line per decision / the full text |
| `get_tasks(project?, status?)` / `get_task(id)` | Compact task list / one task in full |
| `get_brainstorm(project?)` | The canvas as an indented outline, plus the Inbox |
| `search_history(query, project?)` | Matches across commits, handoffs, decisions and tasks; all repos when no project is given |
| `write_handoff(done, next, open_questions, gotchas)` | New handoff file |
| `add_task`, `update_task` | Backlog.md task created or changed |
| `log_decision(title, context, decision, consequences)` | New ADR with status *proposed* |
| `add_brainstorm_note(text, kind, link_from?)` | New node in the canvas Inbox |

Responses are capped at about 4,000 characters and say how to get more. Writes record the agent (from the MCP client name, or an `agent` argument) and the time, and can only touch `.project/` and `backlog/`. No tool commits, pushes or runs shell commands.

## Agents without the MCP server: the varvar skill

Everything the MCP tools do is files in the repo, so `init` also writes `.claude/skills/varvar/SKILL.md`. It tells an agent how to read the latest handoff and write a new one, log a decision and add a task (through Backlog.md's own CLI) by hand, with no varvar install. Use it in cloud sessions, on other machines, or with agents that have no MCP. The varvar section in `AGENTS.md` points to it, and the hooks accept a hand-written handoff like any other. Brainstorm notes aren't covered; ideas go in the handoff's Open questions.

## Automatic handoffs (Claude Code)

```sh
varvar setup claude               # shows what it would change (user scope: all repos)
varvar setup claude --write       # adds the hooks to ~/.claude/settings.json
claude mcp add --scope user varvar -- node /path/to/varvar/bin/varvar.js mcp   # printed by the command above
```

Use `--scope project` to write `<repo>/.claude/settings.json` and `<repo>/.mcp.json` instead. Handoffs are enforced in three layers:

1. **AGENTS.md** tells every agent to call `get_status` and `get_handoff` first and `write_handoff` before finishing.
2. **Hooks.** `SessionStart` records when the session began and adds a short pointer to the latest handoff to Claude's context. `Stop` runs after *every* turn, so it only blocks when this session changed the repo (outside the note files) and no handoff has been written since the session started. It never blocks twice in a row and gives up after two tries, so a session can't get stuck.
3. **Fallback.** `SessionEnd` drafts a handoff from the commits since the last one, marked `auto: true, reviewed: false`, when the session still ended without one. The project page shows it as *auto, unreviewed* with a **Mark reviewed** button. For agents without hooks, use **Draft from commits** or `varvar handoff draft`.

Hooks do nothing in repos without `.project/`.

## Deployment modes

The UI is one static build that reads everything through a single `DataSource` interface (`src/shared/datasource.ts`). `varvar-config.json` next to `index.html` picks the source; the UI hides controls the source's `capabilities` don't support.

| Mode | Status | How |
| --- | --- | --- |
| Local | Built | `varvar` serves the build, the API and live updates on `127.0.0.1` |
| Snapshot | Built | `varvar export --out snapshot.json`, copy `dist/web/` plus the snapshot to any static host, add `varvar-config.json` with `{"source":"snapshot"}`. Read-only; local paths are stripped |
| GitHub | Not built yet | `{"source":"github", …}` currently shows a "not built yet" message. The file parsers in `src/shared/` are browser-safe and read through an abstract `RepoReader`, so a GitHub source can reuse them over the GitHub API |

Asset URLs are relative and routing uses the URL hash, so the same build works at `/` and under `/<repo>/` on GitHub Pages.

## Security

- The server binds to `127.0.0.1` and rejects requests whose `Host` isn't localhost (DNS rebinding) and non-GET requests from another `Origin` or without `Content-Type: application/json` (cross-site requests). To reach it through a forwarded port, add that hostname to `allowed_hosts` in the config (or `HUB_ALLOWED_HOSTS`).
- File reads and writes are confined to the repo (no `..`, no `.git/`, no symlinks out). Agents write only to `.project/` and `backlog/`; the UI can also edit `AGENTS.md` and `CLAUDE.md`.
- No telemetry. The SQLite cache (`~/.varvar/cache.db`) only holds what a rescan rebuilds; `varvar cache clear` deletes it.

## CLI

```
varvar [serve] [--port N] [--no-open]  start the web app
varvar mcp [--repo PATH]             MCP server over stdio
varvar list                          overview in the terminal
varvar init [PATH]                   initialise a repo
varvar handoff draft [PATH]          draft an auto handoff from recent commits
varvar setup claude [--scope user|project] [--write]
varvar hook <session-start|stop|session-end>
varvar export [--out FILE]           snapshot for static hosting
varvar cache clear
varvar config
```

Settings live in `~/.varvar/config.yaml` (`roots`, `repos`, `ignore`, `max_depth`, `stale_days`, `port`, `open_browser`, `allowed_hosts`). Set `VARVAR_HOME` to use another folder.

## Development

```sh
npm run dev         # varvar API with reload on :4319 + Vite dev server with HMR (open the Vite URL)
npm test            # vitest: formats, git signals, writes, MCP, hooks, HTTP API
npm run typecheck
npm run build       # dist/server (tsc) + dist/web (vite)
```

Layout: `src/shared/` (types, file formats, the DataSource interface; browser-safe), `src/node/` (scanning, git, writes, cache, watcher), `src/server/` (Hono API + SSE), `src/mcp/`, `src/hooks/`, `src/cli.ts`, and `web/` (React UI).

## Not built yet

- GitHub mode (GitHub App login through the Cloudflare Worker, GraphQL overview).
- Phase 4: launching agents through ACP in their own worktrees.
- Excalidraw attachments on the canvas.
