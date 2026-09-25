// Sound as in src/engine/eSoundMixer.cpp and gCycle.cpp: every cycle has its
// engine running, pitched by its speed (1.0 at CYCLE_SOUND_SPEED 20) with a
// little doppler, panned and quieter with distance; turns, explosions and
// the countdown voices on top. Music plays from the lambda's workspace.

const FILES = {
  engine: 'snd/cyclrun.ogg',
  turn: 'snd/cycle_turn.ogg',
  explosion: 'snd/expl.ogg',
  three: 'snd/3voicemale.ogg',
  two: 'snd/2voicemale.ogg',
  one: 'snd/1voicemale.ogg',
  go: 'snd/announcerGO.ogg',
};

export class Audio {
  constructor(prefs) {
    this.prefs = prefs;
    this.ctx = null;
    this.buffers = {};
    this.engines = new Map();
    this.music = null;
    this.track = null;
  }

  // browsers only start sound after a click or key press
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.effects = this.ctx.createGain();
    this.effects.connect(this.master);
    this.engineBus = this.ctx.createGain();
    this.engineBus.connect(this.master);
    this.volume();
    for (const [name, url] of Object.entries(FILES)) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx.decodeAudioData(b))
        .then((buffer) => { this.buffers[name] = buffer; })
        .catch(() => { /* a browser without ogg vorbis stays silent */ });
    }
  }

  volume() {
    if (this.ctx) {
      this.master.gain.value = this.prefs.mute ? 0 : this.prefs.volume;
      this.effects.gain.value = 50 / 128;
    }
    if (this.music) this.music.volume = this.prefs.mute ? 0 : this.prefs.music * 0.5;
  }

  play(name, gain = 1, pan = 0) {
    const buffer = this.buffers[name];
    if (!this.ctx || !buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    let node = g;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      node = p;
    }
    node.connect(this.effects);
    src.connect(g);
    src.start();
  }

  // gain and pan of a sound at (x, y) for the camera
  place(camera, x, y) {
    const ex = camera.eye[0], ey = camera.eye[1];
    const dx = x - ex, dy = y - ey;
    const dist = Math.hypot(dx, dy, camera.eye[2]);
    const fx = camera.target[0] - ex, fy = camera.target[1] - ey;
    const fl = Math.hypot(fx, fy) || 1;
    // right of the view direction is (fy, -fx)
    const lateral = (dx * fy - dy * fx) / fl;
    const R = 4 + 0.2 * Math.hypot(ex - (camera.focus?.x ?? ex), ey - (camera.focus?.y ?? ey));
    return { gain: R / (R + dist), pan: dist > 0.1 ? lateral / (dist + 1) : 0, dist, dx, dy };
  }

  positional(name, camera, x, y, boost = 1) {
    const { gain, pan } = this.place(camera, x, y);
    this.play(name, Math.min(1, gain * boost), pan);
  }

  // one looping engine per living cycle
  engines_(cycles, camera, ownId, dt) {
    if (!this.ctx || !this.buffers.engine) return;
    const seen = new Set();
    let total = 0;
    const list = [];
    for (const c of cycles) {
      seen.add(c.id);
      let e = this.engines.get(c.id);
      if (!e) {
        const src = this.ctx.createBufferSource();
        src.buffer = this.buffers.engine;
        src.loop = true;
        const g = this.ctx.createGain();
        g.gain.value = 0;
        const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
        src.connect(g);
        if (p) { g.connect(p); p.connect(this.engineBus); } else g.connect(this.engineBus);
        src.start(0, Math.random() * this.buffers.engine.duration);
        e = { src, g, p, prevDist: null };
        this.engines.set(c.id, e);
      }
      const place = this.place(camera, c.x, c.y);
      // doppler from how fast the distance changes
      const approach = e.prevDist === null || dt <= 0 ? 0 : (e.prevDist - place.dist) / dt;
      e.prevDist = place.dist;
      const p = (0.1 * approach) / 15 / (4 + place.dist) * 4;
      const doppler = p > 0 ? 1 + Math.min(p, 0.5) : 1 / (1 - Math.max(p, -0.5));
      const rate = Math.max(0.2, Math.min(4, (doppler * c.speed) / (20 * (this.speedMultiplier ?? 1))));
      let gain = Math.min(0.4, place.gain) * (c.id === ownId ? 0.6 : 1);
      if (c.frozen) gain *= 0.3;
      total += gain;
      list.push({ e, gain, rate, pan: place.pan });
    }
    const norm = total > 1 ? 1 / Math.sqrt(total) : 1;
    const t = this.ctx.currentTime;
    for (const { e, gain, rate, pan } of list) {
      e.g.gain.setTargetAtTime(gain * norm * 0.5, t, 0.05);
      e.src.playbackRate.setTargetAtTime(rate, t, 0.03);
      if (e.p) e.p.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.05);
    }
    for (const [id, e] of this.engines) {
      if (!seen.has(id)) {
        e.g.gain.setTargetAtTime(0, t, 0.05);
        e.src.stop(t + 0.3);
        this.engines.delete(id);
      }
    }
  }

  silence() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const e of this.engines.values()) {
      e.g.gain.setTargetAtTime(0, t, 0.05);
      e.src.stop(t + 0.3);
    }
    this.engines.clear();
  }

  // music: the title track in the lobby, the game tracks while playing
  playMusic(kind) {
    if (this.track === kind) return;
    this.track = kind;
    if (this.music) {
      this.music.pause();
      this.music = null;
    }
    if (!this.prefs.music || !kind) return;
    const lists = { title: ['media/titletrack.ogg'], game: ['media/fortresswalk.ogg', 'media/doIknowyou.ogg', 'media/when.ogg'] };
    const list = lists[kind];
    let i = kind === 'game' ? Math.floor(Math.random() * list.length) : 0;
    const start = () => {
      const a = new window.Audio(list[i % list.length]);
      a.volume = this.prefs.mute ? 0 : this.prefs.music * 0.5;
      a.addEventListener('ended', () => {
        i++;
        if (this.music === a) start();
      });
      a.addEventListener('error', () => { if (this.music === a) this.music = null; });
      this.music = a;
      a.play().catch(() => {});
    };
    start();
  }
}
