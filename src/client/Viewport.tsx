import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraState, Scene } from '../shared/schema.js';
import { buildWorld, disposeWorld } from './world.js';

export function Viewport({ scene, captureMode = false, onSelect, onCamera, onError }: {
  scene: Scene; captureMode?: boolean; onSelect?: (id: string) => void;
  onCamera?: (camera: CameraState) => void; onError?: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onSelect, onCamera, onError }); callbacks.current = { onSelect, onCamera, onError };
  useEffect(() => {
    const element = host.current!;
    window.__sceneReady = undefined; window.__sceneError = undefined;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); }
    catch (error) { const message = `WebGL initialization failed: ${String(error)}`; window.__sceneError = message; callbacks.current.onError?.(message); return; }
    renderer.setPixelRatio(captureMode ? 1 : Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute('aria-label', '3D scene viewport');
    element.appendChild(renderer.domElement);
    const world = buildWorld(scene);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    camera.position.fromArray(scene.camera.position); camera.lookAt(new THREE.Vector3(...scene.camera.target));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.fromArray(scene.camera.target); controls.enabled = !captureMode;
    controls.enableDamping = false; controls.minZoom = 0.1; controls.maxZoom = 20; controls.update();
    const resize = () => {
      const width = element.clientWidth; const height = element.clientHeight;
      const half = scene.camera.verticalSize / 2; const aspect = width / Math.max(height, 1);
      Object.assign(camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half });
      camera.updateProjectionMatrix(); renderer.setSize(width, height);
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const reportCamera = () => callbacks.current.onCamera?.({
      position: camera.position.toArray(), target: controls.target.toArray(), verticalSize: scene.camera.verticalSize / camera.zoom,
    });
    controls.addEventListener('change', reportCamera); reportCamera();
    let pointer: { x: number; y: number } | undefined;
    const down = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
    const up = (event: PointerEvent) => {
      if (!pointer || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(
        (event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1,
      ), camera);
      const hit = ray.intersectObjects(world.children).find(h => h.object.visible && h.object.userData.id);
      if (hit) callbacks.current.onSelect?.(hit.object.userData.id as string);
    };
    renderer.domElement.addEventListener('pointerdown', down); renderer.domElement.addEventListener('pointerup', up);
    const contextLost = (event: Event) => {
      event.preventDefault(); const message = 'WebGL context lost. Reload the viewport to recover.';
      window.__sceneError = message; window.__sceneReady = undefined; callbacks.current.onError?.(message);
    };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    let animation = 0; let frames = 0;
    const frame = () => {
      renderer.render(world, camera);
      if (++frames === 2) window.__sceneReady = { revision: scene.revision, objectIds: scene.objects.filter(o => o.visible).map(o => o.id) };
      animation = requestAnimationFrame(frame);
    };
    frame();
    return () => {
      cancelAnimationFrame(animation); observer.disconnect(); controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      disposeWorld(world); renderer.dispose(); renderer.domElement.remove();
    };
  }, [scene, captureMode]);
  return <div ref={host} className="viewport-canvas" data-testid="viewport" />;
}
