import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
): Promise<SceneExport> {
  ensureFileReader();
  const world = buildWorld(scene);
  for (const child of [...world.children]) if (child.type !== 'Mesh') world.remove(child);
  world.background = null;
  const exporter = new GLTFExporter();
  try {
    const output = await exporter.parseAsync(world, { binary: true, onlyVisible: true });
    if (!(output instanceof ArrayBuffer)) throw new Error('GLB exporter returned text output');
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
    disposeWorld(world);
  }
}
