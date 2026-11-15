---
status: proposed
date: 2026-11-01
author: claude-code
---

# Use Server-Sent Events for live updates

## Context

The spec suggests Hono or Fastify plus WebSocket. Live updates only flow from the hub to the browser (project changed, scan started/finished); every action from the browser is a normal HTTP request.

## Decision

Use Server-Sent Events (Hono streamSSE, browser EventSource) instead of WebSocket. EventSource reconnects on its own, needs no extra dependency, and passes the same Host check as the rest of the API.

## Consequences

One less dependency and no upgrade handling. If phase 4 needs two-way streaming with an agent (for example answering permission prompts), revisit: either add WebSocket for that channel or keep SSE for output plus POST for input.
