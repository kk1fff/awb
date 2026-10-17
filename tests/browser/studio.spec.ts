import { expect, test, type APIRequestContext } from '@playwright/test';
import type { Checkpoint, Scene, SceneObject, ToolResponse } from '../../src/shared/schema.js';

async function tool(request: APIRequestContext, name: string, args: unknown = {}) {
  const response = await request.post('/api/tools', { data: { tool: name, arguments: args } });
  const result = await response.json() as ToolResponse;
  expect(result.success, JSON.stringify(result.error)).toBe(true); return result;
}
test('@smoke renders a public-API object in Linux Chromium with no browser errors', async ({ page, request }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  const created = await tool(request, 'create_object', { name: 'Smoke box', type: 'box', dimensions: [2, 2, 2], color: '#527653' });
  await page.goto('/'); await expect(page.getByRole('heading', { name: 'A world in the making.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__sceneReady?.objectIds)).toContain((created.result as SceneObject).id);
  await page.screenshot({ path: 'artifacts/tests/studio-smoke.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('human edits, render snapshots, comparisons and checkpoint reviews use public tools', async ({ page, request }) => {
  const created = await tool(request, 'create_object', { name: 'Browser tree', type: 'cone', position: [0, 1, 0], color: '#4b7548' });
  await page.goto('/'); await page.getByRole('button', { name: '△ Browser tree' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Edited tree');
  await page.getByRole('spinbutton', { name: 'position X', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  await expect(page.getByRole('button', { name: '△ Edited tree' })).toBeVisible();
  const state = await (await request.get('/api/state')).json() as Scene;
  expect(state.objects.find(o => o.id === (created.result as SceneObject).id)?.position[0]).toBe(2);
  const before = (await tool(request, 'render_scene', { label: 'Before checkpoint' })).result as Checkpoint;
  const png = await request.get(before.screenshotUrl!); expect(png.ok()).toBe(true); expect(png.headers()['content-type']).toContain('image/png');
  expect((await png.body()).subarray(1, 4).toString()).toBe('PNG');
  await tool(request, 'update_object', { id: (created.result as SceneObject).id, color: '#335577' });
  const after = (await tool(request, 'render_scene', { label: 'After checkpoint' })).result as Checkpoint;
  await page.getByRole('button', { name: /^Checkpoints/ }).click();
  await page.getByLabel('Before checkpoint', { exact: true }).selectOption(before.id);
  await page.getByLabel('After checkpoint', { exact: true }).selectOption(after.id);
  await expect(page.getByAltText('Before: Before checkpoint', { exact: true })).toBeVisible();
  await expect(page.getByAltText('After: After checkpoint', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Reviews & feedback/ }).click();
  await page.getByLabel('Checkpoint', { exact: true }).selectOption(after.id);
  await page.getByLabel('Feedback', { exact: true }).fill('Approved after comparing the two views.');
  await page.getByRole('button', { name: 'Record feedback' }).click();
  await expect(page.getByText('Approved after comparing the two views.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'artifacts/tests/studio-reviewed.png', fullPage: true });
  const frozen = await (await request.get(before.sceneUrl)).json() as Scene;
  expect(frozen.objects.find(o => o.id === (created.result as SceneObject).id)?.color).toBe('#4b7548');
  await tool(request, 'save_scene', { name: 'browser-scene' });
  const loaded = await tool(request, 'load_scene', { name: 'browser-scene' });
  expect((loaded.result as Scene).objects.map(o => o.id)).toEqual((await (await request.get('/api/state')).json() as Scene).objects.map(o => o.id));
});
test('unknown checkpoint surfaces a visible failure instead of claiming render readiness', async ({ page }) => {
  await page.goto('/?checkpoint=missing'); await expect(page.getByRole('alert')).toContainText('Checkpoint load failed');
  expect(await page.evaluate(() => window.__sceneReady)).toBeUndefined();
});
