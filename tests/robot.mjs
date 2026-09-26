// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// A headless player for finding deaths the browser did not see coming:
//   node tests/robot.mjs [ws://localhost:8080/play] [latency ms] [seconds]
//
// It plays with the browser's own Net and Game (web/js), through a socket
// that adds the given round trip, in a room of its own with three AIs. It
// drives into tight spots on purpose: it turns late in front of walls and
// towards the nearest enemy. Every death of its own is checked against its
// prediction: a crash the prediction agrees with is fair, one where the
// prediction still drove on is "unexpected" - lag (an enemy turning in front
// of us before we could know) or a bug.
const url = process.argv[2] ?? 'ws://localhost:8080/play';
const latency = +(process.argv[3] ?? 0) / 1000;
const seconds = +(process.argv[4] ?? 120);

globalThis.location = new URL(url.replace(/^ws/, 'http').replace(/play$/, ''));

// half the round trip each way, with some jitter
const Socket = globalThis.WebSocket;
const lag = () => latency * 500 * (0.8 + 0.4 * Math.random());

class LaggySocket extends EventTarget {
  static OPEN = 1;

  constructor(address) {
    super();
    this.readyState = 0;
    this.ws = new Socket(address);
    this.ws.binaryType = 'arraybuffer';
    this.ws.addEventListener('open', () => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
    this.ws.addEventListener('close', () => { this.readyState = 3; this.dispatchEvent(new Event('close')); });
    this.ws.addEventListener('message', (e) => {
      const data = e.data;
      setTimeout(() => this.dispatchEvent(Object.assign(new Event('message'), { data })), lag());
    });
  }

  // the frames come as ArrayBuffers whatever the page asks for
  set binaryType(_) {}

  send(data) { setTimeout(() => this.ws.send(data), lag()); }
  close() { this.ws.close(); }
}

globalThis.WebSocket = LaggySocket;

const { Net } = await import('../server/web/js/net.js');
const { Game } = await import('../server/web/js/game.js');
const { AXES } = await import('../server/web/js/sim.js');

const t0 = performance.now();
const log = (...a) => console.log(((performance.now() - t0) / 1000).toFixed(2).padStart(7), ...a);

const net = new Net();
const once = (type) => new Promise((resolve) => { const off = net.on(type, (m) => { off(); resolve(m); }); });

// listening before joining: the round's snapshot follows the welcome at once
const game = new Game(net);
net.on('joined', (m) => { game.you = m.you; });
net.on('state', (m) => game.load(m));

net.connect();
await once('open');
net.send({ t: 'hello', name: 'Robot', r: 15, g: 15, b: 3, cid: `robot${Math.floor(Math.random() * 1e9)}` });
net.send({ t: 'create', settings: { name: 'Robot test', minPlayers: 4, aiIq: 100 } });
const created = await once('created');
net.send({ t: 'join', room: created.room, token: created.token });
await once('joined');

net.on('sync', (m) => game.onSync(m));
net.on('turn', (m) => game.onTurn(m));
net.on('brake', (m) => game.onBrake(m));
net.on('die', (m) => game.onDie(m));

let deaths = 0, unexpected = 0, rounds = 0, round = -1, lastTurn = 0, last = null, driven = 0, turns = 0;

game.on('die', (c, killer) => {
  if (c.id !== game.you) return;
  deaths++;
  // what we saw the step before the verdict: had we crashed, or was there room ahead?
  const fair = !last || last.frozen || last.ahead < 0.5;
  if (!fair) unexpected++;
  log(`${fair ? 'died' : 'UNEXPECTED death'} at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}), killer ${killer}` +
      (last ? `; we were at distance ${last.dist.toFixed(2)} with ${last.ahead.toFixed(2)} free ahead${last.frozen ? ' (crashed here too)' : ''}` : ''));
});

function room(w, c, dir) {
  const [dx, dy] = AXES[(dir + 4) % 4];
  const hit = w.ray(c.x, c.y, dx, dy, 100, c, c.time);
  return hit ? hit.t : 100;
}

let before = performance.now();

const timer = setInterval(() => {
  const now = performance.now();
  const serverNow = net.serverNow((now - before) / 1000);
  before = now;
  game.update(serverNow);

  if (game.round !== round) {
    driven += last?.dist ?? 0;
    round = game.round;
    if (round > 0) rounds++;
    last = null;
    lastTurn = 0;
  }

  const c = game.own;
  if (!c || !c.alive || game.phase === 'idle' || serverNow <= game.start) return;

  const w = game.world;
  const ahead = room(w, c, c.dir);
  last = { dist: c.dist, ahead, frozen: !!c.frozen };
  if (c.frozen || c.time - lastTurn < 0.12) return;

  const left = room(w, c, c.dir + 1), right = room(w, c, c.dir - 1);

  // a wall ahead: turn late, like somebody grinding close
  if (ahead < 0.6 + c.speed() * 0.03) {
    lastTurn = c.time;
    turns++;
    game.turn(left > right ? 1 : -1);
    return;
  }

  // now and then, turn towards the nearest enemy
  let enemy = null, best = 40;
  for (const o of w.cycles.values()) {
    const d = Math.hypot(o.x - c.x, o.y - c.y);
    if (o !== c && o.alive && d < best) { best = d; enemy = o; }
  }
  if (enemy && Math.random() < 0.02) {
    const side = -(enemy.x - c.x) * c.dy + (enemy.y - c.y) * c.dx > 0 ? 1 : -1;
    const lateral = Math.abs(-(enemy.x - c.x) * c.dy + (enemy.y - c.y) * c.dx);
    if (lateral > 1.5 && (side > 0 ? left : right) > 4) {
      lastTurn = c.time;
      game.turn(side);
    }
  }
}, 1000 / 120);

setTimeout(() => {
  clearInterval(timer);
  log(`${rounds} rounds, ${deaths} deaths, ${unexpected} unexpected; drove ${Math.round(driven + (last?.dist ?? 0))} m, ${turns} turns away from walls`);
  net.wanted = false;
  net.socket?.close();
  process.exit(0);
}, seconds * 1000);
