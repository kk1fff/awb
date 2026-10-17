import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { Scene } from '../shared/schema.js';
import { buildWorld, disposeWorld } from './world.js';

export async function exportBrowserScene(scene: Scene, workspaceId?: string): Promise<string> {
  const world = await buildWorld(scene, workspaceId);
  for (const child of [...world.children]) if (child.type.includes('Light')) world.remove(child);
  world.background = null;
  world.environment = null;
  try {
    const output = await new GLTFExporter().parseAsync(world, { binary: true, onlyVisible: true });
    if (!(output instanceof ArrayBuffer)) throw new Error('GLB exporter returned text output');
    const bytes = new Uint8Array(output);
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    return btoa(binary);
  } finally {
    disposeWorld(world);
  }
}
