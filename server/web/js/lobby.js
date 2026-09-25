// The front page: who you are, the servers running, and making one.

import { colorize, hex15, strip } from './hud.js';

// The rules a server owner chooses, for the create form and the admin panel.
export const RULES = [
  { key: 'name', label: 'Server name', type: 'text', max: 30, full: true },
  { key: 'password', label: 'Password', type: 'text', max: 30, hint: 'Leave empty for an open server.' },
  { key: 'maxPlayers', label: 'Players at most', options: [2, 3, 4, 6, 8, 10, 12, 16] },
  { key: 'minPlayers', label: 'AI players fill up to', options: [[0, 'no AI players'], [2, '2 players'], [3, '3 players'], [4, '4 players'], [5, '5 players'], [6, '6 players'], [8, '8 players'], [10, '10 players'], [12, '12 players']] },
  { key: 'aiIq', label: 'AI strength', options: [[10, 'harmless'], [30, 'easy'], [50, 'normal'], [70, 'hard'], [100, 'merciless']] },
  { key: 'sizeFactor', label: 'Arena size', options: [[-5, 'tiny (88 m)'], [-4, 'small (125 m)'], [-3, 'normal (177 m)'], [-2, 'large (250 m)'], [-1, 'huge (354 m)'], [0, 'giant (500 m)']] },
  { key: 'speedFactor', label: 'Speed', options: [[-2, 'slow'], [-1, 'relaxed'], [0, 'normal'], [1, 'fast'], [2, 'very fast']] },
  { key: 'rubber', label: 'Rubber', options: [[1, '1 (the original)'], [2, '2'], [3, '3'], [5, '5 (forgiving)'], [10, '10']] },
  { key: 'wallsLength', label: 'Trails', options: [[-1, 'endless'], [100, '100 m'], [200, '200 m'], [400, '400 m']] },
  { key: 'wallsStayUp', label: 'Walls of the fallen', options: [[0, 'vanish at once'], [2, 'stay 2 seconds'], [8, 'stay 8 seconds'], [-1, 'stay for the round']] },
  { key: 'scoreLimit', label: 'A match goes to', options: [[30, '30 points'], [50, '50 points'], [100, '100 points'], [200, '200 points'], [500, '500 points']] },
  { key: 'roundLimit', label: 'or at most', options: [[5, '5 rounds'], [10, '10 rounds'], [20, '20 rounds'], [50, '50 rounds']] },
];

export const DEFAULT_RULES = {
  name: '', password: '', maxPlayers: 8, minPlayers: 4, aiIq: 50, sizeFactor: -3, speedFactor: 0,
  rubber: 1, wallsLength: -1, wallsStayUp: 8, scoreLimit: 100, roundLimit: 10,
};

export function buildRuleFields(container, values) {
  container.replaceChildren();
  for (const r of RULES) {
    const label = document.createElement('label');
    label.className = 'field' + (r.full ? ' full' : '');
    const span = document.createElement('span');
    span.textContent = r.label;
    label.append(span);
    let input;
    if (r.options) {
      input = document.createElement('select');
      const opts = r.options.map((o) => (Array.isArray(o) ? o : [o, String(o)]));
      const v = values[r.key];
      if (!opts.some(([x]) => x === v) && v !== undefined) opts.push([v, String(v)]);
      for (const [value, text] of opts) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        input.append(o);
      }
      input.value = String(v);
    } else {
      input = document.createElement('input');
      input.maxLength = r.max ?? 40;
      input.value = values[r.key] ?? '';
      input.spellcheck = false;
    }
    input.name = r.key;
    label.append(input);
    if (r.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = r.hint;
      label.append(hint);
    }
    container.append(label);
  }
}

export function readRuleFields(container) {
  const out = {};
  for (const r of RULES) {
    const input = container.querySelector(`[name="${r.key}"]`);
    if (!input) continue;
    out[r.key] = r.options ? Number(input.value) : input.value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------

export class Lobby {
  constructor(app) {
    this.app = app;
    this.prefs = app.prefs;
    this.el = document.getElementById('lobby');
    this.rooms = [];
    this.setupProfile();
    this.setupCreate();
    document.getElementById('quick').addEventListener('click', () => this.quickPlay());
    this.grid = new MenuGrid(document.getElementById('grid'));
  }

  show() {
    this.el.hidden = false;
    this.grid.start();
    this.app.net.send({ t: 'list' });
    clearInterval(this.refresh);
    this.refresh = setInterval(() => this.app.net.send({ t: 'list' }), 3000);
  }

  hide() {
    this.el.hidden = true;
    this.grid.stop();
    clearInterval(this.refresh);
  }

  online(count) {
    document.getElementById('online').textContent = count === null ? 'Connecting...' : `${count} ${count === 1 ? 'player' : 'players'} online right now.`;
  }

  // ---------------------------------------------------------------------
  // You: name and colour

  setupProfile() {
    const p = this.prefs;
    const name = document.getElementById('name');
    name.value = p.name;
    name.addEventListener('input', () => {
      p.name = name.value.trim().slice(0, 15);
      p.save();
      this.app.hello();
    });
    const sliders = { r: document.getElementById('cr'), g: document.getElementById('cg'), b: document.getElementById('cb') };
    for (const [k, s] of Object.entries(sliders)) {
      s.value = p[k];
      s.addEventListener('input', () => {
        p[k] = Number(s.value);
        p.save();
        this.drawSwatch();
        this.app.hello();
      });
    }
    const presets = document.getElementById('presets');
    const colors = [[15, 3, 3], [3, 15, 3], [3, 3, 15], [15, 15, 3], [15, 3, 15], [3, 15, 15], [15, 9, 3], [15, 3, 9], [9, 3, 15], [3, 9, 15], [15, 15, 15]];
    for (const [r, g, b] of colors) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.background = hex15(r, g, b);
      btn.setAttribute('aria-label', `Colour ${hex15(r, g, b)}`);
      btn.addEventListener('click', () => {
        Object.assign(p, { r, g, b });
        sliders.r.value = r;
        sliders.g.value = g;
        sliders.b.value = b;
        p.save();
        this.drawSwatch();
        this.app.hello();
      });
      presets.append(btn);
    }
    this.sliders = sliders;
    this.drawSwatch();
  }

  // a little lightcycle trail in your colour
  drawSwatch() {
    const cv = document.getElementById('swatch');
    const ctx = cv.getContext('2d');
    const p = this.prefs;
    const col = hex15(p.r, p.g, p.b);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 96, 96);
    ctx.strokeStyle = 'rgba(128,128,178,0.35)';
    ctx.lineWidth = 1;
    for (let i = 8; i < 96; i += 16) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 96); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(96, i); ctx.stroke();
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 5;
    ctx.shadowColor = col;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(10, 86); ctx.lineTo(10, 40); ctx.lineTo(56, 40); ctx.lineTo(56, 16); ctx.lineTo(84, 16);
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(92, 16); ctx.lineTo(82, 10); ctx.lineTo(82, 22); ctx.closePath();
    ctx.fill();
  }

  // ---------------------------------------------------------------------
  // The server list

  setRooms(rooms) {
    this.rooms = rooms;
    const list = document.getElementById('servers');
    document.getElementById('server-count').textContent = rooms.length ? `${rooms.length} running` : '';
    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      empty.innerHTML = 'No servers are running right now.<br>Create one and send the link to your friends; AI players keep you company until they arrive.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...rooms.map((r) => {
      const row = document.createElement('div');
      row.className = 'server' + (this.prefs.token(r.id) ? ' mine' : '');
      const info = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'title';
      title.append(colorize(r.name));
      if (r.locked) {
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.textContent = ' \u{1F512}';
        lock.title = 'Protected by a password';
        title.append(lock);
      }
      const meta = document.createElement('div');
      meta.className = 'meta';
      const mine = this.prefs.token(r.id) ? ' (yours)' : '';
      meta.textContent = `by ${strip(r.owner)}${mine}` + (r.round ? ` · round ${r.round}` : '') + (r.spectators ? ` · ${r.spectators} watching` : '');
      info.append(title, meta);
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = `${r.humans} / ${r.max}`;
      const small = document.createElement('small');
      small.textContent = r.bots ? `+ ${r.bots} AI` : 'players';
      count.append(small);
      const join = document.createElement('button');
      join.textContent = r.humans >= r.max ? 'Watch' : 'Join';
      join.className = r.humans < r.max ? 'primary-outline' : '';
      join.addEventListener('click', () => this.app.join(r.id));
      row.append(info, count, join);
      row.addEventListener('dblclick', () => this.app.join(r.id));
      return row;
    }));
  }

  quickPlay() {
    this.app.audio.unlock();
    const open = this.rooms.filter((r) => !r.locked && r.humans < r.max).sort((a, b) => b.humans - a.humans);
    if (open.length && open[0].humans > 0) {
      this.app.join(open[0].id);
    } else {
      // nobody around: a server of your own, with AI players to race
      const name = this.prefs.name || 'Player';
      this.app.net.send({ t: 'create', settings: { ...DEFAULT_RULES, name: `${strip(name)}'s server` } });
    }
  }

  // ---------------------------------------------------------------------
  // Creating a server

  setupCreate() {
    const dialog = document.getElementById('create');
    const fields = document.getElementById('create-fields');
    document.getElementById('create-open').addEventListener('click', () => {
      this.app.audio.unlock();
      const name = this.prefs.name || 'Player';
      buildRuleFields(fields, { ...DEFAULT_RULES, ...(this.prefs.lastRules ?? {}), name: `${strip(name)}'s server`, password: '' });
      document.getElementById('create-error').textContent = '';
      dialog.showModal();
      fields.querySelector('input')?.select();
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'ok') return;
      const settings = readRuleFields(fields);
      const { name, password, ...rest } = settings;
      this.prefs.lastRules = rest;
      this.prefs.save();
      this.app.net.send({ t: 'create', settings });
      void name; void password;
    });
  }
}

// The original's menu background: the floor texture, slanted, drifting slowly.
export class MenuGrid {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.running = false;
    const img = new Image();
    img.src = 'tex/floor.png';
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width;
      cv.height = img.height;
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0);
      const d = c.getImageData(0, 0, cv.width, cv.height);
      for (let i = 0; i < d.data.length; i += 4) {
        d.data[i] *= 0.5;
        d.data[i + 1] *= 0.5;
        d.data[i + 2] *= 0.7;
        d.data[i + 3] = 255;
      }
      c.putImageData(d, 0, 0);
      this.tile = cv;
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const frame = (t) => {
      if (!this.running) return;
      this.draw(t / 1000);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  stop() {
    this.running = false;
  }

  draw(t) {
    const cv = this.canvas;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    if (!this.tile) return;
    // about sixteen tiles across; the texture matrix [[.8,.2],[-.2,.8]] and the drift (t/3, t/5)
    const tileSize = w / 16 / 0.82;
    const pattern = ctx.createPattern(this.tile, 'repeat');
    const k = tileSize / this.tile.width;
    const m = new DOMMatrix([0.8 * k, -0.2 * k, 0.2 * k, 0.8 * k, 0, 0])
      .translate((t / 3) * this.tile.width, (t / 5) * this.tile.height);
    pattern.setTransform(m);
    ctx.fillStyle = pattern;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    // a darker middle so the page reads
    const g = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.7);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0.1)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}
