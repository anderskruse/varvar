---
status: proposed
date: 2026-11-01
author: claude-code
---

# Commits that only touch notes are not work

## Context

Committing a handoff creates a commit after the handoff, so "commits since handoff" and the auto-draft would always report at least one commit after "Commit project notes".

## Decision

Count and summarise only commits that touch something outside .project/, backlog/, AGENTS.md and CLAUDE.md (git pathspec excludes). The same rule decides whether a session did work in the Stop hook.

## Consequences

Cards show 0 commits since handoff right after committing notes. A session that only edits tasks or the canvas is not asked for a handoff. Staleness still uses the last commit of any kind, as the spec defines it.
