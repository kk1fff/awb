import { describe, expect, it } from 'vitest';
import { SceneEngine } from '../src/engine/scene.js';
import { emptyScene, sceneSchema, toolSchemas, type SceneObject } from '../src/shared/schema.js';
import { buildWorld, disposeWorld, geometry } from '../src/client/world.js';
import { buildBuiltinModel } from '../src/client/assets.js';
import { builtinAssets, builtinAssetMap } from '../src/shared/assets.js';
import { Box3, Mesh, Vector3 } from 'three';

describe('scene command invariants', () => {
  it('creates defaults, patches only supplied fields, and keeps IDs stable', () => {
    const engine = new SceneEngine();
    const object = engine.execute(
      'create_object',
      toolSchemas.create_object.parse({
        name: 'Trunk',
        type: 'cylinder',
        position: [2, 1, 0],
        color: '#795548',
      }),
    ) as SceneObject;
    expect(object.scale).toEqual([1, 1, 1]);
    expect(object.roughness).toBe(0.86);
    expect(object.metalness).toBe(0);
    expect(engine.snapshot().revision).toBe(1);
    engine.execute(
      'update_object',
      toolSchemas.update_object.parse({ id: object.id, name: 'Tree' }),
    );
    expect(engine.snapshot().objects[0]).toEqual({ ...object, name: 'Tree' });
    const copy = engine.snapshot();
    copy.objects[0].position[0] = 100;
    expect(engine.snapshot().objects[0].position).toEqual([2, 1, 0]);
    engine.execute('inspect_object', { id: object.id });
    engine.execute('list_objects', {});
    expect(engine.snapshot().revision).toBe(2);
    engine.execute('delete_object', { id: object.id });
    expect(engine.snapshot().objects).toHaveLength(0);
  });
  it('rejects invalid final camera state without mutating', () => {
    const engine = new SceneEngine();
    const before = engine.snapshot();
    expect(() => engine.execute('set_camera', { position: before.camera.target })).toThrow();
    expect(engine.snapshot()).toEqual(before);
  });
  it('defaults legacy camera state to orthographic and validates perspective FOV updates', () => {
    const engine = new SceneEngine();
    const legacy = emptyScene();
    delete (legacy.camera as Partial<typeof legacy.camera>).projection;
    delete (legacy.camera as Partial<typeof legacy.camera>).fov;
    const legacyCamera = structuredClone(legacy.camera);
    engine.load(legacy);
    expect(engine.snapshot().camera).toEqual({ ...legacyCamera, projection: 'orthographic', fov: 38 });

    const before = engine.snapshot().camera;
    engine.execute('set_camera', { projection: 'perspective' });
    engine.execute('set_camera', { fov: 40 });
    expect(engine.snapshot().camera).toEqual({ ...before, projection: 'perspective', fov: 40 });
    expect(() => engine.execute('set_camera', { fov: 101 })).toThrow();
    expect(() => engine.execute('set_camera', { fov: 9 })).toThrow();
    expect(engine.snapshot().camera.fov).toBe(40);
  });
  it('loads scene content without rewinding revisions or aliasing input', () => {
    const engine = new SceneEngine();
    const saved = emptyScene();
    saved.revision = 99;
    engine.load(saved);
    expect(engine.snapshot().revision).toBe(1);
    saved.camera.position[0] = 500;
    expect(engine.snapshot().camera.position[0]).toBe(12);
    expect(() => engine.load({ ...saved, schemaVersion: 3 })).toThrow('schemaVersion');
  });
  it('migrates saved version 1 primitive scenes without changing IDs or appearance', () => {
    const engine = new SceneEngine();
    const object = engine.execute('create_object', { name: 'Old tree', type: 'cone' }) as SceneObject;
    const version1 = JSON.parse(JSON.stringify({
      ...engine.snapshot(),
      schemaVersion: 1,
      objects: [{ ...object, roughness: undefined, metalness: undefined }],
    }));
    engine.load(version1);
    expect(engine.snapshot().schemaVersion).toBe(2);
    expect(engine.snapshot().objects[0]).toMatchObject({ id: object.id, type: 'cone', roughness: 0.86, metalness: 0 });
  });
  it('rejects unknown fields, invalid dimensions, nonfinite transforms and malformed colors', () => {
    for (const patch of [
      { dimensions: [0, 1, 1] },
      { scale: [-1, 1, 1] },
      { position: [Infinity, 0, 0] },
      { color: 'green' },
      { extra: true },
    ])
      expect(
        toolSchemas.create_object.safeParse({ name: 'Bad', type: 'box', ...patch }).success,
      ).toBe(false);
    expect(
      toolSchemas.update_object.safeParse({ id: crypto.randomUUID(), type: 'sphere' }).success,
    ).toBe(false);
  });
  it('rejects duplicate object IDs in saved scenes', () => {
    const engine = new SceneEngine();
    const object = engine.execute('create_object', { name: 'A', type: 'box' }) as SceneObject;
    expect(sceneSchema.safeParse({ ...engine.snapshot(), objects: [object, object] }).success).toBe(
      false,
    );
  });
});

describe('geometry and renderer mapping', () => {
  for (const type of ['box', 'sphere', 'cylinder', 'cone', 'plane'] as const) {
    it(`maps ${type} to unit geometry`, () => {
      const g = geometry(type);
      g.computeBoundingBox();
      const box = g.boundingBox!;
      expect(box.max.x - box.min.x).toBeCloseTo(1);
      expect(box.max.y - box.min.y).toBeCloseTo(1);
      expect(box.max.z - box.min.z).toBeCloseTo(type === 'plane' ? 0 : 1);
      g.dispose();
    });
  }
  it('maps dimensions, scale, visibility, material and radians into Three.js', async () => {
    const engine = new SceneEngine();
    engine.execute('create_object', {
      name: 'Test',
      type: 'box',
      dimensions: [2, 3, 4],
      scale: [2, 1, 0.5],
      rotation: [Math.PI / 2, 0, 0],
      visible: false,
      color: '#ff0000',
    });
    const world = await buildWorld(engine.snapshot());
    const mesh = world.children.find((o) => o instanceof Mesh) as Mesh;
    expect(mesh.scale.toArray()).toEqual([4, 3, 2]);
    expect(mesh.rotation.x).toBeCloseTo(Math.PI / 2);
    expect(mesh.visible).toBe(false);
    disposeWorld(world);
  });

  it('keeps locally authored builtin models within their stable catalog bounds', () => {
    for (const asset of builtinAssets.filter((item) => item.kind === 'model')) {
      const model = buildBuiltinModel(asset.id);
      const record = builtinAssetMap.get(asset.id)!;
      const bounds = record.bounds!;
      model.updateMatrixWorld(true);
      const actual = new Box3().setFromObject(model).getSize(new Vector3());
      expect(actual.x, `${asset.id} width`).toBeLessThanOrEqual(bounds[0] + 0.01);
      expect(actual.y, `${asset.id} height`).toBeLessThanOrEqual(bounds[1] + 0.01);
      expect(actual.z, `${asset.id} depth`).toBeLessThanOrEqual(bounds[2] + 0.01);
      const vertexCount = model.children.reduce((count, child) => {
        return count + ((child as Mesh).geometry?.attributes.position?.count ?? 0);
      }, 0);
      if (asset.id === 'builtin:pnw-craftsman-shell') {
        expect(model.children.length).toBeLessThan(10);
        expect(vertexCount).toBeGreaterThan(2000);
      }
      if (asset.id === 'builtin:pnw-gable-roof') {
        expect(model.children.length).toBeLessThan(10);
        expect(vertexCount).toBeGreaterThan(3000);
      }
      if (asset.id === 'builtin:pnw-evergreen') {
        expect(model.children.length).toBeLessThan(20);
        expect(vertexCount).toBeGreaterThan(5000);
      }
    }
  });
});
