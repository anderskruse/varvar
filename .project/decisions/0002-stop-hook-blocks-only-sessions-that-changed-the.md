---
status: proposed
date: 2026-11-01
author: claude-code
---

# Stop hook blocks only sessions that changed the repo

## Context

Claude Code's Stop hook runs after every assistant turn, not only at session end. Blocking until a handoff exists would force a handoff after the first question-and-answer turn. Claude Code also caps consecutive Stop-hook continuations and sets stop_hook_active while one is in progress. SessionEnd hooks get 1.5 s by default.

## Decision

SessionStart records the start time and a fingerprint of HEAD plus the working tree (outside the note files). Stop blocks only when the fingerprint changed and no handoff is newer than the session start; it never blocks when stop_hook_active is set or background work is pending, and gives up after two blocks. SessionEnd drafts an "auto, unreviewed" handoff if none was written, with an explicit 15 s timeout.

## Consequences

Chatty sessions are never nagged; working sessions write one handoff. A session that writes a handoff early and keeps working is not asked for a second one. Session records live in ~/.project-hub/sessions/ and are cleaned after 7 days.
