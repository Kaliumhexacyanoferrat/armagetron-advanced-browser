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
        message = JSON.parse(event.data);
      } catch {
        return;
      }
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
    } else if (message.t !== 'ping' && message.t !== 'turn' && message.t !== 'brake') {
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

export function now() {
  return performance.now() / 1000;
}
