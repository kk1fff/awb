import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { Scene } from '../shared/schema.js';
import { Viewport } from './Viewport.js';
import { App } from './App.js';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import './style.css';

function CheckpointView({ id }: { id: string }) {
  const [scene, setScene] = useState<Scene>();
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/checkpoints/${encodeURIComponent(id)}/scene`).then(async response => {
      if (!response.ok) throw new Error(`Checkpoint load failed (${response.status})`);
      setScene(await response.json() as Scene);
    }).catch(error => { window.__sceneError = String(error); setError(String(error)); });
  }, [id]);
  return <main className="capture-view">{error ? <p role="alert">{error}</p> : scene ? <Viewport scene={scene} captureMode /> : <p>Loading checkpoint…</p>}</main>;
}
const checkpoint = new URLSearchParams(location.search).get('checkpoint');
createRoot(document.getElementById('root')!).render(checkpoint ? <CheckpointView id={checkpoint} /> : <App />);
