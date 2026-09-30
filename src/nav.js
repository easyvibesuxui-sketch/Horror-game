import * as THREE from 'three';

// 2D navigation grid built by raycasting the arena.
// Cell values: 0 = wall / outside, 1 = walkable floor, 2 = obstacle (blocks walking, not bullets)
export const VOID = 0;
export const FLOOR = 1;
export const OBST = 2;

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export class Nav {
  build(root, cell = 0.25) {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    this.cell = cell;
    this.minX = Math.floor(box.min.x) - 1;
    this.minZ = Math.floor(box.min.z) - 1;
    this.w = Math.ceil((box.max.x + 1 - this.minX) / cell);
    this.h = Math.ceil((box.max.z + 1 - this.minZ) / cell);
    const n = this.w * this.h;
    this.grid = new Uint8Array(n);
    this.dist = new Float32Array(n).fill(Infinity);

    const meshes = [];
    root.traverse((o) => { if (o.isMesh) meshes.push(o); });
    const rc = new THREE.Raycaster();
    rc.firstHitOnly = true;
    const origin = new THREE.Vector3();
    const down = new THREE.Vector3(0, -1, 0);
    let floorSum = 0, floorN = 0;

    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        origin.set(this.minX + (i + 0.5) * cell, 1.7, this.minZ + (j + 0.5) * cell);
        rc.set(origin, down);
        rc.far = 3;
        const hits = rc.intersectObjects(meshes, false);
        let v = VOID;
        if (hits.length) {
          const y = hits[0].point.y;
          if (y < 0.25) { v = FLOOR; floorSum += y; floorN++; } else v = OBST;
        }
        this.grid[j * this.w + i] = v;
      }
    }
    this.floorY = floorN ? floorSum / floorN : 0;

    // Thin vertical walls are invisible to downward rays: probe sideways too.
    const side = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1)];
    const marks = [];
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const k = j * this.w + i;
        if (this.grid[k] !== FLOOR) continue;
        for (const h of [0.35, 1.1]) {
          origin.set(this.minX + (i + 0.5) * cell, this.floorY + h, this.minZ + (j + 0.5) * cell);
          let hitVal = -1;
          for (const d of side) {
            rc.set(origin, d);
            rc.far = cell * 0.62;
            const hits = rc.intersectObjects(meshes, false);
            if (hits.length) {
              const name = hits[0].object.name + ' ' + (hits[0].object.parent ? hits[0].object.parent.name : '');
              hitVal = /Room|DoorWay/i.test(name) ? VOID : OBST;
              if (hitVal === VOID) break;
            }
          }
          if (hitVal >= 0) { marks.push(k, hitVal); break; }
        }
      }
    }
    for (let m = 0; m < marks.length; m += 2) this.grid[marks[m]] = marks[m + 1];
    this.updateClearance();
  }

  // Cells whose whole 3x3 neighbourhood is floor: paths through them keep bodies off the walls.
  updateClearance() {
    const { w, h, grid } = this;
    this.clear = new Uint8Array(w * h);
    for (let j = 1; j < h - 1; j++) {
      for (let i = 1; i < w - 1; i++) {
        let ok = 1;
        for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1; di++) if (grid[(j + dj) * w + i + di] !== FLOOR) { ok = 0; break; }
        this.clear[j * w + i] = ok;
      }
    }
  }

  i(x) { return Math.floor((x - this.minX) / this.cell); }
  j(z) { return Math.floor((z - this.minZ) / this.cell); }
  cx(i) { return this.minX + (i + 0.5) * this.cell; }
  cz(j) { return this.minZ + (j + 0.5) * this.cell; }

  at(x, z) {
    const i = this.i(x), j = this.j(z);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return VOID;
    return this.grid[j * this.w + i];
  }
  walk(x, z) { return this.at(x, z) === FLOOR; }

  canStand(x, z, r) {
    return this.walk(x, z) && this.walk(x + r, z) && this.walk(x - r, z) && this.walk(x, z + r) && this.walk(x, z - r)
      && this.walk(x + r * 0.7, z + r * 0.7) && this.walk(x - r * 0.7, z + r * 0.7)
      && this.walk(x + r * 0.7, z - r * 0.7) && this.walk(x - r * 0.7, z - r * 0.7);
  }

  // Moves pos by (dx,dz) with wall sliding. Returns true if moved at all.
  move(pos, dx, dz, r, steer = false) {
    if (this.canStand(pos.x + dx, pos.z + dz, r)) { pos.x += dx; pos.z += dz; return true; }
    if (dx && this.canStand(pos.x + dx, pos.z, r)) { pos.x += dx; return true; }
    if (dz && this.canStand(pos.x, pos.z + dz, r)) { pos.z += dz; return true; }
    if (steer) {
      // try turning away from the obstacle (AI only)
      for (const a of [0.6, -0.6, 1.2, -1.2]) {
        const c = Math.cos(a), s = Math.sin(a);
        const rx = dx * c - dz * s, rz = dx * s + dz * c;
        if (this.canStand(pos.x + rx, pos.z + rz, r)) { pos.x += rx; pos.z += rz; return true; }
      }
    }
    // if already overlapping a wall, allow moves that reduce the overlap
    if (!this.canStand(pos.x, pos.z, r) && this.walk(pos.x + dx, pos.z + dz)) { pos.x += dx; pos.z += dz; return true; }
    return false;
  }

  // Mark a disc as obstacle (used for shop kiosks).
  block(x, z, r) {
    for (let j = this.j(z - r); j <= this.j(z + r); j++) {
      for (let i = this.i(x - r); i <= this.i(x + r); i++) {
        const k = j * this.w + i;
        if (this.grid[k] === FLOOR && Math.hypot(this.cx(i) - x, this.cz(j) - z) <= r) this.grid[k] = OBST;
      }
    }
    this.updateClearance();
  }

  nearestStand(x, z, r, maxR = 6) {
    if (this.canStand(x, z, r)) return new THREE.Vector2(x, z);
    for (let rad = this.cell; rad <= maxR; rad += this.cell) {
      const steps = Math.max(8, Math.ceil((rad * Math.PI * 2) / this.cell));
      for (let s = 0; s < steps; s++) {
        const a = (s / steps) * Math.PI * 2;
        const px = x + Math.cos(a) * rad, pz = z + Math.sin(a) * rad;
        if (this.canStand(px, pz, r)) return new THREE.Vector2(px, pz);
      }
    }
    return new THREE.Vector2(x, z);
  }

  // Distance a bullet travels before hitting a wall.
  bulletLen(ox, oz, dx, dz, max) {
    const step = 0.08;
    for (let t = 0; t < max; t += step) {
      if (this.at(ox + dx * t, oz + dz * t) === VOID) return Math.max(0, t - step * 0.5);
    }
    return max;
  }

  // Line of walkable sight (for direct chasing).
  losWalk(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.ceil(d / 0.2);
    for (let s = 1; s < n; s++) {
      const t = s / n;
      if (!this.walk(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }
  losShoot(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az);
    return this.bulletLen(ax, az, (bx - ax) / d, (bz - az) / d, d) >= d - 0.1;
  }

  // Dijkstra distance field from a target point (8-neighbour, no corner cutting).
  computeFlow(x, z) {
    const { w, h, dist } = this;
    const grid = this.clear;
    dist.fill(Infinity);
    let si = this.i(x), sj = this.j(z);
    if (si < 0 || sj < 0 || si >= w || sj >= h || grid[sj * w + si] !== 1) {
      // start from the nearest clear cell
      let found = false;
      for (let r = 1; r <= 8 && !found; r++) {
        for (let dj = -r; dj <= r && !found; dj++) {
          for (let di = -r; di <= r; di++) {
            const ni = si + di, nj = sj + dj;
            if (ni < 0 || nj < 0 || ni >= w || nj >= h || grid[nj * w + ni] !== 1) continue;
            si = ni; sj = nj; found = true; break;
          }
        }
      }
      if (!found) return;
    }
    const heap = this._heap || (this._heap = new MinHeap(w * h * 8));
    heap.clear();
    const s = sj * w + si;
    dist[s] = 0;
    heap.push(s, 0);
    while (heap.size) {
      const [k, d] = heap.pop();
      if (d > dist[k]) continue;
      const ci = k % w, cj = (k - ci) / w;
      for (const [di, dj, c] of DIRS) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        const nk = nj * w + ni;
        if (grid[nk] !== 1) continue;
        if (di && dj && (grid[cj * w + ni] !== 1 || grid[nj * w + ci] !== 1)) continue;
        const nd = d + c;
        if (nd < dist[nk]) { dist[nk] = nd; heap.push(nk, nd); }
      }
    }
  }

  flowDist(x, z) {
    const i = this.i(x), j = this.j(z);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return Infinity;
    return this.dist[j * this.w + i] * this.cell;
  }

  // Direction (unit, written to out) following the distance field downhill.
  flowDir(x, z, out) {
    const { w, h, dist } = this;
    const grid = this.clear;
    const ci = this.i(x), cj = this.j(z);
    let best = Infinity, bi = -1, bj = -1;
    const here = ci >= 0 && cj >= 0 && ci < w && cj < h ? dist[cj * w + ci] : Infinity;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= w || nj >= h) continue;
        if (di && dj && (grid[cj * w + ni] !== 1 || grid[nj * w + ci] !== 1)) continue;
        const d = dist[nj * w + ni];
        if (d < best) { best = d; bi = ni; bj = nj; }
      }
    }
    if (bi < 0 || (best >= here && here !== Infinity)) { out.set(0, 0, 0); return false; }
    out.set(this.cx(bi) - x, 0, this.cz(bj) - z);
    const l = out.length();
    if (l > 1e-5) out.multiplyScalar(1 / l);
    return true;
  }
}

class MinHeap {
  constructor(cap) { this.k = new Int32Array(cap); this.v = new Float32Array(cap); this.size = 0; }
  clear() { this.size = 0; }
  push(k, v) {
    let i = this.size++;
    const K = this.k, V = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (V[p] <= v) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = k; V[i] = v;
  }
  pop() {
    const K = this.k, V = this.v;
    const rk = K[0], rv = V[0];
    const lk = K[--this.size], lv = V[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && V[c + 1] < V[c]) c++;
      if (V[c] >= lv) break;
      K[i] = K[c]; V[i] = V[c]; i = c;
    }
    K[i] = lk; V[i] = lv;
    return [rk, rv];
  }
}
