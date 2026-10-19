import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Scene } from '../shared/schema.js';
import { buildWorld, disposeWorld } from './world.js';

export async function exportBrowserScene(scene: Scene, workspaceId?: string): Promise<number> {
  const world = await buildWorld(scene, workspaceId, { sequential: true });
  for (const child of [...world.children]) if (child.type.includes('Light')) world.remove(child);
  world.background = null;
  world.environment = null;
  try {
    const output = await new GLTFExporter().parseAsync(world, { binary: true, onlyVisible: true });
    if (!(output instanceof ArrayBuffer)) throw new Error('GLB exporter returned text output');
    if (!window.__fieldworkWriteExportChunk)
      throw new Error('Browser GLB export transport is not ready.');
    const bytes = new Uint8Array(output);
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      let binary = '';
      const chunk = bytes.subarray(offset, offset + chunkSize);
      for (let index = 0; index < chunk.length; index += 0x8000)
        binary += String.fromCharCode(...chunk.subarray(index, index + 0x8000));
      await window.__fieldworkWriteExportChunk(btoa(binary));
    }
    return bytes.length;
  } finally {
    disposeWorld(world);
  }
}
