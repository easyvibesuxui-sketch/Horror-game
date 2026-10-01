import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildWeapon, propModel } from './weapons3d.js';

// First-person hands + weapon, drawn in their own scene on top of the world
// so they never clip into walls.
const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x4a5040, roughness: 0.9 });
const gloveMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 0.55, metalness: 0.05 });
const padMat = new THREE.MeshStandardMaterial({ color: 0x33372c, roughness: 0.8 });
const UP = new THREE.Vector3(0, 1, 0);

function limb(from, to, r0, r1, mat) {
  const d = new THREE.Vector3().subVectors(to, from);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, d.length(), 10), mat);
  m.position.copy(from).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(UP, d.normalize());
  return m;
}

function arm(shoulder, elbow, hand) {
  const g = new THREE.Group();
  g.add(limb(shoulder, elbow, 0.055, 0.05, sleeveMat));
  g.add(limb(elbow, hand, 0.048, 0.04, sleeveMat));
  g.add(limb(elbow.clone().lerp(hand, 0.72), elbow.clone().lerp(hand, 0.8), 0.047, 0.047, padMat));
  const glove = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.07, 0.085), gloveMat);
  glove.position.copy(hand);
  glove.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3().subVectors(hand, elbow).normalize());
  g.add(glove);
  return g;
}

// Star-shaped muzzle flash drawn once on a canvas.
function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.translate(64, 64);
  const g = x.createRadialGradient(0, 0, 0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,230,1)');
  g.addColorStop(0.25, 'rgba(255,200,90,0.9)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  x.fillStyle = g;
  for (let i = 0; i < 7; i++) {
    x.rotate((Math.PI * 2) / 7);
    x.beginPath();
    x.moveTo(-9, 0);
    x.lineTo(0, -(40 + Math.random() * 24));
    x.lineTo(9, 0);
    x.fill();
  }
  x.beginPath();
  x.arc(0, 0, 22, 0, Math.PI * 2);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const NO_CASINGS = new Set(['flame', 'tesla', 'beam', 'rocket']);

export class ViewModel {
  constructor(glowTex, renderer) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10);
    // reflections for metal parts
    const pm = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pm.dispose();
    this.hemi = new THREE.HemisphereLight(0x8898c0, 0x1a1010, 0.6);
    this.key = new THREE.DirectionalLight(0xfff0dd, 1.2);
    this.key.position.set(0.3, 0.7, 1.0); // from behind the camera, like a head lamp
    this.rim = new THREE.DirectionalLight(0x8090ff, 0.6);
    this.rim.position.set(-1, 0.4, -0.5);
    this.muzzleLight = new THREE.PointLight(0xffa050, 0, 2.5, 2);
    this.scene.add(this.hemi, this.key, this.rim, this.muzzleLight);
    this.holder = new THREE.Group();
    this.scene.add(this.holder);

    // muzzle flash: star + soft glow
    this.flash = new THREE.Group();
    const add = THREE.AdditiveBlending;
    this.flashStar = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), blending: add, depthWrite: false, transparent: true, toneMapped: false }));
    this.flashGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa040, blending: add, depthWrite: false, transparent: true, toneMapped: false }));
    this.flash.add(this.flashGlow, this.flashStar);
    this.flash.visible = false;
    this.holder.add(this.flash);
    this.flashT = 0;

    // ejected casings + muzzle smoke (live in the scene, not the holder, so they fly free)
    this.casings = [];
    this.smoke = [];
    for (let i = 0; i < 10; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0x9a9a9a, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      this.scene.add(s);
      this.smoke.push({ s, t: 0, v: new THREE.Vector3() });
    }
    this.si = 0;

    this.recoil = 0; // spring-driven kick
    this.recoilV = 0;
    this.roll = 0;
    this.kick = 1;
    this.switchT = 0;
    this.bobT = 0;
    this.inspectT = 0;
    this.sway = new THREE.Vector2();
    this.muzzle = new THREE.Vector3();
    this.eject = new THREE.Vector3();
    this.gun = null;
    this.adsOffset = new THREE.Vector3();
    this.knifeT = 0;
    this.blade = null;
    this.weapon = null;
    this._v = new THREE.Vector3();
  }

  // Call once the weapon pack has loaded: real knife + casing models.
  initProps() {
    const knife = propModel('knife', 0.3);
    this.blade = new THREE.Group();
    if (knife) {
      knife.rotation.set(0, Math.PI / 2, -Math.PI / 2);
      knife.position.z = -0.08;
      this.blade.add(knife);
    } else {
      const steel = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.035, 0.2), new THREE.MeshStandardMaterial({ color: 0xc8ccd2, roughness: 0.25, metalness: 0.8 }));
      steel.position.z = -0.15;
      this.blade.add(steel);
    }
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.085, 0.1), gloveMat);
    hand.position.z = 0.03;
    this.blade.add(hand, limb(new THREE.Vector3(0, -0.02, 0.08), new THREE.Vector3(0.05, -0.2, 0.42), 0.048, 0.04, sleeveMat));
    this.blade.visible = false;
    this.scene.add(this.blade);
    for (let i = 0; i < 14; i++) {
      const shell = i % 2 === 0;
      const m = propModel(shell ? 'shell' : 'casing', shell ? 0.04 : 0.028)
        || new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6), new THREE.MeshStandardMaterial({ color: 0xc8a040, metalness: 0.9, roughness: 0.3 }));
      m.visible = false;
      this.scene.add(m);
      this.casings.push({ m, shell, t: 0, v: new THREE.Vector3(), w: new THREE.Vector3() });
    }
  }

  knife() { this.knifeT = 0.35; this.inspectT = 0; }
  inspect() { if (this.knifeT <= 0 && this.switchT <= 0) this.inspectT = 2.4; }

  setWeapon(w) {
    if (this.pivot) this.holder.remove(this.pivot);
    const gun = buildWeapon(w);
    const pistol = w.cat === 'pistol';
    gun.rotation.y = Math.PI; // barrel along -z (camera forward)
    gun.scale.setScalar(pistol ? 1.0 : 0.75);
    gun.position.set(pistol ? 0.12 : 0.15, pistol ? -0.12 : -0.15, pistol ? -0.44 : -0.33);
    gun.updateMatrix();
    const grip = gun.userData.grip.clone().applyMatrix4(gun.matrix);
    const fore = gun.userData.fore.clone().applyMatrix4(gun.matrix);
    this.armR = arm(new THREE.Vector3(0.3, -0.42, 0.12), new THREE.Vector3(0.24, -0.3, -0.12), grip);
    this.armL = arm(new THREE.Vector3(-0.22, -0.45, 0.05), new THREE.Vector3(-0.1, -0.33, -0.2), fore);
    this.muzzle.set(0, 0.008, gun.userData.muzzle).applyMatrix4(gun.matrix);
    this.eject.copy(gun.userData.eject).applyMatrix4(gun.matrix);
    this.flash.position.copy(this.muzzle);
    // reload/inspect rotate the weapon (and hands) around the grip, not around the camera
    this.pivot = new THREE.Group();
    this.pivot.position.copy(gun.position);
    const wrap = new THREE.Group();
    wrap.position.copy(gun.position).negate();
    wrap.add(gun, this.armR, this.armL);
    this.pivot.add(wrap);
    this.holder.add(this.pivot);
    this.gun = gun;
    this.weapon = w;
    this.adsOffset.set(-gun.position.x, -gun.position.y - (pistol ? 0.075 : 0.068), 0.05);
    this.kick = w.cat === 'sniper' || w.type === 'rocket' ? 2.2 : w.cat === 'shotgun' ? 1.8 : w.cat === 'pistol' ? 1.2 : w.rpm > 900 ? 0.5 : 0.8;
    this.switchT = 0.35;
    this.inspectT = 0;
  }

  fire(color) {
    const w = this.weapon;
    this.recoilV += 6 * (0.6 + Math.random() * 0.4);
    this.roll += (Math.random() - 0.5) * 0.06 * this.kick;
    this.inspectT = 0;
    const type = w ? w.type || 'hitscan' : 'hitscan';
    const big = w && (w.cat === 'shotgun' || w.cat === 'sniper' || type === 'rocket') ? 1.6 : w && w.cat === 'pistol' ? 0.9 : 1;
    this.flashStar.material.color.set(color);
    this.flashGlow.material.color.set(color);
    this.flashStar.material.rotation = Math.random() * 6.28;
    this.flashStar.scale.setScalar((0.16 + Math.random() * 0.08) * big);
    this.flashGlow.scale.setScalar(0.3 * big);
    this.flashStar.visible = type !== 'flame';
    this.flash.visible = true;
    this.flashT = 0.045;
    this.muzzleLight.color.set(color);
    this.muzzleLight.position.copy(this.muzzle);
    this.muzzleLight.intensity = 3 * big;
    if (!NO_CASINGS.has(type)) this.ejectCasing(w.cat === 'shotgun');
    if (type !== 'flame' && type !== 'tesla' && Math.random() < (w.rpm > 700 ? 0.35 : 0.9)) this.puff();
  }

  ejectCasing(shell) {
    if (!this.casings.length) return;
    const c = this.casings.find((k) => k.t <= 0 && k.shell === shell) || this.casings.find((k) => k.t <= 0);
    if (!c) return;
    this.holder.updateMatrixWorld(true);
    c.m.position.copy(this.eject).applyMatrix4(this.holder.matrixWorld);
    c.v.set(0.9 + Math.random() * 0.6, 1.1 + Math.random() * 0.5, 0.2 + Math.random() * 0.3);
    c.w.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    c.m.rotation.set(0, 0, Math.PI / 2);
    c.m.visible = true;
    c.t = 0.7;
  }

  puff() {
    const p = this.smoke[this.si];
    this.si = (this.si + 1) % this.smoke.length;
    this.holder.updateMatrixWorld(true);
    p.s.position.copy(this.muzzle).applyMatrix4(this.holder.matrixWorld);
    p.v.set((Math.random() - 0.5) * 0.06, 0.12 + Math.random() * 0.06, -0.1);
    p.t = p.max = 0.9;
    p.s.visible = true;
  }

  // o: { speed, lookDX, lookDY, reload (0..1 or -1), down, light, ads, sprint }
  update(dt, o) {
    this.switchT = Math.max(0, this.switchT - dt);
    // damped spring for recoil: snappy kick, smooth settle
    this.recoilV += (-180 * this.recoil - 22 * this.recoilV) * dt;
    this.recoil = Math.max(-0.2, this.recoil + this.recoilV * dt);
    this.roll *= Math.max(0, 1 - dt * 8);
    this.flashT -= dt;
    if (this.flashT <= 0) this.flash.visible = false;
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 60);
    const ads = o.ads || 0;
    const amt = Math.min(1, o.speed / 4) * (1 - 0.8 * ads);
    this.bobT += dt * (6 + o.speed * 1.6) * (amt > 0.05 ? 1 : 0.25);
    this.sway.x = THREE.MathUtils.lerp(this.sway.x, THREE.MathUtils.clamp(-o.lookDX * 0.0007, -0.04, 0.04), Math.min(1, dt * 10));
    this.sway.y = THREE.MathUtils.lerp(this.sway.y, THREE.MathUtils.clamp(o.lookDY * 0.0007, -0.04, 0.04), Math.min(1, dt * 10));
    const h = this.holder;
    const r = this.recoil * this.kick;
    const idle = Math.sin(this.bobT * 0.5) * 0.003;
    h.position.set(
      Math.sin(this.bobT) * 0.014 * amt + this.sway.x,
      -Math.abs(Math.cos(this.bobT)) * 0.016 * amt + idle + this.sway.y - (this.switchT / 0.35) * 0.35 + r * 0.004,
      r * 0.03 * (1 - 0.4 * ads),
    );
    h.rotation.set(r * 0.05 * (1 - 0.5 * ads), this.sway.x * 0.6, this.roll - this.sway.x * 1.5);
    h.position.addScaledVector(this.adsOffset, ads);
    if (o.sprint) { h.rotation.x -= 0.35; h.rotation.y += 0.5; h.position.y -= 0.06; h.position.x -= 0.03; }

    // spinning barrels / pulsing cores on special guns
    if (this.gun && this.gun.userData.spin) for (const b of this.gun.userData.spin) b.rotation.z += dt * (o.firing ? 40 : 2);
    if (this.gun && this.gun.userData.pulse) for (const p of this.gun.userData.pulse) p.scale.setScalar(1 + Math.sin(performance.now() * 0.012) * 0.12);

    // knife swing
    this.knifeT = Math.max(0, this.knifeT - dt);
    if (this.blade) this.blade.visible = this.knifeT > 0;
    if (this.knifeT > 0 && this.blade) {
      const k = 1 - this.knifeT / 0.35;
      const sw = Math.sin(k * Math.PI);
      h.position.y -= sw * 0.25;
      this.blade.position.set(0.22 - k * 0.4, -0.12 - sw * 0.03, -0.32);
      this.blade.rotation.set(-0.1, 0.9 - k * 1.8, -0.6 + k * 0.4);
    }

    // reload: tilt the gun, left hand drops away and comes back with a fresh mag
    const pv = this.pivot;
    if (pv) pv.rotation.set(0, 0, 0);
    if (this.armL) this.armL.position.set(0, 0, 0);
    if (o.reload >= 0 && pv) {
      const p = Math.sin(o.reload * Math.PI);
      pv.rotation.set(p * 0.25, -p * 0.2, p * 0.7);
      h.position.y -= p * 0.03;
      const hand = Math.sin(Math.min(1, o.reload * 1.6) * Math.PI);
      if (this.armL) this.armL.position.set(-hand * 0.04, -hand * 0.2, hand * 0.05);
    }

    // inspect: turn the weapon to show it off
    if (this.inspectT > 0 && pv) {
      this.inspectT = Math.max(0, this.inspectT - dt);
      const k = 1 - this.inspectT / 2.4;
      const e = Math.sin(Math.min(1, k * 1.4) * Math.PI * 0.5) * Math.sin(Math.min(1, (1 - k) * 3) * Math.PI * 0.5);
      pv.rotation.y += e * 1.1;
      pv.rotation.z += e * 0.4 + Math.sin(k * Math.PI * 2) * 0.08 * e;
      pv.rotation.x += e * 0.15;
      h.position.x -= e * 0.05;
      h.position.y += e * 0.04;
    }
    if (o.down) { h.rotation.z += 0.45; h.position.y -= 0.05; h.position.x -= 0.04; }

    // casings and smoke
    for (const c of this.casings) {
      if (c.t <= 0) continue;
      c.t -= dt;
      c.v.y -= 6 * dt;
      c.m.position.addScaledVector(c.v, dt);
      c.m.rotation.x += c.w.x * dt; c.m.rotation.y += c.w.y * dt; c.m.rotation.z += c.w.z * dt;
      if (c.t <= 0) c.m.visible = false;
    }
    for (const p of this.smoke) {
      if (p.t <= 0) continue;
      p.t -= dt;
      p.s.position.addScaledVector(p.v, dt);
      const k = 1 - p.t / p.max;
      p.s.scale.setScalar(0.04 + k * 0.16);
      p.s.material.opacity = 0.22 * (1 - k);
      if (p.t <= 0) p.s.visible = false;
    }

    this.hemi.intensity = 0.45 + o.light * 0.6;
    this.key.intensity = 0.7 + o.light * 1.1;
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  render(renderer) {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}
