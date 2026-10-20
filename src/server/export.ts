import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { Scene, SceneExport } from '../shared/schema.js';
import { buildWorld, disposeWorld } from '../client/world.js';
import { ToolError } from '../engine/scene.js';

const EXPORT_TIMEOUT_MS = 240_000;
let browserExportQueue = Promise.resolve();

async function withBrowserExportSlot<T>(work: () => Promise<T>): Promise<T> {
  const previous = browserExportQueue;
  let release!: () => void;
  browserExportQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

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

async function verifyGlb(file: string, expectedBytes: number): Promise<number> {
  const size = (await stat(file)).size;
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== 12 ||
      header.toString('ascii', 0, 4) !== 'glTF' ||
      header.readUInt32LE(4) !== 2 ||
      header.readUInt32LE(8) !== size ||
      size !== expectedBytes
    )
      throw new Error('GLB header or byte count does not match the exported file.');
    return size;
  } finally {
    await handle.close();
  }
}

async function exportThroughBrowser(scene: Scene, clientUrl: string, temporary: string) {
  await withBrowserExportSlot(async () => {
    const browser = await chromium.launch({
      headless: true,
      channel: 'chromium',
      timeout: 30_000,
    });
    let timedOut = false;
    let browserDisconnected = false;
    let pageCrashed = false;
    browser.on('disconnected', () => {
      browserDisconnected = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void browser.close().catch(() => undefined);
    }, EXPORT_TIMEOUT_MS);
    try {
      const page = await browser.newPage();
      page.on('crash', () => {
        pageCrashed = true;
      });
      const file = await open(temporary, 'wx');
      try {
        let written = 0;
        await page.exposeBinding(
          '__fieldworkWriteExportChunk',
          async (_source, encoded: string) => {
            if (encoded.length > 1_398_104)
              throw new Error('Export chunk exceeds the 1 MiB transfer limit.');
            const bytes = Buffer.from(encoded, 'base64');
            if (bytes.length > 1024 * 1024)
              throw new Error('Export chunk exceeds the 1 MiB transfer limit.');
            let offset = 0;
            while (offset < bytes.length) {
              const result = await file.write(bytes, offset, bytes.length - offset, written);
              if (result.bytesWritten === 0) throw new Error('Export file write made no progress.');
              offset += result.bytesWritten;
              written += result.bytesWritten;
            }
          },
        );
        const browserErrors: string[] = [];
        page.on('pageerror', (error) => browserErrors.push(error.message));
        const url = new URL(clientUrl);
        url.searchParams.set('fieldworkExport', '1');
        await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(() => Boolean(window.__fieldworkExport), undefined, {
          timeout: 30_000,
        });
        if (browserErrors.length) throw new Error(browserErrors.join('\n'));
        const expectedBytes = await page.evaluate(async (value) => {
          if (!window.__fieldworkExport) throw new Error('Browser GLB exporter is not ready.');
          return window.__fieldworkExport(value);
        }, scene);
        if (browserErrors.length) throw new Error(browserErrors.join('\n'));
        if (written !== expectedBytes)
          throw new Error(`Export transferred ${written} of ${expectedBytes} bytes.`);
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (timedOut) throw new Error('Browser export timed out after four minutes.');
      if (browserDisconnected || pageCrashed)
        throw new Error('Chromium exited during GLB export; free memory or simplify the scene.');
      throw error;
    } finally {
      clearTimeout(timer);
      await browser.close().catch(() => undefined);
    }
  });
}

export async function exportScene(
  scene: Scene,
  runDir: string,
  executionId: string,
  clientUrl: string,
): Promise<SceneExport> {
  const fileName = `scene-${executionId}.glb`;
  const directory = path.join(runDir, 'exports');
  const filePath = path.join(directory, fileName);
  const temporary = path.join(directory, `.${fileName}.partial`);
  const useBrowser =
    scene.objects.some((object) => object.type === 'asset' || object.materialId) ||
    Boolean(scene.lighting.environmentAssetId);
  let world: Awaited<ReturnType<typeof buildWorld>> | undefined;
  try {
    await mkdir(directory, { recursive: true });
    let expectedBytes: number;
    if (useBrowser) {
      await exportThroughBrowser(scene, clientUrl, temporary);
      expectedBytes = (await stat(temporary)).size;
    } else {
      ensureFileReader();
      world = await buildWorld(scene, undefined, { forExport: true });
      for (const child of [...world.children])
        if (child.type.includes('Light')) world.remove(child);
      world.background = null;
      const output = await new GLTFExporter().parseAsync(world, {
        binary: true,
        onlyVisible: true,
      });
      if (!(output instanceof ArrayBuffer)) throw new Error('GLB exporter returned text output');
      expectedBytes = output.byteLength;
      await writeFile(temporary, Buffer.from(output));
    }
    const bytes = await verifyGlb(temporary, expectedBytes);
    await rename(temporary, filePath);
    return {
      format: 'glb',
      fileName,
      artifactUrl: `/artifacts/exports/${fileName}`,
      sceneRevision: scene.revision,
      objectCount: scene.objects.filter((object) => object.visible).length,
      bytes,
    };
  } catch (error) {
    let cleanupError = '';
    try {
      await rm(temporary, { force: true });
    } catch (failure) {
      cleanupError = ` Partial file cleanup failed: ${String(failure)}`;
    }
    throw new ToolError(
      'EXPORT_FAILED',
      `GLB export failed: ${error instanceof Error ? error.message : String(error)}${cleanupError}`,
    );
  } finally {
    if (world) disposeWorld(world);
  }
}
