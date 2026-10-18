import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { ToolError } from '../engine/scene.js';
import { assetRecordSchema, sceneSchema, type AssetRecord, type Scene } from '../shared/schema.js';
import type { ToolService } from './service.js';

export const SCENE_BUNDLE_MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
export const SCENE_BUNDLE_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
export const SCENE_BUNDLE_MAX_FILES = 128;
const MAX_COMPRESSION_RATIO = 1000;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temporary, file);
}

const bundleAssetSchema = z.object({
  sourceId: z.string().min(1).max(120),
  record: assetRecordSchema,
  filePath: z.string().optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
const bundleManifestSchema = z
  .object({
    format: z.literal('fieldwork-scene-bundle'),
    version: z.literal(1),
    bundleId: z.uuid(),
    createdAt: z.string().datetime(),
    source: z
      .object({ workspaceId: z.string(), runId: z.string(), executionId: z.uuid() })
      .strict(),
    workspaceContext: z.object({ goal: z.string(), currentTask: z.string() }).strict().optional(),
    sceneRevision: z.number().int().nonnegative(),
    sceneSha256: z.string().regex(/^[0-9a-f]{64}$/),
    previewSha256: z.string().regex(/^[0-9a-f]{64}$/),
    glbSha256: z.string().regex(/^[0-9a-f]{64}$/),
    files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    referencedAssets: z.array(bundleAssetSchema).max(120),
  })
  .strict();

export interface SceneBundleSource {
  scene: Scene;
  preview: Buffer;
  glb: Buffer;
  assets: Array<{ record: AssetRecord; data?: Buffer }>;
  workspaceId: string;
  runId: string;
  executionId: string;
  workspaceContext?: { goal: string; currentTask: string };
}

export async function createSceneBundle(source: SceneBundleSource): Promise<{
  data: Buffer;
  manifest: z.infer<typeof bundleManifestSchema>;
}> {
  const entries: Record<string, Uint8Array> = {
    'scene.json': Buffer.from(JSON.stringify(source.scene, null, 2)),
    'preview.png': source.preview,
    'scene.glb': source.glb,
  };
  const referencedAssets: Array<z.infer<typeof bundleAssetSchema>> = [];
  for (const { record, data } of source.assets) {
    if (record.source === 'builtin') {
      referencedAssets.push({ sourceId: record.id, record });
      continue;
    }
    if (!data)
      throw new ToolError('BUNDLE_ASSET_MISSING', `Missing bytes for local asset ${record.id}.`);
    const extension = path.extname(record.originalFileName ?? record.file ?? '').toLowerCase();
    if (!['.glb', '.hdr', '.png', '.jpg', '.jpeg', '.webp'].includes(extension))
      throw new ToolError(
        'BUNDLE_ASSET_FORMAT',
        `Unsupported referenced asset format for ${record.id}.`,
      );
    const filePath = `assets/${sha256(data).slice(0, 32)}${extension}`;
    entries[filePath] = data;
    referencedAssets.push({ sourceId: record.id, record, filePath, sha256: sha256(data) });
  }
  const sceneBytes = entries['scene.json'];
  const manifest = {
    format: 'fieldwork-scene-bundle' as const,
    version: 1 as const,
    bundleId: randomUUID(),
    createdAt: new Date().toISOString(),
    source: {
      workspaceId: source.workspaceId,
      runId: source.runId,
      executionId: source.executionId,
    },
    workspaceContext: source.workspaceContext ?? { goal: '', currentTask: '' },
    sceneRevision: source.scene.revision,
    sceneSha256: sha256(sceneBytes),
    previewSha256: sha256(source.preview),
    glbSha256: sha256(source.glb),
    files: Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, sha256(data)])),
    referencedAssets,
  };
  if (Object.keys(entries).length + 1 > SCENE_BUNDLE_MAX_FILES)
    throw new ToolError(
      'BUNDLE_TOO_LARGE',
      `Bundle exceeds the ${SCENE_BUNDLE_MAX_FILES} file limit.`,
    );
  const uncompressedBytes = Object.values(entries).reduce(
    (total, value) => total + value.length,
    0,
  );
  if (uncompressedBytes > SCENE_BUNDLE_MAX_UNCOMPRESSED_BYTES)
    throw new ToolError('BUNDLE_TOO_LARGE', 'Bundle exceeds the uncompressed size limit.');
  entries['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2));
  const zipped = zipSync(entries, { level: 6 });
  if (zipped.length > SCENE_BUNDLE_MAX_ARCHIVE_BYTES)
    throw new ToolError(
      'BUNDLE_TOO_LARGE',
      `Bundle exceeds the ${SCENE_BUNDLE_MAX_ARCHIVE_BYTES} byte limit.`,
    );
  return { data: Buffer.from(zipped), manifest };
}

interface BundleImportJournal {
  version: 1;
  importId: string;
  sceneName: string;
  originalCatalog: string | null;
  originalAssetFiles: string[];
}

async function listAssetFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const folder of ['models', 'lighting', 'textures']) {
    const root = path.join(directory, folder);
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => []))
      if (entry.isFile()) files.push(`${folder}/${entry.name}`);
  }
  return files.sort();
}

async function restoreBundleImport(dataDir: string, journal: BundleImportJournal): Promise<void> {
  const reservationPath = path.join(
    dataDir,
    'scenes',
    `${journal.sceneName}.json.bundle-reservation`,
  );
  const reservation = await readFile(reservationPath, 'utf8').catch(() => '');
  if (reservation !== journal.importId) return;

  const assetsDir = path.join(dataDir, 'assets');
  const baselineFiles = new Set(journal.originalAssetFiles);
  for (const relative of await listAssetFiles(assetsDir))
    if (!baselineFiles.has(relative)) await rm(path.join(assetsDir, relative), { force: true });

  const catalogPath = path.join(assetsDir, 'catalog.json');
  if (journal.originalCatalog === null) await rm(catalogPath, { force: true });
  else {
    await mkdir(path.dirname(catalogPath), { recursive: true });
    const temporary = `${catalogPath}.${randomUUID()}.restore`;
    await writeFile(temporary, journal.originalCatalog, { flag: 'wx' });
    await rename(temporary, catalogPath);
  }

  await rm(path.join(dataDir, 'scenes', `${journal.sceneName}.json`), { force: true });
  await rm(path.join(dataDir, 'bundle-imports', `${journal.importId}.json`), { force: true });
  await rm(reservationPath, { force: true });
}

async function releaseBundleReservation(
  dataDir: string,
  journal: BundleImportJournal,
): Promise<void> {
  const reservationPath = path.join(
    dataDir,
    'scenes',
    `${journal.sceneName}.json.bundle-reservation`,
  );
  if ((await readFile(reservationPath, 'utf8').catch(() => '')) === journal.importId)
    await rm(reservationPath, { force: true });
}

/** Roll back imports whose process stopped before its transaction journal was removed. */
export async function recoverInterruptedBundleImports(dataDir: string): Promise<void> {
  const transactionsDir = path.join(dataDir, 'bundle-imports', '.transactions');
  for (const entry of await readdir(transactionsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const journalPath = path.join(transactionsDir, entry.name);
    let journal: BundleImportJournal;
    try {
      const parsed = JSON.parse(await readFile(journalPath, 'utf8')) as BundleImportJournal;
      if (
        parsed.version !== 1 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(parsed.sceneName) ||
        !/^[0-9a-f-]{36}$/i.test(parsed.importId) ||
        !(parsed.originalCatalog === null || typeof parsed.originalCatalog === 'string') ||
        !Array.isArray(parsed.originalAssetFiles) ||
        parsed.originalAssetFiles.some((file) => typeof file !== 'string' || file.includes('..'))
      )
        throw new Error('invalid bundle import journal');
      journal = parsed;
    } catch (error) {
      throw new ToolError(
        'BUNDLE_IMPORT_RECOVERY_FAILED',
        `Cannot recover interrupted bundle import '${entry.name}': ${String(error)}`,
      );
    }
    await restoreBundleImport(dataDir, journal);
    await rm(journalPath, { force: true });
  }
}

function preflightZip(data: Buffer): void {
  if (data.length > SCENE_BUNDLE_MAX_ARCHIVE_BYTES)
    throw new ToolError(
      'BUNDLE_TOO_LARGE',
      `Bundle exceeds the ${SCENE_BUNDLE_MAX_ARCHIVE_BYTES} byte limit.`,
    );
  const minEocd = Math.max(0, data.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = data.length - 22; i >= minEocd; i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0 || eocd + 22 > data.length)
    throw new ToolError('INVALID_BUNDLE', 'Bundle is not a valid ZIP archive.');
  const entriesCount = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  let offset = data.readUInt32LE(eocd + 16);
  if (
    entriesCount === 0xffff ||
    centralSize === 0xffffffff ||
    offset === 0xffffffff ||
    entriesCount > SCENE_BUNDLE_MAX_FILES ||
    offset + centralSize > eocd
  )
    throw new ToolError('INVALID_BUNDLE', 'Bundle ZIP directory is invalid or too large.');
  const seen = new Set<string>();
  let totalUncompressed = 0;
  for (let index = 0; index < entriesCount; index++) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50)
      throw new ToolError('INVALID_BUNDLE', 'Bundle ZIP entry directory is malformed.');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > data.length || (flags & 1) !== 0 || ![0, 8].includes(method))
      throw new ToolError(
        'INVALID_BUNDLE',
        'Bundle has an encrypted, unsupported, or truncated ZIP entry.',
      );
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (
      !name ||
      name.startsWith('/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.' || !part) ||
      seen.has(name)
    )
      throw new ToolError(
        'INVALID_BUNDLE',
        `Bundle contains an unsafe or duplicate path '${name}'.`,
      );
    seen.add(name);
    if (uncompressed > SCENE_BUNDLE_MAX_UNCOMPRESSED_BYTES)
      throw new ToolError(
        'BUNDLE_TOO_LARGE',
        'A bundle entry exceeds the uncompressed size limit.',
      );
    totalUncompressed += uncompressed;
    if (
      totalUncompressed > SCENE_BUNDLE_MAX_UNCOMPRESSED_BYTES ||
      (uncompressed > 1024 * 1024 &&
        (compressed === 0 || uncompressed / compressed > MAX_COMPRESSION_RATIO))
    )
      throw new ToolError('BUNDLE_TOO_LARGE', 'Bundle exceeds decompression limits.');
    offset = end;
  }
  if (offset !== data.readUInt32LE(eocd + 16) + centralSize)
    throw new ToolError('INVALID_BUNDLE', 'Bundle ZIP directory size does not match its entries.');
}

export function readSceneBundle(data: Buffer): {
  manifest: z.infer<typeof bundleManifestSchema>;
  scene: Scene;
  entries: Record<string, Buffer>;
} {
  preflightZip(data);
  let rawEntries: Record<string, Uint8Array>;
  try {
    rawEntries = unzipSync(data);
  } catch (error) {
    throw new ToolError('INVALID_BUNDLE', `Cannot unpack scene bundle: ${String(error)}`);
  }
  const entries = Object.fromEntries(
    Object.entries(rawEntries).map(([name, bytes]) => [name, Buffer.from(bytes)]),
  );
  const json = (name: string) => {
    try {
      return JSON.parse(entries[name]?.toString('utf8') ?? 'null') as unknown;
    } catch {
      throw new ToolError('INVALID_BUNDLE', `Bundle file '${name}' is not valid JSON.`);
    }
  };
  const parsedManifest = bundleManifestSchema.safeParse(json('manifest.json'));
  if (!parsedManifest.success) throw new ToolError('INVALID_BUNDLE', 'Bundle manifest is invalid.');
  const manifest = parsedManifest.data;
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!entries['preview.png']?.subarray(0, 8).equals(pngSignature))
    throw new ToolError('INVALID_BUNDLE', 'Bundle preview is not a PNG image.');
  const sceneResult = sceneSchema.safeParse(json('scene.json'));
  if (!sceneResult.success || sceneResult.data.revision !== manifest.sceneRevision)
    throw new ToolError(
      'INVALID_BUNDLE',
      'Bundle scene is invalid or its revision does not match.',
    );
  const expectedNames = new Set([
    'scene.json',
    'preview.png',
    'scene.glb',
    ...manifest.referencedAssets.flatMap((asset) => (asset.filePath ? [asset.filePath] : [])),
  ]);
  if (
    Object.keys(entries).length !== expectedNames.size + 1 ||
    Object.keys(entries).some((name) => !expectedNames.has(name) && name !== 'manifest.json')
  )
    throw new ToolError('INVALID_BUNDLE', 'Bundle contains missing or unexpected files.');
  if (
    Object.keys(manifest.files).length !== expectedNames.size ||
    Object.keys(manifest.files).some((name) => !expectedNames.has(name))
  )
    throw new ToolError(
      'INVALID_BUNDLE',
      'Bundle manifest file hashes do not match its file list.',
    );
  if (
    sha256(entries['scene.json']) !== manifest.sceneSha256 ||
    sha256(entries['preview.png']) !== manifest.previewSha256 ||
    sha256(entries['scene.glb']) !== manifest.glbSha256
  )
    throw new ToolError(
      'BUNDLE_HASH_MISMATCH',
      'Bundle scene, preview, or GLB hash does not match its manifest.',
    );
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (!entries[name] || sha256(entries[name]) !== hash)
      throw new ToolError(
        'BUNDLE_HASH_MISMATCH',
        `Bundle file '${name}' is missing or has a hash mismatch.`,
      );
  }
  const seenIds = new Set<string>();
  for (const asset of manifest.referencedAssets) {
    if (seenIds.has(asset.sourceId) || asset.record.id !== asset.sourceId)
      throw new ToolError(
        'INVALID_BUNDLE',
        'Bundle referenced asset IDs are duplicate or inconsistent.',
      );
    seenIds.add(asset.sourceId);
    if (asset.record.source === 'local') {
      if (
        !asset.filePath ||
        !asset.sha256 ||
        sha256(entries[asset.filePath] ?? Buffer.alloc(0)) !== asset.sha256
      )
        throw new ToolError(
          'BUNDLE_HASH_MISMATCH',
          `Bundle asset '${asset.sourceId}' is missing or corrupt.`,
        );
    } else if (asset.filePath || asset.sha256) {
      throw new ToolError(
        'INVALID_BUNDLE',
        'Built-in assets cannot contain bundled file payloads.',
      );
    }
  }
  const referenced = new Set<string>();
  for (const object of sceneResult.data.objects) {
    if (object.assetId) {
      referenced.add(object.assetId);
      if (
        manifest.referencedAssets.find((asset) => asset.sourceId === object.assetId)?.record
          .kind !== 'model'
      )
        throw new ToolError(
          'INVALID_BUNDLE',
          `Scene model reference '${object.assetId}' is not a model asset.`,
        );
    }
    if (object.materialId) {
      referenced.add(object.materialId);
      if (
        manifest.referencedAssets.find((asset) => asset.sourceId === object.materialId)?.record
          .kind !== 'material'
      )
        throw new ToolError(
          'INVALID_BUNDLE',
          `Scene material reference '${object.materialId}' is not a material asset.`,
        );
    }
  }
  if (sceneResult.data.lighting.environmentAssetId) {
    referenced.add(sceneResult.data.lighting.environmentAssetId);
    if (
      manifest.referencedAssets.find(
        (asset) => asset.sourceId === sceneResult.data.lighting.environmentAssetId,
      )?.record.kind !== 'environment'
    )
      throw new ToolError(
        'INVALID_BUNDLE',
        'Scene environment reference is not an environment asset.',
      );
  }
  if ([...referenced].some((id) => !seenIds.has(id)))
    throw new ToolError(
      'INVALID_BUNDLE',
      'Bundle is missing metadata for a scene-referenced asset.',
    );
  return { manifest, scene: sceneResult.data, entries };
}

export async function importSceneBundle(
  service: ToolService,
  archive: Buffer,
  sceneName: string,
): Promise<{
  importId: string;
  sceneName: string;
  asset: AssetRecord;
  sceneRevision: number;
  lineage: unknown;
}> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sceneName))
    throw new ToolError(
      'INVALID_SCENE_NAME',
      'Scene name must be 1–80 letters, digits, hyphens or underscores.',
    );
  const { manifest, scene, entries } = readSceneBundle(archive);
  const scenePath = path.resolve(service.options.dataDir, 'scenes', `${sceneName}.json`);
  try {
    await access(scenePath);
    throw new ToolError(
      'BUNDLE_SCENE_COLLISION',
      `A saved scene named '${sceneName}' already exists.`,
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const mappings = new Map<string, string>();
  const createdAssets: string[] = [];
  const importId = randomUUID();
  const transactionsDir = path.join(service.options.dataDir, 'bundle-imports', '.transactions');
  let transactionPath: string | undefined;
  let journal: BundleImportJournal | undefined;
  let completed = false;
  try {
    await mkdir(transactionsDir, { recursive: true });
    const catalogPath = path.join(service.options.dataDir, 'assets', 'catalog.json');
    let originalCatalog: string | null = null;
    try {
      originalCatalog = await readFile(catalogPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    transactionPath = path.join(transactionsDir, `${importId}.json`);
    journal = {
      version: 1,
      importId,
      sceneName,
      originalCatalog,
      originalAssetFiles: await listAssetFiles(path.join(service.options.dataDir, 'assets')),
    };
    await atomicJson(transactionPath, journal);
    try {
      const reservation = await open(`${scenePath}.bundle-reservation`, 'wx');
      try {
        await reservation.writeFile(importId);
        await reservation.sync();
      } finally {
        await reservation.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new ToolError(
          'BUNDLE_SCENE_COLLISION',
          `A saved scene named '${sceneName}' already exists or is being imported.`,
        );
      throw error;
    }
    for (const item of manifest.referencedAssets) {
      if (item.record.source === 'builtin') {
        await service.assets.get(item.sourceId, item.record.kind);
        mappings.set(item.sourceId, item.sourceId);
        continue;
      }
      const imported = await service.assets.importLocalAsset({
        name: item.record.name,
        fileName: item.record.originalFileName ?? path.basename(item.filePath!),
        tags: item.record.tags,
        data: entries[item.filePath!],
        bounds: item.record.bounds,
        description: item.record.description,
        baseColor: item.record.baseColor,
        roughness: item.record.roughness,
        metalness: item.record.metalness,
      });
      createdAssets.push(imported.id);
      mappings.set(item.sourceId, imported.id);
    }
    const portableModel = await service.assets.importLocalAsset({
      name: `${sceneName} portable model`,
      fileName: `${sceneName}.glb`,
      tags: ['scene-bundle', 'promoted'],
      data: entries['scene.glb'],
      description: `Portable model imported from scene bundle ${manifest.bundleId}.`,
    });
    createdAssets.push(portableModel.id);
    const importedScene = structuredClone(scene);
    for (const object of importedScene.objects) {
      if (object.assetId) object.assetId = mappings.get(object.assetId)!;
      if (object.materialId) object.materialId = mappings.get(object.materialId)!;
    }
    if (importedScene.lighting.environmentAssetId)
      importedScene.lighting.environmentAssetId = mappings.get(
        importedScene.lighting.environmentAssetId,
      )!;
    const validScene = sceneSchema.safeParse(importedScene);
    if (!validScene.success)
      throw new ToolError('INVALID_BUNDLE', 'Remapped bundle scene failed validation.');
    await atomicJson(scenePath, validScene.data);
    const lineage = {
      source: manifest.source,
      bundleId: manifest.bundleId,
      bundleSha256: sha256(archive),
      sourceSceneRevision: manifest.sceneRevision,
      importedAt: new Date().toISOString(),
      sceneName,
      assetIds: createdAssets,
      assetMappings: Object.fromEntries(mappings),
    };
    await atomicJson(
      path.join(service.options.dataDir, 'bundle-imports', `${importId}.json`),
      lineage,
    );
    completed = true;
    return { importId, sceneName, asset: portableModel, sceneRevision: scene.revision, lineage };
  } catch (error) {
    if (journal && transactionPath) {
      try {
        await restoreBundleImport(service.options.dataDir, journal);
        await rm(transactionPath, { force: true });
      } catch (rollbackError) {
        service.recoveryError = {
          code: 'BUNDLE_IMPORT_RECOVERY_FAILED',
          message: `Bundle import rollback is pending startup recovery: ${String(rollbackError)}`,
        };
        throw new ToolError(
          'BUNDLE_IMPORT_RECOVERY_FAILED',
          `Bundle import failed and rollback is pending startup recovery: ${String(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    if (journal)
      await releaseBundleReservation(service.options.dataDir, journal).catch(() => undefined);
    if (completed && transactionPath)
      await rm(transactionPath, { force: true }).catch(() => undefined);
  }
}
