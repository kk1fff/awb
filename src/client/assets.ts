import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function box(
  group: THREE.Group,
  size: [number, number, number],
  at: [number, number, number],
  material: THREE.Material,
  rotation: [number, number, number] = [0, 0, 0],
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...at);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function sphere(
  group: THREE.Group,
  size: [number, number, number],
  at: [number, number, number],
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), material);
  mesh.scale.set(...size);
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function cylinderBetween(
  group: THREE.Group,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  material: THREE.Material,
  sides = 8,
) {
  const delta = to.clone().sub(from);
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.72, radius, delta.length(), sides),
    material,
  );
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function tinted(material: THREE.MeshStandardMaterial, color: string) {
  const result = material.clone();
  result.color.set(color);
  return result;
}

function mergeParts(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) continue;
    child.updateMatrix();
    const materialParts = parts.get(child.material) ?? [];
    let geometry = child.geometry.clone();
    if (geometry.index) {
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      geometry = nonIndexed;
    }
    materialParts.push(geometry.applyMatrix4(child.matrix));
    parts.set(child.material, materialParts);
    child.geometry.dispose();
  }
  group.clear();
  for (const [material, geometries] of parts) {
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

function canvasPattern(kind: string): THREE.CanvasTexture | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const random = (() => {
    let seed = [...kind].reduce((acc, char) => acc * 31 + char.charCodeAt(0), 17) >>> 0;
    return () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };
  })();
  if (kind.includes('siding') || kind.includes('timber')) {
    const siding = kind.includes('siding');
    ctx.fillStyle = siding ? '#ded4c2' : '#d8c4aa';
    ctx.fillRect(0, 0, 512, 512);
    const course = siding ? 28 : 84;
    for (let y = 0; y < 512; y += course) {
      const shade = 0.88 + random() * 0.18;
      ctx.fillStyle = `rgba(255,249,236,${0.08 + random() * 0.1})`;
      ctx.fillRect(0, y, 512, siding ? 3 : 2);
      ctx.fillStyle = `rgba(45,34,24,${siding ? 0.16 : 0.05})`;
      ctx.fillRect(0, y + course - (siding ? 3 : 1), 512, siding ? 3 : 1);
      ctx.fillStyle = `rgba(126,91,59,${0.025 + random() * 0.035})`;
      ctx.fillRect(0, y + 4, 512, course - 7);
      for (let i = 0; i < (siding ? 28 : 45); i++) {
        const x = random() * 512;
        ctx.strokeStyle =
          random() > 0.5
            ? `rgba(47,31,21,${0.08 + random() * 0.12})`
            : `rgba(255,231,198,${0.08 + random() * 0.12})`;
        ctx.lineWidth = 0.5 + random() * (siding ? 1.2 : 2.2);
        ctx.beginPath();
        ctx.moveTo(x, y + 5);
        ctx.bezierCurveTo(
          x - 14,
          y + course * 0.3,
          x + 18,
          y + course * 0.65,
          x + (random() - 0.5) * 18,
          y + course - 3,
        );
        ctx.stroke();
      }
      if (!siding) {
        for (let i = 0; i < 4; i++) {
          const x = random() * 512,
            yy = y + random() * course;
          ctx.strokeStyle = `rgba(53,34,21,${0.12 + random() * 0.14})`;
          ctx.beginPath();
          ctx.ellipse(x, yy, 4 + random() * 8, 1.5 + random() * 3, random(), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  } else if (kind.includes('shingle')) {
    ctx.fillStyle = '#d4d5d1';
    ctx.fillRect(0, 0, 512, 512);
    for (let row = 0; row < 32; row++) {
      const y = row * 16;
      const offset = row % 2 ? -18 : 0;
      for (let col = -1; col < 18; col++) {
        const x = col * 36 + offset;
        const shade = 92 + Math.floor(random() * 42);
        ctx.fillStyle = `rgba(${shade},${shade + 2},${shade + 3},${0.64 + random() * 0.2})`;
        ctx.fillRect(x + 1, y + 1, 34, 15);
        ctx.fillStyle = `rgba(255,255,255,${0.07 + random() * 0.12})`;
        ctx.fillRect(x + 2, y + 2, 32, 1);
        ctx.fillStyle = 'rgba(24,28,29,.27)';
        ctx.fillRect(x + 1, y + 14, 34, 2);
        for (let granule = 0; granule < 7; granule++) {
          ctx.fillStyle = `rgba(35,40,41,${0.08 + random() * 0.1})`;
          ctx.fillRect(x + random() * 34, y + random() * 13, 1 + random() * 2, 1);
        }
      }
    }
  } else if (kind.includes('stone')) {
    ctx.fillStyle = '#deded6';
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 460; i++) {
      const x = random() * 512;
      const y = random() * 512;
      const r = 2 + random() * 19;
      const shade = 105 + Math.floor(random() * 105);
      ctx.fillStyle = `rgba(${shade},${shade + 2},${shade - 3},${0.1 + random() * 0.24})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.4, r, random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind.includes('glass')) {
    ctx.fillStyle = '#b8d0ca';
    ctx.fillRect(0, 0, 512, 512);
    const grad = ctx.createLinearGradient(0, 0, 512, 512);
    grad.addColorStop(0, 'rgba(255,255,255,.68)');
    grad.addColorStop(0.35, 'rgba(235,249,246,.12)');
    grad.addColorStop(0.65, 'rgba(74,117,124,.14)');
    grad.addColorStop(1, 'rgba(255,255,255,.42)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 512);
  } else {
    const forestFloor = kind.includes('forest-floor');
    ctx.fillStyle = forestFloor ? '#adb69b' : '#d7dfcb';
    ctx.fillRect(0, 0, 512, 512);
    if (forestFloor) {
      for (let i = 0; i < 90; i++) {
        const x = random() * 512,
          y = random() * 512;
        const radius = 8 + random() * 34;
        const moss = random() > 0.4;
        ctx.fillStyle = moss
          ? `rgba(73,103,58,${0.08 + random() * 0.16})`
          : `rgba(92,69,50,${0.07 + random() * 0.13})`;
        ctx.beginPath();
        ctx.ellipse(
          x,
          y,
          radius * (0.7 + random() * 0.8),
          radius * 0.4,
          random() * Math.PI,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
    for (let i = 0; i < (forestFloor ? 2500 : 1800); i++) {
      const shade = 72 + Math.floor(random() * 130);
      const alpha = forestFloor ? 0.06 + random() * 0.18 : 0.08 + random() * 0.24;
      ctx.fillStyle = forestFloor
        ? `rgba(${shade - 25},${shade + 2},${shade - 38},${alpha})`
        : `rgba(${shade - 22},${shade + 2},${shade - 18},${alpha})`;
      ctx.beginPath();
      ctx.arc(
        random() * 512,
        random() * 512,
        0.6 + random() * (forestFloor ? 4.5 : 5),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
    if (forestFloor) {
      for (let i = 0; i < 42; i++) {
        ctx.save();
        ctx.translate(random() * 512, random() * 512);
        ctx.rotate(random() * Math.PI);
        ctx.fillStyle = `rgba(${70 + Math.floor(random() * 45)},${48 + Math.floor(random() * 35)},${35 + Math.floor(random() * 24)},.24)`;
        ctx.beginPath();
        ctx.ellipse(0, 0, 2 + random() * 5, 0.6 + random() * 1.2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(kind.includes('forest-floor') ? 5 : 3, kind.includes('forest-floor') ? 5 : 3);
  texture.anisotropy = 4;
  return texture;
}

export function createSurfaceMaterial(id: string): THREE.MeshStandardMaterial {
  const table: Record<string, [string, number, number]> = {
    'builtin:cedar-siding': ['#ad9275', 0.88, 0],
    'builtin:dark-shingles': ['#626766', 0.92, 0],
    'builtin:aged-timber': ['#725a43', 0.83, 0],
    'builtin:basalt-stone': ['#777b75', 0.94, 0],
    'builtin:window-glass': ['#9bc1c7', 0.12, 0.08],
    'builtin:forest-canopy': ['#55734c', 0.94, 0],
    'builtin:forest-floor': ['#797d61', 0.98, 0],
    'builtin:painted-cream': ['#ded4c1', 0.82, 0],
  };
  const [color, roughness, metalness] = table[id] ?? ['#7a9d82', 0.86, 0];
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  material.map = canvasPattern(id) ?? null;
  if (id === 'builtin:window-glass') {
    material.transparent = true;
    material.opacity = 0.62;
    material.side = THREE.DoubleSide;
  }
  return material;
}

export function buildBuiltinModel(id: string): THREE.Group {
  const group = new THREE.Group();
  const get = (id: string) => createSurfaceMaterial(id);
  if (id === 'builtin:pnw-craftsman-shell') {
    const cedar = get('builtin:cedar-siding'),
      stone = get('builtin:basalt-stone');
    const trim = get('builtin:painted-cream');
    box(group, [8, 3.5, 6], [0, -0.7, 0], cedar);
    box(group, [8, 0.55, 6.1], [0, -2.72, 0], stone);
    const gable = new THREE.Shape();
    gable.moveTo(-4, 0);
    gable.lineTo(4, 0);
    gable.lineTo(0, 2.55);
    gable.closePath();
    const geo = new THREE.ExtrudeGeometry(gable, { depth: 6, bevelEnabled: false });
    geo.translate(0, 1.05, -3);
    const front = new THREE.Mesh(geo, cedar);
    front.castShadow = front.receiveShadow = true;
    group.add(front);

    // Fine lap courses wrap each wall face and stop below the gable.
    for (let y = -2.35; y <= 0.95; y += 0.25) {
      box(group, [7.88, 0.105, 0.045], [0, y, -3.005], cedar);
      box(group, [7.88, 0.105, 0.045], [0, y, 3.005], cedar);
      box(group, [0.045, 0.105, 5.88], [-3.97, y, 0], cedar);
      box(group, [0.045, 0.105, 5.88], [3.97, y, 0], cedar);
    }
    // Corner boards, window-height belt trim and a visible gable verge.
    for (const x of [-3.86, 3.86]) {
      box(group, [0.16, 3.48, 0.12], [x, -0.7, -3.02], trim);
      box(group, [0.16, 3.48, 0.12], [x, -0.7, 3.02], trim);
    }
    for (const x of [-3.98, 3.98]) {
      box(group, [0.12, 3.48, 0.16], [x - Math.sign(x) * 0.06, -0.7, -2.86], trim);
      box(group, [0.12, 3.48, 0.16], [x - Math.sign(x) * 0.06, -0.7, 2.86], trim);
    }
    box(group, [7.9, 0.16, 0.11], [0, -1.05, -3.04], trim);
    box(group, [7.9, 0.16, 0.11], [0, -1.05, 3.04], trim);
    for (const faceZ of [-3.055, 3.055]) {
      for (const side of [-1, 1]) {
        const verge = box(group, [2.03, 0.12, 0.08], [side * 1.91, 2.25, faceZ], trim);
        verge.rotation.z = side < 0 ? 0.57 : -0.57;
      }
      box(group, [3.1, 0.1, 0.06], [0, 1.38, faceZ], get('builtin:aged-timber'));
    }
  } else if (id === 'builtin:pnw-gable-roof') {
    const roof = get('builtin:dark-shingles'),
      timber = get('builtin:aged-timber');
    const slope = 0.51;
    const pitchFaces = [
      { x: -2.05, sign: 1 },
      { x: 2.05, sign: -1 },
    ];
    for (const face of pitchFaces) {
      box(group, [5.15, 0.22, 6.8], [face.x, 0.15, 0], roof, [0, 0, face.sign * slope]);
      // Raised shingle courses make the eaves and alternating tabs read in profile.
      const shingle = get('builtin:dark-shingles');
      for (let row = 0; row < 8; row++) {
        const localX = -2.25 + row * 0.58;
        for (let col = 0; col < 10; col++) {
          const localZ = -3.0 + col * 0.66 + (row % 2 ? 0.28 : 0);
          const tile = box(
            group,
            [0.52, 0.035, 0.48],
            [
              face.x + localX * Math.cos(slope),
              0.15 + localX * Math.sin(face.sign * slope) + 0.13,
              localZ,
            ],
            shingle,
            [0, 0, face.sign * slope],
          );
          tile.position.y -= 0.035;
        }
      }
    }
    // Ridge cap and fascia finish the roof silhouette without changing its envelope.
    box(group, [0.36, 0.2, 6.88], [0, 1.42, 0], timber);
    box(group, [0.12, 0.18, 6.84], [-4.24, -0.96, 0], timber, [0, 0, -slope]);
    box(group, [0.12, 0.18, 6.84], [4.24, -0.96, 0], timber, [0, 0, slope]);
    for (const side of [-1, 1]) {
      for (let z = -3.1; z <= 3.11; z += 0.78) {
        box(group, [0.12, 0.35, 0.12], [side * 4.08, -1.0, z], timber, [
          0,
          0,
          side < 0 ? -slope : slope,
        ]);
      }
    }
  } else if (id === 'builtin:pnw-porch') {
    const timber = get('builtin:aged-timber'),
      stone = get('builtin:basalt-stone'),
      cream = get('builtin:painted-cream');
    box(group, [4.5, 0.28, 1.85], [0, -1.15, -0.7], timber);
    box(group, [4.55, 0.18, 2.22], [0, 1.82, -0.72], get('builtin:dark-shingles'), [0.16, 0, 0]);
    box(group, [4.55, 0.16, 0.18], [0, 1.78, -0.55], timber);
    for (const x of [-1.8, 1.8]) {
      box(group, [0.22, 3.15, 0.22], [x, 0.18, -0.55], timber);
      box(group, [0.36, 0.13, 0.36], [x, 1.87, -0.55], cream);
      box(group, [0.3, 0.18, 0.3], [x, -1.35, -0.55], stone);
      for (const side of [-1, 1]) {
        const brace = box(group, [0.12, 0.72, 0.12], [x - side * 0.18, 1.34, -0.55], timber);
        brace.rotation.z = side * 0.65;
      }
    }
    for (let i = 1; i <= 3; i++)
      box(group, [4.4, 0.16, 0.32], [0, -1.34 - i * 0.18, -0.9 - i * 0.28], stone);
    box(group, [4.5, 0.18, 0.12], [0, -0.05, -1.48], timber);
    for (let x = -2.0; x <= 2.01; x += 0.4)
      box(group, [0.06, 0.75, 0.06], [x, -0.48, -1.48], cream);
  } else if (id === 'builtin:pnw-window') {
    const timber = get('builtin:aged-timber'),
      glass = get('builtin:window-glass'),
      cream = get('builtin:painted-cream');
    box(group, [1.28, 1.64, 0.12], [0, 0, 0], timber);
    box(group, [1.08, 1.42, 0.035], [0, 0.02, 0.045], glass);
    for (const x of [-0.61, 0.61]) box(group, [0.1, 1.74, 0.1], [x, 0, 0.005], cream);
    for (const y of [-0.8, 0.8]) box(group, [1.36, 0.1, 0.1], [0, y, 0.005], cream);
    // A divided upper sash, recessed lower pane and projecting sill give the window depth.
    box(group, [1.05, 0.08, 0.025], [0, 0.31, 0.072], cream);
    for (const x of [-0.25, 0.25]) box(group, [0.045, 0.44, 0.025], [x, 0.56, 0.072], cream);
    box(group, [1.4, 0.12, 0.18], [0, -0.83, 0], timber);
    box(group, [1.36, 0.08, 0.12], [0, 0.86, -0.005], cream);
  } else if (id === 'builtin:pnw-front-door') {
    const timber = get('builtin:aged-timber'),
      glass = get('builtin:window-glass'),
      cream = get('builtin:painted-cream');
    box(group, [1.16, 2.1, 0.12], [0, 0, 0], timber);
    box(group, [0.72, 0.76, 0.035], [0, 0.5, 0.05], glass);
    box(group, [0.8, 0.06, 0.018], [0, 0.5, 0.068], cream);
    for (const x of [-0.37, 0.37]) box(group, [0.045, 0.8, 0.018], [x, 0.5, 0.068], cream);
    for (const y of [-0.28, -0.69]) {
      box(group, [0.74, 0.28, 0.045], [0, y, 0.056], timber);
      box(group, [0.58, 0.18, 0.018], [0, y, 0.08], tinted(timber, '#896849'));
    }
    box(group, [1.18, 0.08, 0.14], [0, 1.08, 0], cream);
    sphere(group, [0.065, 0.065, 0.065], [0.42, -0.02, 0.05], cream);
  } else if (id === 'builtin:pnw-evergreen') {
    const timber = get('builtin:aged-timber'),
      foliage = get('builtin:forest-canopy');
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.35, 9, 12), timber);
    trunk.position.y = 0;
    trunk.castShadow = true;
    group.add(trunk);
    const random = (() => {
      let seed = 0x51f15e;
      return () => {
        seed = (1664525 * seed + 1013904223) >>> 0;
        return seed / 0xffffffff;
      };
    })();
    const greens = ['#526d48', '#60784d', '#456443', '#718151', '#3f5b3e'].map((color) =>
      tinted(foliage, color),
    );
    for (let tier = 0; tier < 7; tier++) {
      const y = -3.25 + tier * 1.18;
      const radius = 1.68 - tier * 0.205;
      const branches = tier < 2 ? 7 : 6;
      for (let branch = 0; branch < branches; branch++) {
        const angle = (branch / branches) * Math.PI * 2 + tier * 0.47 + (random() - 0.5) * 0.2;
        const length = radius * (0.72 + random() * 0.25);
        const rise = -0.16 + random() * 0.2;
        const start = new THREE.Vector3(Math.cos(angle) * 0.12, y, Math.sin(angle) * 0.12);
        const end = new THREE.Vector3(Math.cos(angle) * length, y + rise, Math.sin(angle) * length);
        cylinderBetween(group, start, end, 0.055 - tier * 0.003, timber, 6);
        const cluster = new THREE.Mesh(
          new THREE.SphereGeometry(0.5, 10, 7),
          greens[(tier + branch) % greens.length]!,
        );
        cluster.position.copy(start).lerp(end, 0.73);
        cluster.scale.set(length * 0.62, 0.23 + random() * 0.08, 0.25 + random() * 0.08);
        cluster.rotation.y = -angle;
        cluster.rotation.z = -Math.cos(angle) * 0.08;
        cluster.rotation.x = Math.sin(angle) * 0.08;
        cluster.castShadow = cluster.receiveShadow = true;
        group.add(cluster);
      }
      const crown = new THREE.Mesh(
        new THREE.ConeGeometry(radius * 0.52, 1.2, 9),
        greens[tier % greens.length]!,
      );
      crown.position.set((random() - 0.5) * 0.18, y + 0.05, (random() - 0.5) * 0.18);
      crown.castShadow = crown.receiveShadow = true;
      group.add(crown);
    }
  } else if (id === 'builtin:pnw-fern') {
    const foliage = get('builtin:forest-canopy');
    sphere(group, [0.38, 0.34, 0.38], [0, -0.18, 0], foliage);
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.78, 5), foliage.clone());
      leaf.position.set(Math.cos(angle) * 0.46, -0.02, Math.sin(angle) * 0.46);
      leaf.rotation.z = -Math.cos(angle) * 0.75;
      leaf.rotation.x = Math.sin(angle) * 0.75;
      leaf.castShadow = true;
      group.add(leaf);
    }
  } else if (id === 'builtin:pnw-stone-path') {
    const stone = get('builtin:basalt-stone'),
      cream = get('builtin:painted-cream');
    const positions: [number, number, number][] = [
      [-0.75, 0, -0.25],
      [-0.25, 0.02, 0.25],
      [0.3, 0, -0.3],
      [0.8, 0.01, 0.24],
    ];
    positions.forEach(([x, y, z], i) =>
      sphere(group, [0.58, 0.14, 0.48], [x, y, z], i % 2 ? stone.clone() : cream.clone()),
    );
  } else if (id === 'builtin:pnw-boulder') {
    const stone = get('builtin:basalt-stone');
    sphere(group, [1.35, 0.84, 1.15], [0, 0, 0], stone);
    const moss = get('builtin:forest-canopy');
    sphere(group, [1.1, 0.16, 0.8], [0, 0.34, 0], moss);
  }
  mergeParts(group);
  return group;
}

export function buildOvercastEnvironment(): THREE.DataTexture {
  const width = 256;
  const height = 128;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const horizon = y / height;
    for (let x = 0; x < width; x++) {
      const noise = Math.sin(x * 0.19) * 5 + Math.sin(x * 0.061) * 8;
      const forestBand = horizon > 0.53 && horizon < 0.71 ? noise + 20 : 0;
      const i = (y * width + x) * 4;
      pixels[i] = Math.max(0, Math.min(255, 153 + (1 - horizon) * 68 - forestBand));
      pixels[i + 1] = Math.max(0, Math.min(255, 176 + (1 - horizon) * 62 - forestBand * 0.8));
      pixels[i + 2] = Math.max(0, Math.min(255, 180 + (1 - horizon) * 58 - forestBand * 0.7));
      pixels[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
