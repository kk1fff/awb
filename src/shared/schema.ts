import { z } from 'zod';

export const vector = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const positiveVector = z.tuple([
  z.number().positive(),
  z.number().positive(),
  z.number().positive(),
]);
export const color = z
  .string()
  .regex(/^#[\da-fA-F]{6}$/, 'Use a six-digit hex color, e.g. #795548');
export const primitive = z.enum(['box', 'sphere', 'cylinder', 'cone', 'plane']);
export const objectType = primitive.or(z.literal('asset'));
export const assetId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{1,119}$/);
export const assetKind = z.enum(['model', 'material', 'environment']);
export const assetSearchSchema = z.object({
  query: z.string().trim().max(200).default(''),
  kind: assetKind.optional(),
  limit: z.number().int().positive().max(50).default(20),
}).strict();
export const assetRecordSchema = z.object({
  id: assetId,
  name: z.string().min(1),
  description: z.string(),
  kind: assetKind,
  tags: z.array(z.string()),
  source: z.enum(['builtin', 'local']),
  format: z.string().optional(),
  file: z.string().optional(),
  baseColor: color.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  bounds: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
}).strict();
const properties = z
  .object({
    name: z.string().trim().min(1).max(120),
    position: vector,
    rotation: vector,
    dimensions: positiveVector,
    scale: positiveVector,
    color,
    roughness: z.number().min(0).max(1).optional(),
    metalness: z.number().min(0).max(1).optional(),
    materialId: assetId.optional(),
    visible: z.boolean(),
  })
  .strict();
export const objectSchema = properties.extend({
  id: z.uuid(),
  type: objectType,
  assetId: assetId.optional(),
  assetBounds: positiveVector.optional(),
}).strict().superRefine((object, ctx) => {
  if (object.type === 'asset' && !object.assetId)
    ctx.addIssue({ code: 'custom', message: 'Asset objects require assetId', path: ['assetId'] });
  if (object.type === 'asset' && !object.assetBounds)
    ctx.addIssue({ code: 'custom', message: 'Asset objects require asset bounds', path: ['assetBounds'] });
  if (object.type !== 'asset' && (object.assetId || object.assetBounds))
    ctx.addIssue({ code: 'custom', message: 'Only asset objects may specify asset metadata', path: ['assetId'] });
});
export const cameraSchema = z
  .object({
    position: vector,
    target: vector,
    verticalSize: z.number().positive().max(10000),
  })
  .strict()
  .refine((c) => c.position.some((v, i) => v !== c.target[i]), {
    message: 'Camera position must differ from its target',
    path: ['position'],
  });
const ambient = z.object({ color, intensity: z.number().min(0).max(10) }).strict();
const directional = ambient.extend({ position: vector });
export const lightingSchema = z.object({ ambient, directional, environmentAssetId: assetId.optional() }).strict();
export const sceneSchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    objects: z.array(objectSchema),
    camera: cameraSchema,
    lighting: lightingSchema,
  })
  .strict()
  .refine((s) => new Set(s.objects.map((o) => o.id)).size === s.objects.length, {
    message: 'Object IDs must be unique',
    path: ['objects'],
  });
const saveName = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/, 'Use 1–80 letters, digits, hyphens or underscores');
export const toolSchemas = {
  create_object: properties
    .partial()
    .extend({ name: properties.shape.name, type: objectType, assetId: assetId.optional() })
    .strict()
    .superRefine((object, ctx) => {
      if (object.type === 'asset' && !object.assetId)
        ctx.addIssue({ code: 'custom', message: 'Asset objects require assetId', path: ['assetId'] });
      if (object.type !== 'asset' && object.assetId)
        ctx.addIssue({ code: 'custom', message: 'Only asset objects may specify assetId', path: ['assetId'] });
    }),
  update_object: properties.partial().extend({ id: z.uuid() }).strict(),
  delete_object: z.object({ id: z.uuid() }).strict(),
  list_objects: z.object({}).strict(),
  inspect_object: z.object({ id: z.uuid() }).strict(),
  search_assets: assetSearchSchema,
  set_camera: z
    .object({
      position: vector.optional(),
      target: vector.optional(),
      verticalSize: z.number().positive().max(10000).optional(),
    })
    .strict(),
  set_lighting: z
    .object({
      ambient: ambient.partial().optional(),
      directional: directional.partial().optional(),
      environmentAssetId: assetId.nullable().optional(),
    })
    .strict(),
  render_scene: z.object({ label: z.string().trim().min(1).max(120).optional() }).strict(),
  export_scene: z.object({}).strict(),
  save_scene: z.object({ name: saveName }).strict(),
  load_scene: z.object({ name: saveName }).strict(),
  record_review: z
    .object({
      kind: z.enum(['evaluation', 'approval', 'change_request', 'tool_issue']),
      author: z.enum(['agent', 'human']),
      text: z.string().trim().min(1).max(12000),
      checkpointId: z.uuid().optional(),
      executionIds: z.array(z.uuid()).default([]),
      suggestion: z.string().trim().min(1).max(4000).optional(),
      impact: z.string().trim().min(1).max(4000).optional(),
    })
    .strict()
    .superRefine((r, ctx) => {
      if (r.kind !== 'tool_issue' && !r.checkpointId)
        ctx.addIssue({
          code: 'custom',
          message: 'A checkpointId is required for scene reviews',
          path: ['checkpointId'],
        });
      if (r.kind === 'tool_issue' && (!r.executionIds.length || !r.suggestion || !r.impact))
        ctx.addIssue({
          code: 'custom',
          message: 'Tool issues require executionIds, suggestion and impact',
        });
    }),
};
export type ToolName = keyof typeof toolSchemas;
export type SceneObject = z.infer<typeof objectSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type AssetRecord = z.infer<typeof assetRecordSchema>;
export type CameraState = Scene['camera'];
export type ReviewInput = z.infer<typeof toolSchemas.record_review>;
export interface ToolResponse {
  success: boolean;
  executionId: string;
  sceneRevision: number;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}
export interface ToolEvent extends ToolResponse {
  timestamp: string;
  tool: string;
  arguments: unknown;
  runId: string;
}
export interface Review extends ReviewInput {
  executionId: string;
  timestamp: string;
  sceneRevision: number;
}
export interface Checkpoint {
  id: string;
  label: string;
  executionId: string;
  sceneRevision: number;
  timestamp: string;
  status: 'rendering' | 'complete' | 'failed';
  screenshotUrl?: string;
  screenshotPath?: string;
  sceneUrl: string;
  error?: string;
}
export interface SceneExport {
  format: 'glb';
  fileName: string;
  artifactUrl: string;
  sceneRevision: number;
  objectCount: number;
  bytes: number;
}
export function emptyScene(): Scene {
  return {
    schemaVersion: 2,
    revision: 0,
    objects: [],
    camera: { position: [12, 12, 12], target: [0, 0, 0], verticalSize: 15 },
    lighting: {
      ambient: { color: '#ffffff', intensity: 1.5 },
      directional: { color: '#fff4dc', intensity: 3, position: [8, 14, 5] },
    },
  };
}

export function migrateScene(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value)) return value;
  const scene = value as Record<string, unknown>;
  if (scene.schemaVersion !== 1) return value;
  const lighting = scene.lighting as Record<string, unknown>;
  return {
    ...scene,
    schemaVersion: 2,
    objects: (scene.objects as Record<string, unknown>[]).map((object) => ({
      ...(object.type === 'asset' ? {} : { roughness: 0.86, metalness: 0 }),
      ...object,
    })),
    lighting: { ...lighting },
  };
}
