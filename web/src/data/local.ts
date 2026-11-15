// Local mode: the hub server on localhost (served from the same origin).
import type { Capabilities, DataSource, DataSourceWriter } from '@shared/datasource';
import type { HistoryItem, HubEvent, ProjectDetail, ProjectSummary } from '@shared/types';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const type = res.headers.get('content-type') ?? '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : String(data);
    throw new Error(msg || `${res.status} ${res.statusText}`);
  }
  return data as T;
}

const enc = encodeURIComponent;

export class LocalSource implements DataSource {
  readonly kind = 'local' as const;
  readonly label = 'Local';
  readonly capabilities: Capabilities = { write: true, agents: false, uncommitted: true, live: true };

  listProjects = () => req<ProjectSummary[]>('GET', 'api/projects');
  getProject = (id: string) => req<ProjectDetail>('GET', `api/projects/${enc(id)}`);
  readFile = (id: string, path: string) => req<string>('GET', `api/projects/${enc(id)}/file?path=${enc(path)}`);
  history = (id: string, since?: string) =>
    req<HistoryItem[]>('GET', `api/projects/${enc(id)}/history${since ? `?since=${enc(since)}` : ''}`);
  rescan = async () => {
    await req('POST', 'api/rescan');
  };

  subscribe(cb: (e: HubEvent) => void): () => void {
    const es = new EventSource('api/events');
    es.addEventListener('hub', (e) => cb(JSON.parse((e as MessageEvent).data) as HubEvent));
    // After a reconnect, things may have changed while we were away.
    let opened = false;
    es.addEventListener('hello', () => {
      if (opened) cb({ type: 'projects' });
      opened = true;
    });
    return () => es.close();
  }

  readonly writer: DataSourceWriter = {
    initialise: (p) => req('POST', `api/projects/${enc(p)}/init`),
    saveProjectMeta: (p, patch) => req('PUT', `api/projects/${enc(p)}/meta`, patch),
    writeHandoff: (p, input) => req('POST', `api/projects/${enc(p)}/handoffs`, input),
    draftHandoff: (p) => req('POST', `api/projects/${enc(p)}/handoffs/draft`),
    markHandoffReviewed: (p, file) => req('POST', `api/projects/${enc(p)}/handoffs/${enc(file)}/reviewed`),
    saveAgentsMd: (p, content, baseHash) => req('PUT', `api/projects/${enc(p)}/agents-md`, { content, baseHash }),
    fixClaudePointer: (p) => req('POST', `api/projects/${enc(p)}/claude-pointer`),
    addHubSnippet: (p) => req('POST', `api/projects/${enc(p)}/hub-snippet`),
    addTask: (p, input) => req('POST', `api/projects/${enc(p)}/tasks`, input),
    updateTask: (p, id, patch) => req('PATCH', `api/projects/${enc(p)}/tasks/${enc(id)}`, patch),
    logDecision: (p, input) => req('POST', `api/projects/${enc(p)}/decisions`, input),
    updateDecision: (p, id, patch) => req('PATCH', `api/projects/${enc(p)}/decisions/${enc(id)}`, patch),
    saveBrainstorm: (p, brainstorm, knownIds) => req('PUT', `api/projects/${enc(p)}/brainstorm`, { brainstorm, knownIds }),
    promoteNode: (p, nodeId, to) => req('POST', `api/projects/${enc(p)}/brainstorm/promote`, { nodeId, to }),
    commitNotes: (p) => req('POST', `api/projects/${enc(p)}/commit-notes`),
  };
}
