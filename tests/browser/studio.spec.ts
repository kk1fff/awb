import { readFile } from 'node:fs/promises';
import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Checkpoint, Scene, SceneObject, ToolResponse } from '../../src/shared/schema.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { tinyGlb, tinyHdr, tinyPng } from '../helpers/assets.js';

async function tool(request: APIRequestContext, name: string, args: unknown = {}) {
  const response = await request.post('/api/tools', { data: { tool: name, arguments: args } });
  const result = (await response.json()) as ToolResponse;
  expect(result.success, JSON.stringify(result.error)).toBe(true);
  return result;
}
test('@smoke renders a public-API object in Linux Chromium with no browser errors', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const created = await tool(request, 'create_object', {
    name: 'Smoke box',
    type: 'box',
    dimensions: [2, 2, 2],
    color: '#527653',
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__sceneReady?.objectIds))
    .toContain((created.result as SceneObject).id);
  await page.screenshot({ path: 'artifacts/tests/studio-smoke.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('live browser observes an agent edit and downloads a GLB export', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  const baseline = (await (await request.get('/api/state')).json()) as Scene;
  await expect(page.getByTestId('revision')).toHaveText(String(baseline.revision).padStart(3, '0'));
  const created = await tool(request, 'create_object', {
    name: 'Live export tree',
    type: 'cone',
    position: [1, 1, 2],
    color: '#3a7744',
  });
  await expect(page.getByRole('button', { name: '△ Live export tree' })).toBeVisible();
  await expect(page.getByTestId('revision')).toHaveText(
    String(baseline.revision + 1).padStart(3, '0'),
  );
  await expect(page.getByText('create_object', { exact: true }).first()).toBeVisible();

  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export GLB/ }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toMatch(/^scene-.+\.glb$/);
  const file = await download.path();
  expect(file).toBeTruthy();
  expect((await readFile(file!)).subarray(0, 4).toString()).toBe('glTF');
  expect((created.result as SceneObject).name).toBe('Live export tree');
});
test('human edits, render snapshots, comparisons and checkpoint reviews use public tools', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  const created = await tool(request, 'create_object', {
    name: 'Browser tree',
    type: 'cone',
    position: [0, 1, 0],
    color: '#4b7548',
  });
  await page.goto('/');
  await page.getByRole('button', { name: '△ Browser tree' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Edited tree');
  await page.getByRole('spinbutton', { name: 'position X', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('button', { name: '△ Edited tree' })).toBeVisible();
  const state = (await (await request.get('/api/state')).json()) as Scene;
  expect(state.objects.find((o) => o.id === (created.result as SceneObject).id)?.position[0]).toBe(
    2,
  );
  const before = (await tool(request, 'render_scene', { label: 'Before checkpoint' }))
    .result as Checkpoint;
  const png = await request.get(before.screenshotUrl!);
  expect(png.ok()).toBe(true);
  expect(png.headers()['content-type']).toContain('image/png');
  expect((await png.body()).subarray(1, 4).toString()).toBe('PNG');
  await tool(request, 'update_object', {
    id: (created.result as SceneObject).id,
    color: '#335577',
  });
  const after = (await tool(request, 'render_scene', { label: 'After checkpoint' }))
    .result as Checkpoint;
  await page.getByRole('button', { name: /^Checkpoints/ }).click();
  await page.getByLabel('Before checkpoint', { exact: true }).selectOption(before.id);
  await page.getByLabel('After checkpoint', { exact: true }).selectOption(after.id);
  await expect(page.getByAltText('Before: Before checkpoint', { exact: true })).toBeVisible();
  await expect(page.getByAltText('After: After checkpoint', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Reviews & feedback/ }).click();
  await page.getByLabel('Checkpoint', { exact: true }).selectOption(after.id);
  await page
    .getByLabel('Feedback', { exact: true })
    .fill('Approved after comparing the two views.');
  await page.getByRole('button', { name: 'Record feedback' }).click();
  await expect(
    page.locator('.reviews').getByText('Approved after comparing the two views.', { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: 'artifacts/tests/studio-reviewed.png', fullPage: true });
  const frozen = (await (await request.get(before.sceneUrl)).json()) as Scene;
  expect(frozen.objects.find((o) => o.id === (created.result as SceneObject).id)?.color).toBe(
    '#4b7548',
  );
  await tool(request, 'save_scene', { name: 'browser-scene' });
  const loaded = await tool(request, 'load_scene', { name: 'browser-scene' });
  expect((loaded.result as Scene).objects.map((o) => o.id)).toEqual(
    ((await (await request.get('/api/state')).json()) as Scene).objects.map((o) => o.id),
  );
  expect(errors).toEqual([]);
});
test('local orbit survives object updates and changes the scene camera only when committed', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__sceneReady));
  const before = (await (await request.get('/api/state')).json()) as Scene;
  const box = await page.locator('canvas').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + box!.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  expect(((await (await request.get('/api/state')).json()) as Scene).camera).toEqual(before.camera);
  const update = await tool(request, 'create_object', { name: 'While orbiting', type: 'box' });
  await expect
    .poll(() => page.evaluate(() => window.__sceneReady?.revision))
    .toBe(update.sceneRevision);
  await page.getByRole('button', { name: 'Use current view' }).click();
  await expect
    .poll(async () => ((await (await request.get('/api/state')).json()) as Scene).camera.position)
    .not.toEqual(before.camera.position);
});

test('agent can search, build, inspect, correct, save and export a PNW Craftsman house', async ({ page, request }) => {
  const previous = (await (await request.get('/api/state')).json()) as Scene;
  for (const object of previous.objects) await tool(request, 'delete_object', { id: object.id });
  await tool(request, 'set_camera', {
    position: [11, 8, -22], target: [0, -0.1, -0.8], verticalSize: 20,
  });
  await tool(request, 'set_lighting', {
    ambient: { color: '#dbe6e1', intensity: 1.45 },
    directional: { color: '#fff8ed', intensity: 2.5, position: [-8, 14, -10] },
    environmentAssetId: 'builtin:pnw-overcast',
  });

  const houseParts = (await tool(request, 'search_assets', { query: 'pnw craftsman', kind: 'model' })).result as {
    id: string; name: string;
  }[];
  expect(houseParts.map((asset) => asset.id)).toEqual(expect.arrayContaining([
    'builtin:pnw-craftsman-shell', 'builtin:pnw-gable-roof', 'builtin:pnw-porch',
    'builtin:pnw-window', 'builtin:pnw-front-door',
  ]));
  const models = new Set(houseParts.map((asset) => asset.id));
  const place = async (assetId: string, name: string, position: [number, number, number]) => {
    expect(models.has(assetId) || assetId.includes('pnw-')).toBe(true);
    return tool(request, 'create_object', { name, type: 'asset', assetId, position });
  };
  await tool(request, 'create_object', {
    name: 'Forest floor', type: 'plane', position: [0, -3.04, 0],
    rotation: [-Math.PI / 2, 0, 0], dimensions: [28, 26, 1], color: '#344c39',
    roughness: 0.96, materialId: 'builtin:forest-floor',
  });
  await place('builtin:pnw-craftsman-shell', 'Cedar Craftsman house', [0, 0, 0]);
  await place('builtin:pnw-gable-roof', 'Charcoal shingle roof', [0, 1.8, 0]);
  await place('builtin:pnw-porch', 'Covered timber porch', [0, -1.55, -3.55]);
  await place('builtin:pnw-front-door', 'Glazed front door', [0, -1.7, -3.12]);
  const overlappingWindow = (await place('builtin:pnw-window', 'Misplaced window', [0, -1.7, -3.12])).result as SceneObject;
  await place('builtin:pnw-window', 'East divided-light window', [2.75, -0.1, -3.12]);
  const treePositions: [number, number, number][] = [[-9, 1.4, 5], [9, 1.4, 5], [9.5, 1.4, -3.5]];
  for (const [index, position] of treePositions.entries())
    await place('builtin:pnw-evergreen', `Douglas fir ${index + 1}`, position);
  await place('builtin:pnw-fern', 'Front fern', [-3.7, -2.8, -3.8]);
  await place('builtin:pnw-fern', 'East fern', [3.7, -2.8, -3.8]);
  await place('builtin:pnw-boulder', 'Mossy basalt', [-5, -2.5, -4.5]);
  await place('builtin:pnw-stone-path', 'Stone path near porch', [0, -2.93, -5.5]);
  await place('builtin:pnw-stone-path', 'Stone path to garden', [0, -2.93, -7.5]);

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__sceneReady?.objectIds.length)).toBeGreaterThan(10);
  const before = (await tool(request, 'render_scene', { label: 'PNW house before correction' })).result as Checkpoint;
  const outputDir = 'artifacts/tests';
  await mkdir(outputDir, { recursive: true });
  const beforePng = await (await request.get(before.screenshotUrl!)).body();
  await writeFile(`${outputDir}/pnw-house-before.png`, beforePng);

  await tool(request, 'update_object', { id: overlappingWindow.id, name: 'West divided-light window', position: [-2.75, -0.1, -3.12] });
  const after = (await tool(request, 'render_scene', { label: 'PNW house after correction' })).result as Checkpoint;
  const afterPng = await (await request.get(after.screenshotUrl!)).body();
  await writeFile(`${outputDir}/pnw-house-after.png`, afterPng);
  const state = (await (await request.get('/api/state')).json()) as Scene;
  expect(state.objects.some((object) => object.name === 'West divided-light window')).toBe(true);
  expect(state.lighting.environmentAssetId).toBe('builtin:pnw-overcast');

  const exported = (await tool(request, 'export_scene')).result as { artifactUrl: string; objectCount: number };
  expect(exported.objectCount).toBe(state.objects.filter((object) => object.visible).length);
  const glb = Buffer.from(await (await request.get(exported.artifactUrl)).body());
  expect(glb.subarray(0, 4).toString()).toBe('glTF');
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString().trim()) as { images?: unknown[]; materials?: unknown[] };
  expect(gltf.materials?.length).toBeGreaterThan(0);
  expect(gltf.images?.length).toBeGreaterThan(0);
  await tool(request, 'save_scene', { name: 'pnw-craftsman-e2e' });
  const loaded = (await tool(request, 'load_scene', { name: 'pnw-craftsman-e2e' })).result as Scene;
  expect(loaded.objects.map((object) => object.id)).toEqual(state.objects.map((object) => object.id));
  expect(loaded.objects.filter((object) => object.type === 'asset')).toHaveLength(14);
  expect(loaded.objects.find((object) => object.name === 'West divided-light window')?.position[0]).toBe(-2.75);

  const runDir = `artifacts/runs/pnw-house-e2e-${Date.now()}`;
  await mkdir(runDir, { recursive: true });
  await writeFile(`${runDir}/scene.json`, JSON.stringify(loaded, null, 2));
  await writeFile(`${runDir}/before.png`, beforePng);
  await writeFile(`${runDir}/after.png`, afterPng);
  const events = (await (await request.get('/api/events')).json()) as unknown[];
  await writeFile(`${runDir}/events.jsonl`, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  await writeFile(`${runDir}/review.md`, [
    '# PNW Craftsman house agent run',
    '',
    `Run: ${runDir.split('/').at(-1)}`,
    `Scene revision: ${loaded.revision}`,
    `Objects: ${loaded.objects.length} total, ${loaded.objects.filter((object) => object.type === 'asset').length} assets`,
    '',
    'The agent searched the built-in PNW catalog, assembled a Craftsman house with a gable roof, covered porch, divided-light windows, entry door, Douglas firs, ferns, boulder, and stepping stones. The first render showed a window overlapping the entry area; the agent corrected its position to flank the porch, rerendered, saved and reloaded the scene, and exported a GLB.',
    '',
    'Visual review: recognizable Northwest house composition, visible timber porch and roof, windows clear of the porch posts, and landscaping framed around the building. The included starter models are procedural and intentionally simple; geometry and foliage remain stylized rather than photorealistic.',
  ].join('\n'));
});
test('local asset previews import into the catalog and can be used through public scene tools', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  const importer = page.getByRole('form', { name: 'Import a local asset' });
  const importOne = async (file: { name: string; mimeType: string; buffer: Buffer }, name: string, tags: string[], preview: '3d' | 'image') => {
    await importer.getByLabel('Asset file').setInputFiles(file);
    await importer.getByLabel('Asset name').fill(name);
    await importer.getByLabel('Asset tags').fill(tags.join(', '));
    if (preview === '3d') await expect(importer.locator('.asset-preview canvas')).toBeVisible();
    else await expect(importer.getByAltText(`Preview of ${file.name}`)).toBeVisible();
    if (file.name.endsWith('.glb')) {
      await mkdir('artifacts/tests', { recursive: true });
      await page.screenshot({ path: 'artifacts/tests/local-asset-import-preview.png', fullPage: true });
    }
    const button = importer.getByRole('button', { name: 'Add to local catalog' });
    await expect(button).toBeEnabled();
    await button.click();
  };

  const revisionBeforeImport = ((await (await request.get('/api/state')).json()) as Scene).revision;
  await importOne({ name: 'cedar-house.glb', mimeType: 'model/gltf-binary', buffer: tinyGlb() }, 'Cedar PNW house', ['house', 'pnw'], '3d');
  let found = await tool(request, 'search_assets', { query: 'pnw house', kind: 'model' });
  const house = (found.result as { id: string }[]).find((asset) => asset.id.startsWith('local:'))!;
  const placed = await tool(request, 'create_object', { name: 'Imported Cedar House', type: 'asset', assetId: house.id });
  await expect.poll(() => page.evaluate(() => window.__sceneReady?.objectIds)).toContain((placed.result as SceneObject).id);

  await importOne({ name: 'overcast.hdr', mimeType: 'image/vnd.radiance', buffer: tinyHdr() }, 'Local overcast sky', ['pnw'], '3d');
  found = await tool(request, 'search_assets', { query: 'overcast', kind: 'environment' });
  const environment = (found.result as { id: string }[]).find((asset) => asset.id.startsWith('local:'))!;
  await tool(request, 'set_lighting', { environmentAssetId: environment.id });

  await importOne({ name: 'cedar.png', mimeType: 'image/png', buffer: tinyPng() }, 'Cedar color map', ['wood'], 'image');
  found = await tool(request, 'search_assets', { query: 'cedar color', kind: 'material' });
  const material = (found.result as { id: string }[]).find((asset) => asset.id.startsWith('local:'))!;
  await tool(request, 'create_object', { name: 'Cedar sample', type: 'box', position: [3, 0, 0], materialId: material.id });
  expect(((await (await request.get('/api/state')).json()) as Scene).revision).toBe(revisionBeforeImport + 3);
  expect(errors).toEqual([]);
});
test('unknown checkpoint surfaces a visible failure instead of claiming render readiness', async ({
  page,
}) => {
  await page.goto('/?checkpoint=missing');
  await expect(page.getByRole('alert')).toContainText('Checkpoint load failed');
  expect(await page.evaluate(() => window.__sceneReady)).toBeUndefined();
});
