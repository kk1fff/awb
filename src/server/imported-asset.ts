import { Box3, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import path from 'node:path';
import { ToolError } from '../engine/scene.js';
import type { AssetRecord } from '../shared/schema.js';

export const MAX_ASSET_BYTES = 100 * 1024 * 1024;
export type ImportedKind = AssetRecord['kind'];

export function kindForFile(fileName: string): ImportedKind | undefined {
  switch (path.extname(fileName).toLowerCase()) {
    case '.glb':
      return 'model';
    case '.hdr':
      return 'environment';
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp':
      return 'material';
    default:
      return undefined;
  }
}

function fail(message: string): never {
  throw new ToolError('INVALID_ASSET_FILE', message);
}

function imageFormat(data: Buffer): string | undefined {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return undefined;
}

function hasCompletePng(data: Buffer): boolean {
  if (
    data.length < 45 ||
    data.readUInt32BE(8) !== 13 ||
    data.toString('ascii', 12, 16) !== 'IHDR' ||
    !data.readUInt32BE(16) ||
    !data.readUInt32BE(20)
  )
    return false;
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > data.length) return false;
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (type === 'IEND') return length === 0 && end === data.length;
    offset = end;
  }
  return false;
}

function hasHdrPixels(data: Buffer, width: number, height: number, line: string): boolean {
  const atLine = data.indexOf(Buffer.from(line, 'ascii'));
  if (atLine < 0) return false;
  let offset = atLine + line.length;
  if (data[offset] === 13 && data[offset + 1] === 10) offset += 2;
  else if (data[offset] === 10) offset++;
  for (let y = 0; y < height; y++) {
    if (offset + 4 > data.length) return false;
    const isRle =
      data[offset] === 2 &&
      data[offset + 1] === 2 &&
      data[offset + 2] === width >> 8 &&
      data[offset + 3] === (width & 255);
    if (!isRle) return offset + (height - y) * width * 4 <= data.length;
    offset += 4;
    for (let channel = 0; channel < 4; channel++) {
      let written = 0;
      while (written < width) {
        if (offset >= data.length) return false;
        const code = data[offset++];
        if (code === 0) return false;
        if (code > 128) {
          const count = code - 128;
          if (offset >= data.length || count > width - written) return false;
          offset++;
          written += count;
        } else {
          if (code > width - written || offset + code > data.length) return false;
          offset += code;
          written += code;
        }
      }
    }
  }
  return true;
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface GltfDoc {
  asset?: { version?: string };
  buffers?: { byteLength?: number; uri?: string }[];
  bufferViews?: {
    buffer?: number;
    byteOffset?: number;
    byteLength?: number;
    byteStride?: number;
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count?: number;
    type?: string;
  }[];
  meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  images?: { uri?: string }[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}

function glbBounds(data: Buffer): [number, number, number] {
  if (
    data.length < 20 ||
    data.toString('ascii', 0, 4) !== 'glTF' ||
    data.readUInt32LE(4) !== 2 ||
    data.readUInt32LE(8) !== data.length
  )
    return fail('The GLB header is invalid or the file is truncated.');
  const jsonLength = data.readUInt32LE(12);
  const jsonType = data.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a || jsonLength < 2 || 20 + jsonLength > data.length)
    return fail('The GLB JSON chunk is missing or invalid.');
  let doc: GltfDoc;
  try {
    doc = JSON.parse(
      data
        .toString('utf8', 20, 20 + jsonLength)
        .replace(/\0+\s*$/, '')
        .trim(),
    ) as GltfDoc;
  } catch {
    return fail('The GLB JSON chunk is not valid JSON.');
  }
  if (doc.asset?.version !== '2.0') return fail('Only glTF 2.0 GLB files are supported.');
  if ((doc.buffers ?? []).some((buffer) => buffer.uri))
    return fail('GLB assets must be self-contained; external buffer references are not supported.');
  if ((doc.images ?? []).some((image) => image.uri && !image.uri.startsWith('data:')))
    return fail('GLB textures must be embedded; external image references are not supported.');
  const binOffset = 20 + jsonLength;
  let bin = data.subarray(0, 0);
  if (binOffset < data.length) {
    if (binOffset + 8 > data.length) return fail('The GLB binary chunk header is truncated.');
    const length = data.readUInt32LE(binOffset);
    if (data.readUInt32LE(binOffset + 4) !== 0x004e4942 || binOffset + 8 + length > data.length)
      return fail('The GLB binary chunk is invalid or truncated.');
    bin = data.subarray(binOffset + 8, binOffset + 8 + length);
  }
  if (doc.buffers?.[0]?.byteLength && doc.buffers[0].byteLength > bin.length)
    return fail('The GLB binary data is incomplete.');

  const accessors = doc.accessors ?? [];
  const views = doc.bufferViews ?? [];
  const meshes = doc.meshes ?? [];
  const nodes = doc.nodes ?? [];
  const bounds = new Box3();
  const readAccessorBounds = (index: number, matrix: Matrix4) => {
    const accessor = accessors[index];
    if (
      !accessor ||
      accessor.type !== 'VEC3' ||
      accessor.componentType !== 5126 ||
      !Number.isInteger(accessor.count) ||
      !accessor.count ||
      accessor.count! < 1
    )
      return fail('House model position data must use nonempty float VEC3 accessors.');
    const view = accessor.bufferView === undefined ? undefined : views[accessor.bufferView];
    if (!view || (view.buffer !== undefined && view.buffer !== 0))
      return fail('The GLB position data is missing or uses an unsupported buffer.');
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = view.byteStride ?? 12;
    if (
      stride < 12 ||
      start < 0 ||
      start + (accessor.count! - 1) * stride + 12 >
        (view.byteOffset ?? 0) + (view.byteLength ?? 0) ||
      start + (accessor.count! - 1) * stride + 12 > bin.length
    )
      return fail('The GLB position data points outside its binary chunk.');
    const local = new Box3();
    for (let i = 0; i < accessor.count!; i++) {
      const at = start + i * stride;
      const point = new Vector3(
        bin.readFloatLE(at),
        bin.readFloatLE(at + 4),
        bin.readFloatLE(at + 8),
      );
      if (![point.x, point.y, point.z].every(Number.isFinite))
        return fail('The GLB contains non-finite vertex positions.');
      local.expandByPoint(point);
    }
    if (!local.isEmpty()) {
      for (const x of [local.min.x, local.max.x])
        for (const y of [local.min.y, local.max.y])
          for (const z of [local.min.z, local.max.z])
            bounds.expandByPoint(new Vector3(x, y, z).applyMatrix4(matrix));
    }
  };
  const compose = (node: GltfNode): Matrix4 => {
    if (node.matrix?.length === 16) return new Matrix4().fromArray(node.matrix);
    const translation = new Vector3(
      ...((node.translation as [number, number, number] | undefined) ?? [0, 0, 0]),
    );
    const rotation =
      node.rotation?.length === 4
        ? new Quaternion(...(node.rotation as [number, number, number, number]))
        : new Quaternion().setFromEuler(new Euler(0, 0, 0));
    const scale = new Vector3(
      ...((node.scale as [number, number, number] | undefined) ?? [1, 1, 1]),
    );
    return new Matrix4().compose(translation, rotation, scale);
  };
  const visited = new Set<number>();
  const walk = (index: number, parent: Matrix4) => {
    if (visited.has(index)) return;
    const node = nodes[index];
    if (!node) return fail('The GLB scene graph references a missing node.');
    visited.add(index);
    const world = parent.clone().multiply(compose(node));
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (!mesh) return fail('The GLB scene graph references a missing mesh.');
      for (const primitive of mesh.primitives ?? []) {
        const position = primitive.attributes?.POSITION;
        if (position !== undefined) readAccessorBounds(position, world);
      }
    }
    for (const child of node.children ?? []) walk(child, world);
  };
  const roots =
    doc.scenes?.[doc.scene ?? 0]?.nodes ??
    nodes.map((_, i) => i).filter((i) => !nodes.some((node) => node.children?.includes(i)));
  for (const root of roots) walk(root, new Matrix4());
  if (bounds.isEmpty()) return fail('The GLB contains no renderable mesh positions.');
  const size = bounds.getSize(new Vector3());
  if (![size.x, size.y, size.z].every((n) => Number.isFinite(n) && n > 0))
    return fail('The GLB model must have positive bounds on all three axes.');
  return [size.x, size.y, size.z];
}

export function validateImportedAsset(
  fileName: string,
  data: Buffer,
): { kind: ImportedKind; format: string; bounds?: [number, number, number] } {
  if (!data.length) return fail('Choose a nonempty file.');
  if (data.length > MAX_ASSET_BYTES) return fail('Files must be 100 MiB or smaller.');
  const kind = kindForFile(fileName);
  if (!kind) return fail('Choose a GLB model, HDR environment, or PNG/JPEG/WebP surface texture.');
  if (kind === 'model') {
    if (data.toString('ascii', 0, 4) !== 'glTF')
      return fail('The selected .glb file does not contain a GLB model.');
    return { kind, format: 'glb', bounds: glbBounds(data) };
  }
  if (kind === 'environment') {
    const header = data.toString('ascii', 0, Math.min(data.length, 128));
    const resolution = /\n-Y\s+(\d+)\s+\+X\s+(\d+)/.exec(header);
    if (!/^#\?(?:RADIANCE|RGBE)\b/.test(header) || !resolution)
      return fail('The selected .hdr file is not a supported Radiance environment map.');
    if (Number(resolution[1]) < 4 || Number(resolution[2]) < 8)
      return fail('HDR environments must be at least 8 pixels wide by 4 pixels high.');
    if (!hasHdrPixels(data, Number(resolution[2]), Number(resolution[1]), resolution[0]))
      return fail('The selected .hdr file has truncated or invalid pixel data.');
    return { kind, format: 'hdr' };
  }
  const actual = imageFormat(data);
  if (!actual) return fail('The selected file is not a valid PNG, JPEG, or WebP image.');
  const extension = path.extname(fileName).toLowerCase();
  if (
    (extension === '.png' && actual !== 'png') ||
    (['.jpg', '.jpeg'].includes(extension) && actual !== 'jpeg') ||
    (extension === '.webp' && actual !== 'webp')
  )
    return fail('The image contents do not match the file extension.');
  if (actual === 'png' && !hasCompletePng(data))
    return fail('The selected PNG is truncated or malformed.');
  if (
    actual === 'jpeg' &&
    (data.length < 4 || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9)
  )
    return fail('The selected JPEG is truncated or malformed.');
  if (
    actual === 'webp' &&
    (data.length < 20 ||
      data.readUInt32LE(4) + 8 !== data.length ||
      !['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16)))
  )
    return fail('The selected WebP is truncated or malformed.');
  return { kind, format: actual };
}
