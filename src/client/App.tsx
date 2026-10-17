import { useEffect, useRef, useState } from 'react';
import type {
  CameraState,
  Checkpoint,
  Review,
  Scene,
  SceneObject,
  ToolEvent,
  ToolName,
  ToolResponse,
  SceneExport,
} from '../shared/schema.js';
import { Viewport } from './Viewport.js';

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Cannot load ${url} (${response.status})`);
  return response.json() as Promise<T>;
}
const glyph: Record<SceneObject['type'], string> = {
  box: '◇',
  sphere: '◉',
  cylinder: '▥',
  cone: '△',
  plane: '▱',
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function App() {
  const [scene, setScene] = useState<Scene>();
  const [events, setEvents] = useState<ToolEvent[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [runId, setRunId] = useState('Connecting');
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingTools, setPendingTools] = useState<{ executionId: string; tool: string }[]>([]);
  const [tab, setTab] = useState<'activity' | 'checkpoints' | 'feedback'>('activity');
  const [saveName, setSaveName] = useState('garden');
  const [reviewCheckpoint, setReviewCheckpoint] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [reviewKind, setReviewKind] = useState<'approval' | 'change_request'>('approval');
  const [comparison, setComparison] = useState<[string, string]>(['', '']);
  const camera = useRef<CameraState | undefined>(undefined);
  const mounted = useRef(true);
  const refresh = async () => {
    const [next, log, shots, notes, health] = await Promise.all([
      get<Scene>('/api/state'),
      get<ToolEvent[]>('/api/events'),
      get<Checkpoint[]>('/api/checkpoints'),
      get<Review[]>('/api/reviews'),
      get<{ runId: string }>('/api/health'),
    ]);
    if (!mounted.current) return;
    setScene((previous) => (previous?.revision === next.revision ? previous : next));
    setEvents(log);
    setCheckpoints(shots);
    setReviews(notes);
    setRunId(health.runId);
  };
  useEffect(() => {
    mounted.current = true;
    const stream = new EventSource('/api/stream');
    stream.addEventListener('snapshot', (event) => {
      const snapshot = JSON.parse((event as MessageEvent).data) as {
        runId: string;
        scene: Scene;
        events: ToolEvent[];
        checkpoints: Checkpoint[];
        reviews: Review[];
      };
      setRunId(snapshot.runId);
      setScene(snapshot.scene);
      setEvents(snapshot.events);
      setCheckpoints(snapshot.checkpoints);
      setReviews(snapshot.reviews);
      setPendingTools([]);
    });
    stream.addEventListener('tool-start', (event) => {
      const message = JSON.parse((event as MessageEvent).data) as {
        executionId: string;
        tool: string;
      };
      setPendingTools((current) => [
        ...current.filter((item) => item.executionId !== message.executionId),
        message,
      ]);
    });
    stream.addEventListener('update', (event) => {
      const message = JSON.parse((event as MessageEvent).data) as { executionId: string };
      setPendingTools((current) =>
        current.filter((item) => item.executionId !== message.executionId),
      );
      void refresh().catch((e) => {
        if (mounted.current) setError(String(e));
      });
    });
    stream.onerror = () => {
      // EventSource reconnects automatically; a fresh snapshot restores any missed updates.
    };
    return () => {
      mounted.current = false;
      stream.close();
    };
  }, []);
  const command = async (tool: ToolName, args: unknown) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, arguments: args }),
      });
      const value = (await response.json()) as ToolResponse;
      if (!value.success)
        throw new Error(
          `${value.error?.message} ${value.error?.details ? pretty(value.error.details) : ''}`,
        );
      await refresh();
      return value;
    } catch (e) {
      setError(String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const object = scene?.objects.find((o) => o.id === selected);
  const complete = checkpoints.filter((c) => c.status === 'complete');
  const exportGlb = async () => {
    const response = await command('export_scene', {});
    const exported = response?.result as SceneExport | undefined;
    if (!exported) return;
    const link = document.createElement('a');
    link.href = exported.artifactUrl;
    link.download = exported.fileName;
    link.click();
  };
  return (
    <div className="studio">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Fieldwork home">
          <span className="brand-mark">
            f<span>·</span>
          </span>
          <span>
            fieldwork<small>AGENT WORLD BUILDER</small>
          </span>
        </a>
        <div className="project-title">
          <span className="status-dot" /> Live workspace <span className="divider">/</span>{' '}
          <span title={runId}>{runId.slice(0, 35)}</span>
        </div>
        <div className="revision">
          <span>SCENE REVISION</span>
          <strong data-testid="revision">{String(scene?.revision ?? 0).padStart(3, '0')}</strong>
        </div>
      </header>
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">CREATE / OBSERVE / REFINE</p>
          <h1>
            A world in the making<span>.</span>
          </h1>
          <p className="subtitle">Built by an agent. Open to your perspective.</p>
        </div>
        <div className="workspace-actions">
          <button disabled={busy || !scene} onClick={() => void exportGlb()}>
            ↓ Export GLB
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void command('render_scene', { label: `Checkpoint ${checkpoints.length + 1}` })
            }
          >
            ◉ Capture checkpoint
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      <div className="editor-grid">
        <section className="scene-panel panel">
          <div className="panel-title">
            <h2>
              <span className="tiny-icon">▱</span> Scene explorer
            </h2>
            <span className="count">{scene?.objects.length ?? 0}</span>
          </div>
          <div className="object-list" aria-label="Scene objects">
            {scene?.objects.length ? (
              scene.objects.map((o) => (
                <button
                  className={`object-row ${selected === o.id ? 'selected' : ''}`}
                  key={o.id}
                  onClick={() => setSelected(o.id)}
                >
                  <span className="object-glyph" style={{ color: o.color }}>
                    {glyph[o.type]}
                  </span>
                  <span>{o.name}</span>
                  <small>{o.visible ? '●' : '○'}</small>
                </button>
              ))
            ) : (
              <div className="empty-tree">
                <span>◇</span>
                <p>Your scene starts here</p>
                <small>
                  Ask your agent to create an object,
                  <br />
                  or add a primitive below.
                </small>
              </div>
            )}
          </div>
          <div className="add-object">
            <label htmlFor="primitive">ADD A PRIMITIVE</label>
            <select
              id="primitive"
              aria-label="Add primitive"
              value=""
              disabled={busy}
              onChange={(e) => {
                if (e.target.value)
                  void command('create_object', {
                    name: `${e.target.value}_${(scene?.objects.length ?? 0) + 1}`,
                    type: e.target.value,
                  });
              }}
            >
              <option value="">＋ Choose geometry</option>
              {Object.keys(glyph).map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </div>
          <div className="properties">
            <h3>OBJECT PROPERTIES</h3>
            {object ? (
              <ObjectEditor
                key={`${object.id}-${scene?.revision}`}
                object={object}
                busy={busy}
                onSave={(args) => command('update_object', args)}
                onDelete={() => command('delete_object', { id: object.id })}
              />
            ) : (
              <p className="muted small">
                Select an object in the scene or explorer to inspect and edit it.
              </p>
            )}
          </div>
        </section>
        <section className="viewport-panel panel">
          <div className="viewport-toolbar">
            <div>
              <span className="status-dot" /> LIVE VIEWPORT
            </div>
            <span>
              ORTHOGRAPHIC <span className="toolbar-separator">/</span> Y UP
            </span>
          </div>
          <div className="viewport-stage">
            {scene && (
              <Viewport
                scene={scene}
                onSelect={setSelected}
                onCamera={(value) => {
                  camera.current = value;
                }}
                onError={setError}
              />
            )}
            {scene?.objects.length === 0 && (
              <div className="empty-viewport">
                <span className="empty-orbit">◇</span>
                <h2>Room for an idea.</h2>
                <p>Your agent’s next creation will appear here.</p>
              </div>
            )}
            <div className="axis-indicator">
              <span className="axis-y">Y</span>
              <span className="axis-z">Z</span>
              <span className="axis-x">X</span>
            </div>
          </div>
          <div className="viewport-footer">
            <span>
              ↔ Orbit <span>·</span> Scroll to zoom <span>·</span> Right-drag to pan
            </span>
            <button
              className="text-button"
              disabled={busy || !scene}
              onClick={() => camera.current && void command('set_camera', camera.current)}
            >
              Use current view ↗
            </button>
          </div>
        </section>
      </div>
      <section className="activity-panel panel">
        <div className="activity-header">
          <nav aria-label="Activity sections">
            {(['activity', 'checkpoints', 'feedback'] as const).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'activity'
                  ? 'Agent activity'
                  : t === 'checkpoints'
                    ? 'Checkpoints'
                    : 'Reviews & feedback'}{' '}
                <span>
                  {t === 'activity'
                    ? events.length
                    : t === 'checkpoints'
                      ? checkpoints.length
                      : reviews.length}
                </span>
              </button>
            ))}
          </nav>
          <span className="live-label">
            <span className="status-dot" /> FOLLOWING LIVE
          </span>
        </div>
        {tab === 'activity' && (
          <div className="event-list">
            {pendingTools.map((operation) => (
              <div className="pending-tool" role="status" key={operation.executionId}>
                <span className="status-dot" /> Agent is running <strong>{operation.tool}</strong>…
              </div>
            ))}
            {events.length ? (
              [...events].reverse().map((event) => (
                <details key={event.executionId} className="event">
                  <summary>
                    <span className={`event-status ${event.success ? '' : 'failed'}`}>
                      {event.success ? '✓' : '!'}
                    </span>
                    <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
                    <strong>{event.tool}</strong>
                    <span className="event-description">
                      {event.error?.message ?? describe(event)}
                    </span>
                    <span className="event-rev">r{event.sceneRevision}</span>
                  </summary>
                  <pre>{pretty(event)}</pre>
                </details>
              ))
            ) : (
              <div className="empty-activity">
                <span>↳</span>
                <div>
                  <strong>Waiting for the first move</strong>
                  <p>
                    Tool calls, observations, and corrections will appear here as the agent works.
                  </p>
                </div>
                <code>POST /api/tools</code>
              </div>
            )}
          </div>
        )}
        {tab === 'checkpoints' && (
          <div className="checkpoints-content">
            <div className="checkpoint-grid">
              {checkpoints.length ? (
                checkpoints.map((c) => (
                  <article key={c.id} className="checkpoint-card">
                    {c.screenshotUrl ? (
                      <a href={c.screenshotUrl} target="_blank" rel="noreferrer">
                        <img src={c.screenshotUrl} alt={c.label} />
                      </a>
                    ) : (
                      <div className="checkpoint-placeholder">
                        {c.status === 'failed' ? 'Render failed' : 'Rendering…'}
                      </div>
                    )}
                    <div>
                      <strong>{c.label}</strong>
                      <span>
                        Revision {c.sceneRevision} · {c.status}
                      </span>
                      <a href={c.sceneUrl} target="_blank" rel="noreferrer">
                        Scene snapshot ↗
                      </a>
                      {c.error && <p className="small">{c.error}</p>}
                      <button
                        className="text-button"
                        onClick={() => {
                          setReviewCheckpoint(c.id);
                          setTab('feedback');
                        }}
                      >
                        Review checkpoint →
                      </button>
                    </div>
                  </article>
                ))
              ) : (
                <p className="muted">Capture a checkpoint to preserve a scene and its image.</p>
              )}
            </div>
            {complete.length > 0 && (
              <div className="comparison">
                <h3>COMPARE CHECKPOINTS</h3>
                <div className="comparison-grid">
                  {([0, 1] as const).map((index) => {
                    const shot = complete.find((c) => c.id === comparison[index]);
                    return (
                      <div key={index}>
                        <label>
                          {index === 0 ? 'Before' : 'After'}
                          <select
                            aria-label={index === 0 ? 'Before checkpoint' : 'After checkpoint'}
                            value={comparison[index]}
                            onChange={(e) =>
                              setComparison((old) =>
                                index === 0 ? [e.target.value, old[1]] : [old[0], e.target.value],
                              )
                            }
                          >
                            <option value="">Choose checkpoint</option>
                            {complete.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label} · r{c.sceneRevision}
                              </option>
                            ))}
                          </select>
                        </label>
                        {shot && (
                          <>
                            <img
                              src={shot.screenshotUrl}
                              alt={`${index === 0 ? 'Before' : 'After'}: ${shot.label}`}
                            />
                            <a href={shot.sceneUrl}>Preserved scene · r{shot.sceneRevision}</a>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {tab === 'feedback' && (
          <div className="feedback-layout">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void command('record_review', {
                  kind: reviewKind,
                  author: 'human',
                  text: reviewText,
                  checkpointId: reviewCheckpoint,
                }).then((value) => {
                  if (value) setReviewText('');
                });
              }}
            >
              <h3>YOUR PERSPECTIVE</h3>
              <label>
                Checkpoint
                <select
                  aria-label="Checkpoint"
                  required
                  value={reviewCheckpoint}
                  onChange={(e) => setReviewCheckpoint(e.target.value)}
                >
                  <option value="">Choose a checkpoint</option>
                  {checkpoints.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label} · r{c.sceneRevision}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Decision
                <select
                  aria-label="Decision"
                  value={reviewKind}
                  onChange={(e) => setReviewKind(e.target.value as typeof reviewKind)}
                >
                  <option value="approval">Approve result</option>
                  <option value="change_request">Request changes</option>
                </select>
              </label>
              <label>
                Feedback
                <textarea
                  required
                  placeholder="What works? What should change?"
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                />
              </label>
              <button disabled={busy}>Record feedback</button>
            </form>
            <div className="reviews">
              {reviews.length ? (
                [...reviews].reverse().map((r) => (
                  <article key={r.executionId}>
                    <span className="review-kind">
                      {r.kind.replaceAll('_', ' ')} · {r.author}
                    </span>
                    <p>{r.text}</p>
                    {r.suggestion && (
                      <p>
                        <strong>Suggestion:</strong> {r.suggestion}
                      </p>
                    )}
                    {r.impact && (
                      <p>
                        <strong>Impact:</strong> {r.impact}
                      </p>
                    )}
                    <small>
                      r{r.sceneRevision}
                      {r.checkpointId ? ` · checkpoint ${r.checkpointId.slice(0, 8)}` : ''}
                    </small>
                    {r.executionIds.length > 0 && (
                      <details>
                        <summary>Execution evidence</summary>
                        <pre>{r.executionIds.join('\n')}</pre>
                      </details>
                    )}
                  </article>
                ))
              ) : (
                <p className="muted">
                  Agent observations, tool suggestions, and your feedback will appear here.
                </p>
              )}
            </div>
          </div>
        )}
      </section>
      <footer className="bottom-bar">
        <span>
          <span className="status-dot" /> LOCAL WORKSPACE <span className="divider">·</span> All
          changes through public tools
        </span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void command('save_scene', { name: saveName });
          }}
        >
          <label htmlFor="save-name">SCENE</label>
          <input
            id="save-name"
            aria-label="Save name"
            value={saveName}
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}"
            required
            onChange={(e) => setSaveName(e.target.value)}
          />
          <button className="text-button" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void command('load_scene', { name: saveName })}
          >
            Load
          </button>
        </form>
        <a href="/api/tools" target="_blank" rel="noreferrer">
          Tool reference ↗
        </a>
      </footer>
    </div>
  );
}
function describe(event: ToolEvent) {
  const args = event.arguments as Record<string, unknown> | null;
  if (args?.name) return String(args.name);
  if (args?.text) return String(args.text).slice(0, 100);
  if (args?.id) return String(args.id).slice(0, 8);
  return event.success ? 'Completed successfully' : 'Failed';
}
function ObjectEditor({
  object,
  busy,
  onSave,
  onDelete,
}: {
  object: SceneObject;
  busy: boolean;
  onSave: (args: unknown) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(object);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const { id, name, position, rotation, scale, dimensions, color, visible } = draft;
        void onSave({ id, name, position, rotation, scale, dimensions, color, visible });
      }}
    >
      <label>
        Name
        <input
          value={draft.name}
          required
          maxLength={120}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <div className="object-meta">
        <span>{object.type}</span>
        <code title={object.id}>{object.id.slice(0, 8)}</code>
      </div>
      {(['position', 'rotation', 'scale', 'dimensions'] as const).map((property) => (
        <fieldset key={property}>
          <legend>{property}</legend>
          <div className="vector-input">
            {draft[property].map((value, index) => (
              <label key={index}>
                <span>{['X', 'Y', 'Z'][index]}</span>
                <input
                  aria-label={`${property} ${['X', 'Y', 'Z'][index]}`}
                  type="number"
                  step="any"
                  required
                  min={property === 'scale' || property === 'dimensions' ? 0.000001 : undefined}
                  value={value}
                  onChange={(e) => {
                    const next = [...draft[property]] as [number, number, number];
                    next[index] = e.target.valueAsNumber;
                    setDraft({ ...draft, [property]: next });
                  }}
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="material-row">
        <label>
          Color
          <input
            type="color"
            value={draft.color}
            onChange={(e) => setDraft({ ...draft, color: e.target.value })}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={draft.visible}
            onChange={(e) => setDraft({ ...draft, visible: e.target.checked })}
          />
          Visible
        </label>
      </div>
      <div className="property-actions">
        <button disabled={busy}>Apply changes</button>
        <button
          type="button"
          className="danger-button"
          disabled={busy}
          onClick={() => void onDelete()}
        >
          Delete
        </button>
      </div>
    </form>
  );
}
