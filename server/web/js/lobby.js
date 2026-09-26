// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The front page: who you are, the servers running, and making one.

import { colorize, hex15, strip } from './hud.js';
import { navigate } from './menunav.js';
import { randomColor } from './prefs.js';

// The rules a server owner chooses, for the create form and the admin panel.
export const RULES = [
  { key: 'name', label: 'Server name', type: 'text', max: 30, full: true },
  { key: 'password', label: 'Password', type: 'text', max: 30, hint: 'Leave empty for an open server.' },
  { key: 'maxPlayers', label: 'Players at most', options: [2, 3, 4, 6, 8, 10, 12, 16] },
  { key: 'minPlayers', label: 'AI players fill up to', options: [[0, 'no AI players'], [2, '2 players'], [3, '3 players'], [4, '4 players'], [5, '5 players'], [6, '6 players'], [8, '8 players'], [10, '10 players'], [12, '12 players']] },
  { key: 'aiIq', label: 'AI strength', options: [[10, 'harmless'], [30, 'easy'], [50, 'normal'], [70, 'hard'], [100, 'merciless']] },
  { key: 'sizeFactor', label: 'Arena size', options: [[-5, 'tiny (88 m)'], [-4, 'small (125 m)'], [-3, 'normal (177 m)'], [-2, 'large (250 m)'], [-1, 'huge (354 m)'], [0, 'giant (500 m)']] },
  { key: 'speedFactor', label: 'Speed', options: [[-2, 'slow'], [-1, 'relaxed'], [0, 'normal'], [1, 'fast'], [2, 'very fast']] },
  { key: 'rubber', label: 'Rubber', options: [[1, '1 (the original\'s default, hard)'], [2, '2'], [3, '3'], [5, '5 (like most servers)'], [10, '10 (forgiving)']] },
  { key: 'wallsLength', label: 'Trails', options: [[-1, 'endless'], [100, '100 m'], [200, '200 m'], [400, '400 m']] },
  { key: 'wallsStayUp', label: 'Walls of the fallen', options: [[0, 'vanish at once'], [2, 'stay 2 seconds'], [8, 'stay 8 seconds'], [-1, 'stay for the round']] },
  { key: 'scoreLimit', label: 'A match goes to', options: [[30, '30 points'], [50, '50 points'], [100, '100 points'], [200, '200 points'], [500, '500 points']] },
  { key: 'roundLimit', label: 'or at most', options: [[5, '5 rounds'], [10, '10 rounds'], [20, '20 rounds'], [50, '50 rounds']] },
  { key: 'idleKick', label: 'Kick idle players after', options: [[0, 'never'], [1, '1 minute'], [2, '2 minutes'], [3, '3 minutes'], [5, '5 minutes'], [10, '10 minutes']] },
  { key: 'idleKickSpectators', label: 'Kick idle spectators after', options: [[0, 'never'], [10, '10 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours']] },
];

export const DEFAULT_RULES = {
  name: '', password: '', maxPlayers: 8, minPlayers: 4, aiIq: 50, sizeFactor: -3, speedFactor: 0,
  rubber: 5, wallsLength: -1, wallsStayUp: 8, scoreLimit: 100, roundLimit: 10,
  idleKick: 3, idleKickSpectators: 30,
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
    document.getElementById('quick').addEventListener('click', () => this.quickJoin());
    this.grid = new MenuGrid(document.getElementById('grid'));
    // the arrow keys walk the page like a menu
    window.addEventListener('keydown', (e) => {
      if (this.el.hidden || document.querySelector('dialog[open]')) return;
      const inside = this.el.contains(document.activeElement);
      if (!inside && document.activeElement !== document.body) return;
      navigate(this.el, e);
    });
  }

  show() {
    this.el.hidden = false;
    if (!document.querySelector('dialog[open]')) document.getElementById('quick').focus({ preventScroll: true });
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
      this.helloSoon();
    });
    const sliders = { r: document.getElementById('cr'), g: document.getElementById('cg'), b: document.getElementById('cb') };
    for (const [k, s] of Object.entries(sliders)) {
      s.value = p[k];
      s.addEventListener('input', () => {
        p[k] = Number(s.value);
        p.save();
        this.drawSwatch();
        this.helloSoon();
      });
    }
    const presets = document.getElementById('presets');
    const colors = [[15, 3, 3], [3, 15, 3], [3, 3, 15], [15, 15, 3], [15, 3, 15], [3, 15, 15], [15, 9, 3], [15, 3, 9], [9, 3, 15], [3, 9, 15], [15, 15, 15]];
    const choose = ([r, g, b]) => {
      Object.assign(p, { r, g, b });
      sliders.r.value = r;
      sliders.g.value = g;
      sliders.b.value = b;
      p.save();
      this.drawSwatch();
      this.helloSoon();
    };
    for (const [r, g, b] of colors) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.background = hex15(r, g, b);
      btn.setAttribute('aria-label', `Colour ${hex15(r, g, b)}`);
      btn.addEventListener('click', () => choose([r, g, b]));
      presets.append(btn);
    }
    const dice = document.createElement('button');
    dice.type = 'button';
    dice.className = 'dice';
    dice.textContent = '?';
    dice.title = 'A random colour';
    dice.setAttribute('aria-label', 'A random colour');
    dice.addEventListener('click', () => choose(randomColor()));
    presets.append(dice);
    this.sliders = sliders;
    this.drawSwatch();
  }

  // typing a name or dragging a slider tells the server once it settles
  helloSoon() {
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => this.app.hello(), 250);
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

  // The servers as the server sorts them: where people play and a place is
  // free first, then full ones, then empty ones. Only the first few of many.
  setRooms(rooms, total = rooms.length) {
    this.rooms = rooms;
    const list = document.getElementById('servers');
    // nothing changed: leave the list (and the keyboard focus in it) alone
    const key = JSON.stringify(rooms) + total + Object.keys(this.prefs.tokens).join();
    if (key === this.roomsKey) return;
    this.roomsKey = key;
    const focused = list.contains(document.activeElement) ? document.activeElement.closest('.server')?.dataset.id : null;
    document.getElementById('server-count').textContent = total ? `${total} running` : '';
    if (!rooms.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-list';
      empty.innerHTML = 'No servers are running right now.<br>Create one and send the link to your friends; AI players keep you company until they arrive.';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...rooms.map((r) => {
      const row = document.createElement('div');
      row.className = 'server' + (this.prefs.token(r.id) ? ' mine' : '') + (r.humans === 0 ? ' idle' : r.humans >= r.max ? ' full' : '');
      row.dataset.id = r.id;
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
      return row;
    }));
    if (total > rooms.length) {
      const more = document.createElement('p');
      more.className = 'dim small more';
      more.textContent = `and ${total - rooms.length} more; Quick join finds a place on any of them.`;
      list.append(more);
    }
    if (focused) list.querySelector(`[data-id="${focused}"] button`)?.focus({ preventScroll: true });
  }

  // Quick join: the server picks one where people play and a place is free,
  // or starts a new one (with AI players to race) if there is none
  quickJoin() {
    this.app.audio.unlock();
    const name = this.prefs.name || 'Player';
    this.app.net.send({ t: 'quick', settings: { ...DEFAULT_RULES, name: `${strip(name)}'s server` } });
  }

  // ---------------------------------------------------------------------
  // Creating a server

  setupCreate() {
    const dialog = document.getElementById('create');
    const fields = document.getElementById('create-fields');
    document.getElementById('create-open').addEventListener('click', () => {
      this.app.audio.unlock();
      const name = this.prefs.name || 'Player';
      // rules saved before rubber 5 became the default still had the old 1 as a default, not a choice
      const last = { ...(this.prefs.lastRules ?? {}) };
      if (last.version !== 2) delete last.rubber;
      buildRuleFields(fields, { ...DEFAULT_RULES, ...last, name: `${strip(name)}'s server`, password: '' });
      document.getElementById('create-error').textContent = '';
      dialog.returnValue = '';
      dialog.showModal();
      fields.querySelector('input')?.select();
    });
    dialog.addEventListener('close', () => {
      if (dialog.returnValue !== 'ok') return;
      const settings = readRuleFields(fields);
      const { name, password, ...rest } = settings;
      this.prefs.lastRules = { ...rest, version: 2 };
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
    this.pattern ??= ctx.createPattern(this.tile, 'repeat');
    const pattern = this.pattern;
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
