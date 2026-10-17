import { randomUUID } from 'node:crypto';
import {
  cameraSchema,
  emptyScene,
  lightingSchema,
  migrateScene,
  sceneSchema,
  type Scene,
  type SceneObject,
} from '../shared/schema.js';

export class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class SceneEngine {
  private state: Scene = emptyScene();
  snapshot(): Scene {
    return structuredClone(this.state);
  }
  restore(scene: Scene): void {
    this.state = structuredClone(scene);
  }
  load(value: unknown): Scene {
    if (
      typeof value === 'object' &&
      value !== null &&
      'schemaVersion' in value &&
      value.schemaVersion !== 1 &&
      value.schemaVersion !== 2
    )
      throw new ToolError('UNSUPPORTED_VERSION', 'Only scene schemaVersion 1 or 2 is supported');
    const next = sceneSchema.parse(migrateScene(value));
    this.state = { ...structuredClone(next), revision: this.state.revision + 1 };
    return this.snapshot();
  }
  execute(tool: string, args: Record<string, unknown>): unknown {
    const find = () => {
      const object = this.state.objects.find((o) => o.id === args.id);
      if (!object)
        throw new ToolError(
          'OBJECT_NOT_FOUND',
          `No object with ID ${String(args.id)}. Use list_objects to find valid IDs.`,
        );
      return object;
    };
    let result: unknown;
    switch (tool) {
      case 'list_objects':
        return structuredClone(this.state.objects);
      case 'inspect_object':
        return structuredClone(find());
      case 'create_object': {
        const object = {
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          dimensions: [1, 1, 1],
          scale: [1, 1, 1],
          color: args.type === 'asset' ? '#ffffff' : '#7a9d82',
          visible: true,
          ...(args.type === 'asset' ? {} : { roughness: 0.86, metalness: 0 }),
          ...args,
          id: randomUUID(),
        } as SceneObject;
        this.state.objects.push(object);
        result = object;
        break;
      }
      case 'update_object': {
        const object = find();
        const { id: _id, ...patch } = args;
        Object.assign(object, patch);
        result = object;
        break;
      }
      case 'delete_object': {
        const object = find();
        this.state.objects = this.state.objects.filter((o) => o.id !== object.id);
        result = { id: object.id };
        break;
      }
      case 'set_camera': {
        const camera = cameraSchema.parse({ ...this.state.camera, ...args });
        this.state.camera = camera;
        result = camera;
        break;
      }
      case 'set_lighting': {
        const lightingDraft: Record<string, unknown> = {
          ambient: { ...this.state.lighting.ambient, ...(args.ambient as object) },
          directional: { ...this.state.lighting.directional, ...(args.directional as object) },
          backgroundMode: args.backgroundMode ?? this.state.lighting.backgroundMode,
          ...(this.state.lighting.backgroundColor ? { backgroundColor: this.state.lighting.backgroundColor } : {}),
          ...(this.state.lighting.environmentAssetId ? { environmentAssetId: this.state.lighting.environmentAssetId } : {}),
        };
        if (args.backgroundColor !== undefined) {
          if (args.backgroundColor === null) delete lightingDraft.backgroundColor;
          else lightingDraft.backgroundColor = args.backgroundColor;
        }
        if (args.environmentAssetId !== undefined) {
          if (args.environmentAssetId === null) delete lightingDraft.environmentAssetId;
          else lightingDraft.environmentAssetId = args.environmentAssetId;
        }
        const lighting = lightingSchema.parse(lightingDraft);
        this.state.lighting = lighting;
        result = lighting;
        break;
      }
      default:
        throw new ToolError('UNKNOWN_TOOL', `Unknown scene operation: ${tool}`);
    }
    this.state.revision++;
    return structuredClone(result);
  }
}
