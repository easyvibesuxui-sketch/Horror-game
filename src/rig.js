import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

// Builds a gnome character (the Chromie model) wearing a tactical suit.
// The model ships without clothes or animations, so the suit is drawn in a
// shader (everything below the neck) and all motion is procedural.
export function makeGnome(srcScene, { suit, trim, height = 1.2, headTint = [1, 1, 1], glow = 0.28 }) {
  const model = SkeletonUtils.clone(srcScene);
  const remove = [];
  model.traverse((o) => {
    if (o.isMesh && !/Skin|Hair/i.test(o.material.name)) remove.push(o);
  });
  remove.forEach((o) => o.parent.remove(o));

  const uniforms = {
    uNeck: { value: new THREE.Vector3() },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uWaist: { value: 0.3 },
    uSuit: { value: new THREE.Color(suit) },
    uTrim: { value: new THREE.Color(trim) },
    uHeadTint: { value: new THREE.Color(...headTint) },
  };

  model.traverse((o) => {
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const old = o.material;
    const tex = old.map || old.emissiveMap;
    const hair = /Hair/i.test(old.name);
    const m = new THREE.MeshStandardMaterial({
      map: tex, emissiveMap: tex, emissive: new THREE.Color(glow * headTint[0], glow * headTint[1], glow * headTint[2]),
      roughness: 0.8, metalness: 0.05, side: THREE.DoubleSide,
    });
    if (!hair) {
      m.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uniforms);
        sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace(
          '#include <project_vertex>',
          '#include <project_vertex>\n  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
        sh.fragmentShader = 'uniform vec3 uNeck; uniform vec3 uUp; uniform float uWaist; uniform vec3 uSuit; uniform vec3 uTrim; uniform vec3 uHeadTint;\nvarying vec3 vWPos;\n'
          + sh.fragmentShader
            .replace('#include <map_fragment>', `#include <map_fragment>
  float hd = dot(vWPos - uNeck, uUp);
  float suitMask = step(hd, 0.0);
  float panel = 0.82 + 0.18 * step(0.5, fract((vWPos.x + vWPos.z) * 6.0 + hd * 3.0));
  diffuseColor.rgb = mix(diffuseColor.rgb * uHeadTint, uSuit * panel, suitMask);`)
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance *= (1.0 - suitMask);
  float collar = suitMask * (1.0 - smoothstep(0.0, 0.03, -hd));
  float belt = suitMask * (1.0 - smoothstep(0.0, 0.022, abs(-hd - uWaist)));
  totalEmissiveRadiance += uTrim * (collar + belt) * 2.2;`);
      };
      m.customProgramCacheKey = () => 'gnome-suit';
    } else {
      m.color.setRGB(...headTint);
    }
    o.material = m;
  });

  // Normalize size, feet on the ground.
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const s = height / (box.max.y - box.min.y);
  model.scale.multiplyScalar(s);
  model.position.y -= box.min.y * s;

  const tilt = new THREE.Group(); // used to lay the body down when downed
  tilt.add(model);
  const root = new THREE.Group(); // position + facing
  root.add(tilt);

  return { root, tilt, model, rig: new Rig(model, GNOME_BONES), uniforms };
}

export const GNOME_BONES = {
  lThigh: 'L_Thigh', rThigh: 'R_Thigh', lCalf: 'L_Calf', rCalf: 'R_Calf', spine: 'Spine_1',
  rUpper: 'R_Bicep', rFore: 'R_Elbow', rHand: 'R_Hand', lUpper: 'L_Bicep', lFore: 'L_Elbow', lHand: 'L_Hand',
  neck: 'Neck_Lower', pelvis: 'Pelvis',
};
// Source-engine (ValveBiped) skeleton used by the black dog model.
export const VALVE_BONES = {
  lThigh: 'ValveBipedBip01_L_Thigh', rThigh: 'ValveBipedBip01_R_Thigh', lCalf: 'ValveBipedBip01_L_Calf', rCalf: 'ValveBipedBip01_R_Calf',
  spine: 'ValveBipedBip01_Spine1', rUpper: 'ValveBipedBip01_R_UpperArm', rFore: 'ValveBipedBip01_R_Forearm', rHand: 'ValveBipedBip01_R_Hand',
  lUpper: 'ValveBipedBip01_L_UpperArm', lFore: 'ValveBipedBip01_L_Forearm', lHand: 'ValveBipedBip01_L_Hand',
  neck: 'ValveBipedBip01_Neck1', pelvis: 'ValveBipedBip01_Pelvis',
};

// Procedural animation for skinned models that ship without animations.
export class Rig {
  constructor(model, names) {
    const all = {};
    model.traverse((o) => { if (o.isBone) all[o.name.replace(/_\d+$/, '')] = o; });
    this.b = {};
    for (const k in names) this.b[k] = all[names[k]];
    this.rest = [];
    for (const k in this.b) if (this.b[k]) this.rest.push([this.b[k], this.b[k].quaternion.clone()]);
    this.phase = Math.random() * 6;
    this.recoil = 0;
  }

  reset() { for (const [b, q] of this.rest) b.quaternion.copy(q); }

  rotWorld(bone, axis, angle) {
    if (!bone) return;
    bone.updateWorldMatrix(true, false);
    bone.getWorldQuaternion(_q);
    _q2.setFromAxisAngle(axis, angle);
    _q.premultiply(_q2);
    bone.parent.getWorldQuaternion(_q2).invert();
    bone.quaternion.copy(_q2.multiply(_q));
  }

  // Rotate bone so the segment bone->child points along dir (world space).
  aim(bone, child, dir) {
    if (!bone || !child) return;
    child.updateWorldMatrix(true, false);
    bone.getWorldPosition(_a);
    child.getWorldPosition(_b);
    _c.subVectors(_b, _a).normalize();
    _q2.setFromUnitVectors(_c, dir);
    bone.getWorldQuaternion(_q);
    _q.premultiply(_q2);
    bone.parent.getWorldQuaternion(_q2).invert();
    bone.quaternion.copy(_q2.multiply(_q));
  }

  // state: 'up' | 'dead'. armsDir: world direction the arms reach toward (null = hang).
  // swing: 0..1 attack swing progress (arms go from raised to slashing down).
  update(dt, speed, yaw, armsDir, state, time, swing = 0) {
    const B = this.b;
    this.reset();
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const up = new THREE.Vector3(0, 1, 0);
    if (state === 'dead') {
      this.rotWorld(B.rUpper, right, 0.8);
      this.rotWorld(B.lUpper, right, -0.6);
      return;
    }
    const amt = Math.min(1, speed / 2.5);
    this.phase += dt * (4 + speed * 2.2);
    const sw = Math.sin(this.phase) * 0.7 * amt;
    this.rotWorld(B.lThigh, right, -sw);
    this.rotWorld(B.rThigh, right, sw);
    this.rotWorld(B.lCalf, right, Math.max(0, Math.cos(this.phase)) * 0.9 * amt);
    this.rotWorld(B.rCalf, right, Math.max(0, -Math.cos(this.phase)) * 0.9 * amt);
    this.rotWorld(B.spine, right, 0.15 * amt + Math.sin(time * 2) * 0.02);
    if (armsDir) {
      const d = armsDir.clone();
      if (swing > 0) d.addScaledVector(up, Math.cos(swing * Math.PI) * 1.2).normalize();
      const r = d.clone().addScaledVector(right, 0.12).normalize();
      const l = d.clone().addScaledVector(right, -0.12).normalize();
      this.aim(B.rUpper, B.rFore, r);
      this.aim(B.rFore, B.rHand, r);
      this.aim(B.lUpper, B.lFore, l);
      this.aim(B.lFore, B.lHand, l);
    } else {
      // arms swing with the stride
      this.rotWorld(B.rUpper, right, -sw * 0.6);
      this.rotWorld(B.lUpper, right, sw * 0.6);
    }
  }

  updateSuit(uniforms) {
    const B = this.b;
    if (!B.neck || !B.pelvis) return;
    B.neck.getWorldPosition(uniforms.uNeck.value);
    B.pelvis.getWorldPosition(_b);
    uniforms.uUp.value.subVectors(uniforms.uNeck.value, _b);
    const len = uniforms.uUp.value.length();
    uniforms.uUp.value.multiplyScalar(1 / len);
    uniforms.uNeck.value.addScaledVector(uniforms.uUp.value, len * 0.08);
    uniforms.uWaist.value = len * 0.95;
  }
}

// ---------- Procedural weapon meshes ----------
const gunMats = {
  metal: new THREE.MeshStandardMaterial({ color: 0x6c727c, roughness: 0.38, metalness: 0.3 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x3c3f45, roughness: 0.55, metalness: 0.2 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x7a4a26, roughness: 0.75 }),
};

const CAT_SHAPE = {
  pistol: { len: 0.22, h: 0.07, barrel: 0.08, stock: 0 },
  smg: { len: 0.34, h: 0.08, barrel: 0.1, stock: 0.08, mag: 0.12 },
  shotgun: { len: 0.55, h: 0.08, barrel: 0.25, stock: 0.18, wood: true },
  rifle: { len: 0.55, h: 0.09, barrel: 0.2, stock: 0.16, mag: 0.14 },
  lmg: { len: 0.7, h: 0.12, barrel: 0.28, stock: 0.18, box: true },
  sniper: { len: 0.8, h: 0.08, barrel: 0.38, stock: 0.2, scope: true, wood: true },
  special: { len: 0.6, h: 0.14, barrel: 0.2, stock: 0.1, glow: true },
};

export function makeGun(w) {
  const sh = CAT_SHAPE[w.cat] || CAT_SHAPE.rifle;
  const g = new THREE.Group();
  const accent = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: new THREE.Color(w.color || (w.cat === 'special' ? 0xff5a1a : 0x000000)),
    emissiveIntensity: w.cat === 'special' ? 2 : 0,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(sh.h * 0.8, sh.h, sh.len), gunMats.metal);
  body.position.z = sh.len * 0.3;
  g.add(body);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(sh.h * 0.18, sh.h * 0.2, sh.barrel, 8), gunMats.dark);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.set(0, sh.h * 0.15, sh.len * 0.8 + sh.barrel * 0.5);
  g.add(barrel);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(sh.h * 0.6, sh.h * 1.3, sh.h * 0.6), sh.wood ? gunMats.wood : gunMats.dark);
  grip.position.set(0, -sh.h * 0.8, 0.02);
  grip.rotation.x = -0.25;
  g.add(grip);
  if (sh.stock) {
    const st = new THREE.Mesh(new THREE.BoxGeometry(sh.h * 0.6, sh.h * 1.1, sh.stock), sh.wood ? gunMats.wood : gunMats.dark);
    st.position.set(0, -sh.h * 0.1, -sh.stock * 0.5 - sh.len * 0.15);
    g.add(st);
  }
  if (sh.mag) {
    const mg = new THREE.Mesh(new THREE.BoxGeometry(sh.h * 0.5, sh.mag, sh.h * 0.7), gunMats.dark);
    mg.position.set(0, -sh.h * 0.5 - sh.mag * 0.4, sh.len * 0.45);
    mg.rotation.x = 0.2;
    g.add(mg);
  }
  if (sh.box) {
    const bx = new THREE.Mesh(new THREE.BoxGeometry(sh.h * 1.2, sh.h * 1.2, sh.h * 1.4), gunMats.dark);
    bx.position.set(0, -sh.h, sh.len * 0.35);
    g.add(bx);
  }
  if (sh.scope) {
    const sc = new THREE.Mesh(new THREE.CylinderGeometry(sh.h * 0.3, sh.h * 0.3, sh.len * 0.35, 10), gunMats.dark);
    sc.rotation.x = Math.PI / 2;
    sc.position.set(0, sh.h * 0.75, sh.len * 0.35);
    g.add(sc);
  }
  if (sh.glow) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(sh.h * 0.55, sh.h * 0.12, 6, 14), accent);
    coil.position.set(0, 0, sh.len * 0.55);
    g.add(coil);
    const coil2 = coil.clone();
    coil2.position.z = sh.len * 0.72;
    g.add(coil2);
  }
  g.userData.muzzle = sh.len * 0.8 + sh.barrel;
  g.userData.grip = new THREE.Vector3(0, -sh.h * 1.1, -0.02);
  g.userData.fore = w.cat === 'pistol' ? new THREE.Vector3(-0.02, -sh.h * 1.25, 0.03) : new THREE.Vector3(0, -sh.h * 0.55, sh.len * 0.62);
  g.traverse((o) => { o.castShadow = false; });
  return g;
}
