import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CameraState, Scene } from '../shared/schema.js';
import { buildWorld, disposeWorld } from './world.js';

export function Viewport({
  scene,
  captureMode = false,
  onSelect,
  onCamera,
  onError,
}: {
  scene: Scene;
  captureMode?: boolean;
  onSelect?: (id: string) => void;
  onCamera?: (camera: CameraState) => void;
  onError?: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const localView = useRef<{ canonical: string; camera: CameraState } | undefined>(undefined);
  const callbacks = useRef({ onSelect, onCamera, onError });
  callbacks.current = { onSelect, onCamera, onError };
  useEffect(() => {
    const element = host.current!;
    window.__sceneReady = undefined;
    window.__sceneError = undefined;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    } catch (error) {
      const message = `WebGL initialization failed: ${String(error)}`;
      window.__sceneError = message;
      callbacks.current.onError?.(message);
      return;
    }
    renderer.setPixelRatio(captureMode ? 1 : Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute('aria-label', '3D scene viewport');
    element.appendChild(renderer.domElement);
    let world: THREE.Scene | undefined;
    let controls: OrbitControls | undefined;
    let observer: ResizeObserver | undefined;
    let animation = 0;
    let disposed = false;
    let renderScheduled = false;
    let renderedFrames = 0;
    let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera | undefined;
    let pointer: { x: number; y: number } | undefined;
    const scheduleRender = () => {
      if (disposed || renderScheduled || !world || !camera) return;
      renderScheduled = true;
      animation = requestAnimationFrame(() => {
        renderScheduled = false;
        if (disposed || !world || !camera) return;
        renderer.render(world, camera);
        if (++renderedFrames === 2) {
          window.__sceneReady = {
            revision: scene.revision,
            objectIds: scene.objects.filter((o) => o.visible).map((o) => o.id),
          };
        } else {
          scheduleRender();
        }
      });
    };
    const contextLost = (event: Event) => {
      event.preventDefault();
      const message = 'WebGL context lost. Reload the viewport to recover.';
      window.__sceneError = message;
      window.__sceneReady = undefined;
      callbacks.current.onError?.(message);
    };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    let down: ((event: PointerEvent) => void) | undefined;
    let up: ((event: PointerEvent) => void) | undefined;
    void buildWorld(scene).then((loadedWorld) => {
      if (disposed) {
        disposeWorld(loadedWorld);
        return;
      }
      world = loadedWorld;
      const canonical = JSON.stringify(scene.camera);
      const view =
        !captureMode && localView.current?.canonical === canonical
          ? localView.current.camera
          : scene.camera;
      camera =
        view.projection === 'perspective'
          ? new THREE.PerspectiveCamera(view.fov, 1, 0.1, 1000)
          : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
      camera.position.fromArray(view.position);
      camera.lookAt(new THREE.Vector3(...view.target));
      controls = new OrbitControls(camera, renderer.domElement);
      controls.target.fromArray(view.target);
      controls.enabled = !captureMode;
      controls.enableDamping = false;
      controls.minZoom = 0.1;
      controls.maxZoom = 20;
      controls.minDistance = 0.1;
      controls.maxDistance = 10000;
      controls.update();
      const resize = () => {
        if (!camera) return;
        const width = element.clientWidth;
        const height = element.clientHeight;
        const aspect = width / Math.max(height, 1);
        if (camera instanceof THREE.OrthographicCamera) {
          const half = view.verticalSize / 2;
          Object.assign(camera, {
            left: -half * aspect,
            right: half * aspect,
            top: half,
            bottom: -half,
          });
        } else {
          camera.aspect = aspect;
        }
        camera!.updateProjectionMatrix();
        renderer.setSize(width, height);
        scheduleRender();
      };
      observer = new ResizeObserver(resize);
      observer.observe(element);
      resize();
      const reportCamera = () => {
        const current = {
          position: camera!.position.toArray(),
          target: controls!.target.toArray(),
          verticalSize:
            camera instanceof THREE.OrthographicCamera
              ? view.verticalSize / camera.zoom
              : view.verticalSize,
          projection: view.projection,
          fov: view.fov,
        };
        if (!captureMode) localView.current = { canonical, camera: current };
        callbacks.current.onCamera?.(current);
      };
      controls.addEventListener('change', () => {
        reportCamera();
        scheduleRender();
      });
      reportCamera();
      down = (event) => { pointer = { x: event.clientX, y: event.clientY }; };
      up = (event) => {
        if (!pointer || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 5) return;
        const rect = renderer.domElement.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(
          new THREE.Vector2(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          ),
          camera!,
        );
        const hit = ray.intersectObjects(world!.children, true).find((h) => h.object.visible && h.object.userData.id);
        if (hit) callbacks.current.onSelect?.(hit.object.userData.id as string);
      };
      renderer.domElement.addEventListener('pointerdown', down);
      renderer.domElement.addEventListener('pointerup', up);
      scheduleRender();
    }).catch((error) => {
      const message = `Scene asset loading failed: ${String(error)}`;
      window.__sceneError = message;
      callbacks.current.onError?.(message);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(animation);
      observer?.disconnect();
      controls?.dispose();
      if (down) renderer.domElement.removeEventListener('pointerdown', down);
      if (up) renderer.domElement.removeEventListener('pointerup', up);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      if (world) disposeWorld(world);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [scene, captureMode]);
  return <div ref={host} className="viewport-canvas" data-testid="viewport" />;
}
