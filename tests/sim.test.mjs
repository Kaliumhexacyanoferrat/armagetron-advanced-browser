// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Plain node checks of the shared rules: node tests/sim.test.mjs
import { World, Cycle, DEFAULTS, squareMap, DT } from '../server/web/js/sim.js';
import assert from 'node:assert';

const s = { ...DEFAULTS };
const map = squareMap(s.sizeFactor);

function run(world, cycles, seconds, each) {
  const deaths = [];
  for (let i = 0; i < seconds * 60; i++) {
    for (const c of cycles) if (c.alive) c.time = i * DT;
    each?.(i);
    for (const d of world.step(cycles, DT)) { d.c.alive = false; d.c.deathTime = d.c.time; deaths.push(d); }
  }
  return deaths;
}

// 1. straight into the rim: dies near the wall, a few moments after arriving
{
  const w = new World(map, s);
  const c = new Cycle(1, 90, 17.7, 1, 0, s); w.cycles.set(1, c);
  const deaths = run(w, [c], 12);
  assert.equal(deaths.length, 1);
  console.log('rim death at y', c.y.toFixed(4), 'time', c.time.toFixed(3), 'of size', map.size.toFixed(2), 'speed', c.v.toFixed(2));
  assert(Math.abs(c.y - map.size) < 0.05);
}

// 2. grinding along the rim at 0.5 m: speeds up
{
  const w = new World(map, s);
  s.accelRim = 1;
  const c = new Cycle(1, 0.5, 10, 1, 0, s); w.cycles.set(1, c);
  run(w, [c], 3);
  console.log('grind speed after 3 s at 0.5 m (rim accel on):', c.v.toFixed(2));
  assert(c.v > 20);
  s.accelRim = 0;
}

// 3. a 180 turn: two left turns 0.1 s apart leaves ~1.9 m between the lanes, then the own wall accelerates
{
  const w = new World(map, s);
  const c = new Cycle(1, 88, 17.7, 1, 0, s); w.cycles.set(1, c);
  run(w, [c], 2.5, (i) => { if (i === 60) { w.requestTurn(c, 1); w.requestTurn(c, 1); } });
  console.log('after 180: x', c.x.toFixed(3), 'lane gap', (88 - c.x).toFixed(3), 'dir', c.dir, 'speed', c.v.toFixed(2), 'alive', c.alive);
  assert(c.alive && c.dir === 3 && c.v > 20);
}

// 4. brake: settles near 14 m/s and the reservoir lasts a second
{
  const w = new World(map, s);
  const c = new Cycle(1, 88, 17.7, 1, 0, s); w.cycles.set(1, c);
  w.setBrake(c, true);
  run(w, [c], 0.9);
  console.log('braking 0.9 s: speed', c.v.toFixed(2), 'reservoir', c.brakeRes.toFixed(2));
  assert(c.v < 16);
}

// 5. two cycles crossing: the later one dies, killed by the first
{
  const w = new World(map, s);
  const a = new Cycle(1, 50, 40, 0, 0, s); w.cycles.set(1, a);  // east along y = 40
  const b = new Cycle(2, 70, 20, 1, 0, s); w.cycles.set(2, b);  // north along x = 70, arrives later
  const deaths = run(w, [a, b], 3);
  console.log('crossing:', deaths.map((d) => `${d.c.id} killed by ${d.owner?.id}`).join(', '));
  assert.equal(deaths[0].c.id, 2);
  assert.equal(deaths[0].owner.id, 1);
}
console.log('ok');
