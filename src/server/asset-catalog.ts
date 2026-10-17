import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { builtinAssets } from '../shared/assets.js';
import { assetRecordSchema, type AssetRecord } from '../shared/schema.js';
import { ToolError } from '../engine/scene.js';

const manifestSchema = z.object({ assets: z.array(assetRecordSchema) }).strict();

export class AssetCatalog {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = path.resolve(dataDir, 'assets');
  }

  async records(): Promise<AssetRecord[]> {
    let content: string;
    try {
      content = await readFile(path.join(this.directory, 'catalog.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return builtinAssets;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ToolError('INVALID_ASSET_CATALOG', 'The local asset catalog is not valid JSON.');
    }
    const result = manifestSchema.safeParse(parsed);
    if (!result.success)
      throw new ToolError('INVALID_ASSET_CATALOG', 'The local asset catalog is invalid.', result.error.issues);
    const local = result.data.assets.map((record) => {
      if (record.source !== 'local' || !record.id.startsWith('local:') || !record.file)
        throw new ToolError('INVALID_ASSET_CATALOG', 'Local assets need source "local", a local: ID, and a file path.');
      if (!record.file) throw new ToolError('INVALID_ASSET_CATALOG', `Asset ${record.id} needs a file path.`);
      if (path.isAbsolute(record.file) || record.file.split(/[\\/]/).includes('..'))
        throw new ToolError('INVALID_ASSET_CATALOG', `Asset '${record.id}' points outside the catalog directory.`);
      const extension = path.extname(record.file).toLowerCase();
      if ((record.kind === 'model' && extension !== '.glb') || (record.kind === 'environment' && extension !== '.hdr') || (record.kind === 'material' && !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)))
        throw new ToolError('INVALID_ASSET_CATALOG', `Unsupported file format for ${record.id}. Use GLB models, HDR environments, and PNG/JPEG/WebP material maps.`);
      if (record.kind === 'model' && !record.bounds)
        throw new ToolError('INVALID_ASSET_CATALOG', `Model ${record.id} needs positive bounds in the catalog.`);
      return record;
    });
    const ids = new Set<string>();
    for (const record of [...builtinAssets, ...local]) {
      if (ids.has(record.id)) throw new ToolError('INVALID_ASSET_CATALOG', `Duplicate asset ID ${record.id}.`);
      ids.add(record.id);
    }
    return [...builtinAssets, ...local];
  }

  async get(id: string, kind?: AssetRecord['kind']): Promise<AssetRecord> {
    const record = (await this.records()).find((item) => item.id === id);
    if (!record || (kind && record.kind !== kind))
      throw new ToolError('ASSET_NOT_FOUND', `No ${kind ?? ''} asset named '${id}'. Search assets for available IDs.`);
    return record;
  }

  async search(query: string, kind: AssetRecord['kind'] | undefined, limit: number): Promise<AssetRecord[]> {
    const tokens = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const ranked = (await this.records())
      .filter((record) => !kind || record.kind === kind)
      .map((record) => {
        const fields = [record.id, record.name, record.description, record.kind, ...record.tags].map((value) => value.toLocaleLowerCase());
        const matches = tokens.filter((token) => fields.some((field) => field.includes(token))).length;
        const score = tokens.length ? matches / tokens.length : 1;
        return { record, score };
      })
      .filter((item) => item.score === 1)
      .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name) || a.record.id.localeCompare(b.record.id));
    return ranked.slice(0, limit).map(({ record }) => record);
  }

  async filePath(id: string): Promise<string> {
    const record = await this.get(id);
    if (record.source !== 'local' || !record.file)
      throw new ToolError('ASSET_NOT_FOUND', `Asset '${id}' is a procedural built-in and has no file.`);
    if (path.isAbsolute(record.file) || record.file.split(/[\\/]/).includes('..'))
      throw new ToolError('INVALID_ASSET_CATALOG', `Asset '${id}' points outside the catalog directory.`);
    const root = await realpath(this.directory);
    const resolved = await realpath(path.resolve(root, record.file));
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new ToolError('INVALID_ASSET_CATALOG', `Asset '${id}' points outside the catalog directory.`);
    try {
      await access(resolved);
    } catch {
      throw new ToolError('ASSET_NOT_FOUND', `Asset file for '${id}' is missing: ${record.file}`);
    }
    return resolved;
  }
}
