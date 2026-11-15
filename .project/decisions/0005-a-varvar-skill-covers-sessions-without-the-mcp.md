---
status: proposed
date: 2026-11-02
author: claude-code
---

# A varvar skill covers sessions without the MCP server

## Context

AGENTS.md tells agents to call get_status and write_handoff, but many sessions have no varvar MCP server: cloud sessions, other machines, clones where varvar isn't installed, agents without MCP. Those sessions couldn't follow the workflow.

## Decision

`init` writes a plain-instructions skill to `.claude/skills/varvar/SKILL.md` (text in `src/shared/skill.ts`). It shows how to read the latest handoff and write a new one, log a decision and add a task (via Backlog.md's CLI) with ordinary file edits. No CLI wrapper, no Node dependency. The AGENTS.md section and the hook messages point to it, and "Commit project notes" includes the skill folder.

## Consequences

The handoff and decision formats are now also described in the skill; tests in `test/formats.test.ts` parse its examples so drift fails the build. Hand-written notes skip the folder checks in `writes.ts`, so the skill states the rule itself. Brainstorm notes are not covered. Existing repos keep their old AGENTS.md section until someone adds the new line.
