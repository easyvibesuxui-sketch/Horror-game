import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  WEAPONS, WEAPON_BY_ID, CATEGORIES, ENEMY_TYPES, PLAYER, COMPANION, SHOPS, ARMOR_ITEMS, MED_ITEMS,
  BOOST_LABELS, waveComposition, waveScaling, BREAK_TIME, FIRST_BREAK,
} from './config.js';
import { Nav, VOID, FLOOR, OBST } from './nav.js';
import { Sfx } from './audio.js';
import { FX } from './fx.js';
import { makeGnome, makeGun } from './rig.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// ---------------------------------------------------------------- renderer
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020203);
scene.fog = new THREE.Fog(0x020203, 13, 30);
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 80);

const sfx = new Sfx();
const fx = new FX(scene);
const nav = new Nav();

// ---------------------------------------------------------------- lights
const hemi = new THREE.HemisphereLight(0x8a9ac0, 0x1a0c0c, 0.55);
scene.add(hemi);
const flashlight = new THREE.SpotLight(0xfff0d0, 45, 16, 0.6, 0.5, 1.3);
scene.add(flashlight, flashlight.target);
const fillLight = new THREE.PointLight(0xa8bcff, 4, 7, 1.4);
scene.add(fillLight);
const muzzleLight = new THREE.PointLight(0xffa050, 0, 7, 1.8);
scene.add(muzzleLight);
const boomLight = new THREE.PointLight(0xff7030, 0, 14, 1.6);
scene.add(boomLight);
const roomLights = [];
[[-7.5, 0.5], [2.5, -6.5], [8, 0], [0, 6.5]].forEach(([x, z], i) => {
  const l = new THREE.PointLight(i === 3 ? 0xff4040 : 0xb0c4ff, 6, 11, 1.4);
  l.position.set(x, 2.4, z);
  l.userData = { base: 6, flick: 1 };
  roomLights.push(l);
  scene.add(l);
});

// ---------------------------------------------------------------- state
const G = {
  started: false, paused: false, over: false,
  time: 0, wave: 0, phase: 'break', breakT: 0, queue: [], spawnT: 0, scale: waveScaling(1),
  coins: 0, kills: 0, shake: 0, zoom: 10,
  enemies: [], pool: { easy: [], fast: [], brute: [] },
  projectiles: [], mines: [], rifts: [], kiosks: [],
  shopOpen: null, flowT: 0, groanT: 3, heartT: 0,
};
// Debug/test hooks: only in dev server or with ?debug in the URL.
const DEBUG = import.meta.env.DEV || /[?&]debug\b/.test(location.search);
if (DEBUG) window.__G = G;
if (DEBUG) window.__dbg = { hemi, scene, nav, get kiosks() { return G.kiosks; }, get player() { return player; }, get comp() { return comp; }, spawnEnemy: (k) => spawnEnemy(k), buyWeapon: (id) => buyWeapon(WEAPON_BY_ID[id]), sim: (sec, dt = 1 / 30) => { for (let t = 0; t < sec; t += dt) { if (!G.over && !G.paused) step(dt); } }, buyItem: (id) => buyItem([...ARMOR_ITEMS, ...MED_ITEMS].find((i) => i.id === id), 0) };
const assets = {};

const input = { keys: {}, mouse: new THREE.Vector2(), mx: innerWidth / 2, my: innerHeight / 2, down: false, clicked: false };
const aimPoint = new THREE.Vector3();
const aimDir = new THREE.Vector3(0, 0, -1);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.7);

// ---------------------------------------------------------------- loading
async function loadAssets() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const files = { arena: 'arena.glb', chromie: 'chromie.glb', huggy: 'huggy.glb', butcher: 'butcher.glb' };
  const prog = {};
  const update = () => {
    const vals = Object.values(prog);
    const p = vals.reduce((a, b) => a + b, 0) / Object.keys(files).length;
    $('load-fill').style.width = `${Math.round(p * 85)}%`;
  };
  await Promise.all(Object.entries(files).map(([k, f]) => new Promise((res, rej) => {
    loader.load(`${BASE}models/${f}`, (g) => { assets[k] = g; prog[k] = 1; update(); res(); },
      (e) => { if (e.total) { prog[k] = e.loaded / e.total; update(); } }, rej);
  })));
  try { await Promise.race([document.fonts.load('800 40px "Noto Sans Georgian"'), new Promise((r) => setTimeout(r, 2500))]); } catch (e) { /* font optional */ }
}

// ---------------------------------------------------------------- world
let arenaMixer;
function buildWorld() {
  const arena = assets.arena.scene;
  scene.add(arena);
  arena.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundsTree();
    // Room shell faces inward: single-sided lets the camera see through near walls and ceiling.
    if (/Room1/.test(o.material.name)) o.material.side = THREE.FrontSide;
  });
  arenaMixer = new THREE.AnimationMixer(arena);
  assets.arena.animations.forEach((c) => arenaMixer.clipAction(c).play());

  $('load-status').textContent = 'სადგურის რუკის აგება...';
  nav.build(arena);
  fx.floorY = nav.floorY;
  aimPlane.constant = -(nav.floorY + 0.7);

  // Hide ceiling-level geometry that could block the camera.
  arena.traverse((o) => {
    if (!o.isMesh || /Room1/.test(o.material.name)) return;
    const b = new THREE.Box3().setFromObject(o);
    if (b.min.y > nav.floorY + 2.35) o.visible = false;
  });

  SHOPS.forEach((s) => buildKiosk(s));
  [[1.1, -7.4], [-10.4, 2.1], [8.2, 3.9], [-2.4, -5.6], [0.1, 9.0], [3.3, -1.5], [-9.5, -3.5]].forEach(([x, z]) => buildRift(x, z));
  buildMinimapBase();
}

function textSprite(text, color, w = 2.6) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 160;
  const x = c.getContext('2d');
  x.font = '800 62px "Noto Sans Georgian", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = color; x.shadowBlur = 24;
  x.fillStyle = '#fff';
  x.fillText(text, 512, 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
  s.scale.set(w, w * 160 / 1024, 1);
  return s;
}

function bestFacing(x, z) {
  let best = 0, bestN = -1;
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2;
    let n = 0;
    for (let r = 0.5; r <= 3; r += 0.25) if (nav.walk(x + Math.sin(ang) * r, z + Math.cos(ang) * r)) n++;
    if (n > bestN) { bestN = n; best = ang; }
  }
  return best;
}

function buildKiosk(s) {
  const p = nav.nearestStand(s.at[0], s.at[1], 0.55);
  const g = new THREE.Group();
  g.position.set(p.x, nav.floorY, p.y);
  g.rotation.y = bestFacing(p.x, p.y);
  const metal = new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.5, metalness: 0.7 });
  const col = new THREE.Color(s.color);
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: col, emissiveIntensity: 2.2 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.7), metal);
  base.position.y = 0.04;
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.25, 0.45), metal);
  body.position.y = 0.66;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), glowMat);
  screen.position.set(0, 1.0, 0.228);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.03, 0.47), glowMat);
  strip.position.y = 0.3;
  const holo = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), new THREE.MeshBasicMaterial({ color: col, wireframe: true, toneMapped: false }));
  holo.position.y = 1.62;
  const label = textSprite(s.name, `#${col.getHexString()}`);
  label.position.y = 2.05;
  const light = new THREE.PointLight(s.color, 5, 5, 1.5);
  light.position.set(0, 1.4, 0.6);
  g.add(base, body, screen, strip, holo, label, light);
  scene.add(g);
  nav.block(p.x, p.y, 0.5);
  G.kiosks.push({ ...s, group: g, holo, pos: new THREE.Vector3(p.x, nav.floorY, p.y) });
}

function buildRift(x, z) {
  const p = nav.nearestStand(x, z, 0.4);
  const g = new THREE.Group();
  g.position.set(p.x, nav.floorY + 0.02, p.y);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xff1a1a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.85, 6, 1), ringMat);
  ring.rotation.x = -Math.PI / 2;
  const inner = new THREE.Mesh(new THREE.CircleGeometry(0.6, 24), new THREE.MeshBasicMaterial({ color: 0x100000, transparent: true, opacity: 0.85, depthWrite: false }));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.005;
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: fx.glowTex, color: 0xff2010, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.35, toneMapped: false }));
  glow.scale.setScalar(2.2);
  glow.position.y = 0.3;
  g.add(inner, ring, glow);
  scene.add(g);
  G.rifts.push({ x: p.x, z: p.y, g, ring, glow, pulse: 0 });
}

// ---------------------------------------------------------------- characters
let player, comp;
function makeCharacter(opts) {
  const c = makeGnome(assets.chromie.scene, opts);
  scene.add(c.root);
  return c;
}

function setupCharacters() {
  const pc = makeCharacter({ suit: 0x1a1f28, trim: 0x22e0ff, height: 1.2 });
  player = {
    ...pc, pos: pc.root.position, yaw: 0, speed: 0,
    hp: PLAYER.hp, maxHp: PLAYER.hp, armor: 0, maxArmor: 0,
    state: 'up', downT: 0, downHp: 0, invuln: 0,
    slots: [{ id: 'm9', ammo: WEAPON_BY_ID.m9.mag }, null, null], cur: 0, lastSlot: 0,
    downedGun: { id: 'm9', ammo: WEAPON_BY_ID.m9.mag },
    reloadT: 0, reloadMax: 0, fireCd: 0,
    grenades: 2, mines: 0, revive: 0,
    boosts: { dmg: 0, rate: 0, speed: 0, regen: 0 },
    gun: null, gunId: null, radius: PLAYER.radius,
  };
  const cc = makeCharacter({ suit: 0x6a3f14, trim: 0xffa020, height: 1.15 });
  comp = {
    ...cc, pos: cc.root.position, yaw: 0, speed: 0,
    hp: COMPANION.hp, maxHp: COMPANION.hp, level: 1, state: 'up',
    fireCd: 0, target: null, targetT: 0, reviveProg: 0, radius: 0.28,
    gun: makeGun(WEAPON_BY_ID.m4),
  };
  scene.add(comp.gun);
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 32), new THREE.MeshBasicMaterial({ color: 0xffa020, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  scene.add(marker);
  comp.marker = marker;
  const tag = textSprite('ქრომი', '#ffa020', 1.1);
  tag.position.y = 1.55;
  comp.root.add(tag);
}

function placeCharacters() {
  const p = nav.nearestStand(0, 4.0, 0.4);
  player.pos.set(p.x, nav.floorY, p.y);
  const c = nav.nearestStand(p.x + 1.2, p.y + 0.6, 0.4);
  comp.pos.set(c.x, nav.floorY, c.y);
}

function curSlot() { return player.state === 'down' ? player.downedGun : player.slots[player.cur]; }
function curWeapon() { return WEAPON_BY_ID[curSlot().id]; }

function syncPlayerGun() {
  const id = curSlot().id;
  if (player.gunId === id) return;
  if (player.gun) scene.remove(player.gun);
  player.gun = makeGun(WEAPON_BY_ID[id]);
  player.gunId = id;
  scene.add(player.gun);
}

// ---------------------------------------------------------------- enemies
const hpBarBg = new THREE.SpriteMaterial({ color: 0x000000, opacity: 0.7, transparent: true, depthTest: false, toneMapped: false });
const hpBarFg = new THREE.SpriteMaterial({ color: 0xff2020, depthTest: false, toneMapped: false });
let huggyH = 7.5, butcherH = 0.6;

class Enemy {
  constructor(key) {
    this.T = ENEMY_TYPES[key];
    this.key = key;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.mats = [];
    let model;
    if (this.T.model === 'huggy') {
      model = SkeletonUtils.clone(assets.huggy.scene);
      model.scale.multiplyScalar(this.T.height / huggyH);
      this.mixer = new THREE.AnimationMixer(model);
      this.action = this.mixer.clipAction(assets.huggy.animations[0]);
      this.action.play();
      this.action.time = Math.random();
    } else {
      model = assets.butcher.scene.clone();
      model.scale.multiplyScalar(this.T.height / butcherH);
    }
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      o.material = o.material.clone();
      if (this.T.tint) {
        o.material.color.setRGB(...this.T.tint);
        o.material.emissive = new THREE.Color(0.25, 0.0, 0.0);
      }
      o.material.userData.baseEmissive = o.material.emissive ? o.material.emissive.clone() : new THREE.Color();
      this.mats.push(o.material);
    });
    this.body.add(model);
    this.model = model;
    // health bar
    this.bar = new THREE.Group();
    const bg = new THREE.Sprite(hpBarBg);
    bg.center.set(0, 0.5);
    bg.scale.set(0.9, 0.09, 1);
    this.fg = new THREE.Sprite(hpBarFg);
    this.fg.center.set(0, 0.5);
    this.fg.scale.set(0.9, 0.07, 1);
    this.fg.renderOrder = 11; bg.renderOrder = 10;
    this.bar.add(bg, this.fg);
    this.bar.visible = false;
    scene.add(this.bar);
    scene.add(this.root);
    this.pos = this.root.position;
    this.kb = new THREE.Vector3();
  }

  spawn(x, z) {
    const sc = G.scale;
    this.maxHp = this.hp = this.T.hp * sc.hp;
    this.speed = this.T.speed * sc.speed * rand(0.9, 1.1);
    this.dmg = this.T.dmg * sc.dmg;
    this.radius = this.T.radius;
    this.pos.set(x, nav.floorY, z);
    this.root.visible = true;
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, -this.T.height, 0);
    this.state = 'spawn';
    this.t = 0;
    this.atkCd = 0.5;
    this.burn = 0;
    this.flash = 0;
    this.kb.set(0, 0, 0);
    this.target = player;
    this.retarget = 0;
    this.active = true;
    this.root.rotation.y = Math.atan2(player.pos.x - x, player.pos.z - z);
    if (this.action) { this.action.paused = false; this.action.timeScale = this.T.anim; }
    for (const m of this.mats) m.opacity = 1, m.transparent = false;
  }

  damage(amount, dir, silent) {
    if (this.state === 'dead' || !this.active) return;
    this.hp -= amount;
    this.flash = 0.08;
    if (dir && this.key !== 'brute') this.kb.addScaledVector(dir, Math.min(3, amount / 40));
    if (!silent) {
      _v.set(this.pos.x, this.pos.y + this.T.height * 0.6, this.pos.z);
      fx.blood(_v, dir, Math.min(10, 3 + Math.floor(amount / 20)));
      sfx.hit();
    }
    if (this.hp <= 0) this.die();
  }

  die() {
    this.state = 'dead';
    this.t = 0;
    this.bar.visible = false;
    if (this.action) this.action.paused = true;
    G.kills++;
    const coins = this.T.coins;
    G.coins += coins;
    popup(`+${coins}`, this.pos.x, this.pos.y + this.T.height, this.pos.z, '#ffc530');
    sfx.coin();
    sfx.enemyDie(this.key === 'fast' ? 1.6 : this.key === 'brute' ? 0.6 : 1);
    _v.set(this.pos.x, this.pos.y + this.T.height * 0.5, this.pos.z);
    fx.blood(_v, null, 16);
    fx.bloodPool(this.pos.x, this.pos.z, this.key === 'brute' ? 1.6 : 1.1);
  }

  update(dt) {
    if (this.mixer && this.state !== 'dead') this.mixer.update(dt);
    if (this.flash > 0) {
      this.flash -= dt;
      const on = this.flash > 0;
      for (const m of this.mats) if (m.emissive) m.emissive.copy(on ? _flashCol : m.userData.baseEmissive);
    }
    if (this.state === 'dead') {
      this.t += dt;
      const k = Math.min(1, this.t / 0.45);
      this.body.rotation.x = -k * k * Math.PI * 0.5;
      this.body.position.y = k * 0.15;
      if (this.t > 3) this.body.position.y = -(this.t - 3) * 1.2;
      if (this.t > 4.3) { this.active = false; this.root.visible = false; }
      return;
    }
    if (this.state === 'spawn') {
      this.t += dt;
      const k = Math.min(1, this.t / 0.9);
      this.body.position.y = -this.T.height * (1 - k) * (1 - k);
      if (k >= 1) { this.state = 'chase'; this.body.position.y = 0; }
      return;
    }
    if (this.burn > 0) {
      this.burn -= dt;
      this.damage(10 * dt * (player.boosts.dmg > 0 ? 2 : 1), null, true);
      if (Math.random() < 0.4) fx.fire(_v.set(this.pos.x, this.pos.y + rand(0.3, 1.6), this.pos.z), _v2.set(0, 0.3, 0), 0.3);
      if (this.state === 'dead') return;
    }
    // choose target: player (even when downed) or companion if closer
    this.retarget -= dt;
    if (this.retarget <= 0) {
      this.retarget = 0.4;
      const dp = player.state === 'dead' ? Infinity : this.pos.distanceTo(player.pos);
      const dc = comp.state === 'up' ? this.pos.distanceTo(comp.pos) : Infinity;
      this.target = dc < dp * 0.8 ? comp : player;
    }
    const tg = this.target;
    const dx = tg.pos.x - this.pos.x, dz = tg.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const reach = this.T.reach + this.radius * 0.5 + 0.25;
    this.atkCd -= dt;

    if (this.state === 'windup') {
      this.t += dt;
      const wind = this.key === 'brute' ? 0.55 : 0.35;
      const k = this.t / wind;
      this.body.rotation.x = Math.sin(Math.min(1, k) * Math.PI) * 0.45;
      this.root.rotation.y = lerpAngle(this.root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 10));
      if (this.t >= wind) {
        this.state = 'chase';
        this.atkCd = this.T.atkRate;
        if (dist <= reach + 0.45) {
          if (tg === player) hurtPlayer(this.dmg, this);
          else hurtCompanion(this.dmg);
        }
      }
      return;
    }

    if (dist <= reach && this.atkCd <= 0) {
      this.state = 'windup';
      this.t = 0;
      sfx.swing();
      return;
    }

    // movement
    const dir = _dir.set(0, 0, 0);
    if (dist > reach * 0.8) {
      if (dist < 7 && nav.losWalk(this.pos.x, this.pos.z, tg.pos.x, tg.pos.z)) dir.set(dx / dist, 0, dz / dist);
      else if (!nav.flowDir(this.pos.x, this.pos.z, dir)) dir.set(dx / dist, 0, dz / dist);
    }
    // separation
    let sx = 0, sz = 0;
    for (const o of G.enemies) {
      if (o === this || !o.active || o.state === 'dead') continue;
      const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z;
      const rr = this.radius + o.radius;
      const d2 = ox * ox + oz * oz;
      if (d2 < rr * rr && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        const f = (rr - d) / rr;
        sx += (ox / d) * f; sz += (oz / d) * f;
      }
    }
    for (const c of [player, comp]) {
      const ox = this.pos.x - c.pos.x, oz = this.pos.z - c.pos.z;
      const rr = this.radius + 0.3;
      const d2 = ox * ox + oz * oz;
      if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2); sx += (ox / d) * 1.5; sz += (oz / d) * 1.5; }
    }
    const sp = this.speed;
    let mx = dir.x * sp + sx * 3 + this.kb.x;
    let mz = dir.z * sp + sz * 3 + this.kb.z;
    this.kb.multiplyScalar(Math.max(0, 1 - dt * 6));
    nav.move(this.pos, mx * dt, mz * dt, 0.2, true);
    const face = dist < 3 ? Math.atan2(dx, dz) : (dir.lengthSq() > 0 ? Math.atan2(dir.x, dir.z) : this.root.rotation.y);
    this.root.rotation.y = lerpAngle(this.root.rotation.y, face, Math.min(1, dt * 8));
    if (this.T.model === 'butcher') {
      // heavy waddle for the static butcher mesh
      const ph = G.time * 5 + this.pos.x;
      this.body.rotation.z = Math.sin(ph) * 0.07;
      this.body.rotation.x = 0.06;
      this.body.position.y = Math.abs(Math.sin(ph)) * 0.06;
    }
  }

  updateBar() {
    if (!this.active || this.state === 'dead' || this.hp >= this.maxHp) { this.bar.visible = false; return; }
    this.bar.visible = true;
    _v.setFromMatrixColumn(camera.matrixWorld, 0);
    this.bar.position.set(this.pos.x, this.pos.y + this.T.height + 0.25, this.pos.z).addScaledVector(_v, -0.45);
    this.fg.scale.x = 0.9 * clamp(this.hp / this.maxHp, 0, 1);
  }
}
const _flashCol = new THREE.Color(0.9, 0.15, 0.1);

function spawnEnemy(key) {
  let e = G.pool[key].find((x) => !x.active);
  if (!e) {
    e = new Enemy(key);
    G.pool[key].push(e);
    G.enemies.push(e);
  }
  const cands = G.rifts.filter((r) => { const d = nav.flowDist(r.x, r.z); return d >= 9 && d < Infinity; });
  let rift = cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
  if (!rift) rift = [...G.rifts].sort((a, b) => nav.flowDist(b.x, b.z) - nav.flowDist(a.x, a.z)).find((r) => nav.flowDist(r.x, r.z) < Infinity) || G.rifts[0];
  let x = rift.x, z = rift.z;
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * 6.28, r = Math.random() * 0.7;
    if (nav.canStand(rift.x + Math.cos(a) * r, rift.z + Math.sin(a) * r, 0.2)) { x = rift.x + Math.cos(a) * r; z = rift.z + Math.sin(a) * r; break; }
  }
  e.spawn(x, z);
  rift.pulse = 1;
  sfx.spawn();
}

function aliveCount() { let n = 0; for (const e of G.enemies) if (e.active && e.state !== 'dead') n++; return n; }

// ---------------------------------------------------------------- combat
const TRACER = new THREE.Color(1, 0.8, 0.45);
function spreadDir(dir, spread) {
  const a = Math.atan2(dir.x, dir.z) + (Math.random() - 0.5) * 2 * spread;
  return new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
}

// Hitscan bullet in the ground plane. origin2 = shooter centre (for hit tests), muzzle = visual start.
function bullet(origin2, muzzle, d, dmg, pierce, range, color, beam) {
  const len = nav.bulletLen(origin2.x, origin2.z, d.x, d.z, range);
  const hits = [];
  for (const e of G.enemies) {
    if (!e.active || e.state === 'dead') continue;
    const vx = e.pos.x - origin2.x, vz = e.pos.z - origin2.z;
    const t = vx * d.x + vz * d.z;
    if (t < -0.2 || t > len + e.radius) continue;
    const perp2 = vx * vx + vz * vz - t * t;
    const r = e.radius + (beam ? 0.12 : 0.05);
    if (perp2 < r * r) hits.push([t, e]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  let n = pierce + 1, end = len, cur = dmg;
  for (const [t, e] of hits) {
    if (n <= 0) break;
    e.damage(cur, d);
    n--;
    cur *= beam ? 0.95 : 0.8;
    if (n === 0) end = Math.max(0.3, t);
  }
  const endP = new THREE.Vector3(origin2.x + d.x * end, muzzle.y, origin2.z + d.z * end);
  fx.tracers.add(muzzle, endP, color || TRACER, beam ? 0.18 : 0.07);
  if (beam) {
    const c = color || TRACER;
    for (let i = 0; i < 3; i++) fx.tracers.add(_v.copy(muzzle).setY(muzzle.y + (i - 1) * 0.02), endP.clone().setY(endP.y + (i - 1) * 0.02), c, 0.22);
  }
  if (end === len && len < range) fx.sparks(endP, beam ? (color ? color.getHex() : 0x88ffff) : 0xffc060, beam ? 10 : 4);
}

function shoot(w, owner, origin2, muzzle, dir, dmgMul) {
  const type = w.type || 'hitscan';
  if (type === 'hitscan' || type === 'beam') {
    const pellets = w.pellets || 1;
    const col = w.color ? new THREE.Color(w.color) : null;
    for (let i = 0; i < pellets; i++) {
      bullet(origin2, muzzle, spreadDir(dir, w.spread || 0), w.dmg * dmgMul, w.pierce || 0, w.range, col, type === 'beam');
    }
  } else if (type === 'flame') {
    fx.fire(muzzle, dir, w.range * 0.55);
    for (const e of G.enemies) {
      if (!e.active || e.state === 'dead') continue;
      const vx = e.pos.x - origin2.x, vz = e.pos.z - origin2.z;
      const d = Math.hypot(vx, vz);
      if (d > w.range + e.radius) continue;
      const cos = (vx * dir.x + vz * dir.z) / (d || 1);
      if (d > 0.8 && cos < Math.cos(w.cone)) continue;
      if (!nav.losShoot(origin2.x, origin2.z, e.pos.x, e.pos.z)) continue;
      e.burn = 2.2;
      e.damage(w.dmg * dmgMul, dir, true);
    }
  } else if (type === 'tesla') {
    let best = null, bd = Infinity;
    for (const e of G.enemies) {
      if (!e.active || e.state === 'dead') continue;
      const vx = e.pos.x - origin2.x, vz = e.pos.z - origin2.z;
      const d = Math.hypot(vx, vz);
      if (d > w.range || d >= bd) continue;
      if ((vx * dir.x + vz * dir.z) / (d || 1) < Math.cos(w.cone)) continue;
      if (!nav.losShoot(origin2.x, origin2.z, e.pos.x, e.pos.z)) continue;
      best = e; bd = d;
    }
    const col = new THREE.Color(0.6, 0.8, 1.2);
    if (!best) {
      fx.arc(muzzle, _v.copy(muzzle).addScaledVector(dir, 3), col);
    } else {
      const hit = new Set();
      let from = muzzle.clone(), e = best, dmg = w.dmg * dmgMul;
      for (let c = 0; c <= w.chain && e; c++) {
        hit.add(e);
        const to = new THREE.Vector3(e.pos.x, e.pos.y + e.T.height * 0.55, e.pos.z);
        fx.arc(from, to, col);
        fx.sparks(to, 0x99ccff, 5);
        e.damage(dmg, null);
        dmg *= 0.8;
        from = to;
        let nx = null, nd = 4.5;
        for (const o of G.enemies) {
          if (!o.active || o.state === 'dead' || hit.has(o)) continue;
          const dd = Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z);
          if (dd < nd) { nd = dd; nx = o; }
        }
        e = nx;
      }
    }
  } else if (type === 'rocket') {
    const d = spreadDir(dir, w.spread || 0);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 6).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xff5010, emissiveIntensity: 0.6 }));
    mesh.position.copy(muzzle);
    mesh.lookAt(_v.copy(muzzle).add(d));
    scene.add(mesh);
    G.projectiles.push({ kind: 'rocket', mesh, pos: mesh.position, vel: d.multiplyScalar(w.projSpeed), life: w.range / w.projSpeed, dmg: w.dmg * dmgMul, splash: w.splash });
  }
  sfx.shot(w);
  if (type !== 'flame') {
    fx.flash(muzzle, type === 'beam' ? (w.color || 0x66ffff) : type === 'tesla' ? 0x99ccff : 0xffb050, type === 'beam' ? 0.5 : 0.45, 0.05);
  }
  if (owner === 'player') {
    muzzleLight.position.copy(muzzle);
    muzzleLight.intensity = type === 'flame' ? 3 : 8;
    muzzleLight.color.set(type === 'beam' ? (w.color || 0x66ffff) : type === 'tesla' ? 0x99ccff : 0xffa050);
    G.shake = Math.min(0.35, G.shake + (w.cat === 'sniper' || type === 'rocket' ? 0.18 : w.cat === 'shotgun' ? 0.12 : 0.03));
    player.rig.recoil = 1;
  }
}

function explode(pos, radius, dmg) {
  for (const e of G.enemies) {
    if (!e.active || e.state === 'dead') continue;
    const d = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
    if (d > radius + e.radius) continue;
    const dir = new THREE.Vector3(e.pos.x - pos.x, 0, e.pos.z - pos.z).normalize();
    e.damage(dmg * (1 - 0.55 * Math.min(1, d / radius)), dir);
    if (e.key !== 'brute') e.kb.addScaledVector(dir, 6);
  }
  fx.explosion(pos, radius);
  fx.bloodPool(pos.x, pos.z, 0.6);
  boomLight.position.set(pos.x, pos.y + 1, pos.z);
  boomLight.intensity = 40;
  G.shake = Math.min(0.8, G.shake + 0.5);
  sfx.explosion(radius / 4);
}

function throwGrenade() {
  if (player.state !== 'up' || player.grenades <= 0 || G.shopOpen) return;
  player.grenades--;
  const start = new THREE.Vector3(player.pos.x, player.pos.y + 1.0, player.pos.z);
  const tx = aimPoint.x - start.x, tz = aimPoint.z - start.z;
  const d = Math.min(11, Math.hypot(tx, tz));
  const ang = Math.atan2(tx, tz);
  const T = 0.55 + d * 0.035;
  const g = 14;
  const vel = new THREE.Vector3(Math.sin(ang) * d / T, (g * T) / 2 - 0.6, Math.cos(ang) * d / T);
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: 0x2c3a20, emissive: 0xff2000, emissiveIntensity: 0.4 }));
  mesh.position.copy(start);
  scene.add(mesh);
  G.projectiles.push({ kind: 'grenade', mesh, pos: mesh.position, vel, life: 1.8, dmg: 260, splash: 4 });
  sfx.throwIt();
}

function placeMine() {
  if (player.state !== 'up' || player.mines <= 0 || G.shopOpen) return;
  player.mines--;
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.2, 0.06, 12), new THREE.MeshStandardMaterial({ color: 0x2a2d25, roughness: 0.6, metalness: 0.5 }));
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff0000, toneMapped: false }));
  led.position.y = 0.05;
  g.add(base, led);
  g.position.set(player.pos.x, nav.floorY + 0.03, player.pos.z);
  scene.add(g);
  G.mines.push({ g, led, pos: g.position, arm: 1.0 });
  sfx.click();
}

function updateProjectiles(dt) {
  for (let i = G.projectiles.length - 1; i >= 0; i--) {
    const p = G.projectiles[i];
    p.life -= dt;
    let boom = p.life <= 0;
    if (p.kind === 'rocket') {
      const nx = p.pos.x + p.vel.x * dt, nz = p.pos.z + p.vel.z * dt;
      if (nav.at(nx, nz) === VOID) boom = true;
      else p.pos.set(nx, p.pos.y, nz);
      if (Math.random() < 0.9) fx.glow.spawn(p.pos.x, p.pos.y, p.pos.z, rand(-0.3, 0.3), rand(0, 0.5), rand(-0.3, 0.3), 0.35, 0.08, fx.tmpColor.setHSL(0.07, 1, 0.55), -1);
      for (const e of G.enemies) {
        if (!e.active || e.state === 'dead') continue;
        if (Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < e.radius + 0.2) { boom = true; break; }
      }
    } else if (p.kind === 'grenade') {
      p.vel.y -= 14 * dt;
      let nx = p.pos.x + p.vel.x * dt, nz = p.pos.z + p.vel.z * dt;
      if (nav.at(nx, p.pos.z) === VOID) { p.vel.x *= -0.4; nx = p.pos.x; }
      if (nav.at(p.pos.x, nz) === VOID) { p.vel.z *= -0.4; nz = p.pos.z; }
      p.pos.set(nx, p.pos.y + p.vel.y * dt, nz);
      if (p.pos.y < nav.floorY + 0.07) {
        p.pos.y = nav.floorY + 0.07;
        p.vel.y = Math.abs(p.vel.y) * 0.3;
        p.vel.x *= 0.6; p.vel.z *= 0.6;
      }
      if (p.pos.y > nav.floorY + 2.5) { p.pos.y = nav.floorY + 2.5; p.vel.y = -Math.abs(p.vel.y) * 0.3; }
      p.mesh.rotation.x += dt * 10;
    }
    if (boom) {
      explode(p.pos, p.splash, p.dmg);
      scene.remove(p.mesh);
      G.projectiles.splice(i, 1);
    }
  }
  for (let i = G.mines.length - 1; i >= 0; i--) {
    const m = G.mines[i];
    m.arm -= dt;
    m.led.visible = m.arm > 0 ? true : (G.time * 3) % 1 < 0.5;
    if (m.arm > 0) continue;
    let trig = false;
    for (const e of G.enemies) {
      if (!e.active || e.state === 'dead' || e.state === 'spawn') continue;
      if (Math.hypot(e.pos.x - m.pos.x, e.pos.z - m.pos.z) < 1.2 + e.radius * 0.5) { trig = true; break; }
    }
    if (trig) {
      explode(m.pos, 3.6, 320);
      scene.remove(m.g);
      G.mines.splice(i, 1);
    }
  }
}

// ---------------------------------------------------------------- player
function hurtPlayer(dmg, from) {
  if (player.invuln > 0 || G.over) return;
  if (player.state === 'down') {
    player.downHp -= dmg * 0.5; // demons maul a downed player less — gives the 10s stand a chance
    flashHurt(0.5);
    sfx.hurt();
    if (player.downHp <= 0) killedWhileDown();
    return;
  }
  const absorbed = Math.min(player.armor, dmg * 0.7);
  player.armor -= absorbed;
  player.hp -= dmg - absorbed;
  flashHurt(Math.min(1, dmg / 25));
  sfx.hurt();
  G.shake = Math.min(0.5, G.shake + 0.12);
  if (from) _v.set(player.pos.x, player.pos.y + 0.7, player.pos.z), fx.blood(_v, null, 5, 0x990000);
  if (player.hp <= 0) goDown();
}

function goDown() {
  player.hp = 0;
  player.state = 'down';
  player.downT = PLAYER.downedTime;
  player.downHp = PLAYER.downedHp;
  player.reloadT = 0;
  player.downedGun.ammo = WEAPON_BY_ID.m9.mag;
  sfx.downed();
  $('downed').classList.remove('hidden');
  if (G.shopOpen) closeShop();
}

function standUp(hp, msg) {
  player.state = 'up';
  player.hp = hp;
  player.invuln = 2;
  player.reloadT = 0;
  $('downed').classList.add('hidden');
  sfx.revive();
  if (msg) announce(msg, '', 1.6);
}

function killedWhileDown() {
  if (player.revive > 0) {
    player.revive--;
    standUp(60, 'გაცოცხლდი!');
    // shockwave pushes demons back
    for (const e of G.enemies) {
      if (!e.active || e.state === 'dead') continue;
      const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
      if (d < 4.5) {
        const dir = new THREE.Vector3(e.pos.x - player.pos.x, 0, e.pos.z - player.pos.z).normalize();
        e.damage(120, dir);
        e.kb.addScaledVector(dir, 9);
      }
    }
    fx.explosion(_v.copy(player.pos), 3);
    fx.flash(_v.copy(player.pos).setY(player.pos.y + 0.8), 0x40ff80, 6, 0.5);
    return;
  }
  gameOver();
}

function hurtCompanion(dmg) {
  if (comp.state !== 'up') return;
  comp.hp -= dmg;
  _v.set(comp.pos.x, comp.pos.y + 0.7, comp.pos.z);
  fx.blood(_v, null, 4);
  if (comp.hp <= 0) {
    comp.hp = 0;
    comp.state = 'down';
    comp.reviveProg = 0;
    sfx.downed();
    announce('ქრომი დაეცა!', 'მიდი და გააცოცხლე — [E]', 2.2);
  }
}

function startReload() {
  const s = curSlot();
  const w = WEAPON_BY_ID[s.id];
  if (player.reloadT > 0 || s.ammo >= w.mag) return;
  player.reloadT = player.reloadMax = w.reload;
  sfx.reload();
}

function switchSlot(i) {
  if (player.state !== 'up' || !player.slots[i] || i === player.cur) return;
  player.lastSlot = player.cur;
  player.cur = i;
  player.reloadT = 0;
  player.fireCd = 0.2;
  sfx.click();
}

function updatePlayer(dt) {
  const p = player;
  p.invuln = Math.max(0, p.invuln - dt);
  for (const k in p.boosts) p.boosts[k] = Math.max(0, p.boosts[k] - dt);
  if (p.state === 'up') {
    if (p.boosts.regen > 0) p.hp = Math.min(p.maxHp, p.hp + 6 * dt);
    if (G.phase === 'break') p.hp = Math.min(p.maxHp, p.hp + 2 * dt); // slow recovery between waves
  }

  // aim
  _v.set(aimPoint.x - p.pos.x, 0, aimPoint.z - p.pos.z);
  if (_v.lengthSq() > 0.04) aimDir.copy(_v.normalize());
  const targetYaw = Math.atan2(aimDir.x, aimDir.z);
  p.yaw = lerpAngle(p.yaw, targetYaw, Math.min(1, dt * 18));
  p.root.rotation.y = p.yaw;

  // move
  const k = input.keys;
  let mx = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
  let mz = (k.KeyS ? 1 : 0) - (k.KeyW ? 1 : 0);
  const ml = Math.hypot(mx, mz);
  let speed = 0;
  if (ml > 0 && !G.shopOpen) {
    mx /= ml; mz /= ml;
    const w = curWeapon();
    speed = p.state === 'down' ? 0.45 : PLAYER.speed * (p.boosts.speed > 0 ? 1.4 : 1) * (w.move || 1);
    nav.move(p.pos, mx * speed * dt, mz * speed * dt, p.radius);
  }
  p.speed = THREE.MathUtils.lerp(p.speed, speed, Math.min(1, dt * 10));

  if (p.state === 'down') {
    p.downT -= dt;
    $('downed-timer').textContent = Math.ceil(Math.max(0, p.downT));
    $('downed-fill').style.width = `${clamp(p.downHp / PLAYER.downedHp, 0, 1) * 100}%`;
    if (p.downT <= 0) standUp(40, 'გადარჩი!');
  }

  // body pose
  const down = p.state === 'down';
  p.tilt.rotation.x = THREE.MathUtils.lerp(p.tilt.rotation.x, down ? -Math.PI / 2 : 0, Math.min(1, dt * 8));
  p.tilt.position.y = down ? 0.12 : 0;
  p.root.updateMatrixWorld(true);
  p.rig.update(dt, down ? 0 : p.speed, p.yaw, aimDir, down ? 'down' : 'up', G.time);
  p.model.updateMatrixWorld(true);
  p.rig.updateSuit(p.uniforms);

  // weapon
  syncPlayerGun();
  const hand = p.rig.handPos(new THREE.Vector3());
  p.gun.position.copy(hand);
  p.gun.lookAt(_v.copy(hand).add(aimDir));
  const muzzle = hand.clone().addScaledVector(aimDir, p.gun.userData.muzzle);

  // reload / fire
  const slot = curSlot();
  const w = WEAPON_BY_ID[slot.id];
  p.fireCd -= dt;
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) { slot.ammo = w.mag; p.reloadT = 0; }
  }
  // auto weapons fire while held; semi-auto fire once per click (a click is buffered until it can fire)
  const trigger = !G.shopOpen && (w.auto ? input.down || input.clicked || (DEBUG && window.__forceFire) : input.clicked || (DEBUG && window.__forceFire));
  if (trigger && p.reloadT <= 0 && p.fireCd <= 0) {
    input.clicked = false;
    if (slot.ammo <= 0) { sfx.empty(); startReload(); }
    else {
      slot.ammo--;
      p.fireCd = 60 / w.rpm / (p.boosts.rate > 0 ? 1.65 : 1);
      shoot(w, 'player', p.pos, muzzle, aimDir, p.boosts.dmg > 0 ? 2 : 1);
      if (slot.ammo <= 0) startReload();
    }
  }

  // lights follow the player
  flashlight.position.set(hand.x, hand.y + 0.25, hand.z);
  flashlight.target.position.set(hand.x + aimDir.x * 6, nav.floorY, hand.z + aimDir.z * 6);
  fillLight.position.set(p.pos.x, p.pos.y + 2.3, p.pos.z);
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 120);
}

// ---------------------------------------------------------------- companion
function updateCompanion(dt) {
  const c = comp;
  const down = c.state === 'down';
  c.marker.visible = down;
  if (down) {
    c.marker.position.set(c.pos.x, nav.floorY + 0.03, c.pos.z);
    c.marker.material.opacity = 0.5 + Math.sin(G.time * 6) * 0.3;
    c.tilt.rotation.x = THREE.MathUtils.lerp(c.tilt.rotation.x, -Math.PI / 2, Math.min(1, dt * 8));
    c.tilt.position.y = 0.12;
    c.root.updateMatrixWorld(true);
    c.rig.update(dt, 0, c.yaw, null, 'dead', G.time);
    c.model.updateMatrixWorld(true);
    c.rig.updateSuit(c.uniforms);
    c.gun.visible = false;
    return;
  }
  c.gun.visible = true;
  c.tilt.rotation.x = THREE.MathUtils.lerp(c.tilt.rotation.x, 0, Math.min(1, dt * 8));
  c.tilt.position.y = 0;
  if (G.phase === 'break') c.hp = Math.min(c.maxHp, c.hp + 4 * dt);

  // target
  c.targetT -= dt;
  if (c.targetT <= 0) {
    c.targetT = 0.3;
    let best = null, bd = COMPANION.range;
    for (const e of G.enemies) {
      if (!e.active || e.state === 'dead' || e.state === 'spawn') continue;
      const d = Math.hypot(e.pos.x - c.pos.x, e.pos.z - c.pos.z);
      if (d < bd && nav.losShoot(c.pos.x, c.pos.z, e.pos.x, e.pos.z)) { bd = d; best = e; }
    }
    c.target = best;
  }
  if (c.target && (!c.target.active || c.target.state === 'dead')) c.target = null;

  // move: stay near the player, back off from demons that get too close
  const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
  const dp = Math.hypot(dx, dz);
  const dir = _dir.set(0, 0, 0);
  if (dp > 3.2) {
    if (dp < 6 && nav.losWalk(c.pos.x, c.pos.z, player.pos.x, player.pos.z)) dir.set(dx / dp, 0, dz / dp);
    else nav.flowDir(c.pos.x, c.pos.z, dir);
  } else if (c.target) {
    const tx = c.pos.x - c.target.pos.x, tz = c.pos.z - c.target.pos.z;
    const td = Math.hypot(tx, tz);
    if (td < 2.2) dir.set(tx / td, 0, tz / td);
  }
  if (dp < 1.0) dir.set(-dx / (dp || 1), 0, -dz / (dp || 1));
  const sp = dir.lengthSq() > 0 ? COMPANION.speed : 0;
  if (sp) nav.move(c.pos, dir.x * sp * dt, dir.z * sp * dt, 0.24, true);
  c.speed = THREE.MathUtils.lerp(c.speed, sp, Math.min(1, dt * 8));

  let aim;
  if (c.target) aim = new THREE.Vector3(c.target.pos.x - c.pos.x, 0, c.target.pos.z - c.pos.z).normalize();
  else if (sp) aim = dir.clone();
  else aim = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
  c.yaw = lerpAngle(c.yaw, Math.atan2(aim.x, aim.z), Math.min(1, dt * 10));
  c.root.rotation.y = c.yaw;
  const fwd = new THREE.Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw));
  c.root.updateMatrixWorld(true);
  c.rig.update(dt, c.speed, c.yaw, fwd, 'up', G.time + 1.3);
  c.model.updateMatrixWorld(true);
  c.rig.updateSuit(c.uniforms);
  const hand = c.rig.handPos(new THREE.Vector3());
  c.gun.position.copy(hand);
  c.gun.lookAt(_v.copy(hand).add(fwd));

  c.fireCd -= dt;
  if (c.target && c.fireCd <= 0 && Math.abs(lerpAngle(c.yaw, Math.atan2(aim.x, aim.z), 1) - c.yaw) < 0.3) {
    const lv = c.level - 1;
    c.fireCd = 60 / (COMPANION.rpm * (1 + 0.15 * lv));
    const muzzle = hand.clone().addScaledVector(fwd, c.gun.userData.muzzle);
    const w = { ...WEAPON_BY_ID.m4, dmg: COMPANION.dmg * (1 + 0.35 * lv), spread: 0.04, pierce: lv >= 3 ? 1 : 0, range: COMPANION.range + 2 };
    shoot(w, 'comp', c.pos, muzzle, fwd, 1);
  }
}

// ---------------------------------------------------------------- waves
function startBreak(t) {
  G.phase = 'break';
  G.breakT = t;
}

function startWave() {
  G.wave++;
  G.phase = 'wave';
  G.scale = waveScaling(G.wave);
  G.queue = waveComposition(G.wave);
  G.spawnT = 1.5;
  G.waveTotal = G.queue.length;
  sfx.siren();
  const boss = G.wave % 5 === 0;
  announce(`ტალღა ${G.wave}`, boss ? 'ბრუტები მოდიან...' : `${G.waveTotal} დემონი`, 2.5);
  hemi.color.set(0xff3030);
  setTimeout(() => hemi.color.set(0x8a9ac0), 900);
}

function updateWaves(dt) {
  if (G.phase === 'break') {
    G.breakT -= dt;
    if (G.breakT <= 0) startWave();
    return;
  }
  G.spawnT -= dt;
  if (G.queue.length && G.spawnT <= 0 && aliveCount() < G.scale.maxAlive) {
    spawnEnemy(G.queue.pop());
    G.spawnT = G.scale.spawnGap * rand(0.6, 1.4);
  }
  if (!G.queue.length && aliveCount() === 0) {
    const bonus = 50 + G.wave * 25;
    G.coins += bonus;
    sfx.waveClear();
    announce(`ტალღა ${G.wave} გავლილია`, `ბონუსი +${bonus} · შესვენება ${BREAK_TIME} წამი`, 3);
    startBreak(BREAK_TIME);
  }
}

// ---------------------------------------------------------------- shop
function nearestKiosk() {
  let best = null, bd = 1.9;
  for (const k of G.kiosks) {
    const d = Math.hypot(k.pos.x - player.pos.x, k.pos.z - player.pos.z);
    if (d < bd) { bd = d; best = k; }
  }
  return best;
}

function openShop(k) {
  G.shopOpen = k;
  input.down = false;
  $('shop').classList.remove('hidden');
  $('crosshair').style.display = 'none';
  canvas.style.cursor = 'default';
  renderShop();
  sfx.click();
}

function closeShop() {
  G.shopOpen = null;
  $('shop').classList.add('hidden');
  $('crosshair').style.display = '';
  canvas.style.cursor = 'none';
}

function card(item, price, state, onBuy) {
  const d = document.createElement('div');
  d.className = `card${state.owned ? ' owned' : ''}`;
  d.innerHTML = `<div class="nm">${item.name}</div><div class="ds">${item.desc || ''}</div>
    <div class="row"><span class="pr">${price === 0 ? 'უფასო' : price}</span><button ${state.disabled ? 'disabled' : ''}>${state.label || 'ყიდვა'}</button></div>`;
  d.querySelector('button').addEventListener('click', (ev) => { ev.stopPropagation(); onBuy(); });
  return d;
}

function pay(price) {
  if (G.coins < price) { sfx.error(); return false; }
  G.coins -= price;
  sfx.buy();
  return true;
}

function weaponDesc(w) {
  const type = w.type || 'hitscan';
  const dmg = w.pellets ? `${w.dmg}×${w.pellets}` : w.dmg;
  const extra = type === 'flame' ? ' · წვა' : type === 'tesla' ? ` · ჯაჭვი ×${w.chain}` : type === 'rocket' ? ' · აფეთქება' : w.pierce ? ` · გამჭოლი ${w.pierce > 50 ? '∞' : w.pierce}` : '';
  return `ზიანი ${dmg} · ${w.rpm}/წთ · ${w.mag} ტყვია${extra}`;
}

function renderShop() {
  const k = G.shopOpen;
  if (!k) return;
  $('shop-title').textContent = k.name;
  $('shop-coins').textContent = G.coins;
  const body = $('shop-body');
  body.innerHTML = '';
  if (k.id === 'arms') {
    $('shop-note').textContent = 'ატარებ 3 იარაღს: პისტოლეტი + 2 ძირითადი. ახალი იარაღი ცვლის ხელში არსებულს (ან ცარიელ სლოტს).';
    for (const cat of Object.keys(CATEGORIES)) {
      const t = document.createElement('div');
      t.className = 'cat-title';
      t.textContent = CATEGORIES[cat];
      body.appendChild(t);
      const grid = document.createElement('div');
      grid.className = 'cards';
      for (const w of WEAPONS.filter((x) => x.cat === cat)) {
        const owned = player.slots.some((s) => s && s.id === w.id);
        grid.appendChild(card({ name: w.name, desc: weaponDesc(w) }, w.price,
          { owned, disabled: G.coins < w.price, label: owned ? 'ტყვიები' : 'ყიდვა' },
          () => buyWeapon(w)));
      }
      body.appendChild(grid);
    }
  } else {
    const list = k.id === 'armor' ? ARMOR_ITEMS : MED_ITEMS;
    $('shop-note').textContent = k.id === 'armor' ? `ბრონი: ${Math.round(player.armor)} · ყუმბარები: ${player.grenades} · ნაღმები: ${player.mines}`
      : `გამაცოცხლებელი: ${player.revive}/1 · ქრომის დონე: ${comp.level}/5`;
    const grid = document.createElement('div');
    grid.className = 'cards';
    for (const it of list) {
      let price = it.price;
      let disabled = G.coins < price;
      let label;
      if (it.id === 'revive' && player.revive >= 1) { disabled = true; label = 'გაქვს'; }
      if (it.id === 'grenade' && player.grenades >= 10) { disabled = true; label = 'სავსეა'; }
      if (it.id === 'mine' && player.mines >= 8) { disabled = true; label = 'სავსეა'; }
      if (it.armor && player.armor >= it.armor) { disabled = true; label = 'გაქვს'; }
      if (it.id === 'medkit' && player.hp >= player.maxHp) { disabled = true; label = 'სავსეა'; }
      if (it.id === 'comp_heal' && (comp.state !== 'up' || comp.hp >= comp.maxHp)) { disabled = true; label = comp.state !== 'up' ? 'დაცემულია' : 'სავსეა'; }
      if (it.id === 'comp_up') {
        price = it.price * comp.level;
        disabled = comp.level >= 5 || G.coins < price;
        if (comp.level >= 5) label = 'მაქს.';
      }
      grid.appendChild(card(it, price, { disabled, label }, () => buyItem(it, price)));
    }
    body.appendChild(grid);
  }
}

function buyWeapon(w) {
  const idx = player.slots.findIndex((s) => s && s.id === w.id);
  if (idx >= 0) {
    // already owned: refill for free and equip
    player.slots[idx].ammo = w.mag;
    switchSlot(idx);
    sfx.reload();
    renderShop();
    return;
  }
  if (!pay(w.price)) return;
  let slot = player.slots[1] ? (player.slots[2] ? (player.cur === 0 ? 1 : player.cur) : 2) : 1;
  if (w.id === 'm9') slot = 0;
  player.slots[slot] = { id: w.id, ammo: w.mag };
  player.lastSlot = player.cur;
  player.cur = slot;
  player.reloadT = 0;
  renderShop();
}

function buyItem(it, price) {
  if (!pay(price)) { renderShop(); return; }
  switch (it.id) {
    case 'armor_light': case 'armor_heavy': case 'armor_jugg':
      player.armor = Math.max(player.armor, it.armor);
      player.maxArmor = Math.max(player.maxArmor, it.armor);
      break;
    case 'grenade': player.grenades = Math.min(10, player.grenades + 3); break;
    case 'mine': player.mines = Math.min(8, player.mines + 2); break;
    case 'revive': player.revive = 1; break;
    case 'medkit': player.hp = player.maxHp; break;
    case 'comp_heal': comp.hp = comp.maxHp; break;
    case 'comp_up':
      comp.level++;
      comp.maxHp = COMPANION.hp * (1 + 0.3 * (comp.level - 1));
      comp.hp = comp.maxHp;
      break;
    default:
      if (it.boost) player.boosts[it.boost] = Math.max(player.boosts[it.boost], 0) + it.time;
  }
  renderShop();
}

// ---------------------------------------------------------------- HUD
const hudCache = {};
function setText(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).textContent = v; } }
function setHTML(id, v) { if (hudCache[id] !== v) { hudCache[id] = v; $(id).innerHTML = v; } }

let announceT = 0;
function announce(big, small, t = 2) {
  $('announce-big').textContent = big;
  $('announce-small').textContent = small;
  $('announce').classList.add('show');
  announceT = t;
}

let hurtV = 0;
function flashHurt(v) { hurtV = Math.min(1, hurtV + v); }

const popups = [];
function popup(text, x, y, z, color) {
  let p = popups.find((q) => q.t <= 0);
  if (!p) {
    if (popups.length > 30) return;
    const el = document.createElement('div');
    el.className = 'popup';
    $('popups').appendChild(el);
    p = { el, t: 0, pos: new THREE.Vector3() };
    popups.push(p);
  }
  p.el.textContent = text;
  p.el.style.color = color;
  p.pos.set(x, y, z);
  p.t = 1;
  p.el.style.display = '';
}

function updatePopups(dt) {
  for (const p of popups) {
    if (p.t <= 0) continue;
    p.t -= dt;
    if (p.t <= 0) { p.el.style.display = 'none'; continue; }
    p.pos.y += dt * 0.8;
    _v.copy(p.pos).project(camera);
    p.el.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`;
    p.el.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
    p.el.style.opacity = Math.min(1, p.t * 2);
  }
}

function updateHUD(dt) {
  const p = player;
  if (G.phase === 'break') {
    setText('wave-title', G.wave === 0 ? 'მოემზადე' : `შესვენება`);
    setText('wave-sub', `ტალღა ${G.wave + 1} იწყება ${Math.ceil(G.breakT)} წამში · [N] ახლავე`);
  } else {
    setText('wave-title', `ტალღა ${G.wave}`);
    setText('wave-sub', `დემონები: ${aliveCount() + G.queue.length}`);
  }
  setText('coin-val', String(G.coins));
  $('hp-fill').style.width = `${clamp(p.hp / p.maxHp, 0, 1) * 100}%`;
  setText('hp-val', String(Math.ceil(Math.max(0, p.hp))));
  $('ar-fill').style.width = `${p.maxArmor ? clamp(p.armor / p.maxArmor, 0, 1) * 100 : 0}%`;
  setText('ar-val', String(Math.ceil(p.armor)));
  setHTML('items', `<span class="chip ${p.grenades ? '' : 'off'}">[G] ყუმბარა ×${p.grenades}</span>`
    + `<span class="chip ${p.mines ? '' : 'off'}">[F] ნაღმი ×${p.mines}</span>`
    + `<span class="chip ${p.revive ? 'on' : 'off'}">✚ გამაცოცხლებელი ${p.revive}/1</span>`);
  let b = '';
  for (const k in p.boosts) if (p.boosts[k] > 0) b += `<span class="chip boost">${BOOST_LABELS[k]} ${Math.ceil(p.boosts[k])}წ</span>`;
  setHTML('boosts', b);
  setHTML('companion-box', comp.state === 'up'
    ? `<span class="name">ქრომი</span> · დონე ${comp.level} · ${Math.ceil(comp.hp)}/${Math.round(comp.maxHp)}`
    : '<span class="down">ქრომი დაეცა — გააცოცხლე [E]</span>');

  const s = curSlot();
  const w = WEAPON_BY_ID[s.id];
  setText('weapon-name', p.state === 'down' ? `${w.name} (დაცემული)` : w.name);
  setText('ammo-cur', String(s.ammo));
  setText('ammo-max', String(w.mag));
  $('ammo').classList.toggle('low', s.ammo <= Math.ceil(w.mag * 0.25));
  const rt = $('reload-track');
  rt.style.visibility = p.reloadT > 0 ? 'visible' : 'hidden';
  if (p.reloadT > 0) $('reload-fill').style.width = `${(1 - p.reloadT / p.reloadMax) * 100}%`;
  setHTML('slots', p.slots.map((sl, i) => `<span class="slot ${i === p.cur && p.state === 'up' ? 'active' : ''}">${i + 1} ${sl ? WEAPON_BY_ID[sl.id].name : '—'}</span>`).join(''));

  // prompts
  let prompt = '';
  const dc = Math.hypot(comp.pos.x - p.pos.x, comp.pos.z - p.pos.z);
  if (p.state === 'up' && comp.state === 'down' && dc < 1.6) {
    prompt = input.keys.KeyE
      ? `ქრომის გაცოცხლება...<div class="progress" style="width:${(comp.reviveProg / COMPANION.reviveTime) * 100}%"></div>`
      : 'დააჭირე და გააჩერე [E] — ქრომის გაცოცხლება';
  } else if (p.state === 'up' && !G.shopOpen) {
    const k = nearestKiosk();
    if (k) prompt = `[E] ${k.name}`;
  }
  const pe = $('prompt');
  if (prompt) { pe.style.display = 'block'; setHTML('prompt', prompt); } else pe.style.display = 'none';

  // effects
  hurtV = Math.max(0, hurtV - dt * 1.5);
  const low = p.state === 'down' ? 0.6 : p.hp < 35 ? 0.35 + Math.sin(G.time * 5) * 0.1 : 0;
  $('hurt').style.opacity = Math.max(hurtV, low);
  if (announceT > 0) { announceT -= dt; if (announceT <= 0) $('announce').classList.remove('show'); }
  if (G.shopOpen) setText('shop-coins', String(G.coins));
}

// minimap
let miniBase;
function buildMinimapBase() {
  const c = document.createElement('canvas');
  c.width = nav.w; c.height = nav.h;
  const x = c.getContext('2d');
  const img = x.createImageData(nav.w, nav.h);
  for (let i = 0; i < nav.w * nav.h; i++) {
    const v = nav.grid[i];
    const col = v === FLOOR ? [70, 72, 80, 255] : v === OBST ? [38, 36, 40, 255] : [0, 0, 0, 0];
    img.data.set(col, i * 4);
  }
  x.putImageData(img, 0, 0);
  miniBase = c;
}

function drawMinimap() {
  const mc = $('minimap');
  const x = mc.getContext('2d');
  x.clearRect(0, 0, mc.width, mc.height);
  const s = Math.min(mc.width / nav.w, mc.height / nav.h);
  const ox = (mc.width - nav.w * s) / 2, oy = (mc.height - nav.h * s) / 2;
  x.imageSmoothingEnabled = false;
  x.drawImage(miniBase, ox, oy, nav.w * s, nav.h * s);
  const P = (px, pz) => [ox + ((px - nav.minX) / nav.cell) * s, oy + ((pz - nav.minZ) / nav.cell) * s];
  const dot = (px, pz, r, col) => { const [a, b] = P(px, pz); x.fillStyle = col; x.beginPath(); x.arc(a, b, r, 0, 7); x.fill(); };
  for (const r of G.rifts) dot(r.x, r.z, 3, 'rgba(255,30,30,0.5)');
  for (const k of G.kiosks) {
    const [a, b] = P(k.pos.x, k.pos.z);
    x.fillStyle = `#${new THREE.Color(k.color).getHexString()}`;
    x.fillRect(a - 3.5, b - 3.5, 7, 7);
  }
  for (const e of G.enemies) {
    if (!e.active || e.state === 'dead') continue;
    dot(e.pos.x, e.pos.z, e.key === 'brute' ? 3 : 2, e.key === 'fast' ? '#ff4030' : e.key === 'brute' ? '#e0a040' : '#6aa0ff');
  }
  dot(comp.pos.x, comp.pos.z, 3, comp.state === 'up' ? '#ffa020' : (G.time * 4) % 1 < 0.5 ? '#ff2020' : '#ffa020');
  dot(player.pos.x, player.pos.z, 3.5, '#ffffff');
}

// ---------------------------------------------------------------- camera
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
function updateCamera(dt, snap) {
  const pitch = 1.0;
  const lead = _v.set(aimPoint.x - player.pos.x, 0, aimPoint.z - player.pos.z);
  if (lead.length() > 3) lead.setLength(3);
  const tx = player.pos.x + lead.x * 0.3, tz = player.pos.z + lead.z * 0.3;
  const want = _v2.set(tx, nav.floorY + Math.sin(pitch) * G.zoom, tz + Math.cos(pitch) * G.zoom);
  const k = snap ? 1 : Math.min(1, dt * 6);
  camPos.lerp(want, k);
  camLook.lerp(_dir.set(tx, nav.floorY + 0.5, tz), k);
  camera.position.copy(camPos);
  if (G.shake > 0) {
    camera.position.x += (Math.random() - 0.5) * G.shake * 0.5;
    camera.position.y += (Math.random() - 0.5) * G.shake * 0.5;
    G.shake = Math.max(0, G.shake - dt * 2);
  }
  camera.lookAt(camLook);
  if (G.camHook) G.camHook(camera, player, comp);
}

function updateAim() {
  input.mouse.set((input.mx / innerWidth) * 2 - 1, -(input.my / innerHeight) * 2 + 1);
  raycaster.setFromCamera(input.mouse, camera);
  raycaster.ray.intersectPlane(aimPlane, aimPoint);
  if (G.autoAim) {
    let best = null, bd = Infinity;
    for (const e of G.enemies) {
      if (!e.active || e.state === 'dead' || e.state === 'spawn') continue;
      const d = e.pos.distanceTo(player.pos);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) aimPoint.set(best.pos.x, aimPoint.y, best.pos.z);
  }
  const ch = $('crosshair');
  ch.style.transform = `translate(${input.mx}px, ${input.my}px)`;
}

// ---------------------------------------------------------------- atmosphere
function updateAtmosphere(dt) {
  for (const l of roomLights) {
    const u = l.userData;
    if (Math.random() < dt * 0.6) u.flick = Math.random() < 0.5 ? 0.05 : 0.4;
    u.flick = THREE.MathUtils.lerp(u.flick, 1, dt * 3);
    l.intensity = u.base * u.flick * (0.9 + Math.random() * 0.1);
  }
  boomLight.intensity = Math.max(0, boomLight.intensity - dt * 120);
  for (const r of G.rifts) {
    r.pulse = Math.max(0, r.pulse - dt * 1.2);
    r.ring.rotation.z += dt * (0.5 + r.pulse * 4);
    r.glow.material.opacity = 0.25 + r.pulse * 0.7 + Math.sin(G.time * 2 + r.x) * 0.05;
    r.glow.scale.setScalar(2 + r.pulse * 1.5);
  }
  for (const k of G.kiosks) {
    k.holo.rotation.y += dt * 1.5;
    k.holo.position.y = 1.62 + Math.sin(G.time * 2) * 0.05;
  }
  // demon groans
  G.groanT -= dt;
  if (G.groanT <= 0) {
    G.groanT = rand(1.5, 4);
    const near = G.enemies.filter((e) => e.active && e.state !== 'dead');
    if (near.length) {
      const e = near[Math.floor(Math.random() * near.length)];
      sfx.groan(e.key === 'fast' ? 1.8 : e.key === 'brute' ? 0.6 : 1);
    }
  }
  // heartbeat
  if (player.state === 'down' || player.hp < 35) {
    G.heartT -= dt;
    if (G.heartT <= 0) { G.heartT = player.state === 'down' ? 0.6 : 0.9; sfx.heartbeat(); }
  }
}

// ---------------------------------------------------------------- main loop
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!G.started) return;
  if (!G.paused && !G.over) step(dt);
  renderer.render(scene, camera);
}

function step(dt) {
  G.time += dt;
  updateAim();
  G.flowT -= dt;
  if (G.flowT <= 0) { G.flowT = 0.25; nav.computeFlow(player.pos.x, player.pos.z); }
  updateWaves(dt);
  updatePlayer(dt);
  updateCompanion(dt);
  for (const e of G.enemies) if (e.active) e.update(dt);
  updateProjectiles(dt);

  // companion revive (hold E)
  if (comp.state === 'down' && player.state === 'up' && input.keys.KeyE
    && Math.hypot(comp.pos.x - player.pos.x, comp.pos.z - player.pos.z) < 1.6) {
    comp.reviveProg += dt;
    if (comp.reviveProg >= COMPANION.reviveTime) {
      comp.state = 'up';
      comp.hp = comp.maxHp;
      comp.reviveProg = 0;
      sfx.revive();
      fx.flash(_v.copy(comp.pos).setY(comp.pos.y + 0.6), 0xffb040, 3, 0.4);
      announce('ქრომი დაბრუნდა!', '', 1.4);
    }
  } else comp.reviveProg = 0;

  if (G.shopOpen && Math.hypot(G.shopOpen.pos.x - player.pos.x, G.shopOpen.pos.z - player.pos.z) > 2.6) closeShop();

  arenaMixer.update(dt);
  updateAtmosphere(dt);
  updateCamera(dt);
  for (const e of G.enemies) e.updateBar();
  fx.update(dt);
  updatePopups(dt);
  updateHUD(dt);
  drawMinimap();
}

// ---------------------------------------------------------------- flow control
function gameOver() {
  G.over = true;
  player.state = 'dead';
  closeShop();
  $('downed').classList.add('hidden');
  let best = 0;
  try { best = Number(localStorage.getItem('hw-best') || 0); if (G.wave > best) localStorage.setItem('hw-best', String(G.wave)); } catch (e) { /* storage unavailable */ }
  $('go-stats').innerHTML = `გადარჩი <b>${Math.max(0, G.wave - 1)}</b> ტალღას · მიაღწიე ტალღა <b>${G.wave}</b>-ს<br>მოკლული დემონები: <b>${G.kills}</b><br>`
    + `${G.wave > best ? 'ახალი რეკორდი!' : `რეკორდი: ტალღა ${best}`}`;
  $('gameover').classList.remove('hidden');
  $('hud').classList.add('hidden');
}

function resetGame() {
  for (const e of G.enemies) { e.active = false; e.root.visible = false; e.bar.visible = false; }
  for (const p of G.projectiles) scene.remove(p.mesh);
  for (const m of G.mines) scene.remove(m.g);
  G.projectiles.length = 0;
  G.mines.length = 0;
  Object.assign(G, { over: false, paused: false, time: 0, wave: 0, coins: 0, kills: 0, shake: 0, queue: [], shopOpen: null });
  Object.assign(player, {
    hp: PLAYER.hp, maxHp: PLAYER.hp, armor: 0, maxArmor: 0, state: 'up', invuln: 0,
    slots: [{ id: 'm9', ammo: WEAPON_BY_ID.m9.mag }, null, null], cur: 0, lastSlot: 0,
    reloadT: 0, fireCd: 0, grenades: 2, mines: 0, revive: 0, boosts: { dmg: 0, rate: 0, speed: 0, regen: 0 },
  });
  Object.assign(comp, { hp: COMPANION.hp, maxHp: COMPANION.hp, level: 1, state: 'up', reviveProg: 0, target: null });
  player.tilt.rotation.x = 0; comp.tilt.rotation.x = 0;
  placeCharacters();
  startBreak(FIRST_BREAK);
  announce('მოემზადე', 'იყიდე იარაღი — დემონები მალე მოვლენ', 3);
  $('downed').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('hud').classList.remove('hidden');
  nav.computeFlow(player.pos.x, player.pos.z);
  updateAim();
  updateCamera(0, true);
}

function setPaused(p) {
  if (!G.started || G.over) return;
  G.paused = p;
  $('pause').classList.toggle('hidden', !p);
  if (p) input.down = false;
}

// ---------------------------------------------------------------- input
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  input.keys[e.code] = true;
  if (!G.started || G.over) return;
  if (e.code === 'KeyP' || (e.code === 'Escape' && !G.shopOpen)) { setPaused(!G.paused); return; }
  if (G.paused) return;
  if (e.code === 'Escape' && G.shopOpen) { closeShop(); return; }
  if (e.code === 'KeyE') {
    if (G.shopOpen) { closeShop(); return; }
    const nearComp = comp.state === 'down' && Math.hypot(comp.pos.x - player.pos.x, comp.pos.z - player.pos.z) < 1.6;
    const k = nearestKiosk();
    if (!nearComp && k && player.state === 'up') openShop(k);
  }
  if (e.code === 'KeyR' && player.state !== 'dead') startReload();
  if (e.code === 'Digit1') switchSlot(0);
  if (e.code === 'Digit2') switchSlot(1);
  if (e.code === 'Digit3') switchSlot(2);
  if (e.code === 'KeyQ') switchSlot(player.lastSlot);
  if (e.code === 'KeyG') throwGrenade();
  if (e.code === 'KeyF') placeMine();
  if (e.code === 'KeyN' && G.phase === 'break') G.breakT = 0;
  if (e.code === 'KeyM') { G.muted = !G.muted; sfx.setMuted(G.muted); }
});
addEventListener('keyup', (e) => { input.keys[e.code] = false; });
addEventListener('blur', () => { input.keys = {}; input.down = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
addEventListener('mousemove', (e) => { input.mx = e.clientX; input.my = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || G.shopOpen) return;
  input.down = true;
  input.clicked = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.down = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', (e) => { if (!G.shopOpen) G.zoom = clamp(G.zoom + Math.sign(e.deltaY) * 0.8, 7, 16); }, { passive: true });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
$('shop-close').addEventListener('click', closeShop);
$('shop').addEventListener('mousedown', (e) => { if (e.target === $('shop')) closeShop(); });
$('resume').addEventListener('click', () => setPaused(false));
$('restart').addEventListener('click', () => { sfx.init(); resetGame(); });
$('play').addEventListener('click', () => {
  sfx.init();
  $('menu').classList.add('hidden');
  G.started = true;
  resetGame();
});

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const best = Number(localStorage.getItem('hw-best') || 0);
    if (best) $('best').textContent = `რეკორდი: ტალღა ${best}`;
  } catch (e) { /* storage unavailable */ }
  try {
    await loadAssets();
    const hb = new THREE.Box3().setFromObject(assets.huggy.scene);
    huggyH = hb.max.y - hb.min.y;
    const bb = new THREE.Box3().setFromObject(assets.butcher.scene);
    butcherH = bb.max.y - bb.min.y;
    await new Promise((r) => setTimeout(r, 30));
    buildWorld();
    $('load-fill').style.width = '95%';
    setupCharacters();
    placeCharacters();
    // warm up shaders with one enemy of each type
    for (const k of ['easy', 'fast', 'brute']) {
      const e = new Enemy(k);
      e.active = false; e.root.visible = true;
      e.pos.set(player.pos.x, -50, player.pos.z);
      G.pool[k].push(e); G.enemies.push(e);
    }
    syncPlayerGun();
    updateCamera(0, true);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    for (const k of ['easy', 'fast', 'brute']) G.pool[k][0].root.visible = false;
    $('load-fill').style.width = '100%';
    $('load-status').textContent = 'მზადაა';
    $('play').disabled = false;
    window.__ready = true;
  } catch (err) {
    console.error(err);
    $('load-status').textContent = `ჩატვირთვის შეცდომა: ${err.message || err}`;
  }
})();
requestAnimationFrame(frame);
