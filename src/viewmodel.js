import * as THREE from 'three';
import { makeGun } from './rig.js';

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
  const cuff = limb(elbow.clone().lerp(hand, 0.72), elbow.clone().lerp(hand, 0.8), 0.047, 0.047, padMat);
  g.add(cuff);
  const glove = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.085, 0.1), gloveMat);
  glove.position.copy(hand);
  glove.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), new THREE.Vector3().subVectors(hand, elbow).normalize());
  g.add(glove);
  return g;
}

export class ViewModel {
  constructor(glowTex) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10);
    this.hemi = new THREE.HemisphereLight(0x8898c0, 0x1a1010, 0.8);
    this.key = new THREE.DirectionalLight(0xfff0dd, 1.4);
    this.key.position.set(0.3, 0.7, 1.0); // from behind the camera, like a head lamp
    this.rim = new THREE.DirectionalLight(0x8090ff, 0.6);
    this.rim.position.set(-1, 0.4, -0.5);
    this.muzzleLight = new THREE.PointLight(0xffa050, 0, 2.5, 2);
    this.scene.add(this.hemi, this.key, this.rim, this.muzzleLight);
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffb050, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
    }));
    this.flash.visible = false;
    this.holder.add(this.flash);
    this.flashT = 0;
    this.recoil = 0;
    this.kick = 1;
    this.switchT = 0;
    this.bobT = 0;
    this.sway = new THREE.Vector2();
    this.muzzle = new THREE.Vector3();
    this.gun = null;
    this.arms = null;
  }

  setWeapon(w) {
    if (this.gun) this.holder.remove(this.gun, this.arms);
    const gun = makeGun(w);
    const pistol = w.cat === 'pistol';
    gun.rotation.y = Math.PI; // barrel along -z (camera forward)
    gun.scale.setScalar(pistol ? 0.8 : 0.75);
    gun.position.set(pistol ? 0.13 : 0.15, pistol ? -0.13 : -0.155, pistol ? -0.42 : -0.36);
    gun.updateMatrix();
    const grip = gun.userData.grip.clone().applyMatrix4(gun.matrix);
    const fore = gun.userData.fore.clone().applyMatrix4(gun.matrix);
    this.arms = new THREE.Group();
    this.arms.add(arm(new THREE.Vector3(0.3, -0.42, 0.12), new THREE.Vector3(0.24, -0.3, -0.12), grip));
    this.arms.add(arm(new THREE.Vector3(-0.22, -0.45, 0.05), new THREE.Vector3(-0.1, -0.33, -0.2), fore));
    this.muzzle.set(0, 0.015, gun.userData.muzzle).applyMatrix4(gun.matrix);
    this.flash.position.copy(this.muzzle);
    this.holder.add(gun, this.arms);
    this.gun = gun;
    this.kick = w.cat === 'sniper' || w.type === 'rocket' ? 2.2 : w.cat === 'shotgun' ? 1.8 : w.cat === 'pistol' ? 1.2 : w.rpm > 900 ? 0.5 : 0.8;
    this.switchT = 0.35;
  }

  fire(color) {
    this.recoil = Math.min(1.5, this.recoil + 1);
    this.flash.material.color.set(color);
    this.flash.visible = true;
    this.flash.scale.setScalar(0.18 + Math.random() * 0.08);
    this.flash.material.rotation = Math.random() * 6;
    this.flashT = 0.05;
    this.muzzleLight.color.set(color);
    this.muzzleLight.position.copy(this.muzzle);
    this.muzzleLight.intensity = 3;
  }

  // o: { speed, lookDX, lookDY, reload (0..1 or -1), down, light }
  update(dt, o) {
    this.switchT = Math.max(0, this.switchT - dt);
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.flashT -= dt;
    if (this.flashT <= 0) this.flash.visible = false;
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 60);
    const amt = Math.min(1, o.speed / 4);
    this.bobT += dt * (6 + o.speed * 1.6) * (amt > 0.05 ? 1 : 0.25);
    this.sway.x = THREE.MathUtils.lerp(this.sway.x, THREE.MathUtils.clamp(-o.lookDX * 0.0007, -0.04, 0.04), Math.min(1, dt * 10));
    this.sway.y = THREE.MathUtils.lerp(this.sway.y, THREE.MathUtils.clamp(o.lookDY * 0.0007, -0.04, 0.04), Math.min(1, dt * 10));
    const h = this.holder;
    const idle = Math.sin(this.bobT * 0.5) * 0.003;
    h.position.set(
      Math.sin(this.bobT) * 0.014 * amt + this.sway.x,
      -Math.abs(Math.cos(this.bobT)) * 0.016 * amt + idle + this.sway.y - (this.switchT / 0.35) * 0.35,
      this.recoil * 0.045 * this.kick,
    );
    h.rotation.set(this.recoil * 0.06 * this.kick, 0, 0);
    if (o.reload >= 0) {
      const p = Math.sin(o.reload * Math.PI);
      h.rotation.x -= p * 0.7;
      h.rotation.z += p * 0.35;
      h.position.y -= p * 0.12;
    }
    if (o.down) {
      h.rotation.z += 0.45;
      h.position.y -= 0.05;
      h.position.x -= 0.04;
    }
    // match the arms' brightness to the surroundings
    this.hemi.intensity = 0.6 + o.light * 0.8;
    this.key.intensity = 0.9 + o.light * 1.4;
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
