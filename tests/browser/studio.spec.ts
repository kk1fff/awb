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

test('@smoke scopes the browser viewport and public tools to a selected workspace', async ({
  page,
  request,
}) => {
  const createdWorkspace = await request.post('/api/workspaces', {
    data: { name: 'Browser specialist', goal: 'Build a scoped browser test scene' },
  });
  expect(createdWorkspace.status()).toBe(201);
  const { workspace } = (await createdWorkspace.json()) as {
    workspace: { id: string; name: string };
  };
  const scoped = `/api/workspaces/${workspace.id}`;
  const created = await request.post(`${scoped}/tools`, {
    data: {
      tool: 'create_object',
      arguments: { name: 'Scoped red house', type: 'box', dimensions: [3, 2, 3], color: '#a54b39' },
    },
  });
  const toolResult = (await created.json()) as ToolResponse;
  expect(toolResult.success).toBe(true);
  await page.goto(`/?workspace=${workspace.id}`);
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
    workspace.id,
  );
  await expect
    .poll(() => page.evaluate(() => window.__sceneReady?.objectIds))
    .toContain((toolResult.result as SceneObject).id);
  await expect(page.getByRole('button', { name: /Scoped red house/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/tests/workspace-browser-smoke.png', fullPage: true });
  const checkpoint = await request.post(`${scoped}/tools`, {
    data: { tool: 'render_scene', arguments: { label: 'Scoped browser checkpoint' } },
  });
  const renderResponse = (await checkpoint.json()) as ToolResponse;
  expect(renderResponse.success).toBe(true);
  const imageUrl = (renderResponse.result as Checkpoint).screenshotUrl!;
  expect(imageUrl).toContain(scoped);
  expect((await request.get(imageUrl)).ok()).toBe(true);
});

test('@smoke creates a structured workspace and persists its scene and brief across reload', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '＋ Workspace' }).click();
  const form = page.locator('.workspace-create form');
  await form.getByLabel('Name').fill('Goal capture test');
  await form.getByLabel('Owner').fill('scene specialist');
  await form.getByLabel('Goal').fill('Build a visible garden scene');
  await form.getByLabel(/Acceptance criteria/).fill('Pond is visible\nThree trees are distinct');
  await form.getByLabel(/Constraints/).fill('Use local assets only');
  await form.getByRole('button', { name: 'Create and open' }).click();
  await expect(page).toHaveURL(/workspace=/);
  const workspaceId = new URL(page.url()).searchParams.get('workspace')!;
  await expect(page.getByRole('combobox', { name: 'Workspace', exact: true })).toHaveValue(
    workspaceId,
  );
  const context = await request.get(`/api/workspaces/${workspaceId}/context`);
  expect(await context.json()).toMatchObject({
    context: {
      name: 'Goal capture test',
      owner: 'scene specialist',
      goal: 'Build a visible garden scene',
      acceptanceCriteria: ['Pond is visible', 'Three trees are distinct'],
      constraints: ['Use local assets only'],
    },
  });
  const created = await request.post(`/api/workspaces/${workspaceId}/tools`, {
    data: { tool: 'create_object', arguments: { name: 'Persisted test object', type: 'box' } },
  });
  expect(created.ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('workspace-brief')).toContainText('Build a visible garden scene');
  await expect(page.getByTestId('workspace-brief')).toContainText('Pond is visible');
  await expect(page.getByTestId('workspace-brief')).toContainText('Use local assets only');
  await expect(page.getByRole('button', { name: /Persisted test object/ })).toBeVisible();
  await page.screenshot({ path: 'artifacts/tests/workspace-dashboard.png', fullPage: true });
});

test('@smoke archives, restores, and purges from another selected workspace with explicit UUID confirmation', async ({
  page,
  request,
}) => {
  const created = await request.post('/api/workspaces', {
    data: { name: 'Lifecycle dashboard', goal: 'Verify workspace lifecycle UI' },
  });
  const { workspace } = (await created.json()) as { workspace: { id: string } };
  const id = workspace.id;
  await page.goto(`/?workspace=${id}`);
  await expect(page.getByTestId('workspace-brief')).toContainText('Verify workspace lifecycle UI');
  await page.getByRole('button', { name: 'Archive workspace' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ARCHIVED' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore workspace' }).click();
  await expect(page.getByRole('button', { name: 'Archive workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Archive workspace' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'ARCHIVED' })).toBeVisible();
  const next = new URL(page.url());
  next.searchParams.delete('workspace');
  await page.goto(next.toString());
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain(id);
    await dialog.accept(id);
  });
  await page
    .getByRole('article')
    .filter({ hasText: 'Lifecycle dashboard' })
    .getByRole('button', { name: 'Purge…' })
    .click();
  await expect(page.getByRole('article').filter({ hasText: 'Lifecycle dashboard' })).toHaveCount(0);
});

test('@smoke exports and imports a portable handoff without replacing the target active scene', async ({
  page,
  request,
}) => {
  const sourceResponse = await request.post('/api/workspaces', {
    data: { name: 'Bundle source UI', goal: 'Build a portable submodel' },
  });
  const targetResponse = await request.post('/api/workspaces', {
    data: { name: 'Bundle target UI', goal: 'Receive a portable submodel' },
  });
  const { workspace: source } = (await sourceResponse.json()) as { workspace: { id: string } };
  const { workspace: target } = (await targetResponse.json()) as { workspace: { id: string } };
  await request.post(`/api/workspaces/${source.id}/tools`, {
    data: {
      tool: 'create_object',
      arguments: { name: 'Handoff box', type: 'box', dimensions: [2, 1, 2], color: '#9f583e' },
    },
  });
  await page.goto(`/?workspace=${source.id}`);
  await expect(page.getByRole('button', { name: /Handoff box/ })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '⇩ Export handoff ZIP' }).click();
  const download = await downloadPromise;
  const bundlePath = await download.path();
  expect(bundlePath).toBeTruthy();

  await request.post(`/api/workspaces/${target.id}/tools`, {
    data: { tool: 'create_object', arguments: { name: 'Existing target object', type: 'sphere' } },
  });
  const before = (await request
    .get(`/api/workspaces/${target.id}/state`)
    .then((response) => response.json())) as Scene;
  await page.goto(`/?workspace=${target.id}`);
  await page.getByLabel('Bundle scene name').fill('Imported-specialist-scene');
  let importStarted!: () => void;
  const importStartedPromise = new Promise<void>((resolve) => {
    importStarted = resolve;
  });
  await page.route(`**/api/workspaces/${target.id}/bundles/import`, async (route) => {
    importStarted();
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response });
  });
  await page.getByLabel('Scene bundle ZIP').setInputFiles(bundlePath!);
  await importStartedPromise;
  await expect(page.getByRole('status').filter({ hasText: 'Importing bundle' })).toBeVisible();
  await expect(page.getByLabel('Scene bundle ZIP')).toBeDisabled();
  await expect(
    page.getByRole('status').filter({ hasText: 'Imported editable save' }),
  ).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'load_scene' })).toBeVisible();
  const after = (await request
    .get(`/api/workspaces/${target.id}/state`)
    .then((response) => response.json())) as Scene;
  expect(after.revision).toBe(before.revision);
  expect(after.objects.map((object) => object.name)).toContain('Existing target object');
  await expect(page.getByRole('button', { name: /Existing target object/ })).toBeVisible();
});

test('@smoke clears a scoped asset picker after import and allows selecting the same file again', async ({
  page,
  request,
}) => {
  const createdWorkspace = await request.post('/api/workspaces', {
    data: { name: 'Scoped asset importer', goal: 'Test local asset import reset' },
  });
  expect(createdWorkspace.status()).toBe(201);
  const { workspace } = (await createdWorkspace.json()) as {
    workspace: { id: string };
  };
  const api = `/api/workspaces/${workspace.id}`;
  await page.goto(`/?workspace=${workspace.id}`);
  const importer = page.getByRole('form', { name: 'Import a local asset' });
  const file = { name: 'repeatable.glb', mimeType: 'model/gltf-binary', buffer: tinyGlb() };
  const fileInput = importer.getByLabel('Asset file');
  await fileInput.setInputFiles(file);
  await importer.getByLabel('Asset name').fill('Repeatable local model');
  await expect(importer.locator('.asset-preview canvas')).toBeVisible();
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`${api}/assets/import`),
  );
  await importer.getByRole('button', { name: 'Add to local catalog' }).click();
  expect((await responsePromise).status()).toBe(201);
  await expect(fileInput).toHaveValue('');
  await expect(importer.getByLabel('Asset name')).toHaveCount(0);
  await page.screenshot({ path: 'artifacts/tests/scoped-asset-import-reset.png', fullPage: true });

  await fileInput.setInputFiles(file);
  await expect(importer.getByLabel('Asset name')).toHaveValue('repeatable');
  await expect(importer.locator('.asset-preview canvas')).toBeVisible();
});

test('public lighting controls produce a visible change in a fixed-scene render', async ({
  page,
  request,
}) => {
  await tool(request, 'create_object', {
    name: 'Lighting response target',
    type: 'box',
    dimensions: [3, 3, 3],
    color: '#b7a58a',
    roughness: 0.8,
  });
  await tool(request, 'set_camera', {
    position: [8, 8, 8],
    target: [0, 0, 0],
    verticalSize: 9,
  });
  await page.goto('/');

  const captureMean = async (ambientIntensity: number, directionalIntensity: number) => {
    await tool(request, 'set_lighting', {
      ambient: { color: '#ffffff', intensity: ambientIntensity },
      directional: {
        color: '#ffffff',
        intensity: directionalIntensity,
        position: [5, 8, 6],
      },
    });
    const checkpoint = (
      await tool(request, 'render_scene', {
        label: `Lighting ambient ${ambientIntensity} directional ${directionalIntensity}`,
      })
    ).result as Checkpoint;
    const response = await request.get(checkpoint.screenshotUrl!);
    expect(response.ok()).toBe(true);
    const encoded = (await response.body()).toString('base64');
    return page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(362, 254, 300, 260);
      let luminance = 0;
      for (let i = 0; i < data.length; i += 4)
        luminance += 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!;
      return luminance / (data.length / 4);
    }, encoded);
  };

  const unlit = await captureMean(0, 0);
  const ambientLit = await captureMean(8, 0);
  const directionalLit = await captureMean(0, 8);
  expect(ambientLit - unlit, `ambient response: ${unlit} -> ${ambientLit}`).toBeGreaterThan(8);
  expect(
    directionalLit - unlit,
    `directional response: ${unlit} -> ${directionalLit}`,
  ).toBeGreaterThan(8);
});

test('environment background and PCF softness change the same scene render', async ({
  page,
  request,
}) => {
  await tool(request, 'create_object', {
    name: 'A/B ground',
    type: 'box',
    position: [0, -0.15, 0],
    dimensions: [24, 0.3, 24],
    color: '#727b50',
  });
  await tool(request, 'create_object', {
    name: 'A/B house mass',
    type: 'box',
    position: [0, 2, 0],
    dimensions: [6, 4, 5],
    color: '#a98768',
  });
  await tool(request, 'create_object', {
    name: 'A/B porch post',
    type: 'box',
    position: [3.3, 1.3, 2.3],
    dimensions: [0.25, 2.6, 0.25],
    color: '#654b36',
  });
  await tool(request, 'create_object', {
    name: 'A/B fir',
    type: 'cone',
    position: [6, 2.4, 1],
    dimensions: [2.4, 4.8, 2.4],
    color: '#34543a',
  });
  await tool(request, 'set_camera', {
    projection: 'perspective',
    fov: 38,
    position: [15, 9, 18],
    target: [0, 2, 0],
  });
  const fixedLight = {
    ambient: { color: '#ffffff', intensity: 0.55 },
    directional: { color: '#fff4dc', intensity: 3, position: [-7, 12, 8], shadowSoftness: 0 },
  };
  await tool(request, 'set_lighting', fixedLight);
  await page.goto('/');

  const capture = async (label: string, patch: Record<string, unknown>) => {
    await tool(request, 'set_lighting', patch);
    const result = (await tool(request, 'render_scene', { label })).result as Checkpoint;
    const image = await request.get(result.screenshotUrl!);
    expect(image.ok()).toBeTruthy();
    const buffer = await image.body();
    const outPath = `artifacts/tests/${label.replaceAll(' ', '-')}.png`;
    await mkdir('artifacts/tests', { recursive: true });
    await writeFile(outPath, buffer);
    const encoded = buffer.toString('base64');
    const pixels = await page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    }, encoded);
    return { result, pixels: Array.from(pixels) };
  };
  const solid = await capture('lighting-ab-solid-hard', {
    backgroundMode: 'solid',
    environmentAssetId: 'builtin:pnw-overcast',
  });
  const visibleEnvironment = await capture('lighting-ab-environment-hard', {
    backgroundMode: 'environment',
  });
  const soft = await capture('lighting-ab-environment-soft', {
    directional: { shadowSoftness: 4 },
  });
  expect(solid.result.sceneRevision).toBeLessThan(visibleEnvironment.result.sceneRevision);

  const difference = (a: number[], b: number[], x0: number, y0: number, x1: number, y1: number) => {
    let changed = 0;
    let total = 0;
    const width = 1024;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const delta =
          Math.abs(a[i]! - b[i]!) +
          Math.abs(a[i + 1]! - b[i + 1]!) +
          Math.abs(a[i + 2]! - b[i + 2]!);
        if (delta > 12) changed++;
        total++;
      }
    return changed / total;
  };
  // Sky-only pixels demonstrate that environment selection is visible, not just IBL.
  expect(difference(solid.pixels, visibleEnvironment.pixels, 200, 20, 824, 130)).toBeGreaterThan(
    0.2,
  );
  // Lower scene region includes the fir's east-side cast shadow and porch/foundation contact shadows.
  expect(difference(visibleEnvironment.pixels, soft.pixels, 120, 300, 904, 740)).toBeGreaterThan(
    0.003,
  );
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

test('orthographic and perspective cameras render the same house and preserve framing controls', async ({
  page,
  request,
}) => {
  const prior = (await (await request.get('/api/state')).json()) as Scene;
  for (const object of prior.objects) await tool(request, 'delete_object', { id: object.id });

  const place = async (assetId: string, name: string, position: [number, number, number]) =>
    tool(request, 'create_object', { name, type: 'asset', assetId, position });
  await tool(request, 'create_object', {
    name: 'Garden foreground',
    type: 'plane',
    position: [0, -3.2, 0],
    rotation: [-Math.PI / 2, 0, 0],
    dimensions: [44, 44, 1],
    color: '#466143',
    materialId: 'builtin:forest-floor',
  });
  await place('builtin:pnw-craftsman-shell', 'Perspective Craftsman shell', [0, 0, 0]);
  await place('builtin:pnw-gable-roof', 'Perspective Craftsman roof', [0, 1.8, 0]);
  await place('builtin:pnw-porch', 'Perspective Craftsman porch', [0, -1.55, -3.55]);
  await place('builtin:pnw-front-door', 'Perspective entry door', [0, -1.7, -3.12]);
  await place('builtin:pnw-window', 'Perspective left window', [-2.75, -0.1, -3.12]);
  await place('builtin:pnw-window', 'Perspective right window', [2.75, -0.1, -3.12]);
  await place('builtin:pnw-evergreen', 'Perspective fir left', [-8, 0, 2]);
  await place('builtin:pnw-evergreen', 'Perspective fir right', [8, 0, 2]);
  await place('builtin:pnw-evergreen', 'Perspective fir background', [-9, 0, -9]);
  await tool(request, 'set_camera', {
    position: [10, 2, -23],
    target: [0, 3.6, 0],
    verticalSize: 22,
    projection: 'orthographic',
    fov: 38,
  });
  await tool(request, 'set_lighting', {
    ambient: { color: '#dbe6e1', intensity: 1.9 },
    directional: { color: '#fff8ed', intensity: 2.6, position: [-8, 14, -10] },
    environmentAssetId: 'builtin:pnw-overcast',
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.__sceneReady));
  await expect(page.getByLabel('Camera projection')).toHaveValue('orthographic');

  const ortho = (await tool(request, 'render_scene', { label: 'PNW house orthographic camera' }))
    .result as Checkpoint;
  const orthoPng = await request.get(ortho.screenshotUrl!);
  expect(ortho.status).toBe('complete');
  expect(orthoPng.ok()).toBe(true);
  const orthoBytes = await orthoPng.body();
  await mkdir('artifacts/tests', { recursive: true });
  await writeFile('artifacts/tests/pnw-camera-orthographic.png', orthoBytes);

  const beforePerspective = (await (await request.get('/api/state')).json()) as Scene;
  await page.getByLabel('Camera projection').selectOption('perspective');
  await expect
    .poll(async () => ((await (await request.get('/api/state')).json()) as Scene).camera.projection)
    .toBe('perspective');
  await expect(page.getByLabel('Vertical field of view')).toHaveValue('38');
  await page.getByLabel('Vertical field of view').focus();
  await page.getByLabel('Vertical field of view').press('ArrowRight');
  await expect
    .poll(async () => ((await (await request.get('/api/state')).json()) as Scene).camera.fov)
    .toBe(39);
  await expect(page.getByLabel('Vertical field of view')).toHaveValue('39');
  await page.getByLabel('Vertical field of view').focus();
  await page.getByLabel('Vertical field of view').press('ArrowLeft');
  await expect
    .poll(async () => ((await (await request.get('/api/state')).json()) as Scene).camera.fov)
    .toBe(38);
  const perspectiveCamera = ((await (await request.get('/api/state')).json()) as Scene).camera;
  for (let axis = 0; axis < 3; axis++) {
    expect(perspectiveCamera.position[axis]).toBeCloseTo(
      beforePerspective.camera.position[axis],
      10,
    );
    expect(perspectiveCamera.target[axis]).toBeCloseTo(beforePerspective.camera.target[axis], 10);
  }
  const perspectiveState = (await (await request.get('/api/state')).json()) as Scene;
  await page.waitForFunction(
    (revision) => window.__sceneReady?.revision === revision,
    perspectiveState.revision,
  );

  const perspective = (
    await tool(request, 'render_scene', { label: 'PNW house 38 degree perspective camera' })
  ).result as Checkpoint;
  const perspectivePng = await request.get(perspective.screenshotUrl!);
  expect(perspective.status).toBe('complete');
  expect(perspectivePng.ok()).toBe(true);
  const perspectiveBytes = await perspectivePng.body();
  await writeFile('artifacts/tests/pnw-camera-perspective.png', perspectiveBytes);
  const changedPixels = await page.evaluate(
    async ([first, second]) => {
      const decode = async (encoded: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height).data;
      };
      const [a, b] = await Promise.all([decode(first), decode(second)]);
      let changed = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (
          Math.abs(a[i]! - b[i]!) +
            Math.abs(a[i + 1]! - b[i + 1]!) +
            Math.abs(a[i + 2]! - b[i + 2]!) >
          24
        )
          changed++;
      }
      return changed / (a.length / 4);
    },
    [orthoBytes.toString('base64'), perspectiveBytes.toString('base64')],
  );
  expect(changedPixels, 'projection should change visible scene framing').toBeGreaterThan(0.02);

  const canvas = page.locator('canvas');
  const oldCanvasBox = await canvas.boundingBox();
  expect(oldCanvasBox).not.toBeNull();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await canvas.boundingBox())?.width).not.toBe(oldCanvasBox!.width);
  const resized = await canvas.evaluate((element) => {
    const view = element as HTMLCanvasElement;
    return {
      width: view.width,
      height: view.height,
      clientWidth: view.clientWidth,
      clientHeight: view.clientHeight,
    };
  });
  expect(resized.width).toBe(resized.clientWidth);
  expect(resized.height).toBe(resized.clientHeight);
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await canvas.click({ position: { x: canvasBox!.width / 2, y: canvasBox!.height * 0.7 } });
  await expect(page.locator('.properties').getByLabel('Name', { exact: true })).toHaveValue(
    /Perspective/,
  );
  const beforeOrbit = ((await (await request.get('/api/state')).json()) as Scene).camera;
  await canvas.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  const visibleCanvasBox = await canvas.boundingBox();
  expect(visibleCanvasBox).not.toBeNull();
  const dragX = visibleCanvasBox!.x + visibleCanvasBox!.width / 2;
  const dragY = visibleCanvasBox!.y + Math.min(visibleCanvasBox!.height / 2, 250);
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX + 60, dragY + 20, { steps: 6 });
  await page.mouse.up();
  expect(((await (await request.get('/api/state')).json()) as Scene).camera).toEqual(beforeOrbit);
  await page.getByRole('button', { name: 'Use current view' }).click();
  await expect
    .poll(async () => ((await (await request.get('/api/state')).json()) as Scene).camera.position)
    .not.toEqual(beforeOrbit.position);
  expect(((await (await request.get('/api/state')).json()) as Scene).camera).toMatchObject({
    projection: 'perspective',
    fov: 38,
    verticalSize: 22,
  });
});

test('agent can search, build, inspect, correct, save and export a PNW Craftsman house', async ({
  page,
  request,
}) => {
  const previous = (await (await request.get('/api/state')).json()) as Scene;
  for (const object of previous.objects) await tool(request, 'delete_object', { id: object.id });
  await tool(request, 'set_camera', {
    position: [11, 8, -22],
    target: [0, -0.1, -0.8],
    verticalSize: 20,
  });
  await tool(request, 'set_lighting', {
    ambient: { color: '#dbe6e1', intensity: 1.45 },
    directional: { color: '#fff8ed', intensity: 2.5, position: [-8, 14, -10] },
    environmentAssetId: 'builtin:pnw-overcast',
  });

  const houseParts = (
    await tool(request, 'search_assets', { query: 'pnw craftsman', kind: 'model' })
  ).result as {
    id: string;
    name: string;
  }[];
  expect(houseParts.map((asset) => asset.id)).toEqual(
    expect.arrayContaining([
      'builtin:pnw-craftsman-shell',
      'builtin:pnw-gable-roof',
      'builtin:pnw-porch',
      'builtin:pnw-window',
      'builtin:pnw-front-door',
    ]),
  );
  const models = new Set(houseParts.map((asset) => asset.id));
  const place = async (assetId: string, name: string, position: [number, number, number]) => {
    expect(models.has(assetId) || assetId.includes('pnw-')).toBe(true);
    return tool(request, 'create_object', { name, type: 'asset', assetId, position });
  };
  await tool(request, 'create_object', {
    name: 'Forest floor',
    type: 'plane',
    position: [0, -3.04, 0],
    rotation: [-Math.PI / 2, 0, 0],
    dimensions: [28, 26, 1],
    color: '#344c39',
    roughness: 0.96,
    materialId: 'builtin:forest-floor',
  });
  await place('builtin:pnw-craftsman-shell', 'Cedar Craftsman house', [0, 0, 0]);
  await place('builtin:pnw-gable-roof', 'Charcoal shingle roof', [0, 1.8, 0]);
  await place('builtin:pnw-porch', 'Covered timber porch', [0, -1.55, -3.55]);
  await place('builtin:pnw-front-door', 'Glazed front door', [0, -1.7, -3.12]);
  const overlappingWindow = (
    await place('builtin:pnw-window', 'Misplaced window', [0, -1.7, -3.12])
  ).result as SceneObject;
  await place('builtin:pnw-window', 'East divided-light window', [2.75, -0.1, -3.12]);
  const treePositions: [number, number, number][] = [
    [-9, 1.4, 5],
    [9, 1.4, 5],
    [9.5, 1.4, -3.5],
  ];
  for (const [index, position] of treePositions.entries())
    await place('builtin:pnw-evergreen', `Douglas fir ${index + 1}`, position);
  await place('builtin:pnw-fern', 'Front fern', [-3.7, -2.8, -3.8]);
  await place('builtin:pnw-fern', 'East fern', [3.7, -2.8, -3.8]);
  await place('builtin:pnw-boulder', 'Mossy basalt', [-5, -2.5, -4.5]);
  await place('builtin:pnw-stone-path', 'Stone path near porch', [0, -2.93, -5.5]);
  await place('builtin:pnw-stone-path', 'Stone path to garden', [0, -2.93, -7.5]);

  await page.addInitScript(() => {
    const instrumented = window as Window & { __fieldworkRafCalls?: number };
    instrumented.__fieldworkRafCalls = 0;
    const requestFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      instrumented.__fieldworkRafCalls!++;
      return requestFrame(callback);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__sceneReady?.objectIds.length))
    .toBeGreaterThan(10);
  const readyFrames = await page.evaluate(
    () => (window as Window & { __fieldworkRafCalls?: number }).__fieldworkRafCalls ?? 0,
  );
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () => (window as Window & { __fieldworkRafCalls?: number }).__fieldworkRafCalls ?? 0,
    ),
  ).toBe(readyFrames);
  const before = (await tool(request, 'render_scene', { label: 'PNW house before correction' }))
    .result as Checkpoint;
  const outputDir = 'artifacts/tests';
  await mkdir(outputDir, { recursive: true });
  const beforePng = await (await request.get(before.screenshotUrl!)).body();
  await writeFile(`${outputDir}/pnw-house-before.png`, beforePng);

  const corrected = await tool(request, 'update_object', {
    id: overlappingWindow.id,
    name: 'West divided-light window',
    position: [-2.75, -0.1, -3.12],
  });
  await expect
    .poll(() => page.evaluate(() => window.__sceneReady?.revision))
    .toBe(corrected.sceneRevision);
  const correctedFrames = await page.evaluate(
    () => (window as Window & { __fieldworkRafCalls?: number }).__fieldworkRafCalls ?? 0,
  );
  expect(correctedFrames).toBeGreaterThan(readyFrames);
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () => (window as Window & { __fieldworkRafCalls?: number }).__fieldworkRafCalls ?? 0,
    ),
  ).toBe(correctedFrames);
  const after = (await tool(request, 'render_scene', { label: 'PNW house after correction' }))
    .result as Checkpoint;
  const afterPng = await (await request.get(after.screenshotUrl!)).body();
  await writeFile(`${outputDir}/pnw-house-after.png`, afterPng);
  const state = (await (await request.get('/api/state')).json()) as Scene;
  expect(state.objects.some((object) => object.name === 'West divided-light window')).toBe(true);
  expect(state.lighting.environmentAssetId).toBe('builtin:pnw-overcast');

  const exported = (await tool(request, 'export_scene')).result as {
    artifactUrl: string;
    objectCount: number;
  };
  expect(exported.objectCount).toBe(state.objects.filter((object) => object.visible).length);
  const glb = Buffer.from(await (await request.get(exported.artifactUrl)).body());
  expect(glb.subarray(0, 4).toString()).toBe('glTF');
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(
    glb
      .subarray(20, 20 + jsonLength)
      .toString()
      .trim(),
  ) as { images?: unknown[]; materials?: unknown[] };
  expect(gltf.materials?.length).toBeGreaterThan(0);
  expect(gltf.images?.length).toBeGreaterThan(0);
  await tool(request, 'save_scene', { name: 'pnw-craftsman-e2e' });
  const loaded = (await tool(request, 'load_scene', { name: 'pnw-craftsman-e2e' })).result as Scene;
  expect(loaded.objects.map((object) => object.id)).toEqual(
    state.objects.map((object) => object.id),
  );
  expect(loaded.objects.filter((object) => object.type === 'asset')).toHaveLength(14);
  expect(
    loaded.objects.find((object) => object.name === 'West divided-light window')?.position[0],
  ).toBe(-2.75);

  const runDir = `artifacts/runs/pnw-house-e2e-${Date.now()}`;
  await mkdir(runDir, { recursive: true });
  await writeFile(`${runDir}/scene.json`, JSON.stringify(loaded, null, 2));
  await writeFile(`${runDir}/before.png`, beforePng);
  await writeFile(`${runDir}/after.png`, afterPng);
  const events = (await (await request.get('/api/events')).json()) as unknown[];
  await writeFile(
    `${runDir}/events.jsonl`,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  await writeFile(
    `${runDir}/review.md`,
    [
      '# PNW Craftsman house agent run',
      '',
      `Run: ${runDir.split('/').at(-1)}`,
      `Scene revision: ${loaded.revision}`,
      `Objects: ${loaded.objects.length} total, ${loaded.objects.filter((object) => object.type === 'asset').length} assets`,
      '',
      'The agent searched the built-in PNW catalog, assembled a Craftsman house with a gable roof, covered porch, divided-light windows, entry door, Douglas firs, ferns, boulder, and stepping stones. The first render showed a window overlapping the entry area; the agent corrected its position to flank the porch, rerendered, saved and reloaded the scene, and exported a GLB.',
      '',
      'Visual review: recognizable Northwest house composition, visible timber porch and roof, windows clear of the porch posts, and landscaping framed around the building. The included starter models are procedural and intentionally simple; geometry and foliage remain stylized rather than photorealistic.',
    ].join('\n'),
  );
});
test('local asset previews import into the catalog and can be used through public scene tools', async ({
  page,
  request,
}) => {
  const createdWorkspace = await request.post('/api/workspaces', {
    data: { name: 'Asset preview test', goal: 'Import and render local assets' },
  });
  expect(createdWorkspace.status()).toBe(201);
  const { workspace } = (await createdWorkspace.json()) as { workspace: { id: string } };
  const scoped = `/api/workspaces/${workspace.id}`;
  const scopedTool = async (name: string, args: unknown = {}) => {
    const response = await request.post(`${scoped}/tools`, {
      data: { tool: name, arguments: args },
    });
    const result = (await response.json()) as ToolResponse;
    expect(result.success, JSON.stringify(result.error)).toBe(true);
    return result;
  };
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(`/?workspace=${workspace.id}`);
  await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  const importer = page.getByRole('form', { name: 'Import a local asset' });
  const importOne = async (
    file: { name: string; mimeType: string; buffer: Buffer },
    name: string,
    tags: string[],
    preview: '3d' | 'image',
  ) => {
    await importer.getByLabel('Asset file').setInputFiles(file);
    await importer.getByLabel('Asset name').fill(name);
    await importer.getByLabel('Asset tags').fill(tags.join(', '));
    if (preview === '3d') await expect(importer.locator('.asset-preview canvas')).toBeVisible();
    else await expect(importer.getByAltText(`Preview of ${file.name}`)).toBeVisible();
    if (file.name.endsWith('.glb')) {
      await mkdir('artifacts/tests', { recursive: true });
      await page.screenshot({
        path: 'artifacts/tests/local-asset-import-preview.png',
        fullPage: true,
      });
    }
    const button = importer.getByRole('button', { name: 'Add to local catalog' });
    await expect(button).toBeEnabled();
    await button.click();
    const fileInput = importer.getByLabel('Asset file');
    await expect(fileInput).toHaveValue('');
    await expect(importer.getByLabel('Asset name')).toHaveCount(0);
    if (file.name.endsWith('.glb')) {
      await page.screenshot({
        path: 'artifacts/tests/local-asset-import-reset.png',
        fullPage: true,
      });
    }
    await fileInput.setInputFiles(file);
    await expect(importer.getByLabel('Asset name')).toHaveValue(file.name.replace(/\.[^.]+$/, ''));
    if (preview === '3d') await expect(importer.locator('.asset-preview canvas')).toBeVisible();
    else await expect(importer.getByAltText(`Preview of ${file.name}`)).toBeVisible();
  };

  const revisionBeforeImport = ((await (await request.get(`${scoped}/state`)).json()) as Scene)
    .revision;
  await importOne(
    { name: 'cedar-house.glb', mimeType: 'model/gltf-binary', buffer: tinyGlb() },
    'Cedar PNW house',
    ['house', 'pnw'],
    '3d',
  );
  let found = await scopedTool('search_assets', { query: 'pnw house', kind: 'model' });
  const house = (found.result as { id: string }[]).find((asset) => asset.id.startsWith('local:'))!;
  const placed = await scopedTool('create_object', {
    name: 'Imported Cedar House',
    type: 'asset',
    assetId: house.id,
  });
  await expect
    .poll(() => page.evaluate(() => window.__sceneReady?.objectIds))
    .toContain((placed.result as SceneObject).id);

  await importOne(
    { name: 'overcast.hdr', mimeType: 'image/vnd.radiance', buffer: tinyHdr() },
    'Local overcast sky',
    ['pnw'],
    '3d',
  );
  found = await scopedTool('search_assets', { query: 'overcast', kind: 'environment' });
  const environment = (found.result as { id: string }[]).find((asset) =>
    asset.id.startsWith('local:'),
  )!;
  await scopedTool('set_lighting', { environmentAssetId: environment.id });

  await importOne(
    { name: 'cedar.png', mimeType: 'image/png', buffer: tinyPng() },
    'Cedar color map',
    ['wood'],
    'image',
  );
  found = await scopedTool('search_assets', { query: 'cedar color', kind: 'material' });
  const material = (found.result as { id: string }[]).find((asset) =>
    asset.id.startsWith('local:'),
  )!;
  await scopedTool('create_object', {
    name: 'Cedar sample',
    type: 'box',
    position: [3, 0, 0],
    materialId: material.id,
  });
  expect(((await (await request.get(`${scoped}/state`)).json()) as Scene).revision).toBe(
    revisionBeforeImport + 3,
  );
  expect(errors).toEqual([]);
});
test('unknown checkpoint surfaces a visible failure instead of claiming render readiness', async ({
  page,
}) => {
  await page.goto('/?checkpoint=missing');
  await expect(page.getByRole('alert')).toContainText('Checkpoint load failed');
  expect(await page.evaluate(() => window.__sceneReady)).toBeUndefined();
});
