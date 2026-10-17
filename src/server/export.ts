import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Scene, SceneExport } from '../shared/schema.js';
import { buildWorld, disposeWorld } from '../client/world.js';

// Three's exporter uses FileReader for binary blobs. Node 22 provides Blob but
// not FileReader, so provide the one operation needed for texture-free GLB files.
function ensureFileReader(): void {
  if (typeof globalThis.FileReader !== 'undefined') return;
  class NodeFileReader {
    result: ArrayBuffer | string | null = null;
    onloadend: ((event: ProgressEvent<FileReader>) => void) | null = null;
    async readAsArrayBuffer(blob: Blob): Promise<void> {
      this.result = await blob.arrayBuffer();
      this.onloadend?.({ target: this } as unknown as ProgressEvent<FileReader>);
    }
  }
  Object.assign(globalThis, { FileReader: NodeFileReader });
}

export async function exportScene(
  scene: Scene,
  runDir: string,
  executionId: string,
  clientUrl: string,
): Promise<SceneExport> {
  ensureFileReader();
  const useBrowser = scene.objects.some((object) => object.type === 'asset' || object.materialId) || Boolean(scene.lighting.environmentAssetId);
  const world = useBrowser ? undefined : await buildWorld(scene);
  try {
    let output: ArrayBuffer;
    if (useBrowser) {
      const browser = await chromium.launch({ headless: true, channel: 'chromium', timeout: 30_000 });
      try {
        const page = await browser.newPage();
        const browserErrors: string[] = [];
        page.on('pageerror', (error) => browserErrors.push(error.message));
        await page.goto(clientUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(() => Boolean(window.__fieldworkExport), undefined, { timeout: 30_000 });
        if (browserErrors.length) throw new Error(browserErrors.join('\n'));
        const encoded = await page.evaluate(async (value) => {
          if (!window.__fieldworkExport) throw new Error('Browser GLB exporter is not ready.');
          return window.__fieldworkExport(value);
        }, scene);
        output = Uint8Array.from(Buffer.from(encoded, 'base64')).buffer as ArrayBuffer;
      } finally {
        await browser.close();
      }
    } else {
      for (const child of [...world!.children]) if (child.type.includes('Light')) world!.remove(child);
      world!.background = null;
      const exported = await new GLTFExporter().parseAsync(world!, { binary: true, onlyVisible: true });
      if (!(exported instanceof ArrayBuffer)) throw new Error('GLB exporter returned text output');
      output = exported;
    }
    const fileName = `scene-${executionId}.glb`;
    const directory = path.join(runDir, 'exports');
    const filePath = path.join(directory, fileName);
    await mkdir(directory, { recursive: true });
    await writeFile(filePath, Buffer.from(output));
    return {
      format: 'glb',
      fileName,
      artifactUrl: `/artifacts/exports/${fileName}`,
      sceneRevision: scene.revision,
      objectCount: scene.objects.filter((object) => object.visible).length,
      bytes: output.byteLength,
    };
  } finally {
    if (world) disposeWorld(world);
  }
}
