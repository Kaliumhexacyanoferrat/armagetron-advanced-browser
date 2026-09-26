// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The round as this browser sees it.
//
// Every cycle is simulated here with the same rules as on the server
// (sim.js), in the same fixed steps. Your own cycle is ahead of the server:
// it turns the moment you press a key and the server is told where. The
// others are what the server last said about them, simulated forward to now;
// a turn of theirs arrives a little late and puts them back on the corner.
// Deaths are the server's to decide: a cycle that looks like it crashed here
// just stops and waits for the verdict.

import { World, Cycle, DT, squareMap } from './sim.js';

const EPS = 1e-6;

export class Game {
  constructor(net) {
    this.net = net;
    this.you = -1;
    this.world = null;
    this.phase = 'idle';
    this.start = 0;
    this.round = 0;
    this.simTime = 0;
    this.names = new Map();     // cycle id -> { name, color }
    this.history = [];          // own states after each step: reconciling with the server
    this.explosions = [];
    this.listeners = {};
    this.visual = new Map();    // cycle id -> { ox, oy } smoothing offsets
  }

  on(name, fn) { (this.listeners[name] ??= []).push(fn); }
  emit(name, ...args) { for (const fn of this.listeners[name] ?? []) fn(...args); }

  get own() { return this.world?.cycles.get(this.you) ?? null; }

  // A snapshot: the start of a round, or what is going on when we join.
  load(s) {
    const sim = s.sim;
    this.settings = sim;
    this.map = squareMap(sim.sizeFactor);
    this.world = new World(this.map, sim);
    this.phase = s.phase;
    this.start = s.start;
    this.round = s.round;
    this.history = [];
    this.explosions = [];
    this.visual.clear();
    this.names.clear();

    for (const ci of s.cycles) {
      const c = new Cycle(ci.id, ci.x, ci.y, ci.dir, ci.time, sim);
      Object.assign(c, {
        v: ci.v, a: ci.a, lastTs: ci.lastTs, rubber: ci.rubber, brakeRes: ci.brakeRes, braking: ci.braking,
        dist: ci.dist, turns: ci.turns, lastTurnTime: ci.lastTurnTime, time: ci.time, rubberEff: ci.rubberEff ?? 1,
        alive: ci.alive, deathTime: ci.deathTime,
      });
      c.points = ci.points.map(([x, y, d, t]) => ({ x, y, d, t }));
      c.holes = ci.holes.map(([a, b]) => [a, b]);
      this.world.cycles.set(c.id, c);
      this.names.set(c.id, { name: ci.name, color: [ci.r / 15, ci.g / 15, ci.b / 15] });
      this.visual.set(c.id, { ox: 0, oy: 0 });
    }

    // everybody alive is at the same moment; that is where we go on from
    const alive = s.cycles.filter((c) => c.alive);
    this.simTime = alive.length ? Math.max(...alive.map((c) => c.time)) : Math.max(s.start, s.now);
    this.emit('load', s);
  }

  gridAfter(t) {
    return this.start + Math.floor((t - this.start) / DT + 1 + EPS) * DT;
  }

  // Simulates one cycle forward to time t, in steps on the common grid.
  catchUp(c, t) {
    let guard = 0;
    while (c.alive && !c.frozen && c.time < t - EPS && guard++ < 400) {
      const next = this.gridAfter(c.time);
      const dt = Math.min(next, t) - c.time;
      if (dt <= EPS) break;
      const deaths = this.world.step([c], dt, (cc, d) => this.queuedTurn(cc, d));
      for (const d of deaths) d.c.frozen = true;
    }
  }

  update(serverNow) {
    this.frameNow = serverNow;
    if (!this.world || this.phase === 'idle') return;
    if (serverNow <= this.start) return;
    if (this.phase === 'countdown') this.phase = 'playing';

    const target = this.start + Math.floor((serverNow - this.start) / DT + EPS) * DT;
    let steps = 0;

    while (this.simTime < target - EPS) {
      if (steps++ > 30) {
        // far behind (a hidden tab): jump, the syncs will sort it out
        this.simTime = target - DT;
      }
      const cycles = [];
      for (const c of this.world.cycles.values()) {
        if (!c.alive || c.frozen) continue;
        if (c.time < this.simTime - EPS) this.catchUp(c, this.simTime);
        if (Math.abs(c.time - this.simTime) < 1e-4) {
          c.time = this.simTime;
          cycles.push(c);
        }
      }
      const deaths = this.world.step(cycles, DT, (c, d) => this.queuedTurn(c, d));
      for (const d of deaths) d.c.frozen = true;
      this.simTime += DT;
      // cycles stepped on their own (catchUp) end up exactly on the grid too
      for (const c of cycles) if (c.alive && !c.frozen) c.time = this.simTime;

      const own = this.own;
      if (own && own.alive) {
        this.history.push(own.copyState());
        if (this.history.length > 120) this.history.shift();
      }
    }

    // smoothing offsets fade (CYCLE_SMOOTH_TIME .3)
    for (const v of this.visual.values()) {
      v.ox *= 0.9;
      v.oy *= 0.9;
    }
  }

  // Where to draw a cycle: its simulated position, a little ahead to the
  // exact moment, plus what is left of a correction being smoothed away.
  display(c, serverNow = this.frameNow) {
    // asked for again and again in a frame (walls, bike, tags, map, sound): worked out once
    const k = c.disp;
    if (k && k.now === serverNow && k.time === c.time && k.cx === c.x && k.cy === c.y && k.alive === c.alive && k.frozen === c.frozen) return k;
    let x = c.x, y = c.y;
    if (c.alive && !c.frozen && serverNow > c.time && !c.rubberActive) {
      const ahead = Math.min(serverNow - c.time, 2 * DT) * c.speed();
      x += c.dx * ahead;
      y += c.dy * ahead;
    }
    const v = this.visual.get(c.id);
    if (v && c.alive) {
      x += v.ox;
      y += v.oy;
    }
    const dist = c.dist + (c.alive && !c.frozen ? Math.min(Math.max(0, serverNow - c.time), 2 * DT) * c.speed() : 0);
    c.disp = { x, y, dist, now: serverNow, time: c.time, cx: c.x, cy: c.y, alive: c.alive, frozen: c.frozen };
    return c.disp;
  }

  // ---------------------------------------------------------------------
  // Your own input

  turn(d) {
    const c = this.own;
    if (!c || !c.alive || c.frozen || this.phase === 'idle') return;
    const now = this.net.serverNow();
    if (now < this.start - 1) return;          // ignored until the last second of the countdown
    if (this.world.requestTurn(c, d)) this.sendTurn(c, d);
  }

  queuedTurn(c, d) {
    if (c.id === this.you) this.sendTurn(c, d);
    else this.emit('turn', c, d);
  }

  sendTurn(c, d) {
    this.net.send({ t: 'turn', d, n: c.turns, dist: c.dist, x: c.x, y: c.y });
    this.emit('turn', c, d);
  }

  brake(on) {
    const c = this.own;
    if (!c || !c.alive || c.frozen || c.braking === on) return;
    this.world.setBrake(c, on);
    this.net.send({ t: 'brake', on });
  }

  // ---------------------------------------------------------------------
  // What the server says

  onTurn(m) {
    const c = this.world?.cycles.get(m.id);
    if (!c) return;

    if (m.id === this.you) {
      this.ownTurn(c, m);
      return;
    }

    if (m.n <= c.turns && c.points.length > m.n) {
      // we know this one; the server moved the corner a bit - take its word
      const p = c.points[m.n];
      p.x = m.x; p.y = m.y; p.d = m.d; p.t = m.time;
      return;
    }

    const before = this.display(c, this.net.serverNow());
    c.points.push({ x: m.x, y: m.y, d: m.d, t: m.time });
    c.x = m.x; c.y = m.y; c.dist = m.d; c.dir = m.dir;
    c.v = m.v; c.a = 0; c.lastTs = 0;
    c.turns = m.n; c.time = m.time; c.lastTurnTime = m.time;
    c.queue = [];
    c.frozen = false;
    this.catchUp(c, this.simTime);
    this.emit('turn', c, 0);
    void before;
  }

  ownTurn(c, m) {
    const p = c.points[m.n];
    if (p && Math.abs(p.x - m.x) + Math.abs(p.y - m.y) < 0.02) return;

    // the server turned somewhere else than we did (or when we did not): its word counts
    if (p) {
      p.x = m.x; p.y = m.y; p.d = m.d; p.t = m.time;
    } else {
      while (c.points.length < m.n) c.points.push({ ...c.points[c.points.length - 1] });
      c.points.push({ x: m.x, y: m.y, d: m.d, t: m.time });
      c.turns = m.n;
      c.dir = m.dir;
      c.lastTurnTime = Math.max(c.lastTurnTime, m.time);
    }
    if (c.turns === m.n) {
      const before = { x: c.x, y: c.y };
      const along = Math.max(0, c.dist - m.d);
      c.x = m.x + c.dx * along;
      c.y = m.y + c.dy * along;
      this.smooth(c, before);
      this.history = [];
    }
  }

  // A sync: [id, x, y, dir, v, a, lastTs, rubber, brakeRes, braking, dist, turns, frozen]
  onSync(m) {
    if (!this.world) return;
    for (const e of m.c) {
      const c = this.world.cycles.get(e[0]);
      if (!c || !c.alive) continue;
      if (c.id === this.you) this.reconcile(c, e, m.time);
      else this.follow(c, e, m.time);
    }
  }

  follow(c, e, time) {
    const [, x, y, dir, v, a, lastTs, rubber, brakeRes, braking, dist, turns, frozen] = e;
    if (turns !== c.turns) return;
    const before = { x: c.x, y: c.y };
    Object.assign(c, { x, y, dir, v, a, lastTs, rubber, brakeRes, braking: !!braking, dist, time });
    c.frozen = !!frozen;
    if (!c.frozen) this.catchUp(c, this.simTime);
    if (!c.frozen && c.time < this.simTime - EPS) c.time = this.simTime;
    this.smooth(c, before);
  }

  reconcile(c, e, time) {
    const [, x, y, dir, v, a, lastTs, rubber, brakeRes, braking, dist, turns, frozen] = e;

    if (c.frozen) {
      // we thought we had crashed; the server lets us drive on
      if (!frozen && dist > c.dist - 0.01 && turns >= c.turns) {
        Object.assign(c, { x, y, dir, v, a, lastTs, rubber, brakeRes, braking: !!braking, dist, turns, time, frozen: false });
        this.history = [];
        this.catchUp(c, this.simTime);
      }
      return;
    }

    // the server holds us at a crash, waiting for a turn of ours that may
    // still avoid it: nothing to correct (moving us there would carry us
    // through the wall and past the turn)
    if (frozen) return;

    const h = this.history.find((s) => Math.abs(s.time - time) < 1e-4);
    if (!h || h.turns !== turns) return;

    const errDist = dist - h.dist;
    const errV = v - h.v;
    const errR = rubber - h.rubber;
    const errB = brakeRes - h.brakeRes;
    const lateral = Math.abs((x - h.x) * -AXIS[h.dir][1] + (y - h.y) * AXIS[h.dir][0]);

    if (lateral > 0.05) {
      // the paths disagree: adopt the server's state and drive on from there
      const before = { x: c.x, y: c.y };
      Object.assign(c, { x, y, dir, v, a, lastTs, rubber, brakeRes, braking: !!braking, dist, turns, time });
      c.queue = [];
      this.history = [];
      this.catchUp(c, this.simTime);
      this.smooth(c, before);
      return;
    }

    if (Math.abs(errDist) < 0.003 && Math.abs(errV) < 0.02 && Math.abs(errR) < 0.01 && Math.abs(errB) < 0.01) return;

    const before = { x: c.x, y: c.y };
    if (c.turns === turns) {
      // a correction never carries us through a wall: that is the server's
      // to find out, and a turn sent from beyond it would come too late
      let move = errDist;
      if (move > 0) {
        const gap = this.settings.rubberMinDistance;
        const hit = this.world.ray(c.x, c.y, c.dx, c.dy, move + gap, c, c.time);
        if (hit) move = Math.max(0, hit.t - gap);
      }
      c.x += c.dx * move;
      c.y += c.dy * move;
      c.dist += move;
    }
    c.v += errV;
    c.rubber = Math.max(0, c.rubber + errR);
    c.brakeRes = Math.min(1, Math.max(0, c.brakeRes + errB));
    for (const s of this.history) {
      if (s.time < time - 1e-4) continue;
      if (s.turns === turns) {
        s.x += AXIS[s.dir][0] * errDist;
        s.y += AXIS[s.dir][1] * errDist;
        s.dist += errDist;
      }
      s.v += errV;
      s.rubber += errR;
      s.brakeRes += errB;
    }
    this.smooth(c, before);
  }

  // a correction moves the cycle; the eye sees it glide instead of jump
  smooth(c, before) {
    const v = this.visual.get(c.id);
    if (!v) return;
    const dx = before.x - c.x, dy = before.y - c.y;
    if (Math.abs(dx) + Math.abs(dy) > 8) {
      v.ox = v.oy = 0;
      return;
    }
    v.ox += dx;
    v.oy += dy;
  }

  onBrake(m) {
    const c = this.world?.cycles.get(m.id);
    if (!c || m.id === this.you) return;
    this.world.setBrake(c, m.on);
  }

  onDie(m) {
    const c = this.world?.cycles.get(m.id);
    if (!c) return;
    c.alive = false;
    c.frozen = false;
    c.x = m.x;
    c.y = m.y;
    c.deathTime = m.time;
    this.world.explode(m.x, m.y, this.settings.explosionRadius, m.time);
    const info = this.names.get(c.id);
    this.explosions.push({ x: m.x, y: m.y, time: m.time, color: info?.color ?? [1, 1, 1], rays: rays() });
    this.emit('die', c, m.killer);
  }
}

const AXIS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// gExplosion: nine fixed rays and 31 random ones, into the upper half sphere
function rays() {
  const list = [[0, 0, 1], [0, 1, 1], [0, -1, 1], [1, 0, 1], [-1, 0, 1], [1, 1, 1], [1, -1, 1], [-1, 1, 1], [-1, -1, 1]];
  for (let i = 0; i < 31; i++) list.push([7 * (Math.random() - 0.5), 7 * (Math.random() - 0.5), 1]);
  return list.map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  });
}
