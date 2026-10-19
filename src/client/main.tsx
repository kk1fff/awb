import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { Scene } from '../shared/schema.js';
import { Viewport } from './Viewport.js';
import { App } from './App.js';
import { exportBrowserScene } from './scene-export.js';
import { workspaceApiBase, workspaceIdFromUrl } from './api.js';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import './style.css';

function CheckpointView({ id, workspaceId }: { id: string; workspaceId: string }) {
  const [scene, setScene] = useState<Scene>();
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`${workspaceApiBase(workspaceId)}/checkpoints/${encodeURIComponent(id)}/scene`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Checkpoint load failed (${response.status})`);
        setScene((await response.json()) as Scene);
      })
      .catch((error) => {
        window.__sceneError = String(error);
        setError(String(error));
      });
  }, [id]);
  return (
    <main className="capture-view">
      {error ? (
        <p role="alert">{error}</p>
      ) : scene ? (
        <Viewport scene={scene} workspaceId={workspaceId} captureMode />
      ) : (
        <p>Loading checkpoint…</p>
      )}
    </main>
  );
}
const params = new URLSearchParams(location.search);
const checkpoint = params.get('checkpoint');
const workspaceId = workspaceIdFromUrl();
if (params.get('fieldworkExport') === '1') {
  window.__fieldworkExport = (scene) => exportBrowserScene(scene, workspaceId);
} else {
  createRoot(document.getElementById('root')!).render(
    checkpoint ? <CheckpointView id={checkpoint} workspaceId={workspaceId} /> : <App />,
  );
}
