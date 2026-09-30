// All sound is synthesized with WebAudio — no audio files needed.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.last = {};
    this.volume = 0.7;
  }

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    this.ctx = new C();
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    comp.connect(this.ctx.destination);
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(comp);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
  }

  setMuted(m) { if (this.master) this.master.gain.value = m ? 0 : this.volume; }

  ok(key, ms) {
    if (!this.ctx) return false;
    const t = performance.now();
    if (this.last[key] && t - this.last[key] < ms) return false;
    this.last[key] = t;
    return true;
  }

  env(gainNode, t, attack, dur, peak) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  noiseHit({ dur = 0.2, freq = 1000, freqEnd, q = 0.8, type = 'lowpass', gain = 0.5, attack = 0.002, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    const g = c.createGain();
    this.env(g, t, attack, dur, gain);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  tone({ type = 'sine', f0 = 440, f1, dur = 0.2, gain = 0.3, attack = 0.005, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    this.env(g, t, attack, dur, gain);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  shot(w) {
    if (!this.ctx) return;
    const cat = w.type || w.cat;
    const gap = w.rpm > 900 ? 55 : 0;
    if (!this.ok('shot', gap)) return;
    switch (cat) {
      case 'pistol':
        this.noiseHit({ dur: 0.16, freq: 2600, freqEnd: 400, gain: 0.45 });
        this.tone({ type: 'square', f0: 180, f1: 60, dur: 0.08, gain: 0.15 });
        break;
      case 'smg':
        this.noiseHit({ dur: 0.1, freq: 3000, freqEnd: 600, gain: 0.35 });
        break;
      case 'shotgun':
        this.noiseHit({ dur: 0.35, freq: 1800, freqEnd: 150, gain: 0.8 });
        this.tone({ type: 'sine', f0: 110, f1: 40, dur: 0.25, gain: 0.5 });
        break;
      case 'rifle': case 'lmg': case 'hitscan':
        this.noiseHit({ dur: 0.18, freq: 2200, freqEnd: 300, gain: 0.5 });
        this.tone({ type: 'sawtooth', f0: 140, f1: 50, dur: 0.1, gain: 0.18 });
        break;
      case 'sniper':
        this.noiseHit({ dur: 0.6, freq: 1600, freqEnd: 90, gain: 0.9 });
        this.tone({ type: 'sine', f0: 90, f1: 30, dur: 0.5, gain: 0.6 });
        break;
      case 'flame':
        if (this.ok('flame', 90)) this.noiseHit({ dur: 0.22, freq: 700, type: 'bandpass', q: 0.6, gain: 0.35, attack: 0.03 });
        break;
      case 'tesla':
        this.tone({ type: 'sawtooth', f0: 1400, f1: 200, dur: 0.12, gain: 0.18 });
        this.noiseHit({ dur: 0.1, freq: 5000, type: 'highpass', gain: 0.25 });
        break;
      case 'beam':
        if (w.dmg > 300) {
          this.tone({ type: 'sawtooth', f0: 2400, f1: 80, dur: 0.7, gain: 0.35 });
          this.noiseHit({ dur: 0.4, freq: 900, freqEnd: 100, gain: 0.6 });
        } else this.tone({ type: 'square', f0: 1800, f1: 600, dur: 0.09, gain: 0.12 });
        break;
      case 'rocket':
        this.noiseHit({ dur: 0.5, freq: 900, freqEnd: 200, gain: 0.6, attack: 0.02 });
        break;
      default:
        this.noiseHit({ dur: 0.15, freq: 2500, freqEnd: 400, gain: 0.4 });
    }
  }

  explosion(big = 1) {
    if (!this.ok('boom', 40)) return;
    this.noiseHit({ dur: 1.2 * big, freq: 1200, freqEnd: 40, gain: 1.0 });
    this.tone({ type: 'sine', f0: 70, f1: 25, dur: 0.9, gain: 0.8 });
  }
  hit() { if (this.ok('hit', 40)) this.noiseHit({ dur: 0.06, freq: 900, type: 'bandpass', q: 2, gain: 0.25 }); }
  groan(pitch = 1) {
    if (!this.ok('groan', 700)) return;
    const f = (70 + Math.random() * 40) * pitch;
    this.tone({ type: 'sawtooth', f0: f, f1: f * 0.6, dur: 0.9, gain: 0.12, attack: 0.15 });
    this.tone({ type: 'sawtooth', f0: f * 1.02, f1: f * 0.55, dur: 0.9, gain: 0.08, attack: 0.2 });
  }
  enemyDie(pitch = 1) {
    if (!this.ok('die', 60)) return;
    this.tone({ type: 'sawtooth', f0: 220 * pitch, f1: 50, dur: 0.5, gain: 0.18 });
    this.noiseHit({ dur: 0.25, freq: 600, type: 'bandpass', gain: 0.3 });
  }
  swing() { if (this.ok('swing', 80)) this.noiseHit({ dur: 0.18, freq: 500, freqEnd: 2000, type: 'bandpass', q: 1.5, gain: 0.2, attack: 0.05 }); }
  coin() {
    if (!this.ok('coin', 50)) return;
    this.tone({ type: 'triangle', f0: 1318, dur: 0.08, gain: 0.12 });
    this.tone({ type: 'triangle', f0: 1760, dur: 0.14, gain: 0.12, delay: 0.06 });
  }
  buy() {
    if (!this.ctx) return;
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ type: 'triangle', f0: f, dur: 0.12, gain: 0.15, delay: i * 0.05 }));
  }
  error() { if (this.ctx) this.tone({ type: 'square', f0: 140, dur: 0.18, gain: 0.12 }); }
  click() { if (this.ctx) this.tone({ type: 'triangle', f0: 900, dur: 0.04, gain: 0.08 }); }
  reload() {
    if (!this.ctx) return;
    this.noiseHit({ dur: 0.05, freq: 3000, type: 'bandpass', q: 3, gain: 0.3 });
    this.noiseHit({ dur: 0.06, freq: 2000, type: 'bandpass', q: 3, gain: 0.3, delay: 0.25 });
  }
  empty() { if (this.ok('empty', 200)) this.tone({ type: 'square', f0: 1200, dur: 0.03, gain: 0.1 }); }
  hurt() {
    if (!this.ok('hurt', 180)) return;
    this.noiseHit({ dur: 0.2, freq: 400, type: 'lowpass', gain: 0.5 });
    this.tone({ type: 'sine', f0: 160, f1: 80, dur: 0.2, gain: 0.3 });
  }
  heartbeat() {
    if (!this.ctx) return;
    this.tone({ type: 'sine', f0: 60, f1: 40, dur: 0.15, gain: 0.5 });
    this.tone({ type: 'sine', f0: 55, f1: 38, dur: 0.15, gain: 0.4, delay: 0.22 });
  }
  siren() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) this.tone({ type: 'sawtooth', f0: 300, f1: 600, dur: 0.6, gain: 0.12, delay: i * 0.65, attack: 0.1 });
  }
  waveClear() {
    if (!this.ctx) return;
    [392, 523, 659, 784].forEach((f, i) => this.tone({ type: 'sine', f0: f, dur: 0.5, gain: 0.14, delay: i * 0.12 }));
  }
  downed() {
    if (!this.ctx) return;
    this.tone({ type: 'sawtooth', f0: 300, f1: 60, dur: 1.2, gain: 0.25 });
    this.noiseHit({ dur: 0.5, freq: 300, gain: 0.5 });
  }
  revive() {
    if (!this.ctx) return;
    [330, 440, 554, 660, 880].forEach((f, i) => this.tone({ type: 'sine', f0: f, dur: 0.3, gain: 0.15, delay: i * 0.07 }));
  }
  throwIt() { if (this.ctx) this.noiseHit({ dur: 0.2, freq: 800, freqEnd: 2500, type: 'bandpass', gain: 0.2, attack: 0.04 }); }
  spawn() { if (this.ok('spawn', 250)) this.tone({ type: 'sine', f0: 50, f1: 35, dur: 0.8, gain: 0.25, attack: 0.1 }); }

  startAmbience() {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = 0.05;
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 220;
    [41, 41.6, 61.8].forEach((hz) => {
      const o = c.createOscillator();
      o.type = 'sawtooth'; o.frequency.value = hz;
      o.connect(f); o.start();
    });
    const n = c.createBufferSource();
    n.buffer = this.noise; n.loop = true;
    const nf = c.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 500; nf.Q.value = 0.7;
    const ng = c.createGain(); ng.gain.value = 0.25;
    n.connect(nf); nf.connect(ng); ng.connect(f); n.start();
    const lfo = c.createOscillator(); lfo.frequency.value = 0.07;
    const lg = c.createGain(); lg.gain.value = 120;
    lfo.connect(lg); lg.connect(f.frequency); lfo.start();
    f.connect(g); g.connect(this.master);
  }
}
