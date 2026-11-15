---
status: proposed
date: 2026-11-01
author: claude-code
---

# Share file parsers between the hub and hosted modes

## Context

GitHub mode must show the same handoffs, decisions, tasks and canvas from the GitHub API that the local hub reads from disk.

## Decision

Keep every format parser and the summary/detail builders in src/shared/, free of Node imports, reading files through an abstract RepoReader (list a directory, read a file). The local hub implements it with fs; a GitHub source can implement it with the contents or GraphQL API.

## Consequences

Format changes happen in one place and are tested once. GitHub mode still needs its own git signals (last commit, branches) from the API, and must report capabilities without uncommitted work or worktrees.
