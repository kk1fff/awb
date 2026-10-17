import * as THREE from 'three';
import type { Scene, SceneObject } from '../shared/schema.js';

export function geometry(type: SceneObject['type']): THREE.BufferGeometry {
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
export function buildWorld(state: Scene) {
  const world = new THREE.Scene();
  world.background = new THREE.Color('#e9ede5');
  for (const object of state.objects) {
    const material = new THREE.MeshStandardMaterial({
      color: object.color,
      roughness: 0.86,
      metalness: 0,
      flatShading: true,
    });
    const mesh = new THREE.Mesh(geometry(object.type), material);
    mesh.name = object.name;
    mesh.userData.id = object.id;
    mesh.position.fromArray(object.position);
    mesh.rotation.set(...object.rotation);
    mesh.scale.set(
      ...(object.dimensions.map((v, i) => v * object.scale[i]) as [number, number, number]),
    );
    mesh.visible = object.visible;
    mesh.castShadow = object.type !== 'plane';
    mesh.receiveShadow = true;
    world.add(mesh);
  }
  const ambient = state.lighting.ambient;
  const directional = state.lighting.directional;
  world.add(new THREE.AmbientLight(ambient.color, ambient.intensity));
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
        material.dispose();
    }
    if (item instanceof THREE.DirectionalLight) item.shadow.dispose();
  });
}
