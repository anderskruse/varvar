---
id: TASK-1
title: "GitHub mode: read-only DataSource over the GitHub API"
status: To Do
assignee: []
reporter: claude-code
created_date: '2026-11-01T22:18:00Z'
labels:
  - hosting
dependencies: []
priority: medium
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Implement source "github" in web/src/data/source.ts: GitHub App login through the existing Cloudflare Worker (code exchange and token refresh), then a RepoReader over the API reusing src/shared/project.ts. Overview data for all installed repos in a few GraphQL requests, cached in the browser.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Sign-in through the worker works and lists the repos the GitHub App is installed on
- [ ] #2 Project page shows handoffs, decisions, tasks and brainstorm read from GitHub
- [ ] #3 Write and agent controls are hidden
<!-- AC:END -->

