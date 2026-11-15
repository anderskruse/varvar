import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { emptyBrainstorm, newNodeId, serializeBrainstorm } from '@shared/brainstorm';
import { NODE_KINDS, type BrainNode, type Brainstorm, type NodeKind } from '@shared/types';
import { useAction, useDebounced, useSource, useToast } from '../lib/app';
import { href } from '../lib/router';
import { Badge } from '../components/ui';
import type { TabProps } from '../pages/Project';

type BrainData = {
  text: string;
  kind: NodeKind;
  author?: string;
  created?: string;
  promoted?: BrainNode['promoted'];
  startEditing?: boolean;
};
type FlowNode = Node<BrainData, 'brain'>;

const KIND_LABEL: Record<NodeKind, string> = { idea: 'Idea', question: 'Question', risk: 'Risk', note: 'Note' };

function toFlow(b: Brainstorm): { nodes: FlowNode[]; edges: Edge[]; inbox: BrainNode[] } {
  const placed = b.nodes.filter((n) => !n.inbox);
  const ids = new Set(placed.map((n) => n.id));
  return {
    nodes: placed.map((n) => ({
      id: n.id,
      type: 'brain',
      position: { x: n.x, y: n.y },
      data: { text: n.text, kind: n.kind, author: n.author, created: n.created, promoted: n.promoted },
    })),
    edges: placed.flatMap((n) =>
      n.links
        .filter((l) => ids.has(l.to))
        .map((l) => ({ id: `${n.id}->${l.to}`, source: n.id, target: l.to, label: l.label })),
    ),
    inbox: b.nodes.filter((n) => n.inbox),
  };
}

function fromFlow(nodes: FlowNode[], edges: Edge[], inbox: BrainNode[]): Brainstorm {
  const out: BrainNode[] = nodes.map((n) => {
    const node: BrainNode = {
      id: n.id,
      text: n.data.text,
      kind: n.data.kind,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      links: edges
        .filter((e) => e.source === n.id)
        .map((e) => (typeof e.label === 'string' && e.label.trim() ? { to: e.target, label: e.label.trim() } : { to: e.target })),
    };
    if (n.data.author) node.author = n.data.author;
    if (n.data.created) node.created = n.data.created;
    if (n.data.promoted) node.promoted = n.data.promoted;
    return node;
  });
  return { version: 1, nodes: [...out, ...inbox] };
}

interface Actions {
  readOnly: boolean;
  updateText(id: string, text: string): void;
}
const ActionsContext = createContext<Actions>({ readOnly: true, updateText: () => {} });

const BrainNodeView = memo(function BrainNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const actions = useContext(ActionsContext);
  const [editing, setEditing] = useState(!!data.startEditing && !actions.readOnly);
  const [text, setText] = useState(data.text);
  useEffect(() => {
    if (!editing) setText(data.text);
  }, [data.text, editing]);
  const commit = () => {
    setEditing(false);
    if (text !== data.text) actions.updateText(id, text);
  };
  return (
    <div className={`bn bn-${data.kind} ${selected ? 'bn-selected' : ''}`} onDoubleClick={() => !actions.readOnly && setEditing(true)}>
      <Handle type="target" position={Position.Left} />
      <div className="bn-kind">
        {KIND_LABEL[data.kind]}
        {data.promoted && <span className="bn-promoted">→ {data.promoted.type === 'task' ? data.promoted.id : `ADR ${data.promoted.id}`}</span>}
      </div>
      {editing ? (
        <textarea
          className="bn-edit nodrag nowheel"
          value={text}
          autoFocus
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commit();
            if (e.key === 'Escape') {
              setText(data.text);
              setEditing(false);
            }
            e.stopPropagation();
          }}
          placeholder="Type, then click outside (Ctrl+Enter)"
        />
      ) : (
        <div className="bn-text">{data.text || <span className="muted">Double-click to write</span>}</div>
      )}
      {data.author && <div className="bn-author">by {data.author}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { brain: BrainNodeView };

export function BrainstormTab(props: TabProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

function Canvas({ detail, reload }: TabProps) {
  const source = useSource();
  const toast = useToast();
  const w = source.writer;
  const readOnly = !w;
  const projectId = detail.summary.id;
  const flow = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [run, busy] = useAction();

  const initial = useMemo(() => toFlow(detail.brainstorm ?? emptyBrainstorm()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>(initial.edges);
  const [inbox, setInbox] = useState<BrainNode[]>(initial.inbox);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');

  // Latest values for async save without stale closures.
  const state = useRef({ nodes, edges, inbox });
  state.current = { nodes, edges, inbox };
  const known = useRef(new Set((detail.brainstorm?.nodes ?? []).map((n) => n.id)));
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);

  /** Add nodes from the file that we've never seen (e.g. agent Inbox notes). */
  const absorb = useCallback(
    (remote: Brainstorm) => {
      const fresh = remote.nodes.filter((n) => !known.current.has(n.id));
      if (!fresh.length) return;
      fresh.forEach((n) => known.current.add(n.id));
      const f = toFlow({ version: 1, nodes: fresh });
      if (f.inbox.length) setInbox((i) => [...i, ...f.inbox]);
      if (f.nodes.length) setNodes((ns) => [...ns, ...f.nodes]);
    },
    [setNodes],
  );

  const save = useCallback(async () => {
    if (!w) return;
    if (saving.current) await saving.current;
    if (!dirty.current) return;
    const b = fromFlow(state.current.nodes, state.current.edges, state.current.inbox);
    b.nodes.forEach((n) => known.current.add(n.id));
    dirty.current = false;
    setSaveState('saving');
    const p = (async () => {
      try {
        const merged = await w.saveBrainstorm(projectId, b, [...known.current]);
        absorb(merged);
        setSaveState(dirty.current ? 'dirty' : 'saved');
      } catch (e) {
        dirty.current = true;
        setSaveState('error');
        toast('error', `Brainstorm not saved: ${(e as Error).message}`);
      }
    })();
    saving.current = p;
    await p;
    saving.current = null;
  }, [w, projectId, absorb, toast]);

  const saveSoon = useDebounced(() => void save(), 700);
  const markDirty = useCallback(() => {
    if (readOnly) return;
    dirty.current = true;
    setSaveState('dirty');
    saveSoon();
  }, [readOnly, saveSoon]);

  // Save on leave.
  useEffect(
    () => () => {
      if (dirty.current) void save();
    },
    [save],
  );

  // The file changed on disk (agent note, text editor, another tab).
  useEffect(() => {
    const remote = detail.brainstorm ?? emptyBrainstorm();
    if (dirty.current || saving.current) {
      absorb(remote);
      return;
    }
    const local = fromFlow(state.current.nodes, state.current.edges, state.current.inbox);
    if (serializeBrainstorm(local) === serializeBrainstorm(remote)) return;
    const f = toFlow(remote);
    remote.nodes.forEach((n) => known.current.add(n.id));
    setNodes(f.nodes.map((n) => ({ ...n, selected: n.id === selectedId })));
    setEdges(f.edges);
    setInbox(f.inbox);
  }, [detail.brainstorm]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      onNodesChangeBase(changes);
      for (const c of changes) {
        if (c.type === 'select' && c.selected) setSelectedId(c.id);
        if (c.type === 'select' && !c.selected) setSelectedId((s) => (s === c.id ? null : s));
      }
      if (changes.some((c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false))) markDirty();
    },
    [onNodesChangeBase, markDirty],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChangeBase(changes);
      if (changes.some((c) => c.type === 'remove')) markDirty();
    },
    [onEdgesChangeBase, markDirty],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return;
      setEdges((eds) => addEdge({ ...c, id: `${c.source}->${c.target}` }, eds));
      markDirty();
    },
    [setEdges, markDirty],
  );

  const actions = useMemo<Actions>(
    () => ({
      readOnly,
      updateText: (id, text) => {
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, text, startEditing: false } } : n)));
        markDirty();
      },
    }),
    [readOnly, setNodes, markDirty],
  );

  const center = () => {
    const rect = wrapper.current?.getBoundingClientRect();
    const p = rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
    const jitter = () => Math.round((Math.random() - 0.5) * 60);
    return { x: Math.round(p.x - 100 + jitter()), y: Math.round(p.y - 40 + jitter()) };
  };

  const addNode = (kind: NodeKind) => {
    const id = newNodeId();
    known.current.add(id);
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { id, type: 'brain', position: center(), selected: true, data: { text: '', kind, created: new Date().toISOString(), startEditing: true } },
    ]);
    setSelectedId(id);
    markDirty();
  };

  const place = (n: BrainNode) => {
    setInbox((i) => i.filter((x) => x.id !== n.id));
    setNodes((ns) => [
      ...ns,
      { id: n.id, type: 'brain', position: center(), data: { text: n.text, kind: n.kind, author: n.author, created: n.created, promoted: n.promoted } },
    ]);
    markDirty();
  };

  const discard = (n: BrainNode) => {
    setInbox((i) => i.filter((x) => x.id !== n.id));
    markDirty();
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const updateSelected = (patch: Partial<BrainData>) => {
    if (!selected) return;
    setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  };

  const promote = (to: 'task' | 'decision') =>
    run(async () => {
      if (!selected || !w) return;
      if (!selected.data.text.trim()) throw new Error('Write something in the node first.');
      dirty.current = true;
      await save();
      const r = await w.promoteNode(projectId, selected.id, to);
      setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, promoted: r.node.promoted } } : n)));
      await reload();
      return r;
    }, to === 'task' ? 'Created a Backlog.md task' : 'Logged a proposed decision');

  const deleteSelected = () => {
    if (!selected) return;
    flow.deleteElements({ nodes: [{ id: selected.id }] });
  };

  const editEdgeLabel = (edge: Edge) => {
    if (readOnly) return;
    const label = window.prompt('Link label (empty to clear)', typeof edge.label === 'string' ? edge.label : '');
    if (label === null) return;
    setEdges((eds) => eds.map((e) => (e.id === edge.id ? { ...e, label: label.trim() || undefined } : e)));
    markDirty();
  };

  const saveLabel: Record<SaveState, string> = { saved: 'Saved', dirty: 'Unsaved…', saving: 'Saving…', error: 'Not saved' };

  return (
    <ActionsContext.Provider value={actions}>
      <div className="brainstorm">
        <div className="canvas-toolbar">
          {!readOnly &&
            NODE_KINDS.map((k) => (
              <button key={k} className={`btn btn-small kind-btn kind-${k}`} onClick={() => addNode(k)}>
                + {KIND_LABEL[k]}
              </button>
            ))}
          <span className="muted canvas-hint">
            {readOnly
              ? 'Read-only'
              : 'Double-click a node to edit · drag from a dot to link · double-click a link to label it · Delete removes'}
          </span>
          <div className="spacer" />
          {!readOnly && <span className={`save-state save-${saveState}`}>{saveLabel[saveState]}</span>}
        </div>
        <div className="canvas-layout">
          <div className="canvas-wrap" ref={wrapper}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeDoubleClick={(_, e) => editEdgeLabel(e)}
              onPaneClick={() => setSelectedId(null)}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
              defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed }, type: 'smoothstep' }}
              colorMode="system"
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1.2 }}
              minZoom={0.2}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={24} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeClassName={(n) => `mm-${(n.data as BrainData).kind}`} />
            </ReactFlow>
            {!nodes.length && (
              <div className="canvas-empty">
                <p>{readOnly ? 'The canvas is empty.' : 'Add an idea, question, risk or note to start.'}</p>
              </div>
            )}
          </div>
          <aside className="canvas-side">
            <section>
              <h3>
                Inbox <span className="count">{inbox.length}</span>
              </h3>
              {!inbox.length && <p className="muted small">Notes from agents (add_brainstorm_note) land here.</p>}
              {inbox.map((n) => (
                <div key={n.id} className={`inbox-item bn-${n.kind}`}>
                  <div className="bn-kind">{KIND_LABEL[n.kind]}</div>
                  <div className="inbox-text">{n.text}</div>
                  {n.author && <div className="bn-author">by {n.author}</div>}
                  {!readOnly && (
                    <div className="inbox-actions">
                      <button className="btn btn-small" onClick={() => place(n)}>
                        Place
                      </button>
                      <button className="btn btn-small btn-ghost" onClick={() => discard(n)}>
                        Discard
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
            {selected && (
              <section className="node-panel">
                <h3>Selected</h3>
                {!readOnly ? (
                  <>
                    <select value={selected.data.kind} onChange={(e) => updateSelected({ kind: e.target.value as NodeKind })}>
                      {NODE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {KIND_LABEL[k]}
                        </option>
                      ))}
                    </select>
                    <textarea
                      rows={5}
                      value={selected.data.text}
                      onChange={(e) => updateSelected({ text: e.target.value })}
                      placeholder="First line becomes the title when promoted"
                    />
                  </>
                ) : (
                  <p>{selected.data.text}</p>
                )}
                {selected.data.promoted ? (
                  <p>
                    Became{' '}
                    <a
                      href={href({
                        page: 'project',
                        id: projectId,
                        tab: selected.data.promoted.type === 'task' ? 'tasks' : 'decisions',
                        item: selected.data.promoted.type === 'task' ? null : selected.data.promoted.id,
                      })}
                    >
                      <Badge kind="neutral">
                        {selected.data.promoted.type} {selected.data.promoted.id}
                      </Badge>
                    </a>
                  </p>
                ) : (
                  !readOnly && (
                    <div className="node-actions">
                      <button className="btn btn-small" disabled={busy} onClick={() => promote('task')}>
                        → Task
                      </button>
                      <button className="btn btn-small" disabled={busy} onClick={() => promote('decision')}>
                        → Decision
                      </button>
                    </div>
                  )
                )}
                {!readOnly && (
                  <button className="btn btn-small btn-ghost danger" onClick={deleteSelected}>
                    Delete node
                  </button>
                )}
                <p className="muted small">
                  <code>{selected.id}</code>
                  {selected.data.author ? ` · by ${selected.data.author}` : ''}
                </p>
              </section>
            )}
          </aside>
        </div>
      </div>
    </ActionsContext.Provider>
  );
}
