import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

class Particles {
  constructor(scene, max, additive) {
    this.max = max;
    const mat = new THREE.MeshBasicMaterial({
      transparent: additive, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: !additive, toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 5 : 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.rot = new Float32Array(max);
    this.next = 0;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, _m);
    scene.add(this.mesh);
  }
  spawn(x, y, z, vx, vy, vz, life, size, color, grav = 9) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size;
    this.grav[i] = grav;
    this.rot[i] = Math.random() * 6;
    this.mesh.instanceColor.setXYZ(i, color.r, color.g, color.b);
    this.mesh.instanceColor.needsUpdate = true;
  }
  update(dt, floorY) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const k = i * 3;
      if (this.life[i] <= 0) { _m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, _m); continue; }
      this.vel[k + 1] -= this.grav[i] * dt;
      this.pos[k] += this.vel[k] * dt;
      this.pos[k + 1] += this.vel[k + 1] * dt;
      this.pos[k + 2] += this.vel[k + 2] * dt;
      if (this.pos[k + 1] < floorY + 0.02) {
        this.pos[k + 1] = floorY + 0.02;
        this.vel[k] *= 0.5; this.vel[k + 2] *= 0.5; this.vel[k + 1] = 0;
      }
      const t = this.life[i] / this.maxLife[i];
      const s = this.size[i] * (0.3 + 0.7 * t);
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      _q.setFromEuler(_e.set(this.rot[i], this.rot[i] * 1.3, 0));
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

class Tracers {
  constructor(scene, max) {
    this.max = max;
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    this.base = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    scene.add(this.lines);
    this.next = 0;
  }
  add(a, b, color, life = 0.08) {
    const i = this.next;
    this.next = (this.next + 1) % this.max;
    this.pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    this.base.set([color.r, color.g, color.b], i * 3);
    this.life[i] = this.maxLife[i] = life;
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      let t = 0;
      if (this.life[i] > 0) { this.life[i] -= dt; t = Math.max(0, this.life[i] / this.maxLife[i]); }
      const r = this.base[i * 3] * t, g = this.base[i * 3 + 1] * t, b = this.base[i * 3 + 2] * t;
      this.col.set([r, g, b, r * 0.3, g * 0.3, b * 0.3], i * 6);
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.solid = new Particles(scene, 500, false);
    this.glow = new Particles(scene, 600, true);
    this.tracers = new Tracers(scene, 96);
    this.glowTex = glowTexture();
    this.flashes = [];
    for (let i = 0; i < 24; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false,
      }));
      s.visible = false;
      s.renderOrder = 7;
      scene.add(s);
      this.flashes.push({ s, life: 0, max: 1, size: 1 });
    }
    this.fi = 0;
    // blood pools on the floor
    this.decalMax = 90;
    this.decals = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.5, 12).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x3a0000, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      this.decalMax,
    );
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.decalMax; i++) this.decals.setMatrixAt(i, _m);
    this.decals.frustumCulled = false;
    this.decalI = 0;
    scene.add(this.decals);
    this.floorY = 0;
    this.tmpColor = new THREE.Color();
  }

  flash(pos, color, size, life = 0.08) {
    const f = this.flashes[this.fi];
    this.fi = (this.fi + 1) % this.flashes.length;
    f.s.position.copy(pos);
    f.s.material.color.set(color);
    f.s.visible = true;
    f.life = f.max = life;
    f.size = size;
    f.s.scale.setScalar(size);
  }

  blood(pos, dir, n = 8, color = 0x8a0000) {
    const c = this.tmpColor.set(color);
    for (let i = 0; i < n; i++) {
      const sp = 1.5 + Math.random() * 3;
      this.solid.spawn(pos.x, pos.y, pos.z,
        (dir ? dir.x * sp : 0) + (Math.random() - 0.5) * 3, Math.random() * 3 + 0.5, (dir ? dir.z * sp : 0) + (Math.random() - 0.5) * 3,
        0.5 + Math.random() * 0.5, 0.04 + Math.random() * 0.05, c, 12);
    }
  }

  bloodPool(x, z, size = 1) {
    const i = this.decalI;
    this.decalI = (this.decalI + 1) % this.decalMax;
    _p.set(x, this.floorY + 0.012 + i * 0.00005, z);
    _q.setFromEuler(_e.set(0, Math.random() * 6, 0));
    const s = size * (0.6 + Math.random() * 0.8);
    _s.set(s, 1, s * (0.6 + Math.random() * 0.5));
    _m.compose(_p, _q, _s);
    this.decals.setMatrixAt(i, _m);
    this.decals.instanceMatrix.needsUpdate = true;
  }

  sparks(pos, color = 0xffc060, n = 6) {
    const c = this.tmpColor.set(color);
    for (let i = 0; i < n; i++) {
      this.glow.spawn(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 6, Math.random() * 4, (Math.random() - 0.5) * 6, 0.25 + Math.random() * 0.2, 0.035, c, 14);
    }
  }

  fire(origin, dir, range) {
    const c = this.tmpColor;
    for (let i = 0; i < 4; i++) {
      const sp = range * (1.2 + Math.random() * 0.8);
      c.setHSL(0.02 + Math.random() * 0.08, 1, 0.45 + Math.random() * 0.2);
      this.glow.spawn(origin.x, origin.y, origin.z,
        dir.x * sp + (Math.random() - 0.5) * 2.5, (Math.random() - 0.2) * 1.5, dir.z * sp + (Math.random() - 0.5) * 2.5,
        0.35 + Math.random() * 0.2, 0.12 + Math.random() * 0.12, c, -1.5);
    }
  }

  explosion(pos, radius) {
    this.flash(pos.clone().setY(pos.y + 0.5), 0xff8a30, radius * 3, 0.35);
    this.flash(pos.clone().setY(pos.y + 0.5), 0xffffff, radius * 1.4, 0.12);
    const c = this.tmpColor;
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * radius * 3;
      c.setHSL(0.03 + Math.random() * 0.1, 1, 0.4 + Math.random() * 0.3);
      this.glow.spawn(pos.x, pos.y + 0.3, pos.z, Math.cos(a) * sp, Math.random() * 6, Math.sin(a) * sp, 0.4 + Math.random() * 0.5, 0.08 + Math.random() * 0.12, c, 6);
    }
    c.set(0x222222);
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * radius * 2;
      this.solid.spawn(pos.x, pos.y + 0.3, pos.z, Math.cos(a) * sp, Math.random() * 7, Math.sin(a) * sp, 0.8 + Math.random() * 0.6, 0.05 + Math.random() * 0.06, c, 14);
    }
  }

  arc(a, b, color) {
    // jagged lightning made of short tracer segments
    const n = 6;
    let prev = a.clone();
    for (let i = 1; i <= n; i++) {
      const p = a.clone().lerp(b, i / n);
      if (i < n) p.add(new THREE.Vector3((Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.35, (Math.random() - 0.5) * 0.35));
      this.tracers.add(prev, p, color, 0.12);
      prev = p;
    }
  }

  update(dt) {
    this.solid.update(dt, this.floorY);
    this.glow.update(dt, this.floorY);
    this.tracers.update(dt);
    for (const f of this.flashes) {
      if (!f.s.visible) continue;
      f.life -= dt;
      if (f.life <= 0) { f.s.visible = false; continue; }
      const t = f.life / f.max;
      f.s.material.opacity = t;
      f.s.scale.setScalar(f.size * (1.2 - 0.2 * t));
    }
  }
}
