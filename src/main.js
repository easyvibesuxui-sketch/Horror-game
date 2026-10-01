import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import {
  WEAPONS, WEAPON_BY_ID, CATEGORIES, ENEMY_TYPES, PLAYER, COMPANION, SHOPS, ARMOR_ITEMS, MED_ITEMS,
  BOOST_LABELS, waveComposition, waveScaling, waveKind, BREAK_TIME, FIRST_BREAK,
  maxReserve, ammoPrice, ADS_FOV, POWERUPS, DROP_CHANCE, DIFFICULTY, PROMO_CODES,
} from './config.js';
import { Nav, VOID, FLOOR, OBST } from './nav.js';
import { Sfx } from './audio.js';
import { FX } from './fx.js';
import { makeGnome, Rig, VALVE_BONES } from './rig.js';
import { ViewModel } from './viewmodel.js';
import { initWeaponModels, propModel } from './weapons3d.js';

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
renderer.toneMappingExposure = 1.2;
renderer.autoClear = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020203);
scene.fog = new THREE.Fog(0x020203, 7, 26);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 80);
camera.rotation.order = 'YXZ';

const sfx = new Sfx();
const fx = new FX(scene);
const nav = new Nav();
const vm = new ViewModel(fx.glowTex, renderer);

// ---------------------------------------------------------------- lights
const hemi = new THREE.HemisphereLight(0x8a9ac0, 0x1a0c0c, 0.5);
scene.add(hemi);
const flashlight = new THREE.SpotLight(0xfff0d0, 40, 22, 0.52, 0.55, 1.2);
scene.add(flashlight, flashlight.target);
const fillLight = new THREE.PointLight(0xa8bcff, 1.6, 5, 1.4);
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
  coins: 0, kills: 0, shake: 0,
  diff: 'medium', promoCoins: 0,
  enemies: [], pool: {},
  projectiles: [], mines: [], rifts: [], kiosks: [], blockers: [], powerups: [],
  shopOpen: null, flowT: 0, groanT: 3, heartT: 0, locked: false,
  ws: null, // per-wave stats for the stage-clear bonus
};
function newWaveStats() { return { kills: 0, heads: 0, knife: 0, dmg: 0, dogDowns: 0, start: G.time }; }
const assets = {};
const PREP = {};
const input = { keys: {}, down: false, clicked: false, lookDX: 0, lookDY: 0 };
let sens = 0.0022;
try { sens = Number(localStorage.getItem('hw-sens')) || sens; } catch (e) { /* storage unavailable */ }

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
raycaster.firstHitOnly = true;

// Debug/test hooks: only in dev server or with ?debug in the URL.
const DEBUG = import.meta.env.DEV || /[?&]debug\b/.test(location.search);

// ---------------------------------------------------------------- loading
async function loadAssets() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const files = {
    arena: 'arena.glb', chromie: 'chromie.glb', huggy: 'huggy.glb', butcher: 'butcher.glb',
    dog: 'dog.glb', siren: 'siren.glb', nurse: 'nurse.glb', weapons: 'weapons.glb',
  };
  const prog = {};
  const update = () => {
    const p = Object.values(prog).reduce((a, b) => a + b, 0) / Object.keys(files).length;
    $('load-fill').style.width = `${Math.round(p * 85)}%`;
  };
  await Promise.all(Object.entries(files).map(([k, f]) => new Promise((res, rej) => {
    loader.load(`${BASE}models/${f}`, (g) => { assets[k] = g; prog[k] = 1; update(); res(); },
      (e) => { if (e.total) { prog[k] = e.loaded / e.total; update(); } }, rej);
  })));
  try { await Promise.race([Promise.all([document.fonts.load('700 40px "Oswald"'), document.fonts.load('40px "Creepster"')]), new Promise((r) => setTimeout(r, 2500))]); } catch (e) { /* font optional */ }
}

// Measure a model (in its first animation pose) so clones can be centred, grounded and scaled.
function prepModel(key) {
  const g = assets[key];
  const sc = g.scene;
  let clip = g.animations[0] || null;
  if (clip) {
    // strip root motion so the run cycle plays in place
    for (const t of clip.tracks) {
      if (/Hips.*\.position$/.test(t.name)) {
        const v = t.values;
        for (let i = 3; i < v.length; i += 3) { v[i] = v[0]; v[i + 2] = v[2]; }
      }
    }
  }
  let mixer = null;
  if (clip) { mixer = new THREE.AnimationMixer(sc); mixer.clipAction(clip).play(); mixer.update(0); }
  sc.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(sc, true);
  if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(sc); }
  sc.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  PREP[key] = {
    h: box.max.y - box.min.y, minY: box.min.y,
    cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2, clip,
  };
}

// ---------------------------------------------------------------- world
let arenaMixer;
function buildWorld() {
  const arena = assets.arena.scene;
  scene.add(arena);
  arena.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.computeBoundsTree();
    if (/Room1/.test(o.material.name)) o.material.side = THREE.FrontSide;
    G.blockers.push(o);
  });
  arenaMixer = new THREE.AnimationMixer(arena);
  assets.arena.animations.forEach((c) => arenaMixer.clipAction(c).play());

  $('load-status').textContent = 'Mapping the station...';
  nav.build(arena);
  fx.floorY = nav.floorY;

  SHOPS.forEach((s) => buildKiosk(s));
  [[1.1, -7.4], [-10.4, 2.1], [8.2, 3.9], [-2.4, -5.6], [0.1, 9.0], [3.3, -1.5], [-9.5, -3.5]].forEach(([x, z]) => buildRift(x, z));
  buildMinimapBase();
}

function textSprite(text, color, w = 2.6) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 160;
  const x = c.getContext('2d');
  x.font = '700 64px "Oswald", sans-serif';
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
  const label = textSprite(s.name, `#${col.getHexString()}`, 2.2);
  label.position.y = 2.05;
  const light = new THREE.PointLight(s.color, 5, 5, 1.5);
  light.position.set(0, 1.4, 0.6);
  g.add(base, body, screen, strip, holo, label, light);
  scene.add(g);
  G.blockers.push(base, body);
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

// ---------------------------------------------------------------- player (first person, no body)
const player = {
  pos: new THREE.Vector3(), yaw: Math.PI, pitch: 0, roll: 0, eye: PLAYER.eye, speed: 0, bobT: 0, stepT: 0,
  hp: PLAYER.hp, maxHp: PLAYER.hp, armor: 0, maxArmor: 0,
  state: 'up', downT: 0, downHp: 0, invuln: 0,
  slots: [newSlot('m9'), null, null], cur: 0, lastSlot: 0,
  downedGun: newSlot('m9'),
  reloadT: 0, reloadMax: 0, fireCd: 0,
  grenades: 2, mines: 0, revive: 0,
  boosts: { dmg: 0, rate: 0, speed: 0, regen: 0, insta: 0, double: 0 },
  vmId: null, radius: PLAYER.radius,
  ads: 0, bloom: 0, spreadNow: 0, stamina: 100, staminaCd: 0, exhausted: false, sprinting: false,
  knifeCd: 0, lastHurt: -99,
};
function newSlot(id) { const w = WEAPON_BY_ID[id]; return { id, ammo: w.mag, reserve: maxReserve(w) }; }

function curSlot() { return player.state === 'down' ? player.downedGun : player.slots[player.cur]; }
function curWeapon() { return WEAPON_BY_ID[curSlot().id]; }
function lookDir(out = new THREE.Vector3()) { return camera.getWorldDirection(out); }
function syncViewModel() {
  const id = curSlot().id;
  if (player.vmId === id) return;
  player.vmId = id;
  vm.setWeapon(WEAPON_BY_ID[id]);
}

// ---------------------------------------------------------------- companion: the black dog
let comp;
function setupCompanion() {
  const src = assets.dog.scene;
  const P = PREP.dog;
  const model = src;
  model.position.set(-P.cx, -P.minY, -P.cz);
  const scaler = new THREE.Group();
  scaler.add(model);
  scaler.scale.setScalar(1.75 / P.h);
  const tilt = new THREE.Group();
  tilt.add(scaler);
  const root = new THREE.Group();
  root.add(tilt);
  scene.add(root);
  const mats = [];
  model.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); mats.push(o.material); } });
  const tag = textSprite(COMPANION.name, '#ff5050', 0.9);
  tag.position.y = 2.0;
  root.add(tag);
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.6, 32), new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  scene.add(marker);
  comp = {
    root, tilt, model: scaler, rig: new Rig(model, VALVE_BONES), mats, marker, tag,
    pos: root.position, yaw: 0, speed: 0, radius: 0.3,
    hp: COMPANION.hp, maxHp: COMPANION.hp, level: 1, state: 'up',
    target: null, targetT: 0, atkCd: 0, swingT: -1, reviveProg: 0, stepT: 0,
  };
}

function placeCharacters() {
  const p = nav.nearestStand(0, 4.0, 0.4);
  player.pos.set(p.x, nav.floorY, p.y);
  player.yaw = Math.PI; // facing north, towards the corridors
  player.pitch = 0;
  const c = nav.nearestStand(p.x + 1.2, p.y + 0.6, 0.4);
  comp.pos.set(c.x, nav.floorY, c.y);
  comp.yaw = Math.PI;
}

// ---------------------------------------------------------------- enemies
const hpBarBg = new THREE.SpriteMaterial({ color: 0x000000, opacity: 0.7, transparent: true, depthTest: false, toneMapped: false });
const hpBarFg = new THREE.SpriteMaterial({ color: 0xff2020, depthTest: false, toneMapped: false });
const _flashCol = new THREE.Color(0.9, 0.15, 0.1);

class Enemy {
  constructor(key, vi) {
    this.T = ENEMY_TYPES[key];
    this.V = this.T.variants[vi];
    this.key = key;
    this.height = this.V.height;
    this.root = new THREE.Group();
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.mats = [];
    const V = this.V;
    if (V.model === 'chromie') {
      // Chromie is a demon: charred skin, glowing red veins
      const g = makeGnome(assets.chromie.scene, { suit: 0x1c0306, trim: 0xff1800, height: V.height, headTint: [0.55, 0.16, 0.16], glow: 0.12 });
      this.gnome = g;
      this.rig = g.rig;
      this.body.add(g.root);
      g.model.traverse((o) => { if (o.isMesh) this.mats.push(o.material); });
    } else {
      const P = PREP[V.model];
      const src = assets[V.model].scene;
      const inner = P.clip ? SkeletonUtils.clone(src) : src.clone();
      inner.position.set(-P.cx, -P.minY, -P.cz);
      const wrap = new THREE.Group();
      wrap.add(inner);
      wrap.scale.setScalar(V.height / P.h);
      if (P.clip) {
        this.mixer = new THREE.AnimationMixer(inner);
        this.action = this.mixer.clipAction(P.clip);
        this.action.play();
        this.action.time = Math.random() * P.clip.duration;
      }
      inner.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        o.material = o.material.clone();
        if (V.tint) {
          o.material.color.setRGB(...V.tint);
          o.material.emissive = new THREE.Color(0.25, 0.0, 0.0);
        }
        this.mats.push(o.material);
      });
      this.body.add(wrap);
    }
    for (const m of this.mats) m.userData.baseEmissive = m.emissive ? m.emissive.clone() : new THREE.Color();
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
    this.moveSpeed = 0;
    this.twitch = 0;
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
    this.body.position.set(0, -this.height, 0);
    this.state = 'spawn';
    this.t = 0;
    this.atkCd = 0.5;
    this.burn = 0;
    this.flash = 0;
    this.kb.set(0, 0, 0);
    this.target = player;
    this.retarget = 0;
    this.active = true;
    this.stun = 0;
    this.leapCd = rand(1.5, 3) * D().abil;
    this.chargeCd = rand(3, 6) * D().abil;
    this.lastHead = false;
    this.lastMelee = false;
    this.root.rotation.y = Math.atan2(player.pos.x - x, player.pos.z - z);
    if (this.action) { this.action.paused = false; this.action.timeScale = this.V.anim || 1; }
  }

  // opts: { head, melee }
  damage(amount, dir, silent, at, opts) {
    if (this.state === 'dead' || !this.active) return;
    if (player.boosts.insta > 0) amount = Math.max(amount, this.hp);
    this.hp -= amount;
    this.flash = 0.08;
    this.lastHead = !!(opts && opts.head);
    this.lastMelee = !!(opts && opts.melee);
    // heavy hits stagger (brutes shrug off all but the biggest), interrupting attacks
    if (this.hp > 0 && amount >= this.maxHp * (this.key === 'brute' ? 0.3 : 0.2) && this.state !== 'spawn') {
      this.stun = this.key === 'brute' ? 0.3 : 0.45;
      if (this.state !== 'chase') { this.state = 'chase'; this.body.position.y = 0; }
    }
    if (dir && this.key !== 'brute') this.kb.addScaledVector(_v2.set(dir.x, 0, dir.z).normalize(), Math.min(3, amount / 40));
    if (!silent) {
      const p = at || _v.set(this.pos.x, this.pos.y + this.height * 0.6, this.pos.z);
      fx.blood(p, dir, Math.min(10, 3 + Math.floor(amount / 20)));
    }
    if (this.hp <= 0) this.die();
  }

  die() {
    this.state = 'dead';
    this.t = 0;
    this.bar.visible = false;
    if (this.action) this.action.paused = true;
    if (this.rig) this.rig.update(0, 0, this.root.rotation.y, null, 'dead', G.time);
    G.kills++;
    let coins = Math.round(this.T.coins * D().coins);
    let tag = '';
    if (this.lastHead) { coins = Math.round(coins * 1.5); tag = ' HEADSHOT'; }
    if (this.lastMelee) { coins += 10; tag = ' KNIFE'; }
    if (player.boosts.double > 0) coins *= 2;
    if (G.ws) { G.ws.kills++; if (this.lastHead) G.ws.heads++; if (this.lastMelee) G.ws.knife++; }
    if (!G.nuking) {
      G.coins += coins;
      popup(`+${coins}${tag}`, this.pos.x, this.pos.y + this.height, this.pos.z, tag ? '#ff8040' : '#ffc530', true);
      coinBurst(this.pos.x, this.pos.y + this.height * 0.6, this.pos.z);
      sfx.coin();
      if (Math.random() < DROP_CHANCE && G.phase === 'wave') dropPowerup(this.pos.x, this.pos.z);
    }
    sfxAt(this.pos, () => sfx.enemyDie(this.key === 'fast' ? 1.6 : this.key === 'brute' ? 0.6 : 1));
    _v.set(this.pos.x, this.pos.y + this.height * 0.5, this.pos.z);
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
      this.body.position.y = -this.height * (1 - k) * (1 - k);
      if (k >= 1) { this.state = 'chase'; this.body.position.y = 0; }
      this.animate(dt, 0, 0);
      return;
    }
    if (this.burn > 0) {
      this.burn -= dt;
      this.damage(10 * dt * (player.boosts.dmg > 0 ? 2 : 1), null, true);
      if (Math.random() < 0.4) fx.fire(_v.set(this.pos.x, this.pos.y + rand(0.3, this.height * 0.8), this.pos.z), _v2.set(0, 0.3, 0), 0.3);
      if (this.state === 'dead') return;
    }
    this.retarget -= dt;
    if (this.retarget <= 0) {
      this.retarget = 0.4;
      const dp = player.state === 'dead' ? Infinity : this.pos.distanceTo(player.pos);
      const dc = comp.state === 'up' ? this.pos.distanceTo(comp.pos) : Infinity;
      // a downed player is prey: every demon goes for the kill
      this.target = player.state !== 'down' && dc < dp * 0.8 ? comp : player;
    }
    const tg = this.target;
    const dx = tg.pos.x - this.pos.x, dz = tg.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    const reach = this.T.reach + this.radius * 0.5 + 0.25;
    this.atkCd -= dt;
    this.leapCd -= dt;
    this.chargeCd -= dt;

    if (this.stun > 0) {
      this.stun -= dt;
      this.body.rotation.x = -0.25 * Math.min(1, this.stun * 4);
      nav.move(this.pos, this.kb.x * dt, this.kb.z * dt, 0.2, true);
      this.kb.multiplyScalar(Math.max(0, 1 - dt * 6));
      if (this.mixer) this.mixer.update(-dt * 0.8); // freeze the walk cycle while reeling
      return;
    }
    if (this.special(dt, tg, dx, dz, dist, reach)) return;

    if (this.state === 'windup') {
      this.t += dt;
      const wind = this.key === 'brute' ? 0.55 : 0.35;
      const k = this.t / wind;
      this.root.rotation.y = lerpAngle(this.root.rotation.y, Math.atan2(dx, dz), Math.min(1, dt * 10));
      this.animate(dt, 0, Math.min(1, k));
      if (this.t >= wind) {
        this.state = 'chase';
        this.atkCd = this.T.atkRate;
        if (dist <= reach + 0.45) {
          this.hit(tg, this.dmg);
        }
      }
      return;
    }
    if (dist <= reach && this.atkCd <= 0) {
      this.state = 'windup';
      this.t = 0;
      sfxAt(this.pos, () => sfx.swing());
      return;
    }

    const dir = _dir.set(0, 0, 0);
    if (dist > reach * 0.8) {
      if (dist < 7 && nav.losWalk(this.pos.x, this.pos.z, tg.pos.x, tg.pos.z)) dir.set(dx / dist, 0, dz / dist);
      else if (!nav.flowDir(this.pos.x, this.pos.z, dir)) dir.set(dx / dist, 0, dz / dist);
    }
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
    const mx = dir.x * this.speed + sx * 3 + this.kb.x;
    const mz = dir.z * this.speed + sz * 3 + this.kb.z;
    this.kb.multiplyScalar(Math.max(0, 1 - dt * 6));
    const px = this.pos.x, pz = this.pos.z;
    nav.move(this.pos, mx * dt, mz * dt, 0.2, true);
    this.moveSpeed = Math.hypot(this.pos.x - px, this.pos.z - pz) / Math.max(dt, 1e-4);
    const face = dist < 3 ? Math.atan2(dx, dz) : (dir.lengthSq() > 0 ? Math.atan2(dir.x, dir.z) : this.root.rotation.y);
    this.root.rotation.y = lerpAngle(this.root.rotation.y, face, Math.min(1, dt * 8));
    this.animate(dt, this.moveSpeed, 0);
  }

  hit(tg, dmg) {
    if (tg === player) hurtPlayer(dmg, this);
    else hurtCompanion(dmg);
  }

  // Class abilities: Fast demons pounce, Brutes roar and charge. Returns true while one is running.
  special(dt, tg, dx, dz, dist, reach) {
    const st = this.state;
    const canSee = () => sightLine(this.pos, tg.pos);
    if (st === 'chase') {
      if (this.key === 'fast' && this.leapCd <= 0 && dist > 2.2 && dist < 5.5 && canSee()) {
        this.state = 'crouch'; this.t = 0;
        sfxAt(this.pos, () => sfx.shriek());
        return true;
      }
      if (this.key === 'brute' && this.chargeCd <= 0 && dist > 3.5 && dist < 10 && canSee()) {
        this.state = 'roar'; this.t = 0;
        sfxAt(this.pos, () => sfx.roar());
        return true;
      }
      return false;
    }
    if (st !== 'crouch' && st !== 'leap' && st !== 'roar' && st !== 'charge') return false;
    this.t += dt;
    const face = Math.atan2(dx, dz);
    if (st === 'crouch') {
      this.root.rotation.y = lerpAngle(this.root.rotation.y, face, Math.min(1, dt * 12));
      this.body.position.y = -0.15 * Math.min(1, this.t / 0.3);
      this.animate(dt, 0, 0);
      if (this.t >= 0.3) {
        this.state = 'leap'; this.t = 0;
        this.leapDir = new THREE.Vector3(dx / dist, 0, dz / dist);
        this.leapTime = Math.min(0.6, (dist - 0.3) / 9);
      }
      return true;
    }
    if (st === 'leap') {
      const k = this.t / this.leapTime;
      nav.move(this.pos, this.leapDir.x * 9 * dt, this.leapDir.z * 9 * dt, 0.2, true);
      this.body.position.y = Math.sin(Math.min(1, k) * Math.PI) * 0.7;
      this.body.rotation.x = 0.5;
      if (k >= 1) {
        this.state = 'chase';
        this.body.position.y = 0;
        this.leapCd = rand(3.5, 5.5) * D().abil;
        this.atkCd = 0.9;
        if (Math.hypot(tg.pos.x - this.pos.x, tg.pos.z - this.pos.z) < reach + 0.5) this.hit(tg, this.dmg * 1.3);
      }
      return true;
    }
    if (st === 'roar') {
      // telegraph: rear back, glow red
      this.root.rotation.y = lerpAngle(this.root.rotation.y, face, Math.min(1, dt * 6));
      this.body.rotation.x = -0.2 * Math.sin(Math.min(1, this.t / 0.8) * Math.PI);
      for (const m of this.mats) if (m.emissive) m.emissive.setRGB(0.5 * Math.abs(Math.sin(this.t * 12)), 0, 0);
      this.flash = 0.01;
      if (this.mixer) this.mixer.update(-dt * 0.5);
      if (this.t >= 0.8) { this.state = 'charge'; this.t = 0; this.chargeYaw = face; }
      return true;
    }
    if (st === 'charge') {
      this.chargeYaw = lerpAngle(this.chargeYaw, face, Math.min(1, dt * 1.5)); // turns slowly: sidestep it!
      this.root.rotation.y = this.chargeYaw;
      const sp = this.speed * 3.6;
      const px = this.pos.x, pz = this.pos.z;
      nav.move(this.pos, Math.sin(this.chargeYaw) * sp * dt, Math.cos(this.chargeYaw) * sp * dt, 0.2, true);
      const moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
      if (this.mixer) this.mixer.update(dt * 1.5);
      this.animate(dt, sp, 0);
      this.body.rotation.x = 0.3;
      const d = Math.hypot(tg.pos.x - this.pos.x, tg.pos.z - this.pos.z);
      if (d < reach + 0.3) {
        this.hit(tg, this.dmg * 1.5);
        if (tg === player) {
          G.shake = Math.min(1, G.shake + 0.6);
          nav.move(player.pos, Math.sin(this.chargeYaw) * 1.2, Math.cos(this.chargeYaw) * 1.2, player.radius);
        }
        this.endCharge();
      } else if (this.t > 2 || moved < sp * dt * 0.3) this.endCharge();
      return true;
    }
    return false;
  }

  endCharge() {
    this.state = 'chase';
    this.chargeCd = rand(6, 9) * D().abil;
    this.atkCd = 1.2;
    this.stun = 0.5; // winded after a charge: a window to punish it
  }

  // Per-model animation: skinned clips, procedural rig (Chromie) or a creepy shuffle for static meshes.
  animate(dt, speed, attack) {
    if (this.rig) {
      this.root.updateMatrixWorld(true);
      const yaw = this.root.rotation.y;
      const fwd = _v2.set(Math.sin(yaw), attack ? 0.2 : -0.1, Math.cos(yaw)).normalize();
      this.rig.update(dt, speed, yaw, fwd, 'up', G.time + this.pos.x, attack);
      this.gnome.model.updateMatrixWorld(true);
      this.rig.updateSuit(this.gnome.uniforms);
      this.body.rotation.x = attack ? Math.sin(attack * Math.PI) * 0.3 : 0.12;
      return;
    }
    if (this.mixer) {
      this.body.rotation.x = attack ? Math.sin(attack * Math.PI) * 0.45 : 0;
      return;
    }
    // static meshes (butcher, nurse)
    const ph = G.time * (this.key === 'brute' ? 5 : 7) + this.pos.x;
    this.twitch = Math.max(0, this.twitch - dt);
    if (this.twitch <= 0 && Math.random() < dt * 0.8) this.twitch = 0.15;
    const tw = this.twitch > 0 ? (Math.random() - 0.5) * 0.25 : 0;
    this.body.rotation.z = Math.sin(ph) * 0.07 * Math.min(1, speed + 0.2) + tw;
    this.body.rotation.x = (attack ? Math.sin(attack * Math.PI) * 0.45 : 0.06) + tw * 0.5;
    this.body.position.y = Math.abs(Math.sin(ph)) * 0.06 * Math.min(1, speed);
  }

  updateBar() {
    if (!this.active || this.state === 'dead' || this.hp >= this.maxHp) { this.bar.visible = false; return; }
    this.bar.visible = true;
    _v.setFromMatrixColumn(camera.matrixWorld, 0);
    this.bar.position.set(this.pos.x, this.pos.y + this.height + 0.2, this.pos.z).addScaledVector(_v, -0.45);
    this.fg.scale.x = 0.9 * clamp(this.hp / this.maxHp, 0, 1);
  }
}

function spawnEnemy(key, vi = Math.floor(Math.random() * ENEMY_TYPES[key].variants.length)) {
  const pk = `${key}${vi}`;
  const pool = G.pool[pk] || (G.pool[pk] = []);
  let e = pool.find((x) => !x.active);
  if (!e) {
    e = new Enemy(key, vi);
    pool.push(e);
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
  sfxAt(e.pos, () => sfx.spawn());
  return e;
}

// Clear line of sight at chest height (3D ray against the level).
const _so = new THREE.Vector3(), _sd = new THREE.Vector3();
function sightLine(a, b) {
  _so.set(a.x, nav.floorY + 1.3, a.z);
  _sd.set(b.x - a.x, 0, b.z - a.z);
  const d = _sd.length();
  if (d < 0.01) return true;
  _sd.multiplyScalar(1 / d);
  return wallHit(_so, _sd, d) >= d - 0.2;
}

// Play a sound as if it came from a world position (stereo pan + distance falloff).
function sfxAt(pos, fn) {
  const dx = pos.x - player.pos.x, dz = pos.z - player.pos.z;
  const d = Math.hypot(dx, dz);
  const right = Math.cos(player.yaw) * dx - Math.sin(player.yaw) * dz;
  sfx.spatial(d > 0.01 ? right / d : 0, clamp(1.15 - d / 22, 0.08, 1), fn);
}

function aliveCount() { let n = 0; for (const e of G.enemies) if (e.active && e.state !== 'dead') n++; return n; }
function isLive(e) { return e.active && e.state !== 'dead'; }

// ---------------------------------------------------------------- combat
const TRACER = new THREE.Color(1, 0.8, 0.45);

function spread3(dir, spread) {
  if (!spread) return dir.clone();
  const side = _v2.set(-dir.z, 0, dir.x).normalize();
  const up = new THREE.Vector3().crossVectors(side, dir).normalize();
  const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
  return dir.clone().addScaledVector(side, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
}

// Distance along a ray to the level geometry.
const lastHit = { point: new THREE.Vector3(), normal: new THREE.Vector3(), ok: false };
function wallHit(o, d, max) {
  raycaster.set(o, d);
  raycaster.far = max;
  const h = raycaster.intersectObjects(G.blockers, false);
  lastHit.ok = h.length > 0 && !!h[0].face;
  if (lastHit.ok) {
    lastHit.point.copy(h[0].point);
    lastHit.normal.copy(h[0].face.normal).transformDirection(h[0].object.matrixWorld);
    if (lastHit.normal.dot(d) > 0) lastHit.normal.negate();
  }
  return h.length ? h[0].distance : max;
}

// Ray vs the enemy's upright cylinder. Returns hit distance or -1.
function rayEnemy(o, d, e, extra = 0) {
  const r = e.radius * 0.8 + extra;
  const ox = o.x - e.pos.x, oz = o.z - e.pos.z;
  const a = d.x * d.x + d.z * d.z;
  const b = 2 * (ox * d.x + oz * d.z);
  const c = ox * ox + oz * oz - r * r;
  const base = e.pos.y + e.body.position.y, top = base + e.height;
  if (a < 1e-8) {
    if (c > 0) return -1;
    const t = d.y < 0 ? (o.y - top) / -d.y : (base - o.y) / d.y;
    return t >= 0 ? t : -1;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  let t1 = (-b - sq) / (2 * a);
  const t2 = (-b + sq) / (2 * a);
  if (t2 < 0) return -1;
  if (t1 < 0) t1 = 0;
  const y1 = o.y + d.y * t1, y2 = o.y + d.y * t2;
  if (y1 >= base && y1 <= top) return t1;
  if (y1 > top && y2 <= top && d.y < 0) return (top - o.y) / d.y;
  if (y1 < base && y2 >= base && d.y > 0) return (base - o.y) / d.y;
  return -1;
}

let hitMarkT = 0;
function hitMarker(head) {
  hitMarkT = 0.12;
  $('crosshair').classList.add('hit');
  $('crosshair').classList.toggle('head', !!head);
  sfx.hitmark(head);
}

// Hitscan bullet from the eye (o) along d; tracer drawn from the gun muzzle.
function bullet(o, muzzle, d, dmg, pierce, range, color, beam) {
  const wall = wallHit(o, d, range);
  const wallInfo = lastHit.ok ? { p: lastHit.point.clone(), n: lastHit.normal.clone() } : null;
  const hits = [];
  for (const e of G.enemies) {
    if (!isLive(e)) continue;
    const t = rayEnemy(o, d, e, beam ? 0.1 : 0);
    if (t >= 0 && t <= wall) hits.push([t, e]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  let n = pierce + 1, end = wall, cur = dmg, any = false, head = false;
  for (const [t, e] of hits) {
    if (n <= 0) break;
    const p = o.clone().addScaledVector(d, t);
    const isHead = p.y > e.pos.y + e.body.position.y + e.height * 0.82;
    e.damage(cur * (isHead ? 1.8 : 1), d, false, p, { head: isHead });
    any = true; head = head || isHead;
    n--;
    cur *= beam ? 0.95 : 0.8;
    if (n === 0) end = t;
  }
  const endP = o.clone().addScaledVector(d, end);
  fx.tracers.add(muzzle, endP, color || TRACER, beam ? 0.18 : 0.06);
  if (beam) {
    const c = color || TRACER;
    for (let i = 0; i < 2; i++) fx.tracers.add(muzzle, endP, c, 0.22);
  }
  if (end === wall && wall < range) {
    fx.sparks(endP, beam ? (color ? color.getHex() : 0x88ffff) : 0xffc060, beam ? 10 : 4);
    if (wallInfo && !beam) fx.bulletHole(wallInfo.p, wallInfo.n);
  }
  return { any, head };
}

function shoot(w, origin, muzzle, dir, dmgMul, spread = w.spread || 0) {
  const type = w.type || 'hitscan';
  let any = false, head = false;
  const flat = _v.set(dir.x, 0, dir.z).normalize().clone();
  if (type === 'hitscan' || type === 'beam') {
    const pellets = w.pellets || 1;
    const col = w.color ? new THREE.Color(w.color) : null;
    for (let i = 0; i < pellets; i++) {
      const r = bullet(origin, muzzle, spread3(dir, spread), w.dmg * dmgMul, w.pierce || 0, w.range, col, type === 'beam');
      any = any || r.any; head = head || r.head;
    }
  } else if (type === 'flame') {
    fx.fire(muzzle, dir, w.range * 0.55);
    for (const e of G.enemies) {
      if (!isLive(e)) continue;
      const vx = e.pos.x - origin.x, vz = e.pos.z - origin.z;
      const d = Math.hypot(vx, vz);
      if (d > w.range + e.radius) continue;
      const cos = (vx * flat.x + vz * flat.z) / (d || 1);
      if (d > 0.8 && cos < Math.cos(w.cone)) continue;
      if (!nav.losShoot(origin.x, origin.z, e.pos.x, e.pos.z)) continue;
      e.burn = 2.2;
      e.damage(w.dmg * dmgMul, flat, true);
      any = true;
    }
  } else if (type === 'tesla') {
    let best = null, bd = Infinity;
    for (const e of G.enemies) {
      if (!isLive(e)) continue;
      const vx = e.pos.x - origin.x, vz = e.pos.z - origin.z;
      const d = Math.hypot(vx, vz);
      if (d > w.range || d >= bd) continue;
      if ((vx * flat.x + vz * flat.z) / (d || 1) < Math.cos(w.cone)) continue;
      if (!nav.losShoot(origin.x, origin.z, e.pos.x, e.pos.z)) continue;
      best = e; bd = d;
    }
    const col = new THREE.Color(0.6, 0.8, 1.2);
    if (!best) {
      fx.arc(muzzle, muzzle.clone().addScaledVector(dir, 3), col);
    } else {
      const hit = new Set();
      let from = muzzle.clone(), e = best, dmg = w.dmg * dmgMul;
      for (let c = 0; c <= w.chain && e; c++) {
        hit.add(e);
        const to = new THREE.Vector3(e.pos.x, e.pos.y + e.height * 0.55, e.pos.z);
        fx.arc(from, to, col);
        fx.sparks(to, 0x99ccff, 5);
        e.damage(dmg, null);
        dmg *= 0.8;
        from = to;
        let nx = null, nd = 4.5;
        for (const o of G.enemies) {
          if (!isLive(o) || hit.has(o)) continue;
          const dd = Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z);
          if (dd < nd) { nd = dd; nx = o; }
        }
        e = nx;
      }
      any = true;
    }
  } else if (type === 'rocket') {
    const d = spread3(dir, spread);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.3, 6).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xff5010, emissiveIntensity: 0.6 }));
    mesh.position.copy(muzzle);
    mesh.lookAt(_v.copy(muzzle).add(d));
    scene.add(mesh);
    G.projectiles.push({ kind: 'rocket', mesh, pos: mesh.position, vel: d.multiplyScalar(w.projSpeed), life: w.range / w.projSpeed, dmg: w.dmg * dmgMul, splash: w.splash });
  }
  sfx.shot(w);
  const fcol = type === 'beam' ? (w.color || 0x66ffff) : type === 'tesla' ? 0x99ccff : type === 'flame' ? 0xff6a20 : 0xffb050;
  vm.fire(fcol);
  muzzleLight.position.copy(muzzle);
  muzzleLight.intensity = type === 'flame' ? 3 : 7;
  muzzleLight.color.set(fcol);
  G.shake = Math.min(0.35, G.shake + (w.cat === 'sniper' || type === 'rocket' ? 0.14 : w.cat === 'shotgun' ? 0.1 : 0.02));
  const kick = (w.cat === 'sniper' ? 0.03 : w.cat === 'shotgun' ? 0.025 : w.cat === 'lmg' || w.id === 'minigun' ? 0.006 : 0.004) * (1 - 0.5 * player.ads);
  player.pitch = Math.min(1.45, player.pitch + kick);
  player.yaw += (Math.random() - 0.5) * kick * 0.6;
  if (any) hitMarker(head);
}

function explode(pos, radius, dmg) {
  for (const e of G.enemies) {
    if (!isLive(e)) continue;
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
  const pd = Math.hypot(player.pos.x - pos.x, player.pos.z - pos.z);
  G.shake = Math.min(0.9, G.shake + Math.max(0.15, 0.7 - pd * 0.06));
  sfx.explosion(radius / 4);
}

function throwGrenade() {
  if (player.state !== 'up' || player.grenades <= 0 || G.shopOpen) return;
  player.grenades--;
  const d = lookDir();
  const start = camera.position.clone().addScaledVector(d, 0.4);
  const vel = d.clone().multiplyScalar(11).add(_v.set(0, 3, 0));
  const mesh = propModel('grenade', 0.13) || new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshStandardMaterial({ color: 0x2c3a20 }));
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
  const f = lookDir();
  const p = _v.set(player.pos.x + f.x * 0.6, 0, player.pos.z + f.z * 0.6);
  if (!nav.walk(p.x, p.z)) p.set(player.pos.x, 0, player.pos.z);
  g.position.set(p.x, nav.floorY + 0.03, p.z);
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
      const step = p.vel.length() * dt;
      _dir.copy(p.vel).normalize();
      const w = wallHit(p.pos, _dir, step + 0.05);
      if (w < step + 0.05) { p.pos.addScaledVector(_dir, Math.max(0, w - 0.1)); boom = true; } else p.pos.addScaledVector(_dir, step);
      if (p.pos.y < nav.floorY + 0.05) boom = true;
      if (Math.random() < 0.9) fx.glow.spawn(p.pos.x, p.pos.y, p.pos.z, rand(-0.3, 0.3), rand(0, 0.5), rand(-0.3, 0.3), 0.35, 0.08, fx.tmpColor.setHSL(0.07, 1, 0.55), -1);
      for (const e of G.enemies) {
        if (!isLive(e)) continue;
        const top = e.pos.y + e.height;
        if (p.pos.y <= top && Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) < e.radius + 0.2) { boom = true; break; }
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
      if (!isLive(e) || e.state === 'spawn') continue;
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
  if (from) showDamageDir(from.pos);
  if (player.state === 'down') {
    player.downHp -= dmg;
    flashHurt(0.7);
    sfx.hurt();
    G.shake = Math.min(0.6, G.shake + 0.2);
    if (player.downHp <= 0) killedWhileDown();
    return;
  }
  player.lastHurt = G.time;
  if (G.ws) G.ws.dmg += dmg;
  const absorbed = Math.min(player.armor, dmg * 0.7);
  player.armor -= absorbed;
  player.hp -= dmg - absorbed;
  flashHurt(Math.min(1, dmg / 25));
  sfx.hurt();
  G.shake = Math.min(0.5, G.shake + 0.15);
  if (player.hp <= 0) goDown();
}

let dmgDirT = 0, dmgDirAng = 0;
function showDamageDir(src) {
  const a = Math.atan2(src.x - player.pos.x, src.z - player.pos.z);
  // angle relative to where we look (0 = in front)
  dmgDirAng = a - (player.yaw + Math.PI);
  dmgDirT = 0.8;
}

function goDown() {
  player.hp = 0;
  player.state = 'down';
  player.downT = D().downed;
  player.downHp = PLAYER.downedHp;
  player.reloadT = 0;
  player.downedGun.ammo = WEAPON_BY_ID.m9.mag;
  player.ads = 0;
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
    standUp(60, 'REVIVED!');
    for (const e of G.enemies) {
      if (!isLive(e)) continue;
      const d = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
      if (d < 4.5) {
        const dir = new THREE.Vector3(e.pos.x - player.pos.x, 0, e.pos.z - player.pos.z).normalize();
        e.damage(120, dir);
        e.kb.addScaledVector(dir, 9);
      }
    }
    fx.explosion(_v.copy(player.pos), 3);
    flashHurt(0);
    $('hurt').style.background = '';
    return;
  }
  gameOver();
}

function hurtCompanion(dmg) {
  if (comp.state !== 'up') return;
  comp.hp -= dmg;
  _v.set(comp.pos.x, comp.pos.y + 1.1, comp.pos.z);
  fx.blood(_v, null, 4);
  for (const m of comp.mats) if (m.emissive) m.emissive.setRGB(0.6, 0.05, 0.05);
  comp.flash = 0.08;
  if (comp.hp <= 0) {
    comp.hp = 0;
    comp.state = 'down';
    comp.reviveProg = 0;
    if (G.ws) G.ws.dogDowns++;
    sfx.downed();
    announce(`${COMPANION.name} is down!`, 'Go to her and hold [E] to revive', 2.4);
  }
}

function startReload() {
  const s = curSlot();
  const w = WEAPON_BY_ID[s.id];
  if (player.reloadT > 0 || s.ammo >= w.mag) return;
  if (s.reserve <= 0) { sfx.empty(); return; }
  player.reloadT = player.reloadMax = w.reload;
  sfx.reload();
}

function finishReload(slot, w) {
  const take = Math.min(w.mag - slot.ammo, slot.reserve);
  slot.ammo += take;
  if (slot.reserve !== Infinity) slot.reserve -= take;
}

function refillAll() {
  for (const sl of player.slots) if (sl) { const w = WEAPON_BY_ID[sl.id]; sl.ammo = w.mag; sl.reserve = maxReserve(w); }
  player.grenades = Math.min(10, player.grenades + 2);
}

// Quick knife: always available, great when out of ammo or swarmed.
function knifeAttack() {
  const p = player;
  if (p.state !== 'up' || p.knifeCd > 0 || G.shopOpen) return;
  p.knifeCd = 0.55;
  p.reloadT = 0;
  vm.knife();
  sfx.knife();
  const f = lookDir(_dir);
  const fl = Math.hypot(f.x, f.z) || 1;
  let best = null, bd = 2.0;
  for (const e of G.enemies) {
    if (!isLive(e) || e.state === 'spawn') continue;
    const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
    const d = Math.hypot(dx, dz) - e.radius * 0.6;
    if (d > bd) continue;
    if ((dx * f.x + dz * f.z) / (Math.hypot(dx, dz) * fl || 1) < 0.5) continue;
    bd = d; best = e;
  }
  if (best) {
    const dir = new THREE.Vector3(best.pos.x - p.pos.x, 0, best.pos.z - p.pos.z).normalize();
    best.damage(75 * (p.boosts.dmg > 0 ? 2 : 1), dir, false, null, { melee: true });
    best.kb.addScaledVector(dir, 2.5);
    hitMarker(false);
    G.shake = Math.min(0.4, G.shake + 0.12);
  }
}

function switchSlot(i) {
  if (player.state !== 'up' || !player.slots[i] || i === player.cur) return;
  player.lastSlot = player.cur;
  player.cur = i;
  player.reloadT = 0;
  player.fireCd = 0.3;
  sfx.click();
}

function updatePlayer(dt) {
  const p = player;
  p.invuln = Math.max(0, p.invuln - dt);
  for (const k in p.boosts) p.boosts[k] = Math.max(0, p.boosts[k] - dt);
  p.knifeCd = Math.max(0, p.knifeCd - dt);
  if (p.state === 'up') {
    if (p.boosts.regen > 0) p.hp = Math.min(p.maxHp, p.hp + 6 * dt);
    if (G.phase === 'break') p.hp = Math.min(p.maxHp, p.hp + 2 * dt);
    // wounds slowly close up to half health if you avoid damage for a few seconds
    else if (G.time - p.lastHurt > 5 && p.hp < p.maxHp * 0.5) p.hp = Math.min(p.maxHp * 0.5, p.hp + 5 * dt);
  }

  // mouse look (slower while zoomed in)
  const zoomSens = sens * (camera.fov / 74);
  p.yaw -= input.lookDX * zoomSens;
  p.pitch = clamp(p.pitch - input.lookDY * zoomSens, -1.45, 1.45);
  const lookDX = input.lookDX, lookDY = input.lookDY;
  input.lookDX = input.lookDY = 0;

  // move relative to where we look
  const k = input.keys;
  const fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0);
  const strafe = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0);
  let speed = 0;
  // sprint: forward only, costs stamina, can't shoot or aim while sprinting
  const wantSprint = (k.ShiftLeft || k.ShiftRight) && fwd > 0 && p.state === 'up' && !input.down && !p.exhausted;
  p.sprinting = wantSprint && p.stamina > 0 && !G.shopOpen;
  if (p.sprinting) {
    p.stamina = Math.max(0, p.stamina - 24 * dt);
    p.staminaCd = 0.7;
    if (p.stamina <= 0) p.exhausted = true;
  } else {
    p.staminaCd -= dt;
    if (p.staminaCd <= 0) p.stamina = Math.min(100, p.stamina + 20 * dt);
    if (p.exhausted && p.stamina > 35) p.exhausted = false;
  }
  if ((fwd || strafe) && !G.shopOpen) {
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    let mx = -sy * fwd + cy * strafe;
    let mz = -cy * fwd - sy * strafe;
    const ml = Math.hypot(mx, mz);
    mx /= ml; mz /= ml;
    const w = curWeapon();
    speed = p.state === 'down' ? 0.45
      : PLAYER.speed * (p.boosts.speed > 0 ? 1.4 : 1) * (w.move || 1) * (p.sprinting ? 1.45 : 1) * (1 - 0.4 * p.ads);
    nav.move(p.pos, mx * speed * dt, mz * speed * dt, p.radius);
  }
  p.speed = THREE.MathUtils.lerp(p.speed, speed, Math.min(1, dt * 10));
  if (p.speed > 1 && p.state === 'up') {
    p.stepT -= dt * p.speed;
    if (p.stepT <= 0) { p.stepT = 2.2; sfx.step(); }
  }

  if (p.state === 'down') {
    p.downT -= dt;
    $('downed-timer').textContent = Math.ceil(Math.max(0, p.downT));
    $('downed-fill').style.width = `${clamp(p.downHp / PLAYER.downedHp, 0, 1) * 100}%`;
    if (p.downT <= 0) standUp(40, 'YOU SURVIVED!');
  }

  // camera: eye height, bob, downed tilt
  const down = p.state === 'down';
  p.eye = THREE.MathUtils.lerp(p.eye, down ? 0.38 : PLAYER.eye, Math.min(1, dt * 6));
  p.roll = THREE.MathUtils.lerp(p.roll, down ? 0.35 : 0, Math.min(1, dt * 6));
  p.bobT += dt * (5 + p.speed * 1.8);
  const bob = down ? 0 : Math.sin(p.bobT * 2) * 0.035 * Math.min(1, p.speed / 4);
  camera.position.set(p.pos.x, p.pos.y + p.eye + bob, p.pos.z);
  camera.rotation.set(p.pitch, p.yaw, p.roll);
  if (G.shake > 0) {
    camera.rotation.x += (Math.random() - 0.5) * G.shake * 0.06;
    camera.rotation.y += (Math.random() - 0.5) * G.shake * 0.06;
    G.shake = Math.max(0, G.shake - dt * 2);
  }
  camera.updateMatrixWorld();

  // weapon
  syncViewModel();
  const slot = curSlot();
  const w = WEAPON_BY_ID[slot.id];
  p.fireCd -= dt;
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) { finishReload(slot, w); p.reloadT = 0; }
  }

  // aim down sights (right mouse)
  const adsWanted = input.ads && !p.sprinting && !G.shopOpen && p.knifeCd < 0.3;
  p.ads += ((adsWanted ? 1 : 0) - p.ads) * Math.min(1, dt * 12);
  const fov = THREE.MathUtils.lerp(74, ADS_FOV[w.cat] || 60, p.ads);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }

  // accuracy: tighter when aiming, looser when moving or spraying
  p.bloom = Math.max(0, p.bloom - dt * 0.14);
  let spread = (w.spread || 0) * (1 - 0.55 * p.ads);
  if (w.cat === 'sniper') spread += 0.08 * (1 - p.ads); // no-scoping is a gamble
  if (!w.pellets) spread += p.bloom + Math.min(1, p.speed / 4) * 0.03 * (1 - 0.5 * p.ads);
  if (down) spread += 0.03;
  p.spreadNow = spread;

  const forced = DEBUG && window.__forceFire;
  const trigger = !G.shopOpen && !p.sprinting && p.knifeCd < 0.3
    && (w.auto ? input.down || input.clicked || forced : input.clicked || forced);
  if (trigger && p.reloadT <= 0 && p.fireCd <= 0) {
    input.clicked = false;
    if (slot.ammo <= 0) {
      sfx.empty();
      if (slot.reserve > 0) startReload();
      else if (p.state === 'up' && p.cur !== 0) { switchSlot(0); announce('OUT OF AMMO', 'Buy ammo at the Armory', 1.6); }
    } else {
      slot.ammo--;
      p.fireCd = 60 / w.rpm / (p.boosts.rate > 0 ? 1.65 : 1);
      const dir = lookDir();
      const muzzle = camera.localToWorld(_v2.set(0.13 * (1 - p.ads), -0.12 + 0.04 * p.ads, -0.55)).clone();
      shoot(w, camera.position.clone(), muzzle, dir, p.boosts.dmg > 0 ? 2 : 1, spread);
      p.bloom = Math.min(0.07, p.bloom + (w.rpm > 700 ? 0.005 : 0.012) * (1 - 0.5 * p.ads));
      if (slot.ammo <= 0 && slot.reserve > 0) startReload();
    }
  }
  const scoped = w.cat === 'sniper' && p.ads > 0.85;
  vm.holder.visible = !scoped;
  $('scope').style.opacity = scoped ? 1 : 0;
  vm.update(dt, {
    speed: down ? 0 : p.speed, lookDX, lookDY, ads: p.ads, sprint: p.sprinting, firing: trigger && slot.ammo > 0,
    reload: p.reloadT > 0 ? 1 - p.reloadT / p.reloadMax : -1, down, light: 0.55,
  });

  // lights follow the eye
  const d = lookDir(_dir);
  flashlight.position.copy(camera.position).addScaledVector(_v.set(0, -0.15, 0), 1);
  flashlight.target.position.copy(camera.position).addScaledVector(d, 8);
  fillLight.position.set(p.pos.x, p.pos.y + 2.2, p.pos.z);
  muzzleLight.intensity = Math.max(0, muzzleLight.intensity - dt * 120);
}

// ---------------------------------------------------------------- companion AI
function updateCompanion(dt) {
  const c = comp;
  const down = c.state === 'down';
  c.marker.visible = down;
  if (c.flash > 0) {
    c.flash -= dt;
    if (c.flash <= 0) for (const m of c.mats) if (m.emissive) m.emissive.setRGB(0, 0, 0);
  }
  if (down) {
    c.marker.position.set(c.pos.x, nav.floorY + 0.03, c.pos.z);
    c.marker.material.opacity = 0.5 + Math.sin(G.time * 6) * 0.3;
    c.tilt.rotation.x = THREE.MathUtils.lerp(c.tilt.rotation.x, -Math.PI / 2, Math.min(1, dt * 8));
    c.tilt.position.y = 0.15;
    c.root.updateMatrixWorld(true);
    c.rig.update(dt, 0, c.yaw, null, 'dead', G.time);
    return;
  }
  c.tilt.rotation.x = THREE.MathUtils.lerp(c.tilt.rotation.x, 0, Math.min(1, dt * 8));
  c.tilt.position.y = 0;
  if (G.phase === 'break') c.hp = Math.min(c.maxHp, c.hp + 4 * dt);
  const lv = c.level - 1;

  // pick a demon to hunt: close to her, not too far from the player, reachable
  c.targetT -= dt;
  if (c.targetT <= 0) {
    c.targetT = 0.3;
    let best = null, bd = COMPANION.seek;
    for (const e of G.enemies) {
      if (!isLive(e) || e.state === 'spawn') continue;
      const d = Math.hypot(e.pos.x - c.pos.x, e.pos.z - c.pos.z);
      if (d >= bd) continue;
      if (Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z) > COMPANION.leash) continue;
      if (!nav.losWalk(c.pos.x, c.pos.z, e.pos.x, e.pos.z)) continue;
      bd = d; best = e;
    }
    c.target = best;
  }
  if (c.target && !isLive(c.target)) c.target = null;

  const dir = _dir.set(0, 0, 0);
  let face = null;
  let attacking = false;
  if (c.swingT >= 0) {
    // blade swing in progress
    c.swingT += dt / 0.35;
    if (c.swingT >= 0.5 && !c.hitDone && c.target) {
      c.hitDone = true;
      const t = c.target;
      if (Math.hypot(t.pos.x - c.pos.x, t.pos.z - c.pos.z) < COMPANION.reach + t.radius + 0.4) {
        const hd = _v.set(t.pos.x - c.pos.x, 0, t.pos.z - c.pos.z).normalize().clone();
        t.damage(COMPANION.dmg * (1 + 0.35 * lv), hd);
      }
    }
    if (c.swingT >= 1) c.swingT = -1;
    attacking = true;
  }
  c.atkCd -= dt;
  if (c.target) {
    const t = c.target;
    const tx = t.pos.x - c.pos.x, tz = t.pos.z - c.pos.z;
    const td = Math.hypot(tx, tz);
    face = Math.atan2(tx, tz);
    if (td > COMPANION.reach + t.radius) dir.set(tx / td, 0, tz / td);
    else if (c.atkCd <= 0 && c.swingT < 0) {
      c.swingT = 0; c.hitDone = false;
      c.atkCd = COMPANION.atkRate / (1 + 0.1 * lv);
      sfx.slash();
    }
  } else {
    const dx = player.pos.x - c.pos.x, dz = player.pos.z - c.pos.z;
    const dp = Math.hypot(dx, dz);
    if (dp > 2.8) {
      if (dp < 6 && nav.losWalk(c.pos.x, c.pos.z, player.pos.x, player.pos.z)) dir.set(dx / dp, 0, dz / dp);
      else nav.flowDir(c.pos.x, c.pos.z, dir);
    } else if (dp < 1.0) dir.set(-dx / (dp || 1), 0, -dz / (dp || 1));
  }
  const sp = dir.lengthSq() > 0 ? COMPANION.speed * (1 + 0.05 * lv) : 0;
  const px = c.pos.x, pz = c.pos.z;
  if (sp) nav.move(c.pos, dir.x * sp * dt, dir.z * sp * dt, 0.24, true);
  const moved = Math.hypot(c.pos.x - px, c.pos.z - pz) / Math.max(dt, 1e-4);
  c.speed = THREE.MathUtils.lerp(c.speed, moved, Math.min(1, dt * 8));
  if (face === null && sp) face = Math.atan2(dir.x, dir.z);
  if (face !== null) c.yaw = lerpAngle(c.yaw, face, Math.min(1, dt * 10));
  c.root.rotation.y = c.yaw;
  c.tag.visible = Math.hypot(c.pos.x - player.pos.x, c.pos.z - player.pos.z) > 3;
  c.root.updateMatrixWorld(true);
  const arms = (attacking || c.target) ? _v.set(Math.sin(c.yaw), 0, Math.cos(c.yaw)) : null;
  c.rig.update(dt, c.speed, c.yaw, arms, 'up', G.time + 2.1, attacking ? Math.max(0, c.swingT) : 0);
}

// ---------------------------------------------------------------- power-ups
function iconSprite(text, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.font = '700 64px "Oswald", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = color; x.shadowBlur = 18;
  x.fillStyle = '#fff';
  x.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false, fog: false }));
}
const PU_ICON = { ammo: '▤', insta: '☠', double: '×2', nuke: '☢' };

function dropPowerup(x, z, type) {
  if (!type) {
    const total = Object.values(POWERUPS).reduce((a, p) => a + p.weight, 0);
    let r = Math.random() * total;
    for (const k in POWERUPS) { r -= POWERUPS[k].weight; if (r <= 0) { type = k; break; } }
  }
  const P = POWERUPS[type];
  const col = `#${new THREE.Color(P.color).getHexString()}`;
  const g = new THREE.Group();
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: fx.glowTex, color: P.color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, toneMapped: false }));
  glow.scale.setScalar(1.3);
  const icon = iconSprite(PU_ICON[type], col);
  icon.scale.setScalar(0.55);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.45, 32), new THREE.MeshBasicMaterial({ color: P.color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -0.85;
  g.add(glow, icon, ring);
  g.position.set(x, nav.floorY + 0.9, z);
  scene.add(g);
  G.powerups.push({ type, g, pos: g.position, t: 25, ring });
}

function applyPowerup(type) {
  const P = POWERUPS[type];
  sfx.powerup();
  announce(P.name, '', 1.8);
  if (type === 'ammo') refillAll();
  else if (type === 'insta' || type === 'double') player.boosts[type] = Math.max(player.boosts[type], P.time);
  else if (type === 'nuke') {
    sfx.nuke();
    $('flash').style.transition = 'none';
    $('flash').style.opacity = 1;
    requestAnimationFrame(() => { $('flash').style.transition = 'opacity 1.4s'; $('flash').style.opacity = 0; });
    G.shake = 1;
    G.nuking = true;
    for (const e of G.enemies) if (isLive(e)) e.damage(e.hp + 1, null, false);
    G.nuking = false;
    const bonus = player.boosts.double > 0 ? 400 : 200;
    G.coins += bonus;
    popup(`+${bonus}`, player.pos.x, player.pos.y + 1.8, player.pos.z, '#ffffff');
  }
}

function updatePowerups(dt) {
  for (let i = G.powerups.length - 1; i >= 0; i--) {
    const pu = G.powerups[i];
    pu.t -= dt;
    pu.pos.y = nav.floorY + 0.9 + Math.sin(G.time * 3 + i) * 0.08;
    pu.ring.rotation.z += dt * 2;
    pu.g.visible = pu.t > 5 || (G.time * 6) % 1 < 0.6; // blinks before vanishing
    const near = Math.hypot(pu.pos.x - player.pos.x, pu.pos.z - player.pos.z) < 1.2 && player.state !== 'dead';
    if (near) applyPowerup(pu.type);
    if (near || pu.t <= 0) { scene.remove(pu.g); G.powerups.splice(i, 1); }
  }
}

// ---------------------------------------------------------------- stage clear bonus
let scTimers = [];
function stageClear() {
  const ws = G.ws || newWaveStats();
  const w = G.wave;
  const time = G.time - ws.start;
  const par = 15 + G.waveTotal * 2.2;
  const lines = [[`Wave ${w} cleared`, 50 + w * 25]];
  if (ws.kills) lines.push([`Demons slain × ${ws.kills}`, ws.kills * 3]);
  if (ws.heads) lines.push([`Headshots × ${ws.heads}`, ws.heads * 8]);
  if (ws.knife) lines.push([`Knife kills × ${ws.knife}`, ws.knife * 12]);
  if (ws.dmg === 0) lines.push(['Untouchable — no damage taken', 100 + w * 20]);
  if (time < par) lines.push([`Speed bonus — ${Math.round(time)}s (par ${Math.round(par)}s)`, Math.round((par - time) * 4)]);
  if (ws.dogDowns === 0) lines.push([`${COMPANION.name} never fell`, 40 + w * 10]);
  const total = lines.reduce((a, l) => a + l[1], 0);
  G.coins += total;
  G.ws = null;

  scTimers.forEach(clearTimeout);
  scTimers = [];
  $('sc-title').textContent = `WAVE ${w} CLEARED`;
  $('sc-lines').innerHTML = lines.map(([t, v]) => `<div><span>${t}</span><b>+${v}</b></div>`).join('');
  $('sc-total').textContent = '0';
  $('stage-clear').classList.add('show');
  const rows = [...$('sc-lines').children];
  let shown = 0;
  rows.forEach((row, i) => scTimers.push(setTimeout(() => {
    row.classList.add('in');
    shown += lines[i][1];
    $('sc-total').textContent = `+${shown}`;
    sfx.coin();
  }, 400 + i * 320)));
  scTimers.push(setTimeout(() => $('stage-clear').classList.remove('show'), 400 + rows.length * 320 + 4200));
}

// Spinning 3D coins that fly up out of slain demons.
let coinTex = null;
const coinSprites = [];
function coinBurst(x, y, z) {
  if (!coinTex) return;
  const n = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    let c = coinSprites.find((k) => k.t <= 0);
    if (!c) {
      if (coinSprites.length > 24) return;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: coinTex, transparent: true, depthWrite: false, toneMapped: false }));
      scene.add(sp);
      c = { sp, t: 0, v: new THREE.Vector3() };
      coinSprites.push(c);
    }
    c.t = 0.9;
    c.sp.visible = true;
    c.sp.position.set(x, y, z);
    c.v.set(rand(-0.8, 0.8), rand(2.5, 3.5), rand(-0.8, 0.8));
    c.spin = rand(0, 6);
  }
}
function updateCoins(dt) {
  for (const c of coinSprites) {
    if (c.t <= 0) continue;
    c.t -= dt;
    c.v.y -= 6 * dt;
    c.sp.position.addScaledVector(c.v, dt);
    c.spin += dt * 12;
    const s = 0.22;
    c.sp.scale.set(s * Math.abs(Math.cos(c.spin)) + 0.02, s, 1);
    c.sp.material.opacity = Math.min(1, c.t * 3);
    if (c.t <= 0) c.sp.visible = false;
  }
}

// Blackout rounds: the station's lights die, only your flashlight is left.
let blackout = false;
function setBlackout(on) {
  if (blackout === on) return;
  blackout = on;
  for (const l of roomLights) l.userData.base = on ? 0.35 : 6;
  hemi.intensity = on ? 0.12 : 0.5;
  scene.fog.near = on ? 3 : 7;
  scene.fog.far = on ? 17 : 26;
  flashlight.intensity = on ? 55 : 40;
}

// ---------------------------------------------------------------- waves
function startBreak(t) { G.phase = 'break'; G.breakT = t; }

function startWave() {
  G.wave++;
  G.phase = 'wave';
  G.waveKind = waveKind(G.wave);
  const d = D();
  const base = waveScaling(G.wave);
  G.scale = { ...base, hp: base.hp * d.hp, dmg: base.dmg * d.dmg, speed: base.speed * d.speed, maxAlive: Math.round(base.maxAlive * d.alive) };
  G.queue = waveComposition(G.wave, G.waveKind);
  // resize the wave for the difficulty, keeping its mix of demon types
  const target = Math.max(4, Math.round(G.queue.length * d.count));
  while (G.queue.length > target) G.queue.splice(Math.floor(Math.random() * G.queue.length), 1);
  while (G.queue.length < target) G.queue.splice(Math.floor(Math.random() * G.queue.length), 0, G.queue[Math.floor(Math.random() * G.queue.length)]);
  if (G.waveKind === 'rush') { G.scale.spawnGap *= 0.55; G.scale.maxAlive += 6; }
  G.spawnT = 1.5;
  G.waveTotal = G.queue.length;
  G.ws = newWaveStats();
  sfx.siren();
  const sub = {
    boss: 'The Brutes are coming...',
    rush: `HELL RUSH — ${G.waveTotal} fast demons!`,
    blackout: `BLACKOUT... ${G.waveTotal} demons in the dark`,
    normal: `${G.waveTotal} demons`,
  }[G.waveKind];
  announce(`WAVE ${G.wave}`, `${sub} · ${d.label}`, 2.8);
  if (G.waveKind === 'blackout') { setBlackout(true); sfx.blackout(); }
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
    sfx.waveClear();
    stageClear();
    setBlackout(false);
    startBreak(BREAK_TIME);
  }
}

// ---------------------------------------------------------------- shop
function nearestKiosk() {
  let best = null, bd = 2.2;
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
  if (document.pointerLockElement) document.exitPointerLock();
  renderShop();
  sfx.click();
}

function closeShop() {
  if (!G.shopOpen) return;
  G.shopOpen = null;
  $('shop').classList.add('hidden');
  $('crosshair').style.display = '';
  if (!G.over) lockPointer();
}

function card(item, price, state, onBuy) {
  const d = document.createElement('div');
  d.className = `card${state.owned ? ' owned' : ''}`;
  d.innerHTML = `<div class="nm">${item.name}</div><div class="ds">${item.desc || ''}</div>
    <div class="row"><span class="pr">${price === 0 ? 'FREE' : price}</span><button ${state.disabled ? 'disabled' : ''}>${state.label || 'Buy'}</button></div>`;
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
  const extra = type === 'flame' ? ' · burns' : type === 'tesla' ? ` · chains ×${w.chain}` : type === 'rocket' ? ' · explosive' : w.pierce ? ` · pierce ${w.pierce > 50 ? '∞' : w.pierce}` : '';
  const res = maxReserve(w);
  return `DMG ${dmg} · ${w.rpm} RPM · ${w.mag}/${res === Infinity ? '∞' : res} rounds${extra}`;
}

function renderShop() {
  const k = G.shopOpen;
  if (!k) return;
  $('shop-title').textContent = k.name;
  $('shop-coins').textContent = G.coins;
  const body = $('shop-body');
  body.innerHTML = '';
  if (k.id === 'arms') {
    $('shop-note').textContent = 'You carry 3 weapons: pistol + 2 primaries. A new weapon replaces the one in your hands (or fills an empty slot). Refill ammo for weapons you own here.';
    for (const cat of Object.keys(CATEGORIES)) {
      const t = document.createElement('div');
      t.className = 'cat-title';
      t.textContent = CATEGORIES[cat];
      body.appendChild(t);
      const grid = document.createElement('div');
      grid.className = 'cards';
      for (const w of WEAPONS.filter((x) => x.cat === cat)) {
        const sl = player.slots.find((s) => s && s.id === w.id);
        if (sl) {
          const full = sl.ammo >= w.mag && sl.reserve >= maxReserve(w);
          const ap = ammoPrice(w);
          grid.appendChild(card({ name: w.name, desc: weaponDesc(w) }, ap,
            { owned: true, disabled: full || G.coins < ap, label: full ? 'Full' : 'Ammo' }, () => buyWeapon(w)));
        } else {
          grid.appendChild(card({ name: w.name, desc: weaponDesc(w) }, w.price,
            { disabled: G.coins < w.price, label: 'Buy' }, () => buyWeapon(w)));
        }
      }
      body.appendChild(grid);
    }
  } else {
    const list = k.id === 'armor' ? ARMOR_ITEMS : MED_ITEMS;
    $('shop-note').textContent = k.id === 'armor' ? `Armor: ${Math.round(player.armor)} · Grenades: ${player.grenades} · Mines: ${player.mines}`
      : `Self-revive: ${player.revive}/1 · ${COMPANION.name} — level ${comp.level}/5`;
    const grid = document.createElement('div');
    grid.className = 'cards';
    for (const it of list) {
      let price = it.price;
      let disabled = G.coins < price;
      let label;
      if (it.id === 'revive' && player.revive >= 1) { disabled = true; label = 'Owned'; }
      if (it.id === 'grenade' && player.grenades >= 10) { disabled = true; label = 'Full'; }
      if (it.id === 'mine' && player.mines >= 8) { disabled = true; label = 'Full'; }
      if (it.armor && player.armor >= it.armor) { disabled = true; label = 'Owned'; }
      if (it.id === 'medkit' && player.hp >= player.maxHp) { disabled = true; label = 'Full'; }
      if (it.id === 'comp_heal' && (comp.state !== 'up' || comp.hp >= comp.maxHp)) { disabled = true; label = comp.state !== 'up' ? 'Downed' : 'Full'; }
      if (it.id === 'comp_up') {
        price = it.price * comp.level;
        disabled = comp.level >= 5 || G.coins < price;
        if (comp.level >= 5) label = 'Max';
      }
      grid.appendChild(card(it, price, { disabled, label }, () => buyItem(it, price)));
    }
    body.appendChild(grid);
  }
}

function buyWeapon(w) {
  const idx = player.slots.findIndex((s) => s && s.id === w.id);
  if (idx >= 0) {
    // owned: buy a full ammo refill
    if (!pay(ammoPrice(w))) return;
    player.slots[idx].ammo = w.mag;
    player.slots[idx].reserve = maxReserve(w);
    switchSlot(idx);
    sfx.reload();
    renderShop();
    return;
  }
  if (!pay(w.price)) return;
  let slot = player.slots[1] ? (player.slots[2] ? (player.cur === 0 ? 1 : player.cur) : 2) : 1;
  if (w.id === 'm9') slot = 0;
  player.slots[slot] = newSlot(w.id);
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
function popup(text, x, y, z, color, coin) {
  let p = popups.find((q) => q.t <= 0);
  if (!p) {
    if (popups.length > 30) return;
    const el = document.createElement('div');
    el.className = 'popup';
    $('popups').appendChild(el);
    p = { el, t: 0, pos: new THREE.Vector3() };
    popups.push(p);
  }
  p.el.innerHTML = coin ? `<i class="coin-icon small"></i>${text}` : text;
  p.el.style.color = color;
  p.pos.set(x, y, z);
  p.t = 1;
  p.el.style.display = '';
}

function updatePopups(dt) {
  for (const p of popups) {
    if (p.t <= 0) continue;
    p.t -= dt;
    p.pos.y += dt * 0.8;
    _v.copy(p.pos).project(camera);
    if (p.t <= 0 || _v.z > 1) { p.el.style.display = 'none'; if (p.t <= 0) continue; continue; }
    p.el.style.display = '';
    p.el.style.left = `${(_v.x * 0.5 + 0.5) * innerWidth}px`;
    p.el.style.top = `${(-_v.y * 0.5 + 0.5) * innerHeight}px`;
    p.el.style.opacity = Math.min(1, p.t * 2);
  }
}

function updateHUD(dt) {
  const p = player;
  if (G.phase === 'break') {
    setText('wave-title', G.wave === 0 ? 'Get Ready' : 'Intermission');
    setText('wave-sub', `Wave ${G.wave + 1} starts in ${Math.ceil(G.breakT)}s · [N] start now`);
  } else {
    setText('wave-title', `Wave ${G.wave}`);
    setText('wave-sub', `Demons left: ${aliveCount() + G.queue.length}`);
  }
  setText('coin-val', String(G.coins));
  const hpNow = p.state === 'down' ? p.downHp : p.hp;
  const hpMax = p.state === 'down' ? PLAYER.downedHp : p.maxHp;
  $('hp-fill').style.width = `${clamp(hpNow / hpMax, 0, 1) * 100}%`;
  setText('hp-val', String(Math.ceil(Math.max(0, hpNow))));
  $('ar-fill').style.width = `${p.maxArmor ? clamp(p.armor / p.maxArmor, 0, 1) * 100 : 0}%`;
  setText('ar-val', String(Math.ceil(p.armor)));
  setHTML('items', `<span class="chip ${p.grenades ? '' : 'off'}">[G] Grenade ×${p.grenades}</span>`
    + `<span class="chip ${p.mines ? '' : 'off'}">[F] Mine ×${p.mines}</span>`
    + `<span class="chip ${p.revive ? 'on' : 'off'}">✚ Self-revive ${p.revive}/1</span>`);
  let b = '';
  for (const k in p.boosts) if (p.boosts[k] > 0) b += `<span class="chip boost">${BOOST_LABELS[k]} ${Math.ceil(p.boosts[k])}s</span>`;
  setHTML('boosts', b);
  setHTML('companion-box', comp.state === 'up'
    ? `<span class="name">${COMPANION.name}</span> · Lv ${comp.level} · ${Math.ceil(comp.hp)}/${Math.round(comp.maxHp)}`
    : `<span class="down">${COMPANION.name} is down — revive her [E]</span>`);

  const s = curSlot();
  const w = WEAPON_BY_ID[s.id];
  setText('weapon-name', p.state === 'down' ? `${w.name} (downed)` : w.name);
  setText('ammo-cur', String(s.ammo));
  setText('ammo-max', s.reserve === Infinity ? '∞' : String(s.reserve));
  $('st-fill').style.width = `${p.stamina}%`;
  $('st-fill').classList.toggle('tired', p.exhausted);
  const ch = $('crosshair');
  ch.style.setProperty('--g', `${Math.round(clamp(p.spreadNow, 0, 0.25) * 260 * (74 / camera.fov))}px`);
  ch.style.opacity = w.cat === 'sniper' && p.ads > 0.85 ? 0 : 1 - 0.6 * p.ads * (w.cat === 'sniper' ? 1 : 0.5);
  $('ammo').classList.toggle('low', s.ammo <= Math.ceil(w.mag * 0.25) || s.reserve === 0);
  const rt = $('reload-track');
  rt.style.visibility = p.reloadT > 0 ? 'visible' : 'hidden';
  if (p.reloadT > 0) $('reload-fill').style.width = `${(1 - p.reloadT / p.reloadMax) * 100}%`;
  setHTML('slots', p.slots.map((sl, i) => `<span class="slot ${i === p.cur && p.state === 'up' ? 'active' : ''}">${i + 1} ${sl ? WEAPON_BY_ID[sl.id].name : '—'}</span>`).join(''));

  let prompt = '';
  const dc = Math.hypot(comp.pos.x - p.pos.x, comp.pos.z - p.pos.z);
  if (p.state === 'up' && comp.state === 'down' && dc < 1.8) {
    prompt = input.keys.KeyE
      ? `Reviving ${COMPANION.name}...<div class="progress" style="width:${(comp.reviveProg / COMPANION.reviveTime) * 100}%"></div>`
      : `Hold [E] to revive ${COMPANION.name}`;
  } else if (p.state === 'up' && !G.shopOpen) {
    const k = nearestKiosk();
    if (k) prompt = `[E] ${k.name}`;
  }
  if (!prompt && G.started && !G.locked && !G.shopOpen && !G.paused && !DEBUG_NOLOCK) prompt = 'Click the screen to look around';
  const pe = $('prompt');
  if (prompt) { pe.style.display = 'block'; setHTML('prompt', prompt); } else pe.style.display = 'none';

  hurtV = Math.max(0, hurtV - dt * 1.5);
  const low = p.state === 'down' ? 0.6 : p.hp < 35 ? 0.35 + Math.sin(G.time * 5) * 0.1 : 0;
  $('hurt').style.opacity = Math.max(hurtV, low);
  if (announceT > 0) { announceT -= dt; if (announceT <= 0) $('announce').classList.remove('show'); }
  if (G.shopOpen) setText('shop-coins', String(G.coins));
  if (hitMarkT > 0) { hitMarkT -= dt; if (hitMarkT <= 0) $('crosshair').classList.remove('hit', 'head'); }
  dmgDirT = Math.max(0, dmgDirT - dt);
  const dd = $('dmg-dir');
  dd.style.opacity = dmgDirT;
  if (dmgDirT > 0) dd.style.transform = `translate(-50%, -50%) rotate(${-dmgDirAng}rad)`;
}
const DEBUG_NOLOCK = DEBUG && /[?&]nolock\b/.test(location.search);

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
    if (!isLive(e)) continue;
    dot(e.pos.x, e.pos.z, e.key === 'brute' ? 3 : 2, e.key === 'fast' ? '#ff4030' : e.key === 'brute' ? '#e0a040' : '#6aa0ff');
  }
  dot(comp.pos.x, comp.pos.z, 3, comp.state === 'up' ? '#ff5050' : (G.time * 4) % 1 < 0.5 ? '#ffffff' : '#ff5050');
  // player arrow
  const [a, b] = P(player.pos.x, player.pos.z);
  const fx_ = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  x.fillStyle = '#ffffff';
  x.beginPath();
  x.moveTo(a + fx_ * 7, b + fz * 7);
  x.lineTo(a - fz * 4 - fx_ * 3, b + fx_ * 4 - fz * 3);
  x.lineTo(a + fz * 4 - fx_ * 3, b - fx_ * 4 - fz * 3);
  x.closePath();
  x.fill();
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
  G.groanT -= dt;
  if (G.groanT <= 0) {
    G.groanT = rand(1.5, 4);
    const near = G.enemies.filter(isLive);
    if (near.length) {
      const e = near[Math.floor(Math.random() * near.length)];
      sfxAt(e.pos, () => sfx.groan(e.key === 'fast' ? 1.8 : e.key === 'brute' ? 0.6 : 1));
    }
  }
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
  renderer.clear();
  renderer.render(scene, camera);
  if (!G.over) vm.render(renderer);
}

function step(dt) {
  G.time += dt;
  if (DEBUG && G.autoAim) autoAim();
  G.flowT -= dt;
  if (G.flowT <= 0) { G.flowT = 0.25; nav.computeFlow(player.pos.x, player.pos.z); }
  updateWaves(dt);
  updatePlayer(dt);
  updateCompanion(dt);
  for (const e of G.enemies) if (e.active) e.update(dt);
  updateProjectiles(dt);
  updatePowerups(dt);
  updateCoins(dt);

  if (comp.state === 'down' && player.state === 'up' && input.keys.KeyE
    && Math.hypot(comp.pos.x - player.pos.x, comp.pos.z - player.pos.z) < 1.8) {
    comp.reviveProg += dt;
    if (comp.reviveProg >= COMPANION.reviveTime) {
      comp.state = 'up';
      comp.hp = comp.maxHp;
      comp.reviveProg = 0;
      sfx.revive();
      fx.flash(_v.copy(comp.pos).setY(comp.pos.y + 1), 0xff6040, 3, 0.4);
      announce(`${COMPANION.name} is back!`, '', 1.4);
    }
  } else comp.reviveProg = 0;

  if (G.shopOpen && Math.hypot(G.shopOpen.pos.x - player.pos.x, G.shopOpen.pos.z - player.pos.z) > 2.8) closeShop();

  arenaMixer.update(dt);
  updateAtmosphere(dt);
  for (const e of G.enemies) e.updateBar();
  fx.update(dt);
  updatePopups(dt);
  updateHUD(dt);
  drawMinimap();
}

// test helper: look at the nearest demon
function autoAim() {
  let best = null, bd = Infinity;
  for (const e of G.enemies) {
    if (!isLive(e) || e.state === 'spawn') continue;
    const d = e.pos.distanceTo(player.pos);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return;
  const eye = _v.set(player.pos.x, player.pos.y + player.eye, player.pos.z);
  const dx = best.pos.x - eye.x, dz = best.pos.z - eye.z, dy = best.pos.y + best.height * 0.6 - eye.y;
  player.yaw = Math.atan2(-dx, -dz);
  player.pitch = Math.atan2(dy, Math.hypot(dx, dz));
}

// ---------------------------------------------------------------- flow control
function lockPointer() {
  if (DEBUG_NOLOCK) return;
  try {
    const r = canvas.requestPointerLock && canvas.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  } catch (e) { /* pointer lock unavailable */ }
}

function gameOver() {
  G.over = true;
  player.state = 'dead';
  closeShop();
  if (document.pointerLockElement) document.exitPointerLock();
  $('downed').classList.add('hidden');
  let best = 0;
  const key = `hw-best-${G.diff}`;
  try { best = Number(localStorage.getItem(key) || 0); if (G.wave > best) localStorage.setItem(key, String(G.wave)); } catch (e) { /* storage unavailable */ }
  $('go-stats').innerHTML = `Difficulty: <b>${D().label}</b><br>You survived <b>${Math.max(0, G.wave - 1)}</b> waves · reached wave <b>${G.wave}</b><br>Demons killed: <b>${G.kills}</b><br>`
    + `${G.wave > best ? 'NEW RECORD!' : `Best on ${D().label}: wave ${best}`}`;
  $('gameover').classList.remove('hidden');
  $('hud').classList.add('hidden');
}

function resetGame() {
  for (const e of G.enemies) { e.active = false; e.root.visible = false; e.bar.visible = false; }
  for (const p of G.projectiles) scene.remove(p.mesh);
  for (const m of G.mines) scene.remove(m.g);
  G.projectiles.length = 0;
  G.mines.length = 0;
  Object.assign(G, { over: false, paused: false, time: 0, wave: 0, coins: G.promoCoins, kills: 0, shake: 0, queue: [], shopOpen: null });
  Object.assign(player, {
    hp: PLAYER.hp, maxHp: PLAYER.hp, armor: 0, maxArmor: 0, state: 'up', invuln: 0, eye: PLAYER.eye, roll: 0,
    slots: [newSlot('m9'), null, null], cur: 0, lastSlot: 0,
    reloadT: 0, fireCd: 0, grenades: 2, mines: 0, revive: 0, boosts: { dmg: 0, rate: 0, speed: 0, regen: 0, insta: 0, double: 0 },
    ads: 0, bloom: 0, stamina: 100, exhausted: false, knifeCd: 0, lastHurt: -99,
  });
  G.ws = null;
  scTimers.forEach(clearTimeout);
  $('stage-clear').classList.remove('show');
  for (const pu of G.powerups) scene.remove(pu.g);
  G.powerups.length = 0;
  setBlackout(false);
  Object.assign(comp, { hp: COMPANION.hp, maxHp: COMPANION.hp, level: 1, state: 'up', reviveProg: 0, target: null, swingT: -1 });
  comp.tilt.rotation.x = 0;
  placeCharacters();
  startBreak(FIRST_BREAK);
  announce('GET READY', 'Buy weapons — the demons are coming', 3);
  $('downed').classList.add('hidden');
  $('gameover').classList.add('hidden');
  $('hud').classList.remove('hidden');
  nav.computeFlow(player.pos.x, player.pos.z);
}

function setPaused(p) {
  if (!G.started || G.over) return;
  G.paused = p;
  $('pause').classList.toggle('hidden', !p);
  if (p) { input.down = false; if (document.pointerLockElement) document.exitPointerLock(); }
}

// ---------------------------------------------------------------- input
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  input.keys[e.code] = true;
  if (!G.started || G.over) return;
  if (e.code === 'KeyP') { setPaused(!G.paused); if (!G.paused) lockPointer(); return; }
  if (e.code === 'Escape') {
    if (G.shopOpen) closeShop();
    else if (!G.locked) setPaused(!G.paused);
    return;
  }
  if (G.paused) return;
  if (e.code === 'KeyE') {
    if (G.shopOpen) { closeShop(); return; }
    const nearComp = comp.state === 'down' && Math.hypot(comp.pos.x - player.pos.x, comp.pos.z - player.pos.z) < 1.8;
    const k = nearestKiosk();
    if (!nearComp && k && player.state === 'up') openShop(k);
  }
  if (e.code === 'KeyR' && player.state !== 'dead') startReload();
  if (e.code === 'Digit1') switchSlot(0);
  if (e.code === 'Digit2') switchSlot(1);
  if (e.code === 'Digit3') switchSlot(2);
  if (e.code === 'KeyQ') switchSlot(player.lastSlot);
  if (e.code === 'KeyG') throwGrenade();
  if (e.code === 'KeyV') knifeAttack();
  if (e.code === 'KeyI' && player.state === 'up' && player.reloadT <= 0) vm.inspect();
  if (e.code === 'KeyF') placeMine();
  if (e.code === 'KeyN' && G.phase === 'break') G.breakT = 0;
  if (e.code === 'KeyM') { G.muted = !G.muted; sfx.setMuted(G.muted); }
});
addEventListener('keyup', (e) => { input.keys[e.code] = false; });
addEventListener('blur', () => { input.keys = {}; input.down = false; input.ads = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });
document.addEventListener('pointerlockchange', () => {
  G.locked = document.pointerLockElement === canvas;
  if (!G.locked) {
    input.down = false;
    // Esc released the mouse: pause, unless we freed it ourselves for the shop
    if (G.started && !G.over && !G.shopOpen && !G.paused) setPaused(true);
  }
});
addEventListener('mousemove', (e) => {
  if (!G.locked) return;
  input.lookDX += e.movementX;
  input.lookDY += e.movementY;
});
canvas.addEventListener('mousedown', (e) => {
  if (G.shopOpen || !G.started || G.paused) return;
  if (!G.locked && !DEBUG_NOLOCK) { lockPointer(); return; }
  if (e.button === 0) { input.down = true; input.clicked = true; }
  if (e.button === 2) input.ads = true;
});
addEventListener('mouseup', (e) => { if (e.button === 0) input.down = false; if (e.button === 2) input.ads = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', (e) => {
  if (G.shopOpen || !G.started || player.state !== 'up') return;
  const owned = [0, 1, 2].filter((i) => player.slots[i]);
  const idx = owned.indexOf(player.cur);
  switchSlot(owned[(idx + (e.deltaY > 0 ? 1 : owned.length - 1)) % owned.length]);
}, { passive: true });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  vm.resize();
});
$('shop-close').addEventListener('click', closeShop);
$('shop').addEventListener('mousedown', (e) => { if (e.target === $('shop')) closeShop(); });
$('resume').addEventListener('click', () => { setPaused(false); lockPointer(); });
$('restart').addEventListener('click', () => { sfx.init(); resetGame(); lockPointer(); });
$('pause-restart').addEventListener('click', () => { setPaused(false); resetGame(); lockPointer(); });
// ---------------------------------------------------------------- menu: difficulty + promo code
function D() { return DIFFICULTY[G.diff] || DIFFICULTY.medium; }
function renderDifficulty() {
  for (const b of document.querySelectorAll('#difficulty button')) b.classList.toggle('active', b.dataset.diff === G.diff);
  $('diff-desc').textContent = D().desc;
  let best = 0;
  try { best = Number(localStorage.getItem(`hw-best-${G.diff}`) || 0); } catch (e) { /* storage unavailable */ }
  $('best').textContent = best ? `Best on ${D().label}: wave ${best}` : '';
}
for (const b of document.querySelectorAll('#difficulty button')) {
  b.addEventListener('click', () => {
    G.diff = b.dataset.diff;
    try { localStorage.setItem('hw-diff', G.diff); } catch (e) { /* storage unavailable */ }
    renderDifficulty();
  });
}
function applyPromo() {
  const code = $('promo').value.trim();
  const msg = $('promo-msg');
  if (!code) { msg.textContent = ''; return; }
  const p = PROMO_CODES[code];
  if (p) {
    G.promoCoins = p.coins;
    msg.textContent = `Code accepted: ${p.label}`;
    msg.className = 'ok';
  } else {
    msg.textContent = 'Invalid code';
    msg.className = 'bad';
  }
}
$('promo-apply').addEventListener('click', applyPromo);
$('promo').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') applyPromo(); });
renderDifficulty();

$('play').addEventListener('click', () => {
  if ($('promo').value.trim() && !G.promoCoins) applyPromo();
  sfx.init();
  $('menu').classList.add('hidden');
  const bg = $('bgvideo');
  bg.pause();
  bg.classList.add('off');
  G.started = true;
  resetGame();
  lockPointer();
});
const sensInput = $('sens');
sensInput.value = String(Math.round(sens * 10000));
sensInput.addEventListener('input', () => {
  sens = Number(sensInput.value) / 10000;
  try { localStorage.setItem('hw-sens', String(sens)); } catch (e) { /* storage unavailable */ }
});

if (DEBUG) {
  window.__G = G;
  window.__THREE_V3 = THREE.Vector3;
  window.__dbg = {
    hemi, scene, nav, camera, player, get comp() { return comp; }, get kiosks() { return G.kiosks; },
    spawnEnemy, dropPowerup, sightLine, keys: input.keys, setAds: (v) => { input.ads = v; }, buyWeapon: (id) => buyWeapon(WEAPON_BY_ID[id]),
    buyItem: (id) => buyItem([...ARMOR_ITEMS, ...MED_ITEMS].find((i) => i.id === id), 0),
    sim: (sec, dt = 1 / 30) => { for (let t = 0; t < sec; t += dt) { if (!G.over && !G.paused) step(dt); } },
  };
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const saved = localStorage.getItem('hw-diff');
    if (saved && DIFFICULTY[saved]) G.diff = saved;
    renderDifficulty();
  } catch (e) { /* storage unavailable */ }
  try {
    await loadAssets();
    coinTex = await new THREE.TextureLoader().loadAsync(`${BASE}media/coin.webp`).catch(() => null);
    if (coinTex) coinTex.colorSpace = THREE.SRGBColorSpace;
    for (const k of ['huggy', 'butcher', 'siren', 'nurse', 'dog']) prepModel(k);
    initWeaponModels(assets.weapons);
    vm.initProps();
    player.vmId = null;
    await new Promise((r) => setTimeout(r, 30));
    buildWorld();
    $('load-fill').style.width = '95%';
    setupCompanion();
    placeCharacters();
    // warm up shaders with one demon of every model
    for (const key of Object.keys(ENEMY_TYPES)) {
      ENEMY_TYPES[key].variants.forEach((_, vi) => {
        const e = new Enemy(key, vi);
        e.active = false; e.root.visible = true;
        e.pos.set(player.pos.x, nav.floorY, player.pos.z - 3);
        const pk = `${key}${vi}`;
        (G.pool[pk] || (G.pool[pk] = [])).push(e);
        G.enemies.push(e);
      });
    }
    syncViewModel();
    updatePlayer(0);
    renderer.compile(scene, camera);
    renderer.render(scene, camera);
    for (const e of G.enemies) e.root.visible = false;
    $('load-fill').style.width = '100%';
    $('load-status').textContent = 'Ready';
    $('play').disabled = false;
    window.__ready = true;
  } catch (err) {
    console.error(err);
    $('load-status').textContent = `Loading error: ${err.message || err}`;
  }
})();
requestAnimationFrame(frame);
