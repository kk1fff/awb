import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { TextureLoader } from 'three';
import { builtinAssetMap } from '../shared/assets.js';
import type { AssetRecord, Scene, SceneObject } from '../shared/schema.js';
import {
  buildBuiltinModel,
  buildOvercastEnvironment,
  buildStudioEnvironment,
  createSurfaceMaterial,
} from './assets.js';
import { workspaceApiBase } from './api.js';

const reflectorShader = (
  Reflector as unknown as {
    ReflectorShader: {
      uniforms: Record<string, { value: unknown }>;
      vertexShader: string;
      fragmentShader: string;
    };
  }
).ReflectorShader;
const mirrorShader = {
  name: 'FieldworkMirror',
  uniforms: { ...reflectorShader.uniforms, reflectionStrength: { value: 0.78 } },
  vertexShader: reflectorShader.vertexShader,
  fragmentShader: reflectorShader.fragmentShader
    .replace(
      'uniform sampler2D tDiffuse;',
      'uniform sampler2D tDiffuse;\n uniform float reflectionStrength;',
    )
    .replace('blendOverlay( base.rgb, color )', 'mix( color, base.rgb, reflectionStrength )'),
};

export function geometry(
  type: Exclude<SceneObject['type'], 'asset'>,
  profile?: SceneObject['profile'],
): THREE.BufferGeometry {
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
    case 'mirror':
      return new THREE.PlaneGeometry(1, 1);
    case 'lathe':
      if (!profile) throw new Error('Lathe geometry requires a profile.');
      const lathe = new THREE.LatheGeometry(
        profile.map(([radius, y]) => new THREE.Vector2(radius, y)),
        96,
      );
      lathe.computeTangents();
      return lathe;
  }
}

async function loadSurfaceMaterial(
  id: string,
  apiBase: string,
): Promise<THREE.MeshStandardMaterial> {
  if (builtinAssetMap.get(id)?.kind === 'material') return createSurfaceMaterial(id);
  if (!id.startsWith('local:')) throw new Error(`Unknown material asset ${id}.`);
  const response = await fetch(`${apiBase}/assets/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`Cannot load material ${id} (${response.status}).`);
  const record = (await response.json()) as AssetRecord;
  if (record.kind !== 'material') throw new Error(`Catalog entry ${id} is not a material.`);
  const map = await new TextureLoader().loadAsync(
    `${apiBase}/assets/${encodeURIComponent(id)}/file`,
  );
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = 4;
  return new THREE.MeshPhysicalMaterial({
    color: record.baseColor ?? '#ffffff',
    roughness: record.roughness ?? 0.86,
    metalness: record.metalness ?? 0,
    map,
  });
}
export async function buildWorld(
  state: Scene,
  workspaceId?: string,
  options: { sequential?: boolean; forExport?: boolean } = {},
) {
  const apiBase = workspaceApiBase(workspaceId);
  const world = new THREE.Scene();
  world.background = new THREE.Color('#e9ede5');
  const loadEnvironment = async () => {
    const id = state.lighting.environmentAssetId;
    if (!id) return undefined;
    if (id === 'builtin:pnw-overcast') return buildOvercastEnvironment();
    if (id === 'builtin:studio-softboxes') return buildStudioEnvironment();
    if (id.startsWith('local:'))
      return new RGBELoader().loadAsync(`${apiBase}/assets/${encodeURIComponent(id)}/file`);
    throw new Error(`Unknown environment asset ${id}`);
  };
  const environment = await loadEnvironment();
  const fallbackBackground = state.lighting.environmentAssetId ? '#b9c6c5' : '#e9ede5';
  if (environment) {
    environment.mapping = THREE.EquirectangularReflectionMapping;
    world.environment = environment;
    world.environmentIntensity = state.lighting.environmentIntensity;
  }
  // The same environment asset independently drives reflections and, when
  // requested, the visible sky. Legacy scenes default to their prior solid.
  world.background =
    state.lighting.backgroundMode === 'environment' && environment
      ? environment
      : new THREE.Color(state.lighting.backgroundColor ?? fallbackBackground);
  const gltfLoader = new GLTFLoader();
  const createItem = async (object: SceneObject) => {
    let root: THREE.Object3D;
    if (object.type === 'asset') {
      if (!object.assetId) throw new Error(`Object ${object.name} has no assetId.`);
      if (builtinAssetMap.get(object.assetId)?.kind === 'model')
        root = buildBuiltinModel(object.assetId);
      else if (object.assetId.startsWith('local:'))
        root = (
          await gltfLoader.loadAsync(`${apiBase}/assets/${encodeURIComponent(object.assetId)}/file`)
        ).scene;
      else throw new Error(`Unknown model asset ${object.assetId}.`);
    } else if (object.type === 'mirror') {
      root = options.forExport
        ? new THREE.Mesh(
            geometry('mirror'),
            new THREE.MeshStandardMaterial({
              color: object.color,
              metalness: 1,
              roughness: 0.02,
              side: THREE.DoubleSide,
            }),
          )
        : new Reflector(geometry('mirror'), {
            color: object.color,
            textureWidth: 1024,
            textureHeight: 1024,
            clipBias: 0.003,
            multisample: 2,
            shader: mirrorShader,
          });
      if (root instanceof Reflector)
        (root.material as THREE.ShaderMaterial).uniforms.reflectionStrength.value =
          object.reflectionStrength ?? 0.78;
    } else {
      const material = object.materialId
        ? await loadSurfaceMaterial(object.materialId, apiBase)
        : new THREE.MeshPhysicalMaterial({
            color: object.color,
            roughness: object.roughness ?? 0.86,
            metalness: object.metalness ?? 0,
          });
      if (object.materialOverrides) {
        if (object.materialOverrides.color) material.color.set(object.materialOverrides.color);
        if (object.materialOverrides.roughness !== undefined)
          material.roughness = object.materialOverrides.roughness;
        if (object.materialOverrides.metalness !== undefined)
          material.metalness = object.materialOverrides.metalness;
        if (
          object.materialOverrides.anisotropy !== undefined &&
          material instanceof THREE.MeshPhysicalMaterial
        )
          material.anisotropy = object.materialOverrides.anisotropy;
      }
      root = new THREE.Mesh(geometry(object.type, object.profile), material);
    }
    root.name = object.name;
    root.position.fromArray(object.position);
    root.rotation.set(...object.rotation);
    const assetScale =
      object.type === 'asset' && object.assetBounds
        ? object.dimensions.map((value, i) => (value / object.assetBounds![i]) * object.scale[i])
        : object.dimensions.map((value, i) => value * object.scale[i]);
    root.scale.set(...(assetScale as [number, number, number]));
    root.visible = object.visible;
    const overrideMaterial =
      object.type === 'asset' && object.materialId
        ? await loadSurfaceMaterial(object.materialId, apiBase)
        : undefined;
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.userData.id = object.id;
      child.name ||= object.name;
      child.castShadow = object.type !== 'plane' && object.type !== 'mirror';
      child.receiveShadow = object.type !== 'mirror';
      if (object.type === 'asset') {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        const clones = materials.map((original) => {
          const material = overrideMaterial ? overrideMaterial.clone() : original.clone();
          if (!object.materialId && material instanceof THREE.MeshStandardMaterial) {
            if (object.roughness !== undefined) material.roughness = object.roughness;
            if (object.metalness !== undefined) material.metalness = object.metalness;
            if (object.color !== '#ffffff') material.color.multiply(new THREE.Color(object.color));
          }
          if (object.materialOverrides && material instanceof THREE.MeshStandardMaterial) {
            if (object.materialOverrides.color) material.color.set(object.materialOverrides.color);
            if (object.materialOverrides.roughness !== undefined)
              material.roughness = object.materialOverrides.roughness;
            if (object.materialOverrides.metalness !== undefined)
              material.metalness = object.materialOverrides.metalness;
            if (
              object.materialOverrides.anisotropy !== undefined &&
              material instanceof THREE.MeshPhysicalMaterial
            )
              material.anisotropy = object.materialOverrides.anisotropy;
          }
          return material;
        });
        child.material = Array.isArray(child.material) ? clones : clones[0];
      }
    });
    return root;
  };
  const items: THREE.Object3D[] = options.sequential
    ? []
    : await Promise.all(state.objects.map(createItem));
  if (options.sequential) for (const object of state.objects) items.push(await createItem(object));
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
  // PCF radius is consumed by Three's PCFShadowMap shader. A 2x response
  // gives each integer UI step a visible but bounded penumbra change.
  sun.shadow.radius = 1 + directional.shadowSoftness * 2;
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
      if (item instanceof Reflector) {
        item.dispose();
        return;
      }
      for (const material of Array.isArray(item.material) ? item.material : [item.material]) {
        for (const textureKey of [
          'map',
          'normalMap',
          'bumpMap',
          'roughnessMap',
          'metalnessMap',
          'aoMap',
        ] as const) {
          const texture = material[textureKey];
          if (texture) texture.dispose();
        }
        material.dispose();
      }
    }
    if (item instanceof THREE.DirectionalLight) item.shadow.dispose();
  });
  if (world.environment) world.environment.dispose();
}
