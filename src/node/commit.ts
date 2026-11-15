// "Commit project notes": commits only .project/, backlog/, the agent files and the varvar skill.
// Never pushes.
import { NOTE_PATHS } from '../shared/agents.js';
import { git, headSha } from './git.js';

/** Changed note files, including both sides of renames. */
export async function changedNoteFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...NOTE_PATHS]);
  const parts = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') files.push(parts[++i]);
  }
  return [...new Set(files)];
}

export function notesCommitMessage(files: string[]): string {
  const handoffs = files.filter((f) => f.startsWith('.project/handoffs/') && f.endsWith('.md'));
  const decisions = files.filter((f) => f.startsWith('.project/decisions/') && f.endsWith('.md'));
  const tasks = files.filter((f) => f.startsWith('backlog/') && f.endsWith('.md'));
  const parts: string[] = [];
  if (handoffs.length === 1) parts.push(`handoff ${handoffs[0].split('/').pop()!.replace(/\.md$/, '')}`);
  else if (handoffs.length) parts.push(`${handoffs.length} handoffs`);
  if (decisions.length === 1) parts.push(`decision ${decisions[0].split('/').pop()!.slice(0, 4)}`);
  else if (decisions.length) parts.push(`${decisions.length} decisions`);
  if (tasks.length) parts.push(`${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
  if (files.includes('.project/brainstorm.json')) parts.push('brainstorm');
  if (files.includes('.project/project.yaml')) parts.push('project.yaml');
  if (files.includes('AGENTS.md')) parts.push('AGENTS.md');
  if (files.includes('CLAUDE.md')) parts.push('CLAUDE.md');
  if (files.some((f) => f.startsWith('.claude/skills/varvar/'))) parts.push('varvar skill');
  const other = files.length - handoffs.length - decisions.length - tasks.length;
  if (!parts.length && other) parts.push(`${files.length} file${files.length === 1 ? '' : 's'}`);
  const subject = `Update project notes: ${parts.join(', ')}`;
  const body = files
    .slice(0, 30)
    .map((f) => `- ${f}`)
    .join('\n');
  return `${subject}\n\n${body}${files.length > 30 ? `\n- … and ${files.length - 30} more` : ''}\n\nCommitted by varvar.`;
}

export async function commitNotes(repo: string): Promise<{ sha: string; message: string; files: string[] }> {
  const files = await changedNoteFiles(repo);
  if (!files.length) throw new Error('No changes in .project/, backlog/, AGENTS.md, CLAUDE.md or the varvar skill to commit.');
  const message = notesCommitMessage(files);
  await git(repo, ['add', '-A', '--', ...files]);
  // --only: commit just these paths, leaving anything else the user staged alone.
  await git(repo, ['commit', '--only', '-m', message, '--', ...files], { timeout: 120_000 });
  const sha = (await headSha(repo)) ?? '';
  return { sha, message: message.split('\n')[0], files };
}
