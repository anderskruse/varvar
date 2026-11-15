// Claude Code hooks that enforce handoffs.
//
// - SessionStart records when the session began (and the repo's state) and
//   adds a one-paragraph pointer to the latest handoff to Claude's context.
// - Stop fires after every turn. It blocks only when this session changed the
//   repo and no handoff newer than the session start exists. It never blocks
//   twice in a row (stop_hook_active) and gives up after a few tries, so a
//   session can't get stuck.
// - SessionEnd drafts an "auto, unreviewed" handoff from the commits if the
//   session still ended without one.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { NOTE_PATHS } from '../shared/agents.js';
import { HANDOFF_DIR, nextStepFromHandoff, parseHandoff, refFromFileName, sortHandoffFiles } from '../shared/handoff.js';
import { listItems, truncate } from '../shared/markdown.js';
import { hubHome } from '../node/config.js';
import { exists, readText } from '../node/fsutil.js';
import { headSha, repoRoot, status } from '../node/git.js';
import { AGENT_WRITABLE, draftAutoHandoff } from '../node/writes.js';

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

interface SessionRecord {
  session_id: string;
  repo: string;
  startedAt: number;
  startHead: string | null;
  fingerprint: string;
  blocks: number;
}

const MAX_BLOCKS = 2;
const AGENT = 'claude-code';

function sessionsDir(): string {
  return path.join(hubHome(), 'sessions');
}

function recordPath(sessionId: string): string {
  return path.join(sessionsDir(), `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

async function loadRecord(sessionId: string): Promise<SessionRecord | null> {
  const t = await readText(recordPath(sessionId));
  if (!t) return null;
  try {
    return JSON.parse(t) as SessionRecord;
  } catch {
    return null;
  }
}

async function saveRecord(r: SessionRecord): Promise<void> {
  await fs.mkdir(sessionsDir(), { recursive: true });
  await fs.writeFile(recordPath(r.session_id), JSON.stringify(r, null, 2));
}

async function projectRepo(cwd: string | undefined): Promise<string | null> {
  if (!cwd) return null;
  const root = await repoRoot(cwd);
  if (!root) return null;
  return (await exists(path.join(root, '.project'))) ? root : null;
}

const isNote = (p: string) => NOTE_PATHS.some((n) => p === n || p.startsWith(`${n}/`));

/** HEAD plus the working tree state outside the note files: changes when the session does work. */
export async function workFingerprint(repo: string): Promise<string> {
  const [head, st] = await Promise.all([headSha(repo), status(repo).catch(() => null)]);
  const entries = (st?.entries ?? [])
    .filter((e) => !isNote(e.path))
    .map((e) => `${e.xy} ${e.path}`)
    .sort();
  return createHash('sha1').update(`${head}\n${entries.join('\n')}`).digest('hex');
}

/** A handoff written after the session started. */
export async function handoffSince(repo: string, startedAt: number): Promise<string | null> {
  const dir = path.join(repo, HANDOFF_DIR);
  let files: string[];
  try {
    files = sortHandoffFiles(await fs.readdir(dir));
  } catch {
    return null;
  }
  const startMinute = Math.floor(startedAt / 60_000) * 60_000;
  for (const f of files) {
    const named = new Date(refFromFileName(f).date).getTime();
    if (Number.isFinite(named) && named < startMinute) break; // sorted newest first
    const st = await fs.stat(path.join(dir, f)).catch(() => null);
    if (st && st.mtimeMs >= startedAt - 5_000) return f;
  }
  return null;
}

async function newRecord(sessionId: string, repo: string): Promise<SessionRecord> {
  const rec: SessionRecord = {
    session_id: sessionId,
    repo,
    startedAt: Date.now(),
    startHead: await headSha(repo),
    fingerprint: await workFingerprint(repo),
    blocks: 0,
  };
  await saveRecord(rec);
  return rec;
}

async function latestHandoffContext(repo: string): Promise<string> {
  const files = sortHandoffFiles(await fs.readdir(path.join(repo, HANDOFF_DIR)).catch(() => [] as string[]));
  if (!files[0]) {
    return 'varvar: this repo has no handoff yet. Call get_status for its state, and write_handoff before you finish ' +
      '(without the MCP tools, use the varvar skill).';
  }
  const text = (await readText(path.join(repo, HANDOFF_DIR, files[0]))) ?? '';
  const h = parseHandoff(files[0], text);
  const next = listItems(h.sections.next).slice(0, 3);
  const auto = h.auto && !h.reviewed ? ' (auto-drafted, unreviewed)' : '';
  return [
    `varvar: latest handoff ${h.file} by ${h.agent}, ${h.date}${auto}.`,
    next.length ? `Next: ${next.map((n) => truncate(n, 160)).join(' | ')}` : nextStepFromHandoff(h) ?? '',
    'Call get_handoff for the full handoff, and write_handoff before you finish (without the MCP tools, use the varvar skill).',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function onSessionStart(input: HookInput): Promise<string> {
  const repo = await projectRepo(input.cwd);
  if (!repo || !input.session_id) return '';
  const existing = await loadRecord(input.session_id);
  if (!existing || existing.repo !== repo) await newRecord(input.session_id, repo);
  void cleanupOldRecords();
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: await latestHandoffContext(repo) },
  });
}

export async function onStop(input: HookInput): Promise<string> {
  const repo = await projectRepo(input.cwd);
  if (!repo || !input.session_id) return '';
  if (input.stop_hook_active) return '';
  // Paused on background work, not finished.
  if (input.background_tasks?.length || input.session_crons?.length) return '';
  const rec = await loadRecord(input.session_id);
  if (!rec || rec.repo !== repo) {
    // Hooks were installed mid-session: start counting from now.
    await newRecord(input.session_id, repo);
    return '';
  }
  if (await handoffSince(repo, rec.startedAt)) return '';
  if ((await workFingerprint(repo)) === rec.fingerprint) return '';
  if (rec.blocks >= MAX_BLOCKS) return '';
  rec.blocks += 1;
  await saveRecord(rec);
  return JSON.stringify({
    decision: 'block',
    reason:
      'varvar: this session changed the repo but no handoff has been written since it started. ' +
      'Call the write_handoff tool (varvar MCP server) with done, next, open_questions and gotchas, then finish. ' +
      'Without the MCP tools, write the handoff file as the varvar skill (.claude/skills/varvar/SKILL.md) describes. ' +
      'If the work is not finished, say so in the handoff.',
  });
}

export async function onSessionEnd(input: HookInput): Promise<string> {
  const repo = await projectRepo(input.cwd);
  if (!repo || !input.session_id) return '';
  const rec = await loadRecord(input.session_id);
  if (!rec || rec.repo !== repo) return '';
  try {
    if (!(await handoffSince(repo, rec.startedAt)) && (await workFingerprint(repo)) !== rec.fingerprint) {
      await draftAutoHandoff({ repo, allowed: AGENT_WRITABLE }, { agent: AGENT, reason: 'session ended without a handoff' });
    }
  } finally {
    await fs.rm(recordPath(rec.session_id), { force: true });
  }
  return '';
}

async function cleanupOldRecords(): Promise<void> {
  try {
    const dir = sessionsDir();
    for (const f of await fs.readdir(dir)) {
      const st = await fs.stat(path.join(dir, f));
      if (Date.now() - st.mtimeMs > 7 * 86_400_000) await fs.rm(path.join(dir, f), { force: true });
    }
  } catch {
    /* nothing to clean */
  }
}

export async function runHook(event: string, stdin: string): Promise<string> {
  let input: HookInput = {};
  try {
    input = JSON.parse(stdin || '{}') as HookInput;
  } catch {
    return '';
  }
  switch (event) {
    case 'session-start':
      return onSessionStart(input);
    case 'stop':
      return onStop(input);
    case 'session-end':
      return onSessionEnd(input);
    default:
      throw new Error(`Unknown hook "${event}". Use session-start, stop or session-end.`);
  }
}
