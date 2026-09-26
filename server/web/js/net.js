// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The socket to the server, and a clock that agrees with the server's.
//
// Every message is JSON with a "t" for its type. The clock: the server's time
// is estimated from ping round trips, trusting the fastest recent ones (their
// halves are the most honest), and follows changes smoothly so the game never
// jumps in time.

export class Net {
  constructor() {
    this.handlers = new Map();
    this.socket = null;
    this.offset = null;      // server time - local time, seconds
    this.target = null;
    this.rtt = 0.1;
    this.samples = [];
    this.open = false;
    this.wanted = false;
    this.queue = [];
    this.retry = 0;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => {
      const list = this.handlers.get(type);
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  emit(type, message) {
    for (const fn of this.handlers.get(type) ?? []) fn(message);
    for (const fn of this.handlers.get('*') ?? []) fn(message);
  }

  connect() {
    this.wanted = true;
    if (this.socket) return;

    const address = new URL('play', location.href);
    address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    const socket = new WebSocket(address);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.open = true;
      this.retry = 0;
      this.samples = [];
      this.ping();
      this.pinger = setInterval(() => this.ping(), 1000);
      this.emit('open', {});
      for (const m of this.queue.splice(0)) this.send(m);
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : decode(event.data);
      } catch {
        return;
      }
      if (!message) return;
      if (message.t === 'pong') this.pong(message);
      if (message.t === 'welcome' && this.offset === null) this.offset = message.time - now();
      this.emit(message.t, message);
    });

    socket.addEventListener('close', () => {
      clearInterval(this.pinger);
      const was = this.open;
      this.open = false;
      this.socket = null;
      this.emit('close', { was });
      if (this.wanted) {
        this.retry++;
        setTimeout(() => this.connect(), Math.min(5000, 500 * this.retry));
      }
    });
  }

  send(message) {
    if (this.open && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    } else if (!TRANSIENT.has(message.t) && this.queue.length < 20) {
      // hello and join are sent again on reconnecting anyway
      this.queue.push(message);
    }
  }

  ping() {
    this.send({ t: 'ping', c: now(), l: this.rtt });
  }

  pong({ c, s }) {
    const t = now();
    const rtt = t - c;
    if (rtt < 0 || rtt > 5) return;
    this.samples.push({ rtt, offset: s + rtt / 2 - t, at: t });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.rtt = this.rtt * 0.7 + rtt * 0.3;
    this.target = best.offset;
    if (this.offset === null || Math.abs(this.target - this.offset) > 0.25) this.offset = this.target;
  }

  // the server's clock now; follows a new estimate at up to 5% speed
  serverNow(dt = 0) {
    if (this.offset === null) return now();
    if (this.target !== null && dt > 0) {
      const diff = this.target - this.offset;
      const max = dt * 0.05;
      this.offset += Math.max(-max, Math.min(max, diff));
    }
    return now() + this.offset;
  }
}

// The server's binary frames (server/Protocol.cs, Wire), read into the same
// shapes the JSON messages would have.
export function decode(buffer) {
  const v = new DataView(buffer);
  let at = 0;
  const u8 = () => v.getUint8(at++);
  const u16 = () => { const x = v.getUint16(at, true); at += 2; return x; };
  const i16 = () => { const x = v.getInt16(at, true); at += 2; return x; };
  const f32 = () => { const x = v.getFloat32(at, true); at += 4; return x; };
  const f64 = () => { const x = v.getFloat64(at, true); at += 8; return x; };
  switch (u8()) {
    case 1: {
      const time = f64();
      const n = u8();
      const c = new Array(n);
      for (let i = 0; i < n; i++) {
        const id = u16(), bits = u8(), turns = u16();
        const x = f32(), y = f32(), vv = f32(), a = f32(), lastTs = f32(), rubber = f32(), brakeRes = f32(), dist = f64();
        // the order of the old JSON arrays: id, x, y, dir, v, a, lastTs, rubber, brakeRes, braking, dist, turns, frozen
        c[i] = [id, x, y, bits & 3, vv, a, lastTs, rubber, brakeRes, (bits >> 2) & 1, dist, turns, (bits >> 3) & 1];
      }
      return { t: 'sync', time, c };
    }
    case 2: {
      const id = u16(), n = u16(), dir = u8();
      const x = f64(), y = f64(), d = f64(), time = f64(), vv = f32();
      return { t: 'turn', id, n, dir, x, y, d, time, v: vv };
    }
    case 3: {
      const id = u16(), x = f64(), y = f64(), time = f64(), killer = i16();
      return { t: 'die', id, x, y, time, killer };
    }
    case 4: {
      const id = u16(), on = u8() === 1, time = f64();
      return { t: 'brake', id, on, time };
    }
    default:
      return null;
  }
}

// what is only worth sending right now
const TRANSIENT = new Set(['ping', 'turn', 'brake', 'typing', 'list', 'hello', 'join']);

export function now() {
  return performance.now() / 1000;
}
