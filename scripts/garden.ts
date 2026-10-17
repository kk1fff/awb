/** A reproducible construction helper. Visual evaluation/corrections are intentionally left to the external agent. */
import type { Checkpoint, SceneObject, ToolResponse } from '../src/shared/schema.js';

const api = process.env.SCENE_API ?? 'http://127.0.0.1:3001';
async function tool<T>(name: string, args: unknown = {}): Promise<T> {
  const response = await fetch(`${api}/api/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: name, arguments: args }),
    signal: AbortSignal.timeout(45000),
  });
  const result = (await response.json()) as ToolResponse;
  if (!result.success) throw new Error(JSON.stringify(result));
  return result.result as T;
}
const existing = await tool<SceneObject[]>('list_objects');
if (existing.length)
  throw new Error(
    'Garden demo requires a fresh scene. Start a new server run; existing work was not changed.',
  );
async function object(
  name: string,
  type: SceneObject['type'],
  position: number[],
  dimensions: number[],
  color: string,
  rotation = [0, 0, 0],
) {
  return tool<SceneObject>('create_object', { name, type, position, dimensions, color, rotation });
}
await object('Garden foundation', 'box', [0, -0.23, 0], [12, 0.4, 10], '#a9b68b');
await object('Moss lawn', 'plane', [0, -0.02, 0], [11.8, 9.8, 1], '#a5b684', [-Math.PI / 2, 0, 0]);
await object('Pond stone basin', 'cylinder', [-2.1, 0.02, 0.2], [4.3, 0.18, 3.25], '#84917b');
await object('Pond water', 'cylinder', [-2.1, 0.13, 0.2], [3.85, 0.08, 2.85], '#568f93');
for (const [i, x, z, size] of [
  [1, -3.9, 0.6, 0.65],
  [2, -3.3, 1.5, 0.75],
  [3, -2.4, 1.75, 0.6],
  [4, -0.55, 0.8, 0.7],
  [5, -0.4, -0.8, 0.55],
  [6, -2.5, -1.35, 0.7],
  [7, -3.6, -0.9, 0.65],
])
  await object(`Pond rock ${i}`, 'sphere', [x, 0.15, z], [size, 0.42, size * 0.8], '#9ba18d');
for (let i = 0; i < 9; i++) {
  const z = 4.2 - i * 0.92;
  const x = 1 + Math.sin(i * 0.55) * 0.65;
  await object(
    `Path stone ${i + 1}`,
    'cylinder',
    [x, 0.08, z],
    [0.85, 0.16, 0.65],
    i % 2 ? '#c1c1aa' : '#b4b7a1',
    [0, i * 0.3, 0],
  );
}
for (const [i, x, z, height] of [
  [1, -3.7, -2.9, 3.7],
  [2, 0.3, -3.3, 4.2],
  [3, 4.1, -2.4, 3.35],
]) {
  await object(`Tree ${i} trunk`, 'cylinder', [x, 0.85, z], [0.25, 1.7, 0.25], '#776046');
  await object(`Tree ${i} lower crown`, 'cone', [x, 1.9, z], [2.3, 2.7, 2.3], '#496e46');
  await object(
    `Tree ${i} upper crown`,
    'cone',
    [x, height - 0.85, z],
    [1.65, 1.95, 1.65],
    '#60824e',
  );
}
// Bench faces the pond; use named pieces so an agent can inspect and revise the assembly.
for (const [i, x, z] of [
  [1, 3.1, 0.25],
  [2, 4.7, 0.25],
  [3, 3.1, 1.05],
  [4, 4.7, 1.05],
])
  await object(`Bench leg ${i}`, 'box', [x, 0.35, z], [0.17, 0.7, 0.17], '#6c533b');
for (let i = 0; i < 3; i++)
  await object(
    `Bench seat plank ${i + 1}`,
    'box',
    [3.9, 0.77, 0.3 + i * 0.3],
    [2.15, 0.16, 0.24],
    '#a67b4d',
  );
for (const [i, x] of [
  [1, 3.05],
  [2, 4.75],
])
  await object(`Bench back post ${i}`, 'box', [x, 1.15, 1.12], [0.14, 1.1, 0.14], '#74583c');
for (let i = 0; i < 2; i++)
  await object(
    `Bench back slat ${i + 1}`,
    'box',
    [3.9, 1.25 + i * 0.3, 1.12],
    [2.15, 0.2, 0.12],
    '#ab8052',
  );
await object('Stone lantern base', 'cylinder', [-4.4, 0.18, 3.2], [0.75, 0.3, 0.75], '#9a9d88');
await object('Stone lantern pillar', 'box', [-4.4, 0.63, 3.2], [0.3, 0.75, 0.3], '#b6b8a4');
await object('Stone lantern chamber', 'box', [-4.4, 1.15, 3.2], [0.62, 0.42, 0.62], '#c4bea2');
await object('Stone lantern roof', 'cone', [-4.4, 1.52, 3.2], [1, 0.36, 1], '#8f9580');
for (const [i, x, z] of [
  [1, -4.6, -1.9],
  [2, 4.6, 3.6],
  [3, 3.8, 3.8],
  [4, -1.8, -3.7],
])
  await object(`Low shrub ${i}`, 'sphere', [x, 0.3, z], [0.95, 0.65, 0.85], '#7c965d');
await tool('set_camera', { position: [13, 12, 14], target: [0, 0.6, 0], verticalSize: 13 });
await tool('set_lighting', {
  ambient: { intensity: 1.7 },
  directional: { position: [-3, 12, 7], intensity: 3 },
});
const checkpoint = await tool<Checkpoint>('render_scene', { label: 'Garden — first observation' });
console.log(
  JSON.stringify(
    {
      task: 'Create a small Japanese garden with a pond, stone path, three trees, and a wooden bench, viewed isometrically.',
      checkpoint,
      next: 'Open the PNG, evaluate the actual image, record_review, then correct through public tools if needed.',
    },
    null,
    2,
  ),
);
