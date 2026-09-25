// Talks to a running server like a browser would: node tests/ws.test.mjs [ws://localhost:8080/play]
const url = process.argv[2] ?? 'ws://localhost:8080/play';

function client(name) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    for (const w of [...waiters]) if (w.test(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  };
  const c = {
    ws, inbox, name,
    send: (m) => ws.send(JSON.stringify(m)),
    wait: (test, ms = 8000) => new Promise((resolve, reject) => {
      const found = inbox.find(test);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return resolve(found); }
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`${name}: timeout waiting`)), ms);
    }),
    open: new Promise((r) => (ws.onopen = r)),
  };
  return c;
}

const a = client('alice');
await a.open;
await a.wait((m) => m.t === 'welcome');
a.send({ t: 'hello', name: 'Alice', r: 15, g: 3, b: 3, cid: 'aliceclientid1' });
a.send({ t: 'create', settings: { name: 'Test server', minPlayers: 3, aiIq: 50 } });
const created = await a.wait((m) => m.t === 'created');
console.log('created', created.room);
a.send({ t: 'join', room: created.room, token: created.token });
const joined = await a.wait((m) => m.t === 'joined');
console.log('joined as', joined.you, 'admin', joined.admin);
const state = await a.wait((m) => m.t === 'state' && m.phase === 'countdown');
console.log('round', state.round, 'cycles', state.cycles.map((c) => `${c.name}@${c.x.toFixed(1)},${c.y.toFixed(1)} dir ${c.dir}`).join(' | '));

const b = client('bob');
await b.open;
b.send({ t: 'hello', name: 'Bob', r: 3, g: 3, b: 15, cid: 'bobclientid12' });
b.send({ t: 'list' });
const rooms = await b.wait((m) => m.t === 'rooms');
console.log('rooms', JSON.stringify(rooms.rooms));
b.send({ t: 'join', room: created.room });
await b.wait((m) => m.t === 'joined');

// wait for the start and turn once
const now = () => performance.now() / 1000;
a.send({ t: 'ping', c: now() });
const pong = await a.wait((m) => m.t === 'pong');
const offset = pong.s - pong.c;
const waitMs = (state.start - (now() + offset)) * 1000 + 700;
await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
const sync = await a.wait((m) => m.t === 'sync');
const mine = sync.c.find((e) => e[0] === joined.you);
console.log('sync: my cycle', mine?.slice(0, 13).map((v) => +(+v).toFixed(2)).join(','));
a.send({ t: 'turn', d: 1, n: 1, dist: mine[10], x: mine[1], y: mine[2] });
const turn = await a.wait((m) => m.t === 'turn' && m.id === joined.you);
console.log('turn event', JSON.stringify(turn));

a.send({ t: 'chat', text: 'hello grid' });
const chat = await b.wait((m) => m.t === 'msg' && m.text.includes('hello grid'));
console.log('chat seen by bob:', chat.text);

b.send({ t: 'chat', text: '/kick Alice' });
const denied = await b.wait((m) => m.t === 'msg' && m.text.includes('Only the administrator'));
console.log('bob cannot kick:', denied.text);

const players = await a.wait((m) => m.t === 'players' && m.list.some((p) => p.name === 'Bob'));
console.log('players', players.list.map((p) => `${p.name}${p.bot ? '(AI)' : ''}:${p.score}`).join(', '));
const bob = players.list.find((p) => p.name === 'Bob');
a.send({ t: 'admin', cmd: 'ban', id: bob.id, minutes: 5, reason: 'testing' });
const kicked = await b.wait((m) => m.t === 'kicked');
console.log('bob kicked:', kicked.reason);
b.send({ t: 'join', room: created.room });
const refused = await b.wait((m) => m.t === 'refused');
console.log('bob refused:', refused.reason);

const die = await a.wait((m) => m.t === 'die', 30000);
console.log('somebody died', JSON.stringify(die));
const msgs = a.inbox.filter((m) => m.t === 'msg').map((m) => m.text);
console.log('messages:', msgs.slice(-6).join('\n  '));
a.ws.close();
b.ws.close();
console.log('ok');
