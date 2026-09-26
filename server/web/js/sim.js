// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The light cycle rules, shared in spirit with the server (server/Sim.cs is a
// line-by-line port of this file - change both together).
//
// Numbers and formulas follow Armagetron Advanced's defaults (settings.cfg):
// src/tron/gCycleMovement.cpp for speed, wall acceleration, brake and rubber,
// src/tron/gCycle.cpp and gWall.cpp for walls and collisions. The world is the
// floor plane x/y; cycles drive along four axes and turn by 90 degrees.
//
// The simulation runs in fixed steps of 1/60 s on both sides, so a turn made
// in the browser happens at the same place on the server.

export const RATE = 60;
export const DT = 1 / RATE;

// counter-clockwise: a left turn is +1, a right turn -1
export const AXES = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export const DEFAULTS = {
  speed: 20,            // CYCLE_SPEED
  speedMin: 0.25,       // CYCLE_SPEED_MIN, ratio of speed
  startSpeed: 20,       // CYCLE_START_SPEED
  decayBelow: 5,        // CYCLE_SPEED_DECAY_BELOW
  decayAbove: 0.1,      // CYCLE_SPEED_DECAY_ABOVE
  accel: 15,            // CYCLE_ACCEL
  accelOffset: 2,       // CYCLE_ACCEL_OFFSET
  wallNear: 6,          // CYCLE_WALL_NEAR
  accelSelf: 1, accelEnemy: 1, accelRim: 0,
  brake: 30,            // CYCLE_BRAKE
  brakeRefill: 0.1,     // CYCLE_BRAKE_REFILL
  brakeDeplete: 1,      // CYCLE_BRAKE_DEPLETE
  delay: 0.1,           // CYCLE_DELAY
  turnSpeedFactor: 0.95,// CYCLE_TURN_SPEED_FACTOR
  turnMemory: 3,        // CYCLE_TURN_MEMORY
  rubber: 1,            // CYCLE_RUBBER
  rubberSpeed: 40,      // CYCLE_RUBBER_SPEED
  rubberTime: 10,       // CYCLE_RUBBER_TIME
  rubberMinDistance: 0.005,
  pingRubber: 3,        // CYCLE_PING_RUBBER: rubber lasts longer by (rubber + ping * this) / rubber
  wallsLength: -1,      // WALLS_LENGTH, -1 infinite
  wallsStayUp: 8,       // WALLS_STAY_UP_DELAY (dedicated server value)
  explosionRadius: 4,   // EXPLOSION_RADIUS
  sizeFactor: -3,       // SIZE_FACTOR
};

export function sizeMultiplier(sizeFactor) {
  return Math.pow(2, sizeFactor / 2);
}

// The original square map (Anonymous/polygon/regular/square-1.0.1): a 500 x 500
// rim and twelve spawn points, scaled by the size factor.
export function squareMap(sizeFactor) {
  const m = sizeMultiplier(sizeFactor);
  const spawns = [
    [255, 50, 1], [245, 450, 3], [50, 245, 0], [450, 255, 2],
    [305, 100, 1], [195, 400, 3], [100, 195, 0], [400, 305, 2],
    [205, 100, 1], [295, 400, 3], [100, 295, 0], [400, 205, 2],
  ].map(([x, y, dir]) => ({ x: x * m, y: y * m, dir }));
  const s = 500 * m;
  const rim = [[0, 0], [0, s], [s, s], [s, 0], [0, 0]];
  return { size: s, spawns, rim };
}

// ---------------------------------------------------------------------------
// Walls

// A cycle's trail: the points where it started and turned; the last segment
// runs from the last point to the cycle itself. d is the distance the cycle
// had driven at the point, t the time it was there. holes are [d0, d1]
// stretches blown away by explosions.

export class Cycle {
  constructor(id, x, y, dir, time, settings) {
    const s = settings;
    this.id = id;
    this.x = x; this.y = y;
    this.dir = dir;
    this.v = s.startSpeed;
    this.a = 0;
    this.lastTs = 0;          // verlet: the previous step's length
    this.rubber = 0;          // rubber used, 0 .. settings.rubber
    this.rubberEff = 1;       // how far one unit of rubber goes (more for a higher ping)
    this.brakeRes = 1;        // brake reservoir, 0 .. 1
    this.braking = false;
    this.dist = 0;
    this.turns = 0;
    this.lastTurnTime = time - 10;
    this.queue = [];
    this.alive = true;
    this.deathTime = 0;
    this.points = [{ x, y, d: 0, t: time }];
    this.holes = [];
    this.influence = null;    // { id, time }: whose wall pressed us last, for kill credit
    this.time = time;
  }

  get dx() { return AXES[this.dir][0]; }
  get dy() { return AXES[this.dir][1]; }

  // Speed() of the original: the verlet speed half a step ahead
  speed() { return Math.max(0, this.v + 0.5 * this.lastTs * this.a); }

  accelerationDiscontinuity() {
    this.v = this.speed();
    this.lastTs = 0;
  }

  copyState() {
    return {
      x: this.x, y: this.y, dir: this.dir, v: this.v, a: this.a, lastTs: this.lastTs,
      rubber: this.rubber, brakeRes: this.brakeRes, braking: this.braking,
      dist: this.dist, turns: this.turns, lastTurnTime: this.lastTurnTime, time: this.time,
    };
  }

  setState(s) {
    Object.assign(this, s);
  }
}

// ---------------------------------------------------------------------------
// The world: rim walls and every cycle's trail.

export class World {
  constructor(map, settings) {
    this.map = map;
    this.s = settings;
    this.cycles = new Map();
    this.rim = [];
    for (let i = 0; i + 1 < map.rim.length; i++) {
      const [x0, y0] = map.rim[i], [x1, y1] = map.rim[i + 1];
      this.rim.push({ x0, y0, x1, y1 });
    }
  }

  // Is the wall point at distance d on cycle c's trail dangerous at time t?
  // Holes, the far end of finite trails, and walls that went down are not.
  wallDangerous(c, d, t) {
    if (!c.alive && t > c.deathTime + this.s.wallsStayUp + 0.2 && this.s.wallsStayUp >= 0) return false;
    if (this.s.wallsLength > 0 && d + this.s.wallsLength < c.dist) return false;
    for (const h of c.holes) if (d >= h[0] && d <= h[1]) return false;
    return true;
  }

  // Cast a ray from (ox, oy) along (rx, ry) up to parameter maxT. Walls laid
  // after time do not count yet: a cycle simulated again from the past (a late
  // turn, catching up after a correction) only meets the walls that were
  // there then. Returns the
  // closest dangerous wall: { t, owner (a Cycle, or null for the rim),
  // wx, wy (wall direction, not normalised), wd (distance on the owner's
  // trail), wt (time it was laid) } or null. Skips cycle self's current and
  // previous segment, like the original's EdgeIsDangerous.
  ray(ox, oy, rx, ry, maxT, self, time) {
    let best = null, bestT = maxT;
    for (const r of this.rim) {
      if (intersect(ox, oy, rx, ry, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0) && hitT >= 0 && hitT < bestT) {
        bestT = hitT;
        best = { t: hitT, owner: null, wx: r.x1 - r.x0, wy: r.y1 - r.y0, wd: 0, wt: -1e9 };
      }
    }
    // the box the ray can reach: walls outside it are skipped without the maths
    const ex = rx * maxT, ey = ry * maxT;
    const x0 = Math.min(ox, ox + ex) - 1e-6, x1 = Math.max(ox, ox + ex) + 1e-6;
    const y0 = Math.min(oy, oy + ey) - 1e-6, y1 = Math.max(oy, oy + ey) + 1e-6;
    const s = this.s;
    for (const c of this.cycles.values()) {
      // a trail that went down: nothing of it is dangerous any more
      if (!c.alive && s.wallsStayUp >= 0 && time > c.deathTime + s.wallsStayUp + 0.2) continue;
      const pts = c.points, n = pts.length;
      for (let i = 0; i < n; i++) {
        // skip own current (i = n-1) and previous (i = n-2) segment
        if (c === self && i >= n - 2) continue;
        const p = pts[i];
        const last = i + 1 >= n;
        const qx = last ? c.x : pts[i + 1].x, qy = last ? c.y : pts[i + 1].y;
        if ((p.x < x0 && qx < x0) || (p.x > x1 && qx > x1) || (p.y < y0 && qy < y0) || (p.y > y1 && qy > y1)) continue;
        const sx = qx - p.x, sy = qy - p.y;
        if (sx === 0 && sy === 0) continue;
        if (!intersect(ox, oy, rx, ry, p.x, p.y, sx, sy) || hitT < 0 || hitT >= bestT) continue;
        const qt = last ? c.time : pts[i + 1].t;
        const wt = p.t + (qt - p.t) * hitU;
        if (wt > time + 1e-9) continue;
        const qd = last ? c.dist : pts[i + 1].d;
        const d = p.d + (qd - p.d) * hitU;
        if (!this.wallDangerous(c, d, time)) continue;
        bestT = hitT;
        best = { t: hitT, owner: c, wx: sx, wy: sy, wd: d, wt };
      }
    }
    return best;
  }

  // Wall acceleration (CalculateAcceleration): a 45 degree ray backwards to
  // each side; a parallel wall at perpendicular distance h pulls the cycle
  // forward by accel * (1/(h+offset) - 1/(near+offset)).
  wallAcceleration(c, time) {
    const s = this.s;
    let acc = 0;
    const dx = c.dx, dy = c.dy;
    for (let side = 1; side >= -1; side -= 2) {
      // left of (dx, dy) is (-dy, dx)
      const rx = -dx - side * dy, ry = -dy + side * dx;
      const hit = this.ray(c.x, c.y, rx, ry, s.wallNear, c, time);
      if (!hit) continue;
      if (Math.abs(hit.wx * dx + hit.wy * dy) <= 0.9) continue;
      const h = hit.t;
      let factor;
      if (!hit.owner) factor = s.accelRim;
      else if (hit.owner === c) factor = s.accelSelf;
      else factor = s.accelEnemy;
      if (hit.owner && hit.owner !== c) this.influence(c, hit.owner, hit.wt - h / Math.max(c.v, 1));
      acc += factor * s.accel * (1 / (h + s.accelOffset) - 1 / (s.wallNear + s.accelOffset));
    }
    return acc;
  }

  influence(c, owner, time) {
    if (!c.influence || time > c.influence.time) c.influence = { id: owner.id, time };
  }

  // A turn: -1 right, +1 left. Queued if the last turn was too recent.
  requestTurn(c, d) {
    if (!c.alive) return;
    if (c.queue.length === 0 && c.time >= c.lastTurnTime + this.s.delay - 1e-6) {
      this.turn(c, d);
      return true;
    }
    const q = c.queue;
    if (q.length <= this.s.turnMemory) q.push(d);
    else if (q[q.length - 1] === -d) q.pop();
    else q.push(d);
    return false;
  }

  turn(c, d) {
    c.accelerationDiscontinuity();
    c.v *= this.s.turnSpeedFactor;
    c.dir = (c.dir + d + 4) % 4;
    c.turns++;
    c.lastTurnTime = c.time;
    c.points.push({ x: c.x, y: c.y, d: c.dist, t: c.time });
  }

  setBrake(c, on) {
    if (c.braking === on) return;
    c.accelerationDiscontinuity();
    c.braking = on;
  }

  // Phase one of a step: speed and brake, then how far the cycle wants to go,
  // held back by rubber in front of a wall. Returns the step length.
  prepare(c, dt, onTurn) {
    const s = this.s;
    if (c.queue.length && c.time >= c.lastTurnTime + s.delay - 1e-6) {
      const d = c.queue.shift();
      this.turn(c, d);
      if (onTurn) onTurn(c, d);
    }

    const base = s.speed;
    let a = 0;
    const braking = c.braking && c.brakeRes > 0;
    if (braking) a -= s.brake;
    a += (base - c.v) * (c.v <= base ? s.decayBelow : s.decayAbove);
    a += this.wallAcceleration(c, c.time);

    const verletDt = 0.5 * (dt + c.lastTs);
    c.lastTs = dt;
    c.v += a * verletDt;
    c.a = a;
    if (c.v < base * s.speedMin) { c.v = base * s.speedMin; c.a = 0; }

    if (braking) c.brakeRes = Math.max(0, c.brakeRes - s.brakeDeplete * dt);
    else if (c.brakeRes < 1) c.brakeRes = Math.min(1, c.brakeRes + s.brakeRefill * dt);

    let step = c.v * dt;
    c.rubberActive = false;

    // rubber: close in on a wall ahead exponentially instead of hitting it
    if (s.rubber > c.rubber && s.rubberSpeed > 0) {
      const beta = dt * s.rubberSpeed;
      const factor = Math.min(0.999, beta > 0.001 ? 1 - Math.exp(-beta) : beta);
      const needed = Math.max(step / factor, 3 * step);
      const hit = this.ray(c.x, c.y, c.dx, c.dy, needed + s.rubberMinDistance, c, c.time);
      if (hit) {
        const space = hit.t - s.rubberMinDistance;
        if (hit.owner && hit.owner !== c) this.influence(c, hit.owner, hit.wt - hit.t / Math.max(c.v, 1));
        if (space < needed) {
          c.rubberActive = true;
          const rubberStep = Math.min(step, Math.max(0, space) * factor);
          const use = step - rubberStep;
          const available = (s.rubber - c.rubber) * c.rubberEff;
          if (use <= available) {
            c.rubber += use / c.rubberEff;
            step = rubberStep;
          } else {
            // out of rubber: the rest of the step goes into the wall
            c.rubber = s.rubber;
            step = rubberStep + (use - available);
          }
        }
      }
    }
    return step;
  }

  // Phase two: where does the move from the cycle's position cross a
  // dangerous wall, if anywhere? Moves of other cycles in the same step count
  // if they got to the crossing first (the original's "who was first" rule).
  collide(c, step, moves) {
    if (step <= 0) return null;
    const dx = c.dx, dy = c.dy;
    let hit = this.ray(c.x, c.y, dx, dy, step, c, c.time);
    let at = hit ? hit.t : Infinity;
    let owner = hit ? hit.owner : null;
    let wt = hit ? hit.wt : 0;
    for (const m of moves) {
      if (m.c === c || m.step <= 0) continue;
      const o = m.c;
      if (!intersect(c.x, c.y, dx, dy, o.x, o.y, o.dx * m.step, o.dy * m.step) || hitT < 0 || hitT >= at) continue;
      // they were there first if they reached the crossing earlier in the step
      if (hitU < hitT / step) {
        at = hitT;
        owner = o;
        wt = o.time + hitU * m.dt;
      }
    }
    return at <= step ? { t: at, owner, wt } : null;
  }

  // Phase three: move, or die at the wall. A wall found only now (another
  // cycle's move in this very step) is still survived if the rubber covers it.
  advance(c, step, dt, hit) {
    const s = this.s;
    if (hit) {
      const back = Math.max(0, hit.t - s.rubberMinDistance);
      const over = step - back;
      if (over <= (s.rubber - c.rubber) * c.rubberEff) {
        c.rubber += over / c.rubberEff;
        step = back;
      } else {
        const frac = step > 0 ? hit.t / step : 0;
        this.move(c, hit.t, dt * frac);
        if (hit.owner && hit.owner !== c) this.influence(c, hit.owner, hit.wt);
        return { dead: true, owner: hit.owner };
      }
    }
    this.move(c, step, dt);
    if (c.rubber > s.rubber) return { dead: true, owner: null };
    c.rubber /= 1 + dt / s.rubberTime;
    return null;
  }

  move(c, step, dt) {
    c.x += c.dx * step;
    c.y += c.dy * step;
    c.dist += step;
    c.time += dt;
  }

  // One step of length dt for a set of cycles, all three phases. Returns
  // who died: [{ c, owner }], with c.time set to the moment of death.
  step(cycles, dt, onTurn) {
    const moves = [];
    for (const c of cycles) {
      if (!c.alive || c.frozen) continue;
      moves.push({ c, step: this.prepare(c, dt, onTurn), dt });
    }
    const hits = moves.map((m) => this.collide(m.c, m.step, moves));
    const deaths = [];
    moves.forEach((m, i) => {
      const r = this.advance(m.c, m.step, dt, hits[i]);
      if (r && r.dead) deaths.push({ c: m.c, owner: r.owner });
    });
    return deaths;
  }

  // The explosion of a dying cycle blows a hole of the given radius into every
  // player wall around it (gExplosion). Only walls laid before it count.
  explode(x, y, radius, time) {
    for (const c of this.cycles.values()) {
      const pts = c.points, n = pts.length;
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const q = i + 1 < n ? pts[i + 1] : c;
        const qd = i + 1 < n ? q.d : c.dist;
        const len = qd - p.d;
        if (len <= 0) continue;
        const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
        const along = (x - p.x) * ux + (y - p.y) * uy;
        const perp = Math.abs((x - p.x) * uy - (y - p.y) * ux);
        if (perp >= radius) continue;
        const half = Math.sqrt(radius * radius - perp * perp);
        const a = Math.max(0, along - half), b = Math.min(len, along + half);
        if (a >= b) continue;
        addHole(c.holes, p.d + a, p.d + b);
      }
    }
  }
}

function addHole(holes, a, b) {
  holes.push([a, b]);
  holes.sort((u, v) => u[0] - v[0]);
  for (let i = 0; i + 1 < holes.length;) {
    if (holes[i + 1][0] <= holes[i][1]) {
      holes[i][1] = Math.max(holes[i][1], holes[i + 1][1]);
      holes.splice(i + 1, 1);
    } else i++;
  }
}

// Ray/segment intersection: point o + t * r against segment p + u * s,
// u in [0, 1]. True on a hit, with t and u in hitT and hitU (no garbage: this
// runs thousands of times a frame).
let hitT = 0, hitU = 0;

export function intersect(ox, oy, rx, ry, px, py, sx, sy) {
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return false;
  const qx = px - ox, qy = py - oy;
  const u = (qx * ry - qy * rx) / den;
  if (u < 0 || u > 1) return false;
  hitT = (qx * sy - qy * sx) / den;
  hitU = u;
  return true;
}
