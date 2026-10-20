import { describe, expect, it } from 'vitest';
import { SceneEngine } from '../src/engine/scene.js';
import { emptyScene, sceneSchema, toolSchemas, type SceneObject } from '../src/shared/schema.js';
import { buildWorld, disposeWorld, geometry } from '../src/client/world.js';
import { buildBuiltinModel } from '../src/client/assets.js';
import { builtinAssets, builtinAssetMap } from '../src/shared/assets.js';
import {
  Box3,
  Color,
  DirectionalLight,
  LatheGeometry,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';

describe('scene command invariants', () => {
  it('validates editable lathe profiles and limits the scene to one mirror', () => {
    const engine = new SceneEngine();
    const profile: [number, number][] = [
      [0, -0.5],
      [0.5, -0.49],
      [0.5, 0.2],
      [0.25, 0.49],
      [0, 0.5],
    ];
    expect(() => toolSchemas.create_object.parse({ name: 'Missing', type: 'lathe' })).toThrow();
    expect(() =>
      toolSchemas.create_object.parse({
        name: 'Bad',
        type: 'lathe',
        profile: [
          [0, 0],
          [0, 0],
          [0.5, 0.5],
        ],
      }),
    ).toThrow();
    const bottle = engine.execute(
      'create_object',
      toolSchemas.create_object.parse({ name: 'Bottle', type: 'lathe', profile }),
    ) as SceneObject;
    expect(bottle.profile).toEqual(profile);
    const nextProfile: [number, number][] = [
      [0, -0.5],
      [0.4, -0.49],
      [0.48, 0.25],
      [0.2, 0.49],
      [0, 0.5],
    ];
    engine.execute(
      'update_object',
      toolSchemas.update_object.parse({ id: bottle.id, profile: nextProfile }),
    );
    expect(engine.snapshot().objects[0].profile).toEqual(nextProfile);
    expect(() => engine.execute('update_object', { id: bottle.id, profile: [[0, 0]] })).toThrow();
    expect(engine.snapshot().revision).toBe(2);
    const mirror = engine.execute(
      'create_object',
      toolSchemas.create_object.parse({ name: 'Table', type: 'mirror' }),
    ) as SceneObject;
    expect(mirror.color).toBe('#242a30');
    expect(mirror.reflectionStrength).toBe(0.78);
    expect(mirror.roughness).toBeUndefined();
    expect(() => engine.execute('create_object', { name: 'Second table', type: 'mirror' })).toThrow(
      'Only one live mirror',
    );
    expect(() => engine.execute('update_object', { id: mirror.id, metalness: 1 })).toThrow();
    expect(engine.snapshot().revision).toBe(3);
  });
  it('keeps legacy preset behavior while applying explicit material overrides', async () => {
    const engine = new SceneEngine();
    engine.execute('create_object', {
      name: 'Preset',
      type: 'cylinder',
      materialId: 'builtin:steel-brushed',
    });
    const overrideObject = engine.execute('create_object', {
      name: 'Override',
      type: 'cylinder',
      materialId: 'builtin:steel-brushed',
      roughness: 0.08,
      materialOverrides: { metalness: 0.9, anisotropy: 0.35 },
    }) as SceneObject;
    expect(overrideObject.materialOverrides).toEqual({
      roughness: 0.08,
      metalness: 0.9,
      anisotropy: 0.35,
    });
    engine.execute('update_object', { id: overrideObject.id, color: '#aaaaaa' });
    const world = await buildWorld(engine.snapshot());
    const meshes = world.children.filter((item) => item instanceof Mesh) as Mesh[];
    const preset = meshes[0].material as MeshStandardMaterial;
    const override = meshes[1].material as MeshStandardMaterial;
    expect(preset.roughness).toBe(0.24);
    expect(preset.metalness).toBe(1);
    expect(preset.normalMap?.image).toMatchObject({ width: 256, height: 128 });
    expect(override.roughness).toBe(0.08);
    expect(override.metalness).toBe(0.9);
    expect((override as typeof override & { anisotropy: number }).anisotropy).toBe(0.35);
    expect(override.color.getHexString()).toBe('aaaaaa');
    disposeWorld(world);
  });
  it('builds smooth lathe geometry and a disposable live mirror with an export fallback', async () => {
    const engine = new SceneEngine();
    engine.execute('create_object', {
      name: 'Body',
      type: 'lathe',
      profile: [
        [0, -0.5],
        [0.5, -0.49],
        [0.5, 0.2],
        [0.2, 0.49],
        [0, 0.5],
      ],
    });
    engine.execute('create_object', { name: 'Table', type: 'mirror' });
    const world = await buildWorld(engine.snapshot());
    expect((world.children[0] as Mesh).geometry).toBeInstanceOf(LatheGeometry);
    expect(((world.children[0] as Mesh).geometry as LatheGeometry).parameters.segments).toBe(96);
    expect((world.children[0] as Mesh).geometry.getAttribute('tangent')).toBeDefined();
    expect(world.children[1]).toBeInstanceOf(Reflector);
    expect(
      ((world.children[1] as Reflector).material as import('three').ShaderMaterial).uniforms
        .reflectionStrength.value,
    ).toBe(0.78);
    disposeWorld(world);
    const exportWorld = await buildWorld(engine.snapshot(), undefined, { forExport: true });
    expect(exportWorld.children[1]).not.toBeInstanceOf(Reflector);
    const material = (exportWorld.children[1] as Mesh).material as MeshStandardMaterial;
    expect(material.metalness).toBe(1);
    expect(material.roughness).toBeLessThan(0.1);
    disposeWorld(exportWorld);
  });
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
    expect(engine.snapshot().camera).toEqual({
      ...legacyCamera,
      projection: 'orthographic',
      fov: 38,
    });

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
    const object = engine.execute('create_object', {
      name: 'Old tree',
      type: 'cone',
    }) as SceneObject;
    const version1 = JSON.parse(
      JSON.stringify({
        ...engine.snapshot(),
        schemaVersion: 1,
        objects: [{ ...object, roughness: undefined, metalness: undefined }],
      }),
    );
    engine.load(version1);
    expect(engine.snapshot().schemaVersion).toBe(2);
    expect(engine.snapshot().objects[0]).toMatchObject({
      id: object.id,
      type: 'cone',
      roughness: 0.86,
      metalness: 0,
    });
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

  it('defaults legacy lighting to its existing solid background and hard PCF shadow', async () => {
    const legacy = emptyScene();
    const { backgroundMode: _mode, backgroundColor: _color, ...oldLighting } = legacy.lighting;
    const { shadowSoftness: _softness, ...oldDirectional } = oldLighting.directional;
    const engine = new SceneEngine();
    engine.load({
      ...legacy,
      lighting: { ...oldLighting, directional: oldDirectional },
    });
    const parsed = engine.snapshot();
    expect(parsed.lighting.backgroundMode).toBe('solid');
    expect(parsed.lighting.directional.shadowSoftness).toBe(0);
    expect(parsed.lighting.environmentIntensity).toBe(0.55);
    const world = await buildWorld(parsed);
    const sun = world.children.find((o) => o instanceof DirectionalLight) as DirectionalLight;
    expect((world.background as Color).getHexString()).toBe('e9ede5');
    expect(sun.shadow.radius).toBe(1);
    expect(sun.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    expect(sun.shadow.bias).toBe(-0.0005);
    disposeWorld(world);
  });

  it('uses selected environment independently for the visible background and maps softness to PCF radius', async () => {
    const solidWithEnvironment = sceneSchema.parse({
      ...emptyScene(),
      lighting: { ...emptyScene().lighting, environmentAssetId: 'builtin:pnw-overcast' },
    });
    const solidWorld = await buildWorld(solidWithEnvironment);
    expect((solidWorld.background as Color).getHexString()).toBe('b9c6c5');
    disposeWorld(solidWorld);

    const scene = sceneSchema.parse({
      ...emptyScene(),
      lighting: {
        ...emptyScene().lighting,
        environmentAssetId: 'builtin:pnw-overcast',
        backgroundMode: 'environment',
        directional: { ...emptyScene().lighting.directional, shadowSoftness: 2.5 },
      },
    });
    const world = await buildWorld(scene);
    const sun = world.children.find((o) => o instanceof DirectionalLight) as DirectionalLight;
    expect(world.background).toBe(world.environment);
    expect(world.environmentIntensity).toBe(0.55);
    expect(sun.shadow.radius).toBe(6);
    expect(sun.shadow.mapSize.toArray()).toEqual([2048, 2048]);
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
