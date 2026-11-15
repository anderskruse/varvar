---
status: accepted
date: 2026-11-02
author: claude-code
---

# The product is called varvar

## Context

The spec called the tool "Project Hub" with a placeholder CLI `hub` (TASK-3). The user settled the name: Project Hub is varvar.

## Decision

All user- and agent-facing names are varvar: the CLI (`varvar`, bin/varvar.js), the MCP server name, the UI title, `~/.varvar` with `VARVAR_HOME`, the `## varvar` section in AGENTS.md, the varvar skill and `varvar-config.json` for static builds. Internal code names (`Hub` class, src/node/hub.ts, the SSE event name) stay as they are.

## Consequences

Older `## Project Hub` sections and hook commands that call bin/hub.js are still recognised, so `init` doesn't add a second section and `varvar setup claude` replaces old hooks. Settings in an old ~/.project-hub are not migrated; nothing had been configured there yet.
