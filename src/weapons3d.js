import * as THREE from 'three';

// Weapon models. Most guns come from the low-poly "polygon guns" pack
// (public/models/weapons.glb, one node per item: item_<n>). The pack has no
// shotguns or sci-fi guns, so those are built procedurally below.
//
// Every model is returned in "viewmodel space": origin on the bore line above
// the pistol grip, barrel along +z, with userData points for hands/muzzle/ejection.

// items: pack nodes to combine, len: target length (m), grip: grip position
// along the length from the rear (0..1), bore: bore line below the top (0..1 of height)
const SPECS = {
  m9: { items: [29], len: 0.22, grip: 0.24, bore: 0.18, tint: [0.3, 0.31, 0.34] },
  glock: { items: [29], len: 0.2, grip: 0.24, bore: 0.18, tint: [0.2, 0.22, 0.2] },
  deagle: { items: [29], len: 0.27, grip: 0.24, bore: 0.18 },
  magnum: { items: [33], len: 0.31, grip: 0.18, bore: 0.22 },
  uzi: { items: [53], len: 0.34, grip: 0.48 },
  mp5: { items: [37], len: 0.6, grip: 0.42 },
  mp7: { items: [53], len: 0.38, grip: 0.48, tint: [0.8, 0.7, 0.52] },
  p90: { items: [52], len: 0.5, grip: 0.55 },
  vector: { items: [31], len: 0.55, grip: 0.45 },
  ak47: { items: [5], len: 0.85, grip: 0.36 },
  m4: { items: [6], len: 0.84, grip: 0.38 },
  famas: { items: [22], len: 0.72, grip: 0.55 },
  aug: { items: [2], len: 0.8, grip: 0.4 },
  scar: { items: [9], len: 0.85, grip: 0.4 },
  m249: { items: [11], len: 1.0, grip: 0.42 },
  pkm: { items: [11], len: 1.05, grip: 0.42, tint: [0.62, 0.52, 0.4] },
  svd: { items: [0], len: 1.15, grip: 0.36 },
  m24: { items: [47], len: 1.1, grip: 0.33 },
  barrett: { items: [50], len: 1.3, grip: 0.33 },
  rpg: { items: [43, 44, 41], len: 1.0, grip: 0.42, bore: 0.35 },
};
const PROPS = { knife: 8, grenade: 26, casing: 16, shell: 45 };

let items = null;
export function initWeaponModels(gltf) {
  items = {};
  gltf.scene.updateMatrixWorld(true);
  for (const c of gltf.scene.children) if (c.name.startsWith('item_')) items[Number(c.name.slice(5))] = c;
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    o.material.metalness = 0.4;
    o.material.roughness = 0.42;
  });
}

// A small pack item (knife, grenade, casing, shell) centred at the origin, longest side = size.
export function propModel(name, size) {
  const src = items && items[PROPS[name]];
  if (!src) return null;
  const inner = src.clone(true);
  const box = new THREE.Box3().setFromObject(inner);
  const c = box.getCenter(new THREE.Vector3());
  const d = box.getSize(new THREE.Vector3());
  const s = size / Math.max(d.x, d.y, d.z);
  inner.position.copy(c).multiplyScalar(-s);
  inner.scale.setScalar(s);
  const g = new THREE.Group();
  g.add(inner);
  return g;
}

export function buildWeapon(w) {
  const spec = SPECS[w.id];
  if (!spec || !items || spec.items.some((n) => !items[n])) return proceduralWeapon(w);
  const inner = new THREE.Group();
  for (const n of spec.items) inner.add(items[n].clone(true));
  if (spec.tint) {
    const tint = new THREE.Color(...spec.tint);
    inner.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.color.multiply(tint); } });
  }
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const s = spec.len / size.z;
  const gripZ = box.min.z + spec.grip * size.z;
  const boreY = box.max.y - size.y * (spec.bore ?? 0.3);
  inner.scale.setScalar(s);
  inner.position.set(-((box.min.x + box.max.x) / 2) * s, -boreY * s, -gripZ * s);
  const g = new THREE.Group();
  g.add(inner);
  const H = size.y * s;
  const front = (box.max.z - gripZ) * s;
  finish(g, w, front, H);
  return g;
}

function finish(g, w, front, H) {
  g.userData.muzzle = front;
  const pistol = w.cat === 'pistol';
  g.userData.grip = pistol ? new THREE.Vector3(0, -H * 0.66, -0.012) : new THREE.Vector3(0, -H * 0.42, -0.01);
  g.userData.fore = pistol
    ? new THREE.Vector3(-0.012, -H * 0.8, 0.005)
    : new THREE.Vector3(0, -H * 0.28, Math.min(front * 0.5, 0.32));
  g.userData.eject = new THREE.Vector3(0.025, 0.01, Math.min(0.09, front * 0.2));
}

// ---------------------------------------------------------------- procedural guns
const M = {
  metal: new THREE.MeshStandardMaterial({ color: 0x5d636c, roughness: 0.35, metalness: 0.75 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.5, metalness: 0.45 }),
  poly: new THREE.MeshStandardMaterial({ color: 0x1f2124, roughness: 0.75, metalness: 0.05 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a4422, roughness: 0.6, metalness: 0.0 }),
  red: new THREE.MeshStandardMaterial({ color: 0x8a1c14, roughness: 0.45, metalness: 0.3 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xb08a3a, roughness: 0.3, metalness: 0.9 }),
};
const glowMat = (c, k = 3) => new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(c), emissiveIntensity: k, roughness: 0.4 });

function box(g, mat, w, h, d, x, y, z, rx = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.x = rx;
  g.add(m);
  return m;
}
function tube(g, mat, r, len, x, y, z, seg = 12, r2 = r) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, seg), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z + len / 2);
  g.add(m);
  return m;
}

function proceduralWeapon(w) {
  const g = new THREE.Group();
  let front = 0.5, H = 0.12;
  switch (w.id) {
    case 'pump': case 'spas': {
      const syn = w.id === 'spas';
      const stockM = syn ? M.poly : M.wood;
      box(g, M.dark, 0.05, 0.07, 0.2, 0, -0.01, 0.02);                // receiver
      box(g, stockM, 0.045, 0.06, 0.26, 0, -0.04, -0.2, 0.12);         // stock
      box(g, stockM, 0.04, 0.07, 0.06, 0, -0.07, -0.02, -0.4);          // grip
      tube(g, M.metal, 0.014, 0.5, 0, 0.012, 0.1);                     // barrel
      tube(g, M.dark, 0.012, 0.4, 0, -0.022, 0.1);                     // magazine tube
      box(g, stockM, 0.05, 0.045, 0.14, 0, -0.022, 0.32);              // pump
      for (let i = 0; i < 5; i++) box(g, M.dark, 0.052, 0.004, 0.012, 0, -0.022, 0.27 + i * 0.024);
      box(g, M.metal, 0.006, 0.006, 0.4, 0, 0.03, 0.2);                // rib
      front = 0.6; H = 0.13;
      break;
    }
    case 'dbarrel': {
      box(g, M.wood, 0.05, 0.06, 0.28, 0, -0.04, -0.2, 0.1);
      box(g, M.metal, 0.06, 0.06, 0.12, 0, -0.005, 0.03);
      tube(g, M.metal, 0.014, 0.5, 0.0145, 0.005, 0.08);
      tube(g, M.metal, 0.014, 0.5, -0.0145, 0.005, 0.08);
      box(g, M.wood, 0.055, 0.035, 0.18, 0, -0.03, 0.2);
      box(g, M.wood, 0.04, 0.07, 0.05, 0, -0.07, -0.03, -0.4);
      front = 0.58; H = 0.13;
      break;
    }
    case 'aa12': {
      box(g, M.poly, 0.07, 0.1, 0.36, 0, -0.01, 0.06);
      box(g, M.poly, 0.05, 0.08, 0.2, 0, -0.03, -0.22);
      tube(g, M.dark, 0.018, 0.22, 0, 0.01, 0.24);
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 18), M.dark);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0, -0.11, 0.08);
      g.add(drum);
      box(g, M.poly, 0.04, 0.08, 0.05, 0, -0.09, -0.03, -0.3);
      box(g, M.dark, 0.01, 0.025, 0.25, 0, 0.055, 0.08);
      front = 0.46; H = 0.2;
      break;
    }
    case 'm32': {
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.13, 6), M.dark);
      cyl.rotation.x = Math.PI / 2;
      cyl.position.set(0, -0.03, 0.12);
      g.add(cyl);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        tube(g, M.brass, 0.018, 0.012, Math.cos(a) * 0.045, -0.03 + Math.sin(a) * 0.045, 0.185);
      }
      tube(g, M.dark, 0.026, 0.2, 0, -0.03, 0.19);
      box(g, M.poly, 0.04, 0.09, 0.05, 0, -0.09, 0.0, -0.35);
      box(g, M.poly, 0.03, 0.03, 0.22, 0, -0.03, -0.17);
      box(g, M.dark, 0.012, 0.03, 0.2, 0, 0.045, 0.12);
      front = 0.39; H = 0.18;
      break;
    }
    case 'minigun': {
      const spinner = new THREE.Group();
      spinner.position.set(0, -0.02, 0);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        tube(spinner, M.metal, 0.011, 0.5, Math.cos(a) * 0.03, Math.sin(a) * 0.03, 0.12);
      }
      g.add(spinner);
      for (const z of [0.2, 0.42]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16), M.dark);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(0, -0.02, z);
        g.add(ring);
      }
      box(g, M.dark, 0.12, 0.12, 0.2, 0, -0.03, 0.02);
      box(g, M.red, 0.1, 0.1, 0.12, 0.09, -0.09, -0.02);
      box(g, M.poly, 0.03, 0.03, 0.14, 0, 0.06, 0.05);
      g.userData.spin = [spinner];
      front = 0.62; H = 0.2;
      break;
    }
    case 'flamer': {
      box(g, M.dark, 0.06, 0.08, 0.3, 0, -0.01, 0.05);
      tube(g, M.metal, 0.02, 0.28, 0, 0.0, 0.2, 10, 0.03);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 14), M.red);
      tank.rotation.x = Math.PI / 2;
      tank.position.set(0, -0.08, 0.08);
      g.add(tank);
      const pilot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), glowMat(0x3aa0ff, 4));
      pilot.position.set(0, -0.025, 0.47);
      g.add(pilot);
      box(g, M.poly, 0.04, 0.08, 0.05, 0, -0.07, -0.04, -0.35);
      box(g, M.poly, 0.04, 0.06, 0.2, 0, -0.03, -0.2);
      front = 0.48; H = 0.16;
      break;
    }
    case 'tesla': {
      box(g, M.dark, 0.07, 0.09, 0.32, 0, -0.01, 0.06);
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 12), glowMat(0x4f9cff, 1.6));
      core.position.set(0, 0.06, 0.04);
      g.add(core);
      for (let i = 0; i < 4; i++) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.008, 6, 18), glowMat(0x3a7aff, 1.4));
        coil.position.set(0, 0, 0.24 + i * 0.05);
        g.add(coil);
      }
      tube(g, M.metal, 0.012, 0.22, 0, 0, 0.22);
      box(g, M.poly, 0.04, 0.08, 0.05, 0, -0.08, -0.03, -0.35);
      box(g, M.poly, 0.04, 0.06, 0.2, 0, -0.02, -0.18);
      g.userData.pulse = [core];
      front = 0.46; H = 0.17;
      break;
    }
    case 'laser': case 'railgun': {
      const rail = w.id === 'railgun';
      const col = rail ? 0x6f8cff : 0x33ffff;
      box(g, M.poly, 0.06, 0.08, rail ? 0.5 : 0.42, 0, -0.01, rail ? 0.14 : 0.1);
      box(g, glowMat(col, 3), 0.062, 0.008, rail ? 0.46 : 0.38, 0, 0.01, rail ? 0.14 : 0.1);
      if (rail) {
        box(g, M.metal, 0.012, 0.03, 0.55, 0.03, 0.02, 0.42);
        box(g, M.metal, 0.012, 0.03, 0.55, -0.03, 0.02, 0.42);
        box(g, glowMat(col, 4), 0.02, 0.006, 0.52, 0, 0.02, 0.42);
      } else tube(g, M.metal, 0.014, 0.18, 0, 0, 0.3);
      box(g, M.dark, 0.03, 0.04, 0.12, 0, 0.065, 0.06);
      box(g, M.poly, 0.04, 0.08, 0.05, 0, -0.08, -0.03, -0.35);
      box(g, M.poly, 0.04, 0.06, 0.2, 0, -0.03, -0.19);
      front = rail ? 0.69 : 0.48; H = 0.15;
      break;
    }
    default: {
      box(g, M.dark, 0.05, 0.07, 0.4, 0, -0.01, 0.1);
      tube(g, M.metal, 0.012, 0.2, 0, 0.005, 0.3);
      box(g, M.poly, 0.04, 0.08, 0.05, 0, -0.07, -0.03, -0.35);
      front = 0.5; H = 0.13;
    }
  }
  finish(g, w, front, H);
  return g;
}
