import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { TextureLoader } from 'three';
import { builtinAssetMap } from '../shared/assets.js';
import type { AssetRecord, Scene, SceneObject } from '../shared/schema.js';
import { buildBuiltinModel, buildOvercastEnvironment, createSurfaceMaterial } from './assets.js';

export function geometry(type: Exclude<SceneObject['type'], 'asset'>): THREE.BufferGeometry {
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(1, 1, 1);
    case 'sphere':
      return new THREE.SphereGeometry(0.5, 32, 20);
    case 'cylinder':
      return new THREE.CylinderGeometry(0.5, 0.5, 1, 32);
    case 'cone':
      return new THREE.ConeGeometry(0.5, 1, 32);
    case 'plane':
      return new THREE.PlaneGeometry(1, 1);
  }
}

async function loadSurfaceMaterial(id: string): Promise<THREE.MeshStandardMaterial> {
  if (builtinAssetMap.get(id)?.kind === 'material') return createSurfaceMaterial(id);
  if (!id.startsWith('local:')) throw new Error(`Unknown material asset ${id}.`);
  const response = await fetch(`/api/assets/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Cannot load material ${id} (${response.status}).`);
  const record = await response.json() as AssetRecord;
  if (record.kind !== 'material') throw new Error(`Catalog entry ${id} is not a material.`);
  const map = await new TextureLoader().loadAsync(`/api/assets/${encodeURIComponent(id)}/file`);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  return new THREE.MeshStandardMaterial({
    color: record.baseColor ?? '#ffffff',
    roughness: record.roughness ?? 0.86,
    metalness: record.metalness ?? 0,
    map,
  });
}
export async function buildWorld(state: Scene) {
  const world = new THREE.Scene();
  world.background = new THREE.Color('#e9ede5');
  const loadEnvironment = async () => {
    const id = state.lighting.environmentAssetId;
    if (!id) return undefined;
    if (id === 'builtin:pnw-overcast') return buildOvercastEnvironment();
    if (id.startsWith('local:'))
      return new RGBELoader().loadAsync(`/api/assets/${encodeURIComponent(id)}/file`);
    throw new Error(`Unknown environment asset ${id}`);
  };
  const environment = await loadEnvironment();
  if (environment) {
    environment.mapping = THREE.EquirectangularReflectionMapping;
    world.environment = environment;
    world.environmentIntensity = 0.55;
    // Keep the reflection map for material lighting; a solid overcast sky gives
    // the house a readable horizon instead of exposing the raw HDR/data map.
    world.background = new THREE.Color('#b9c6c5');
  }
  const gltfLoader = new GLTFLoader();
  const items = await Promise.all(state.objects.map(async (object) => {
    let root: THREE.Object3D;
    if (object.type === 'asset') {
      if (!object.assetId) throw new Error(`Object ${object.name} has no assetId.`);
      if (builtinAssetMap.get(object.assetId)?.kind === 'model') root = buildBuiltinModel(object.assetId);
      else if (object.assetId.startsWith('local:'))
        root = (await gltfLoader.loadAsync(`/api/assets/${encodeURIComponent(object.assetId)}/file`)).scene;
      else throw new Error(`Unknown model asset ${object.assetId}.`);
    } else {
      const material = object.materialId
        ? await loadSurfaceMaterial(object.materialId)
        : new THREE.MeshStandardMaterial({
            color: object.color,
            roughness: object.roughness ?? 0.86,
            metalness: object.metalness ?? 0,
          });
      root = new THREE.Mesh(geometry(object.type), material);
    }
    root.name = object.name;
    root.position.fromArray(object.position);
    root.rotation.set(...object.rotation);
    const assetScale = object.type === 'asset' && object.assetBounds
      ? object.dimensions.map((value, i) => (value / object.assetBounds![i]) * object.scale[i])
      : object.dimensions.map((value, i) => value * object.scale[i]);
    root.scale.set(...(assetScale as [number, number, number]));
    root.visible = object.visible;
    const overrideMaterial = object.type === 'asset' && object.materialId
      ? await loadSurfaceMaterial(object.materialId)
      : undefined;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.userData.id = object.id;
      child.name ||= object.name;
      child.castShadow = object.type !== 'plane';
      child.receiveShadow = true;
      if (object.type === 'asset') {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        const clones = materials.map((original) => {
          const material = overrideMaterial ? overrideMaterial.clone() : original.clone();
          if (!object.materialId && material instanceof THREE.MeshStandardMaterial) {
            if (object.roughness !== undefined) material.roughness = object.roughness;
            if (object.metalness !== undefined) material.metalness = object.metalness;
            if (object.color !== '#ffffff') material.color.multiply(new THREE.Color(object.color));
          }
          return material;
        });
        child.material = Array.isArray(child.material) ? clones : clones[0];
      }
    });
    return root;
  }));
  for (const item of items) {
    world.add(item);
  }
  const ambient = state.lighting.ambient;
  const directional = state.lighting.directional;
  world.add(new THREE.AmbientLight(ambient.color, ambient.intensity));
  world.add(new THREE.HemisphereLight('#e8efeb', '#737966', 1.15));
  const sun = new THREE.DirectionalLight(directional.color, directional.intensity);
  sun.position.fromArray(directional.position);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0005;
  Object.assign(sun.shadow.camera, {
    left: -15,
    right: 15,
    top: 15,
    bottom: -15,
    near: 0.1,
    far: 80,
  });
  world.add(sun);
  return world;
}
export function disposeWorld(world: THREE.Scene) {
  world.traverse((item) => {
    if (item instanceof THREE.Mesh) {
      item.geometry.dispose();
      for (const material of Array.isArray(item.material) ? item.material : [item.material])
      {
        if ('map' in material && material.map) material.map.dispose();
        material.dispose();
      }
    }
    if (item instanceof THREE.DirectionalLight) item.shadow.dispose();
  });
  if (world.environment) world.environment.dispose();
}
