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
  AssetRecord,
} from '../shared/schema.js';
import { Viewport } from './Viewport.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { workspaceApiBase, workspaceIdFromUrl } from './api.js';

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
  asset: '⌂',
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function App() {
  const workspaceId = workspaceIdFromUrl();
  const apiBase = workspaceApiBase(workspaceId);
  const workspaceContextUrl =
    workspaceId === 'default' ? '/api/workspaces/default/context' : `${apiBase}/context`;
  type WorkspaceSummary = {
    id: string;
    name: string;
    owner?: string;
    goal: string;
    acceptanceCriteria: string[];
    constraints: string[];
    currentTask: string;
    workStatus: string;
    summary: string;
    workspaceStatus: 'active' | 'archived';
    updatedAt: string;
    runId?: string;
    active: boolean;
  };
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceContext, setWorkspaceContext] = useState<Record<string, any>>();
  const [projectInfo, setProjectInfo] = useState<{ goal: string; main_session: string } | null>(
    null,
  );
  const [designerStatus, setDesignerStatus] = useState<{
    limit: number;
    used: number;
    reservations: { reservationId: string; task: string; state: string; sessionId?: string }[];
  }>();
  const [workspaceFilter, setWorkspaceFilter] = useState<'all' | 'active' | 'archived'>('all');
  const [bundleName, setBundleName] = useState('specialist-submodel');
  const [bundleMessage, setBundleMessage] = useState('');
  const [bundleImportBusy, setBundleImportBusy] = useState(false);
  const bundleInput = useRef<HTMLInputElement>(null);
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
  const [assetQuery, setAssetQuery] = useState('pnw');
  const [assetKind, setAssetKind] = useState<'model' | 'material' | 'environment'>('model');
  const [assetResults, setAssetResults] = useState<AssetRecord[]>([]);
  const [assetFile, setAssetFile] = useState<File>();
  const assetFileInput = useRef<HTMLInputElement>(null);
  const [assetName, setAssetName] = useState('');
  const [assetTags, setAssetTags] = useState('');
  const [assetPreviewReady, setAssetPreviewReady] = useState(false);
  const [assetPreviewError, setAssetPreviewError] = useState('');
  const [assetImportBusy, setAssetImportBusy] = useState(false);
  const [reviewCheckpoint, setReviewCheckpoint] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [reviewKind, setReviewKind] = useState<'approval' | 'change_request'>('approval');
  const [comparison, setComparison] = useState<[string, string]>(['', '']);
  const [cameraFovDraft, setCameraFovDraft] = useState<number>();
  const camera = useRef<CameraState | undefined>(undefined);
  const pendingFov = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const refresh = async () => {
    const [next, log, shots, notes, health] = await Promise.all([
      get<Scene>(`${apiBase}/state`),
      get<ToolEvent[]>(`${apiBase}/events`),
      get<Checkpoint[]>(`${apiBase}/checkpoints`),
      get<Review[]>(`${apiBase}/reviews`),
      get<{ runId: string }>(`${apiBase}/health`),
    ]);
    if (!mounted.current) return;
    setScene((previous) => (previous?.revision === next.revision ? previous : next));
    setEvents(log);
    setCheckpoints(shots);
    setReviews(notes);
    setRunId(health.runId);
    const [listed, contextResult] = await Promise.all([
      get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
      get<{ context: Record<string, any> }>(workspaceContextUrl),
    ]);
    setWorkspaces(listed.workspaces);
    setWorkspaceContext(contextResult.context);
  };
  useEffect(() => {
    mounted.current = true;
    const refreshProject = () => {
      void get<{ project: { goal: string; main_session: string } | null }>('/api/project')
        .then((value) => {
          if (mounted.current) setProjectInfo(value.project);
          if (value.project) {
            void get<NonNullable<typeof designerStatus>>('/api/designers')
              .then((status) => {
                if (mounted.current) setDesignerStatus(status);
              })
              .catch(() => undefined);
          }
        })
        .catch(() => undefined);
    };
    refreshProject();
    const projectTimer = setInterval(refreshProject, 2000);
    void get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces')
      .then((value) => setWorkspaces(value.workspaces))
      .catch(() => undefined);
    void get<{ context: Record<string, any> }>(workspaceContextUrl)
      .then((value) => setWorkspaceContext(value.context))
      .catch((e) => setError(String(e)));
    const stream = new EventSource(`${apiBase}/stream`);
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
      clearInterval(projectTimer);
      stream.close();
    };
  }, [apiBase, workspaceContextUrl]);
  useEffect(() => {
    if (scene) setCameraFovDraft(scene.camera.fov);
  }, [scene?.camera.fov]);
  const command = async (tool: ToolName, args: unknown) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBase}/tools`, {
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
  const commitCameraFov = () => {
    if (!scene || !camera.current) return;
    const fov = cameraFovDraft ?? scene.camera.fov;
    if (fov === scene.camera.fov || pendingFov.current === fov) return;
    pendingFov.current = fov;
    void command('set_camera', { ...camera.current, fov }).finally(() => {
      pendingFov.current = undefined;
    });
  };
  const object = scene?.objects.find((o) => o.id === selected);
  const complete = checkpoints.filter((c) => c.status === 'complete');
  const selectedWorkspace = workspaces.find((item) => item.id === workspaceId);
  const isArchived =
    (workspaceContext?.workspaceStatus ?? selectedWorkspace?.workspaceStatus) === 'archived';
  const refreshWorkspaces = async () => {
    const [listed, contextResult] = await Promise.all([
      get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces'),
      get<{ context: Record<string, any> }>(workspaceContextUrl),
    ]);
    setWorkspaces(listed.workspaces);
    setWorkspaceContext(contextResult.context);
  };
  const lifecycleAction = async (action: 'archive' | 'restore' | 'purge', id = workspaceId) => {
    if (action === 'purge') {
      const typed = window.prompt(
        `Permanently purge archived workspace ${id}. Type its exact UUID to confirm.`,
      );
      if (typed !== id) return;
    }
    const response = await fetch(`/api/workspaces/${id}${action === 'purge' ? '' : `/${action}`}`, {
      method: action === 'purge' ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(action === 'purge' ? { body: JSON.stringify({ confirmWorkspaceId: id }) } : {}),
    });
    const value = (await response.json()) as { error?: { message?: string } };
    if (!response.ok) {
      setError(value.error?.message ?? `${action} failed`);
      return;
    }
    if (action === 'purge' && id === workspaceId) {
      location.href = '/';
      return;
    }
    await refreshWorkspaces();
  };
  const exportBundle = async () => {
    const result = (await command('export_scene_bundle', {})) as
      { result?: { artifactUrl?: string; fileName?: string } } | undefined;
    if (!result?.result?.artifactUrl) return;
    const link = document.createElement('a');
    link.href = result.result.artifactUrl;
    link.download = result.result.fileName ?? 'scene-bundle.zip';
    link.click();
  };
  const importBundle = async (file?: File) => {
    if (!file || bundleImportBusy) return;
    setBundleImportBusy(true);
    setError('');
    setBundleMessage('');
    try {
      const response = await fetch(`${apiBase}/bundles/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/zip',
          'X-Scene-Name': encodeURIComponent(bundleName.trim()),
        },
        body: file,
      });
      const value = (await response.json()) as {
        asset?: { id?: string };
        sceneName?: string;
        lineage?: {
          source?: { workspaceId?: string; runId?: string; executionId?: string };
          sourceSceneRevision?: number;
        };
        error?: { message?: string };
      };
      if (!response.ok) {
        setError(value.error?.message ?? 'Bundle import failed.');
        return;
      }
      setBundleMessage(
        `Imported editable save “${value.sceneName ?? bundleName}” from ${value.lineage?.source?.workspaceId ?? 'source workspace'} r${value.lineage?.sourceSceneRevision ?? '?'} and placeable asset ${value.asset?.id ?? ''}. Active scene is unchanged.`,
      );
      if (bundleInput.current) bundleInput.current.value = '';
    } catch (error) {
      setError(`Bundle import failed: ${String(error)}`);
    } finally {
      setBundleImportBusy(false);
    }
  };
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
          <select
            aria-label="Workspace"
            value={workspaceId}
            onChange={(event) => {
              const next = new URL(location.href);
              if (event.target.value === 'default') next.searchParams.delete('workspace');
              else next.searchParams.set('workspace', event.target.value);
              location.href = next.toString();
            }}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => {
              const create = document.querySelector<HTMLDetailsElement>('.workspace-create');
              if (create) {
                create.open = true;
                create.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }
            }}
          >
            ＋ Workspace
          </button>
          <span title={runId}>{runId.slice(0, 35)}</span>
        </div>
        <div className="revision">
          <span>SCENE REVISION</span>
          <strong data-testid="revision">{String(scene?.revision ?? 0).padStart(3, '0')}</strong>
        </div>
      </header>
      <section className="workspace-dashboard panel" aria-label="Workspace dashboard">
        {projectInfo && (
          <>
            <div className="project-goal" data-testid="project-goal">
              <strong>Project goal</strong>
              <span>{projectInfo.goal || 'Awaiting a goal from the human.'}</span>
            </div>
            {designerStatus && (
              <div className="designer-status" data-testid="designer-status">
                <strong>
                  Designers {designerStatus.used}/{designerStatus.limit}
                </strong>
                <span>Includes the lead designer</span>
                {designerStatus.reservations
                  .filter((entry) => !['closed', 'aborted'].includes(entry.state))
                  .map((entry) => (
                    <span key={entry.reservationId}>
                      {entry.task} · {entry.state}
                      {entry.sessionId ? ` · ${entry.sessionId.slice(0, 8)}` : ''}
                    </span>
                  ))}
              </div>
            )}
          </>
        )}
        <div className="panel-title">
          <div>
            <h2>Workspace brief</h2>
            <small>Persistent context · workspace status is separate from agent work status</small>
          </div>
          <label className="workspace-filter">
            Show
            <select
              aria-label="Workspace filter"
              value={workspaceFilter}
              onChange={(event) => setWorkspaceFilter(event.target.value as typeof workspaceFilter)}
            >
              <option value="all">All workspaces</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
        <div className="workspace-dashboard-grid">
          <div className="workspace-browser">
            <div className="workspace-list" aria-label="All workspaces">
              {workspaces
                .filter(
                  (item) => workspaceFilter === 'all' || item.workspaceStatus === workspaceFilter,
                )
                .map((item) => (
                  <article
                    key={item.id}
                    className={`workspace-card ${item.id === workspaceId ? 'selected' : ''}`}
                  >
                    <button
                      className="workspace-card-open"
                      onClick={() => {
                        const next = new URL(location.href);
                        if (item.id === 'default') next.searchParams.delete('workspace');
                        else next.searchParams.set('workspace', item.id);
                        location.href = next.toString();
                      }}
                    >
                      <strong>
                        {item.name}
                        {item.id === 'default' ? ' · legacy default' : ''}
                      </strong>
                      <span>
                        {item.workspaceStatus.toUpperCase()} · {item.workStatus} ·{' '}
                        {item.active ? 'service open' : 'service idle'}
                      </span>
                      <small>
                        {item.goal || 'No goal recorded'} · {item.owner || 'No owner'} ·{' '}
                        {item.runId ? `run ${item.runId.slice(0, 12)}` : 'no run yet'}
                      </small>
                      <small>
                        Updated{' '}
                        {item.updatedAt === 'legacy'
                          ? 'before workspace tracking'
                          : new Date(item.updatedAt).toLocaleString()}
                      </small>
                      <code>{item.id}</code>
                    </button>
                    {item.id !== 'default' && item.id !== projectInfo?.main_session && (
                      <div className="workspace-card-actions">
                        {item.workspaceStatus === 'active' ? (
                          <button onClick={() => void lifecycleAction('archive', item.id)}>
                            Archive
                          </button>
                        ) : (
                          <button onClick={() => void lifecycleAction('restore', item.id)}>
                            Restore
                          </button>
                        )}
                        {item.workspaceStatus === 'archived' && (
                          <button
                            className="danger-button"
                            onClick={() => void lifecycleAction('purge', item.id)}
                          >
                            Purge…
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
            </div>
            <details className="workspace-create">
              <summary>＋ Create specialist workspace</summary>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const response = await fetch('/api/workspaces', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      name: form.get('name'),
                      owner: form.get('owner') || undefined,
                      goal: form.get('goal'),
                      acceptanceCriteria: String(form.get('acceptanceCriteria') || '')
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                      constraints: String(form.get('constraints') || '')
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    }),
                  });
                  const value = (await response.json()) as {
                    workspace?: { id: string };
                    error?: { message?: string };
                  };
                  if (!response.ok || !value.workspace) {
                    setError(value.error?.message ?? 'Workspace creation failed.');
                    return;
                  }
                  const next = new URL(location.href);
                  next.searchParams.set('workspace', value.workspace.id);
                  location.href = next.toString();
                }}
              >
                <label>
                  Name
                  <input name="name" required maxLength={100} />
                </label>
                <label>
                  Owner
                  <input name="owner" maxLength={120} />
                </label>
                <label>
                  Goal
                  <textarea name="goal" required maxLength={2000} />
                </label>
                <label>
                  Acceptance criteria <small>One per line</small>
                  <textarea name="acceptanceCriteria" />
                </label>
                <label>
                  Constraints <small>One per line</small>
                  <textarea name="constraints" />
                </label>
                <button type="submit">Create and open</button>
              </form>
            </details>
          </div>
          <div className="workspace-brief" data-testid="workspace-brief">
            {isArchived && (
              <div className="archived-banner" role="status">
                ARCHIVED · Read-only workspace. Restore it before making scene or context changes.
              </div>
            )}
            <div className="brief-title">
              <h3>{workspaceContext?.name ?? selectedWorkspace?.name ?? 'Loading workspace…'}</h3>
              <span className={`work-status ${isArchived ? 'archived' : ''}`}>
                {isArchived
                  ? 'ARCHIVED'
                  : (workspaceContext?.workStatus ?? 'planned').replace('_', ' ').toUpperCase()}
              </span>
            </div>
            <p className="brief-goal">
              {workspaceContext?.goal || 'No goal recorded for this workspace.'}
            </p>
            <div className="brief-meta">
              <span>Owner: {workspaceContext?.owner || 'Unassigned'}</span>
              <span>Updated: {workspaceContext?.updatedAt || '—'}</span>
              <span>
                Scene r{workspaceContext?.currentScene?.revision ?? scene?.revision ?? 0} ·{' '}
                {workspaceContext?.currentScene?.objectCount ?? scene?.objects.length ?? 0} objects
              </span>
              <span>Run: {workspaceContext?.runId ?? runId}</span>
            </div>
            <div className="brief-columns">
              <div>
                <h4>Current task</h4>
                <p>{workspaceContext?.currentTask || 'No current task.'}</p>
              </div>
              <div>
                <h4>Summary</h4>
                <p>{workspaceContext?.summary || 'No progress summary yet.'}</p>
              </div>
              <div>
                <h4>Acceptance criteria</h4>
                {workspaceContext?.acceptanceCriteria?.length ? (
                  <ul>
                    {workspaceContext.acceptanceCriteria.map((item: string) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p>None recorded.</p>
                )}
              </div>
              <div>
                <h4>Constraints</h4>
                {workspaceContext?.constraints?.length ? (
                  <ul>
                    {workspaceContext.constraints.map((item: string) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p>None recorded.</p>
                )}
              </div>
            </div>
            {workspaceContext?.latestCheckpoint && (
              <a
                href={workspaceContext.latestCheckpoint.screenshotUrl}
                target="_blank"
                rel="noreferrer"
              >
                Latest checkpoint · r{workspaceContext.latestCheckpoint.sceneRevision} ↗
              </a>
            )}
            {isArchived && (
              <p className="archived-hint">
                Scene inspection and history remain available. Restore this workspace to edit it.
              </p>
            )}
            <div className="brief-controls">
              {workspaceId !== 'default' &&
                workspaceId !== projectInfo?.main_session &&
                (isArchived ? (
                  <button onClick={() => void lifecycleAction('restore')}>Restore workspace</button>
                ) : (
                  <button onClick={() => void lifecycleAction('archive')}>Archive workspace</button>
                ))}
              <label>
                Update work status
                <select
                  aria-label="Update work status"
                  disabled={isArchived}
                  value={workspaceContext?.workStatus ?? 'planned'}
                  onChange={async (event) => {
                    const response = await fetch(`/api/workspaces/${workspaceId}/context`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ workStatus: event.target.value }),
                    });
                    if (!response.ok) setError('Could not update workspace status.');
                    else await refreshWorkspaces();
                  }}
                >
                  <option value="planned">Planned</option>
                  <option value="working">Working</option>
                  <option value="blocked">Blocked</option>
                  <option value="needs_review">Needs review</option>
                  <option value="done">Done</option>
                </select>
              </label>
              <span className="activity-summary">
                Latest activity:{' '}
                {workspaceContext?.recentActivity?.[0]
                  ? `${workspaceContext.recentActivity[0].tool} · r${workspaceContext.recentActivity[0].sceneRevision}`
                  : 'No tool calls yet'}
              </span>
            </div>
          </div>
        </div>
      </section>
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">CREATE / OBSERVE / REFINE</p>
          <h1>
            A world in the making<span>.</span>
          </h1>
          <p className="subtitle">Built by an agent. Open to your perspective.</p>
        </div>
        <div className="workspace-actions">
          <button disabled={busy || !scene || isArchived} onClick={() => void exportBundle()}>
            ⇩ Export handoff ZIP
          </button>
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
      <section className="bundle-handoff panel">
        <div>
          <strong>Specialist handoff</strong>
          <p>
            Import a portable ZIP as an editable named save and a placeable GLB. The active scene
            stays unchanged.
          </p>
        </div>
        <label>
          Editable save name (letters, digits, hyphens)
          <input
            aria-label="Bundle scene name"
            value={bundleName}
            disabled={isArchived || bundleImportBusy}
            onChange={(event) => setBundleName(event.target.value)}
          />
        </label>
        <input
          ref={bundleInput}
          aria-label="Scene bundle ZIP"
          type="file"
          accept=".zip,application/zip"
          disabled={isArchived || bundleImportBusy}
          onChange={(event) => void importBundle(event.currentTarget.files?.[0])}
        />
        {bundleImportBusy && <p role="status">Importing bundle… Large bundles can take a while.</p>}
        {bundleMessage && (
          <p role="status">
            {bundleMessage} Use <strong>load_scene</strong> to open the editable save, or{' '}
            <strong>search_assets</strong> then <strong>create_object</strong> to place the GLB.
          </p>
        )}
      </section>
      {error && (
        <div role="alert" className="error-banner">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      <div className={`editor-grid ${isArchived ? 'read-only' : ''}`}>
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
              {(['box', 'sphere', 'cylinder', 'cone', 'plane'] as const).map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </div>
          <form
            className="add-object"
            onSubmit={async (event) => {
              event.preventDefault();
              const response = await command('search_assets', {
                query: assetQuery,
                kind: assetKind,
              });
              setAssetResults((response?.result as AssetRecord[] | undefined) ?? []);
            }}
          >
            <label htmlFor="asset-query">SEARCH LOCAL ASSETS</label>
            <input
              id="asset-query"
              value={assetQuery}
              onChange={(event) => setAssetQuery(event.target.value)}
            />
            <select
              aria-label="Asset kind"
              value={assetKind}
              onChange={(event) => setAssetKind(event.target.value as typeof assetKind)}
            >
              <option value="model">Models</option>
              <option value="material">Materials</option>
              <option value="environment">Lighting</option>
            </select>
            <button type="submit" disabled={busy}>
              Search
            </button>
            {assetResults.map((asset) => (
              <button
                type="button"
                key={asset.id}
                disabled={busy}
                title={asset.description}
                onClick={() => {
                  if (asset.kind === 'model')
                    void command('create_object', {
                      name: asset.name,
                      type: 'asset',
                      assetId: asset.id,
                    });
                  else if (asset.kind === 'environment')
                    void command('set_lighting', { environmentAssetId: asset.id });
                  else
                    void command('create_object', {
                      name: asset.name,
                      type: 'box',
                      materialId: asset.id,
                    });
                }}
              >
                {asset.kind === 'model' ? '＋ ' : asset.kind === 'environment' ? '☼ ' : '▧ '}
                {asset.name}
              </button>
            ))}
          </form>
          <form
            className="asset-import add-object"
            aria-label="Import a local asset"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!assetFile || !assetPreviewReady) return;
              setAssetImportBusy(true);
              setError('');
              try {
                const response = await fetch(`${apiBase}/assets/import`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/octet-stream',
                    'X-Asset-Name': encodeURIComponent(assetName),
                    'X-Asset-File-Name': encodeURIComponent(assetFile.name),
                    'X-Asset-Tags': encodeURIComponent(
                      JSON.stringify(
                        assetTags
                          .split(',')
                          .map((tag) => tag.trim())
                          .filter(Boolean),
                      ),
                    ),
                  },
                  body: assetFile,
                });
                const value = (await response.json()) as {
                  asset?: AssetRecord;
                  error?: { message?: string };
                };
                if (!response.ok || !value.asset)
                  throw new Error(
                    value.error?.message ?? `Asset import failed (${response.status}).`,
                  );
                setAssetResults((current) => [
                  value.asset!,
                  ...current.filter((item) => item.id !== value.asset!.id),
                ]);
                setAssetKind(value.asset.kind);
                setAssetQuery(value.asset.name);
                if (assetFileInput.current) assetFileInput.current.value = '';
                setAssetFile(undefined);
                setAssetName('');
                setAssetTags('');
                setAssetPreviewReady(false);
              } catch (e) {
                setError(String(e));
              } finally {
                setAssetImportBusy(false);
              }
            }}
          >
            <label>IMPORT A LOCAL ASSET</label>
            <input
              ref={assetFileInput}
              aria-label="Asset file"
              type="file"
              accept=".glb,.hdr,.png,.jpg,.jpeg,.webp"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                setAssetFile(file);
                setAssetPreviewReady(false);
                setAssetPreviewError('');
                setAssetName(file?.name.replace(/\.[^.]+$/, '') ?? '');
              }}
            />
            {assetFile && (
              <>
                <input
                  aria-label="Asset name"
                  value={assetName}
                  onChange={(event) => setAssetName(event.target.value)}
                  placeholder="Asset name"
                />
                <input
                  aria-label="Asset tags"
                  value={assetTags}
                  onChange={(event) => setAssetTags(event.target.value)}
                  placeholder="Tags, comma separated"
                />
                <AssetPreview
                  key={`${assetFile.name}-${assetFile.size}-${assetFile.lastModified}`}
                  file={assetFile}
                  onReady={(ready, message = '') => {
                    setAssetPreviewReady(ready);
                    setAssetPreviewError(message);
                  }}
                />
                {assetPreviewError && (
                  <p className="asset-preview-error" role="alert">
                    {assetPreviewError}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={!assetPreviewReady || assetImportBusy || !assetName.trim()}
                >
                  {assetImportBusy
                    ? 'Importing…'
                    : assetPreviewReady
                      ? 'Add to local catalog'
                      : 'Preview before import'}
                </button>
                <small className="asset-import-note">
                  Local files only · GLB, HDR, PNG/JPEG/WebP · 100 MiB max
                </small>
              </>
            )}
          </form>
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
            <div className="camera-controls">
              <label htmlFor="camera-projection">CAMERA</label>
              <select
                id="camera-projection"
                aria-label="Camera projection"
                value={scene?.camera.projection ?? 'orthographic'}
                disabled={busy || !camera.current}
                onChange={(event) => {
                  if (camera.current)
                    void command('set_camera', {
                      ...camera.current,
                      projection: event.target.value as CameraState['projection'],
                    });
                }}
              >
                <option value="orthographic">Orthographic</option>
                <option value="perspective">Perspective</option>
              </select>
              {scene?.camera.projection === 'perspective' && (
                <label className="camera-fov">
                  <span>VERTICAL FOV</span>
                  <input
                    aria-label="Vertical field of view"
                    type="range"
                    min="10"
                    max="100"
                    step="1"
                    value={cameraFovDraft ?? scene.camera.fov}
                    disabled={busy || !camera.current}
                    onChange={(event) => setCameraFovDraft(Number(event.target.value))}
                    onPointerUp={commitCameraFov}
                    onKeyUp={commitCameraFov}
                    onBlur={commitCameraFov}
                  />
                  <output>{scene.camera.fov}°</output>
                </label>
              )}
              <span className="toolbar-separator">/</span> Y UP
            </div>
          </div>
          <div className="viewport-stage">
            {scene && (
              <Viewport
                scene={scene}
                workspaceId={workspaceId}
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
        <a href={`${apiBase}/tools`} target="_blank" rel="noreferrer">
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
        const {
          id,
          name,
          position,
          rotation,
          scale,
          dimensions,
          color,
          visible,
          roughness,
          metalness,
          materialId,
        } = draft;
        void onSave({
          id,
          name,
          position,
          rotation,
          scale,
          dimensions,
          color,
          visible,
          roughness,
          metalness,
          materialId,
        });
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
      <div className="material-row">
        <label>
          Roughness
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            aria-label="Roughness"
            placeholder="asset default"
            value={draft.roughness ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                roughness: e.target.value === '' ? undefined : e.target.valueAsNumber,
              })
            }
          />
        </label>
        <label>
          Metalness
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            aria-label="Metalness"
            placeholder="asset default"
            value={draft.metalness ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                metalness: e.target.value === '' ? undefined : e.target.valueAsNumber,
              })
            }
          />
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

function AssetPreview({
  file,
  onReady,
}: {
  file: File;
  onReady: (ready: boolean, message?: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callback = useRef(onReady);
  callback.current = onReady;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const isImage = ['png', 'jpg', 'jpeg', 'webp'].includes(extension ?? '');
  const [imageUrl, setImageUrl] = useState('');
  useEffect(() => {
    let disposed = false;
    const url = URL.createObjectURL(file);
    if (isImage) {
      const image = new Image();
      image.onload = () => {
        if (!disposed) {
          setImageUrl(url);
          callback.current(true);
        }
      };
      image.onerror = () => {
        if (!disposed) callback.current(false, 'The image could not be previewed.');
      };
      image.src = url;
      return () => {
        disposed = true;
        URL.revokeObjectURL(url);
      };
    }
    const element = host.current;
    if (!element) return () => URL.revokeObjectURL(url);
    let renderer: THREE.WebGLRenderer | undefined;
    let scene: THREE.Scene | undefined;
    let previewEnvironment: THREE.Texture | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(1);
      renderer.setSize(260, 150);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      element.appendChild(renderer.domElement);
      scene = new THREE.Scene();
      scene.background = new THREE.Color('#d8dfd5');
      scene.add(new THREE.HemisphereLight('#ffffff', '#68735f', 2));
      const light = new THREE.DirectionalLight('#fff2df', 3);
      light.position.set(4, 7, 5);
      scene.add(light);
      const camera = new THREE.PerspectiveCamera(38, 260 / 150, 0.05, 10000);
      const render = () => {
        if (!disposed && scene && renderer) {
          renderer.render(scene, camera);
          callback.current(true);
        }
      };
      if (extension === 'hdr') {
        new RGBELoader().load(
          url,
          (texture) => {
            if (disposed || !scene) {
              texture.dispose();
              return;
            }
            previewEnvironment = texture;
            texture.mapping = THREE.EquirectangularReflectionMapping;
            scene.background = texture;
            camera.position.set(0, 0, 3.5);
            render();
          },
          undefined,
          (error) => {
            if (!disposed) callback.current(false, `HDR preview failed: ${String(error)}`);
          },
        );
      } else {
        new GLTFLoader().load(
          url,
          (gltf) => {
            if (disposed || !scene) return;
            const model = gltf.scene;
            scene.add(model);
            const bounds = new THREE.Box3().setFromObject(model);
            const size = bounds.getSize(new THREE.Vector3());
            const center = bounds.getCenter(new THREE.Vector3());
            model.position.sub(center);
            const largest = Math.max(size.x, size.y, size.z);
            camera.position.set(largest * 1.8, largest * 1.25, largest * 2.8);
            camera.lookAt(0, 0, 0);
            render();
          },
          undefined,
          (error) => {
            if (!disposed) callback.current(false, `GLB preview failed: ${String(error)}`);
          },
        );
      }
    } catch (error) {
      callback.current(false, `Preview could not start: ${String(error)}`);
    }
    return () => {
      disposed = true;
      if (scene) {
        scene.traverse((item) => {
          if (item instanceof THREE.Mesh) {
            item.geometry.dispose();
            for (const material of Array.isArray(item.material) ? item.material : [item.material])
              material.dispose();
          }
        });
      }
      previewEnvironment?.dispose();
      renderer?.dispose();
      renderer?.domElement.remove();
      URL.revokeObjectURL(url);
    };
  }, [file, extension, isImage]);
  return isImage ? (
    <div className="asset-preview">
      <img src={imageUrl || undefined} alt={`Preview of ${file.name}`} />
    </div>
  ) : (
    <div
      ref={host}
      className="asset-preview asset-preview-canvas"
      aria-label={`3D preview of ${file.name}`}
    />
  );
}
