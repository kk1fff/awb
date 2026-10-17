import * as THREE from 'three';

function box(group: THREE.Group, size: [number, number, number], at: [number, number, number], material: THREE.Material, rotation: [number, number, number] = [0, 0, 0]) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...at);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function sphere(group: THREE.Group, size: [number, number, number], at: [number, number, number], material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), material);
  mesh.scale.set(...size);
  mesh.position.set(...at);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

function canvasPattern(kind: string): THREE.CanvasTexture | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
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
    ctx.fillStyle = kind.includes('siding') ? '#b0a797' : '#a59b8d';
    ctx.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 20) {
      ctx.fillStyle = 'rgba(38,34,29,.18)';
      ctx.fillRect(0, y, 256, 2);
      ctx.fillStyle = 'rgba(245,239,225,.12)';
      ctx.fillRect(0, y + 3, 256, 1);
      for (let i = 0; i < 22; i++) {
        const x = random() * 256;
        ctx.strokeStyle = random() > 0.5 ? 'rgba(38,22,13,.22)' : 'rgba(239,194,145,.18)';
        ctx.lineWidth = 0.5 + random() * 1.1;
        ctx.beginPath();
        ctx.moveTo(x, y + 5);
        ctx.bezierCurveTo(x - 10, y + 8, x + 12, y + 12, x + (random() - 0.5) * 12, y + 18);
        ctx.stroke();
      }
    }
  } else if (kind.includes('shingle')) {
    ctx.fillStyle = '#33383a';
    ctx.fillRect(0, 0, 256, 256);
    for (let row = 0; row < 16; row++) {
      const y = row * 16;
      const offset = row % 2 ? -16 : 0;
      for (let col = -1; col < 9; col++) {
        const x = col * 32 + offset;
        const shade = 44 + Math.floor(random() * 28);
        ctx.fillStyle = `rgb(${shade},${shade + 3},${shade + 5})`;
        ctx.fillRect(x + 1, y + 1, 30, 14);
        ctx.fillStyle = 'rgba(220,226,228,.13)';
        ctx.fillRect(x + 2, y + 2, 28, 1);
        ctx.fillStyle = 'rgba(8,10,12,.45)';
        ctx.fillRect(x + 1, y + 14, 30, 2);
      }
    }
  } else if (kind.includes('stone')) {
    ctx.fillStyle = '#777a73';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 150; i++) {
      const x = random() * 256;
      const y = random() * 256;
      const r = 2 + random() * 13;
      const shade = 74 + Math.floor(random() * 82);
      ctx.fillStyle = `rgba(${shade},${shade + 2},${shade - 3},${0.1 + random() * 0.24})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.4, r, random() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (kind.includes('glass')) {
    ctx.fillStyle = '#9bbcc1';
    ctx.fillRect(0, 0, 256, 256);
    const grad = ctx.createLinearGradient(0, 0, 256, 256);
    grad.addColorStop(0, 'rgba(255,255,255,.62)');
    grad.addColorStop(0.35, 'rgba(235,249,246,.12)');
    grad.addColorStop(0.65, 'rgba(74,117,124,.14)');
    grad.addColorStop(1, 'rgba(255,255,255,.35)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 256);
  } else {
    ctx.fillStyle = '#31533b';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const shade = 42 + Math.floor(random() * 80);
      ctx.fillStyle = `rgba(${shade - 14},${shade},${shade - 12},${0.08 + random() * 0.28})`;
      ctx.beginPath();
      ctx.arc(random() * 256, random() * 256, 1 + random() * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  texture.anisotropy = 4;
  return texture;
}

export function createSurfaceMaterial(id: string): THREE.MeshStandardMaterial {
  const table: Record<string, [string, number, number]> = {
    'builtin:cedar-siding': ['#b6805d', 0.88, 0],
    'builtin:dark-shingles': ['#44494b', 0.92, 0],
    'builtin:aged-timber': ['#77543d', 0.83, 0],
    'builtin:basalt-stone': ['#777b75', 0.94, 0],
    'builtin:window-glass': ['#9bc1c7', 0.12, 0.08],
    'builtin:forest-canopy': ['#31583c', 0.9, 0],
    'builtin:forest-floor': ['#66705a', 0.98, 0],
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
    const cedar = get('builtin:cedar-siding'), stone = get('builtin:basalt-stone');
    box(group, [8, 3.5, 6], [0, -0.7, 0], cedar);
    box(group, [8.2, 0.55, 6.2], [0, -2.72, 0], stone);
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
  } else if (id === 'builtin:pnw-gable-roof') {
    const roof = get('builtin:dark-shingles'), timber = get('builtin:aged-timber');
    const slope = 0.51;
    box(group, [5.35, 0.22, 7.1], [-2.15, 0.45, 0], roof, [0, 0, slope]);
    box(group, [5.35, 0.22, 7.1], [2.15, 0.45, 0], roof, [0, 0, -slope]);
    box(group, [0.28, 0.3, 7.2], [0, 1.9, 0], timber);
    box(group, [0.16, 0.55, 7.25], [-4.42, -0.55, 0], timber, [0, 0, -slope]);
    box(group, [0.16, 0.55, 7.25], [4.42, -0.55, 0], timber, [0, 0, slope]);
  } else if (id === 'builtin:pnw-porch') {
    const timber = get('builtin:aged-timber'), stone = get('builtin:basalt-stone'), cream = get('builtin:painted-cream');
    box(group, [4.5, 0.28, 1.85], [0, -1.15, -0.7], timber);
    box(group, [4.7, 0.22, 2.35], [0, 2.75, -0.72], get('builtin:dark-shingles'), [0.16, 0, 0]);
    box(group, [4.6, 0.2, 0.22], [0, 2.62, -0.55], timber);
    for (const x of [-1.8, 1.8]) {
      box(group, [0.22, 3.85, 0.22], [x, 0.75, -0.55], timber);
      box(group, [0.42, 0.12, 0.42], [x, 2.73, -0.55], cream);
    }
    for (let i = 1; i <= 3; i++) box(group, [4.4, 0.16, 0.32], [0, -1.34 - i * 0.18, -0.9 - i * 0.28], stone);
    box(group, [4.5, 0.18, 0.12], [0, -0.05, -1.48], timber);
    for (let x = -2.0; x <= 2.01; x += 0.4) box(group, [0.06, 0.75, 0.06], [x, -0.48, -1.48], cream);
  } else if (id === 'builtin:pnw-window') {
    const timber = get('builtin:aged-timber'), glass = get('builtin:window-glass'), cream = get('builtin:painted-cream');
    box(group, [1.5, 1.9, 0.18], [0, 0, 0], timber);
    box(group, [1.24, 1.64, 0.08], [0, 0, 0.11], glass);
    for (const x of [-0.68, 0.68]) box(group, [0.12, 2.0, 0.22], [x, 0, 0], cream);
    for (const y of [-0.88, 0.88]) box(group, [1.5, 0.12, 0.22], [0, y, 0], cream);
    box(group, [0.08, 0.82, 0.12], [0, 0.42, 0.14], cream);
    box(group, [1.22, 0.08, 0.12], [0, 0.42, 0.14], cream);
    box(group, [1.8, 0.12, 0.3], [0, -1.02, 0], timber);
  } else if (id === 'builtin:pnw-front-door') {
    const timber = get('builtin:aged-timber'), glass = get('builtin:window-glass'), cream = get('builtin:painted-cream');
    box(group, [1.18, 2.22, 0.18], [0, 0, 0], timber);
    box(group, [0.72, 0.78, 0.08], [0, 0.55, 0.13], glass);
    box(group, [0.78, 0.08, 0.08], [0, 0.55, 0.19], cream);
    for (const x of [-0.43, 0.43]) box(group, [0.08, 0.84, 0.08], [x, 0.55, 0.19], cream);
    for (const y of [-0.2, -0.67]) box(group, [0.7, 0.32, 0.09], [0, y, 0.15], timber);
    sphere(group, [0.08, 0.08, 0.08], [0.42, -0.02, 0.2], cream);
  } else if (id === 'builtin:pnw-evergreen') {
    const timber = get('builtin:aged-timber'), foliage = get('builtin:forest-canopy');
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.42, 4.4, 12), timber);
    trunk.position.y = -2.2;
    trunk.castShadow = true;
    group.add(trunk);
    for (let i = 0; i < 5; i++) {
      const height = 3.4 - i * 0.38;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.55 - i * 0.19, height, 12), foliage.clone());
      cone.position.y = -0.7 + i * 1.45;
      cone.castShadow = cone.receiveShadow = true;
      group.add(cone);
    }
  } else if (id === 'builtin:pnw-fern') {
    const foliage = get('builtin:forest-canopy');
    sphere(group, [0.38, 0.34, 0.38], [0, -0.18, 0], foliage);
    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2;
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.12, 1.1, 5), foliage.clone());
      leaf.position.set(Math.cos(angle) * 0.46, 0.12, Math.sin(angle) * 0.46);
      leaf.rotation.z = -Math.cos(angle) * 0.75;
      leaf.rotation.x = Math.sin(angle) * 0.75;
      leaf.castShadow = true;
      group.add(leaf);
    }
  } else if (id === 'builtin:pnw-stone-path') {
    const stone = get('builtin:basalt-stone'), cream = get('builtin:painted-cream');
    const positions: [number, number, number][] = [[-0.75, 0, -0.25], [-0.25, 0.02, 0.25], [0.3, 0, -0.3], [0.8, 0.01, 0.24]];
    positions.forEach(([x, y, z], i) => sphere(group, [0.58, 0.14, 0.48], [x, y, z], i % 2 ? stone.clone() : cream.clone()));
  } else if (id === 'builtin:pnw-boulder') {
    const stone = get('builtin:basalt-stone');
    sphere(group, [1.35, 0.84, 1.15], [0, 0, 0], stone);
    const moss = get('builtin:forest-canopy');
    sphere(group, [1.1, 0.16, 0.8], [0, 0.34, 0], moss);
  }
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
