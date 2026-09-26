// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// The heads-up display: the original's standard cockpit (resource/proto/
// Anonymous/original/original.cockpit.xml) drawn on a 2D canvas over the
// game, and the console, centre messages, score table, chat line and name
// tags as HTML.
//
// Cockpit coordinates are the original's: x from -1 (left) to 1 (right), y
// from -1 (bottom) to 0.5 (top), so a y unit is two thirds of the height.

import { trailOf } from './render.js';

export function colorize(text, base = null) {
  // 0xRRGGBB switches colour, 0xRESETT goes back to the default
  const out = document.createDocumentFragment();
  const re = /0x([0-9a-fA-F]{6}|RESETT)/g;
  let last = 0, color = base, m;
  const push = (s) => {
    if (!s) return;
    const span = document.createElement('span');
    span.textContent = s;
    if (color) paint(span, color);
    out.append(span);
  };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    color = m[1] === 'RESETT' ? base : '#' + m[1].toLowerCase();
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

// tColor::IsDark with FONT_MIN_R/G/B .5 and FONT_MIN_TOTAL .7: text that dark
// gets a bright background, so a black name stays readable
export function isDark(hex) {
  const v = parseInt(hex.slice(1), 16);
  const r = (v >> 16) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  return (r < 0.5 && g < 0.5 && b < 0.5) || r + g + b < 0.7;
}

export function paint(el, hex) {
  el.style.color = hex;
  el.classList.toggle('dark-text', isDark(hex));
}

export function strip(text) {
  return String(text ?? '').replace(/0x([0-9a-fA-F]{6}|RESETT)/g, '');
}

export function rgb(c) {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

export function hex15(r, g, b) {
  const h = (v) => Math.round((v / 15) * 255).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

export class Hud {
  constructor(root, prefs) {
    this.root = root;
    this.prefs = prefs;
    this.canvas = root.querySelector('#cockpit');
    this.ctx = this.canvas.getContext('2d');
    this.consoleEl = root.querySelector('#console');
    this.centerEl = root.querySelector('#center');
    this.scoresEl = root.querySelector('#scores');
    this.tagsEl = root.querySelector('#tags');
    this.statusEl = root.querySelector('#status');
    this.lines = [];
    this.center = null;
    this.tags = new Map();
    this.fps = 60;
    this.started = performance.now();
    this.mapMode = 0;
    // touch screens: the cockpit is only the map, small, under the icons at the top right
    this.touch = matchMedia('(pointer: coarse)').matches;
    this.images = {};
    for (const n of ['gauge', 'gauge_filled', 'clock', 'map_floor']) {
      const img = new Image();
      img.src = `tex/${n}.png`;
      img.onload = () => { this.images[n] = img; if (n === 'map_floor') this.makeMapPattern(img); };
    }
  }

  makeMapPattern(img) {
    // floor-1.aatex.png tinted (.5, 1, .5), as the map's background
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const c = cv.getContext('2d');
    c.drawImage(img, 0, 0);
    const d = c.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const a = d.data[i + 3] / 255;
      d.data[i] *= 0.5 * a;
      d.data[i + 1] *= a;
      d.data[i + 2] *= 0.5 * a;
      d.data[i + 3] = 255;
    }
    c.putImageData(d, 0, 0);
    this.mapPattern = cv;
  }

  // -------------------------------------------------------------------
  // Console: seven lines; a new line stays at least four seconds, then one
  // line scrolls away every two (rConsole)

  message(text) {
    this.lines.push({ text, el: null });
    this.hold = performance.now() + 4000;
    while (this.lines.length > 40) this.lines.shift();
    this.renderConsole();
  }

  renderConsole() {
    const el = this.consoleEl;
    const rows = this.chatOpen ? 15 : 7;
    const visible = this.lines.slice(-rows);
    el.replaceChildren(...visible.map((l) => {
      const div = document.createElement('div');
      div.append(colorize(l.text));
      return div;
    }));
    el.classList.toggle('empty', visible.length === 0);
  }

  tickConsole(now) {
    if (this.chatOpen || !this.lines.length) return;
    if (now > this.hold) {
      this.lines.shift();
      this.hold = now + 2000;
      this.renderConsole();
    }
  }

  // big text in the lower middle, fading out over a second after its time
  showCenter(text, duration = 0) {
    this.center = { text, until: performance.now() + duration * 1000 };
    this.centerEl.replaceChildren(colorize(text));
    this.centerEl.style.opacity = 1;
  }

  tickCenter(now) {
    if (!this.center) return;
    const left = (this.center.until + 1000 - now) / 1000;
    if (left <= 0) {
      this.center = null;
      this.centerEl.style.opacity = 0;
    } else {
      this.centerEl.style.opacity = Math.min(1, left);
    }
  }

  status(text) {
    text ??= '';
    if (text === this.statusText) return;
    this.statusText = text;
    this.statusEl.textContent = text;
    this.statusEl.hidden = !text;
  }

  // -------------------------------------------------------------------
  // Score table (Tab, and between rounds)

  showScores(on) {
    this.scoresOpen = on;
    this.scoresEl.hidden = !on;
    this.onScores?.();
  }

  renderScores(players, you) {
    if (!this.scoresEl || this.scoresEl.hidden) return;
    const rows = players.filter((p) => !p.spectator || !p.bot);
    const table = document.createElement('table');
    const head = table.createTHead().insertRow();
    for (const h of ['Player:', 'Alive:', 'Score:', 'Kills:', 'Ping:', '']) {
      const th = document.createElement('th');
      th.textContent = h;
      head.append(th);
    }
    const body = table.createTBody();
    if (!rows.length) {
      const td = body.insertRow().insertCell();
      td.colSpan = 6;
      td.textContent = 'Nobody there.';
    }
    for (const p of rows.slice(0, 20)) {
      const tr = body.insertRow();
      if (p.id === you) tr.className = 'you';
      const name = tr.insertCell();
      name.className = 'name';
      if (p.chatting) name.append('*');
      const span = document.createElement('span');
      span.style.color = hex15(p.r, p.g, p.b);
      span.append(colorize(p.name, hex15(p.r, p.g, p.b)));
      name.append(span);
      const alive = tr.insertCell();
      alive.textContent = p.spectator ? '-' : p.alive ? 'Yes' : 'No';
      alive.className = p.spectator ? 'dim' : p.alive ? 'yes' : 'no';
      tr.insertCell().textContent = p.score;
      tr.insertCell().textContent = p.kills;
      tr.insertCell().textContent = p.bot ? 'AI' : p.ping;
      const tags = tr.insertCell();
      tags.className = 'dim';
      tags.textContent = [p.admin ? 'admin' : '', p.spectator ? 'spectator' : ''].filter(Boolean).join(', ');
    }
    this.scoresEl.replaceChildren(table);
  }

  // -------------------------------------------------------------------
  // Name tags: over other cycles, shown for five seconds after they come into
  // view (FADEOUT_NAME_DELAY), then fading out

  nameTags(game, renderer, now, own) {
    const seen = new Set();
    if (this.prefs.names !== false && game.world) {
      for (const c of game.world.cycles.values()) {
        if (!c.alive || c.id === own) continue;
        const d = game.display(c);
        const p = renderer.project(d.x - c.dx * 0.35, d.y - c.dy * 0.35, 1.0);
        let tag = this.tags.get(c.id);
        if (!p || p.x < -50 || p.y < -50 || p.x > renderer.cssW + 50 || p.y > renderer.cssH + 50) {
          if (tag) tag.since = null;
          continue;
        }
        seen.add(c.id);
        if (!tag) {
          const el = document.createElement('div');
          el.className = 'tag';
          el.append(colorize(game.names.get(c.id)?.name ?? ''));
          this.tagsEl.append(el);
          tag = { el, since: null };
          this.tags.set(c.id, tag);
        }
        if (tag.since === null) tag.since = now;
        const age = (now - tag.since) / 1000;
        const alpha = this.prefs.names === 'always' ? 0.75 : 0.75 * Math.max(0, Math.min(1, 5 - age));
        tag.el.style.opacity = alpha;
        tag.el.style.transform = `translate(${p.x}px, ${p.y - renderer.cssH * 0.0333}px) translate(-50%, -100%)`;
      }
    }
    for (const [id, tag] of this.tags) {
      if (!seen.has(id)) {
        tag.el.style.opacity = 0;
        if (!game.world?.cycles.get(id)?.alive) {
          tag.el.remove();
          this.tags.delete(id);
        }
      }
    }
  }

  clearTags() {
    for (const tag of this.tags.values()) tag.el.remove();
    this.tags.clear();
  }

  // -------------------------------------------------------------------
  // The cockpit

  draw(state) {
    const now = performance.now();
    this.tickConsole(now);
    this.tickCenter(now);

    const cv = this.canvas;
    // the cockpit is lines and text: a sharp picture needs no more than 1.5 pixels a point
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * Math.max(0.75, this.prefs.quality ?? 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (this.prefs.hud === false || state.chatting) return;

    this.W = W;
    this.H = H;
    // sizes follow the height, as on the original's 4:3 screens; on a screen
    // narrower than that (a phone held upright) they follow the width
    this.S = Math.min(H, W * 0.75);

    // top: clock, time and frame rate
    if (this.prefs.clock !== false && !this.touch) this.drawTop(state);

    if (this.touch) {
      if (state.showCockpit) this.minimap(state);
      return;
    }

    if (!state.showCockpit) return;
    const c = state.cycle;

    if (c) {
      const speed = c.speed();
      this.maxSpeed = Math.max(this.maxSpeed ?? 0, speed);
      const max = Math.max(20, Math.ceil(this.maxSpeed / 10) * 10);
      this.needle(-0.165, -0.9, 0.15, speed, 0, max, 'Speed');
      this.bar(-0.55, -0.9, 0.15, 0.05, c.rubber, 0, state.settings.rubber, 'Rubber',
        [[0, [0, 1, 0]], [0.3, [0, 1, 0]], [0.6, [1, 1, 0]], [0.8, [1, 0, 0]], [1, [1, 0, 0]]]);
      this.bar(0.25, -0.9, 0.15, 0.05, c.brakeRes, 0, 1, 'Brakes',
        [[0, [1, 0, 0]], [0.5, [1, 1, 0]], [1, [0, 1, 0]]]);
    }

    // the bottom row of labels
    const f = state.fastest;
    this.label(-0.7, -0.96, 0.035, [['Fastest:', f ? strip(f.name) : '-', f ? `(${f.speed.toFixed(1)})` : '']]);
    this.label(-0.15, -0.96, 0.035, [['Ping:', String(state.ping)]]);
    this.label(0.06, -0.96, 0.035, [['Enemies:', String(state.enemies), 'Friends:', '0']]);

    // scores
    const me = state.myScore, top = state.topScore;
    const color = me === top ? '#ff9d50' : me > top ? '#11ff11' : '#11ffff';
    this.label(-0.93, -0.88, 0.04, [['Me:', 'Top:'], [String(me), String(top)]], color, 'Scores');

    this.minimap(state);
  }

  X(x) { return ((x + 1) / 2) * this.W; }
  Y(y) { return this.H - (y + 1) * (2 / 3) * this.H; }
  SX(s) { return (s * this.W) / 2; }
  SY(s) { return s * (2 / 3) * this.S; }

  text(str, x, y, height, align = 'center', color = '#fff') {
    const ctx = this.ctx;
    const px = Math.max(8, this.SY(height));
    ctx.font = `${px}px Armagetronad, "DejaVu Sans Mono", monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(str, this.X(x), this.Y(y));
  }

  needle(x, y, size, value, min, max, caption) {
    const ctx = this.ctx;
    const v = Math.max(min, Math.min(max, value));
    const a = ((v - min) / (max - min)) * Math.PI;
    const r = Math.min(this.SX(size), this.SY(size));
    const cx = this.X(x), cy = this.Y(y);
    ctx.strokeStyle = '#f00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 0.1 * r * Math.cos(a), cy - 0.1 * r * Math.sin(a));
    ctx.lineTo(cx - r * Math.cos(a), cy - r * Math.sin(a));
    ctx.stroke();
    const k = r / this.SY(1);
    ctx.font = `${Math.max(8, 0.2 * r)}px Armagetronad, monospace`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value.toFixed(1), cx - 1.45 * r * Math.cos(a), cy - 1.35 * r * Math.sin(a));
    ctx.font = `${Math.max(8, 0.24 * r)}px Armagetronad, monospace`;
    ctx.fillText(String(min), cx - r, cy + 0.12 * r);
    ctx.fillText(String(max), cx + r, cy + 0.12 * r);
    ctx.fillText(caption, cx, cy + 0.2 * r);
    void k;
  }

  bar(x, y, sx, sy, value, min, max, caption, gradient) {
    const ctx = this.ctx;
    const v = Math.max(min, Math.min(max, value));
    const f = max > min ? (v - min) / (max - min) : 0;
    const x0 = this.X(x - sx), x1 = this.X(x + sx);
    const y0 = this.Y(y + sy), y1 = this.Y(y);
    const w = x1 - x0, h = y1 - y0;
    const split = x0 + w * f;

    // the empty part: the gauge image at half alpha; the full part: the filled
    // image in the gradient's colour at this value
    const img = this.images.gauge, fill = this.images.gauge_filled;
    ctx.save();
    ctx.beginPath();
    ctx.rect(split, y0, x1 - split, h);
    ctx.clip();
    ctx.globalAlpha = 0.5;
    if (img) ctx.drawImage(img, x0, y0, w, h);
    ctx.restore();

    const col = sample(gradient, f);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, split - x0, h);
    ctx.clip();
    if (fill) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(fill, x0, y0, w, h);
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = rgb(col);
      ctx.fillRect(x0, y0, w, h);
    } else {
      ctx.fillStyle = rgb(col);
      ctx.fillRect(x0, y0, w, h);
    }
    ctx.restore();

    const th = 0.24 * sx;
    this.text(value.toFixed(2), x, y + 0.2 * sx + sy * 0.4, th);
    this.text(String(min), x - sx, y - 0.15 * sx, th);
    this.text(String(max), x + sx, y - 0.15 * sx, th);
    this.text(caption, x, y - 0.15 * sx, th);
  }

  label(x, y, height, rows, color = '#fff', caption = null) {
    const ctx = this.ctx;
    const px = Math.max(8, this.SY(height));
    ctx.font = `${px}px Armagetronad, "DejaVu Sans Mono", monospace`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    let yy = this.Y(y);
    if (caption) {
      ctx.fillStyle = '#fff';
      ctx.fillText(caption, this.X(x), yy - px);
      ctx.fillStyle = color;
    }
    // columns as wide as their widest cell plus a gap
    const widths = [];
    for (const row of rows) row.forEach((cell, i) => { widths[i] = Math.max(widths[i] ?? 0, ctx.measureText(cell).width); });
    for (const row of rows) {
      let xx = this.X(x);
      row.forEach((cell, i) => {
        ctx.fillText(cell, xx, yy);
        xx += widths[i] + px * 0.5;
      });
      yy += px;
    }
  }

  drawTop(state) {
    const ctx = this.ctx;
    const d = new Date();
    // the clock face and three hands
    const cx = this.X(0.3), cy = this.Y(0.4);
    const r = Math.min(this.SX(0.075), this.SY(0.075));
    if (this.images.clock) {
      ctx.globalAlpha = 0.8;
      ctx.drawImage(this.images.clock, cx - r, cy - r, 2 * r, 2 * r);
      ctx.globalAlpha = 1;
    }
    const hand = (value, max, len, color, width) => {
      const a = (value / max) * Math.PI * 2 - Math.PI / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * r * len, cy + Math.sin(a) * r * len);
      ctx.stroke();
    };
    hand(d.getHours() % 12 + d.getMinutes() / 60, 12, 0.5, '#fff', 2);
    hand(d.getMinutes() + d.getSeconds() / 60, 60, 0.75, '#fff', 1.5);
    hand(d.getSeconds(), 60, 0.75, '#fff', 1);

    const h12 = ((d.getHours() + 11) % 12) + 1;
    const time = `${String(h12).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
    const running = Math.floor((performance.now() - this.started) / 1000);
    this.label(0.4, 0.45, 0.04, [
      ['Time:', time],
      ['Framerate:', `${Math.round(state.fps)} FPS`],
      ['Running for:', `${running} Seconds`],
      ['Music:', state.song ?? ''],
    ]);
    // the frame rate bar: red, green up to the rate
    const x0 = this.X(0.89 - 0.08), x1 = this.X(0.89 + 0.08), y0 = this.Y(0.38 + 0.03), y1 = this.Y(0.38);
    const f = Math.max(0, Math.min(1, state.fps / 100));
    const img = this.images.gauge_filled;
    const draw = (from, to, color) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(from, y0, to - from, y1 - y0);
      ctx.clip();
      if (img) {
        ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0);
        ctx.globalCompositeOperation = 'multiply';
      }
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.restore();
    };
    draw(x0 + (x1 - x0) * f, x1, '#f00');
    draw(x0, x0 + (x1 - x0) * f, '#0f0');
  }

  // The map (cMap): the arena, trails, cycles as triangles. Left shift
  // switches between the whole arena and a zoomed view around the cycle.
  minimap(state) {
    if (this.prefs.map === false) return;
    const game = state.game;
    if (!game.world) return;
    const ctx = this.ctx;
    const size = game.world.map.size;
    let half = Math.min(this.SX(0.25), this.SY(0.25));
    let cx = this.X(0.73), cy = this.Y(-0.72);
    if (this.touch) {
      half = Math.min(this.W, this.H) * 0.12;
      cx = this.W - 12 - half;
      cy = 60 + half;
    }
    const focus = state.focus;
    const mode = MAP_MODES[this.mapMode % MAP_MODES.length];

    // map rotation: spawn direction up, camera direction up, cycle direction up, or none
    let angle = 0;
    const up = (dx, dy) => -Math.atan2(dx, dy);
    if (mode.rotation === 'spawn' && state.spawnDir) angle = up(state.spawnDir[0], state.spawnDir[1]);
    else if (mode.rotation === 'camera' && state.cameraDir) angle = up(state.cameraDir[0], state.cameraDir[1]);
    else if (mode.rotation === 'cycle' && focus) angle = up(focus.dx, focus.dy);

    let scale, ox, oy;
    if (mode.mode === 'cycle' && focus) {
      scale = (half / (size / 2)) * mode.zoom;
      ox = focus.x;
      oy = focus.y;
    } else {
      scale = half / (size / 2) / Math.SQRT2 * (mode.rotation === 'fixed' ? Math.SQRT2 : 1);
      ox = size / 2;
      oy = size / 2;
    }

    ctx.save();
    ctx.beginPath();
    if (mode.clip === 'ellipse') ctx.arc(cx, cy, half, 0, Math.PI * 2);
    else ctx.rect(cx - half, cy - half, 2 * half, 2 * half);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(scale, -scale);
    ctx.translate(-ox, -oy);

    // background: the tinted floor texture inside the rim
    ctx.beginPath();
    const rim = game.world.map.rim;
    rim.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    if (this.mapPattern) {
      // one pattern, made again only for another arena size
      if (this.mapFill?.size !== size) {
        const pat = ctx.createPattern(this.mapPattern, 'repeat');
        pat.setTransform(new DOMMatrix().scale(0.075 * size / 256 * 4));
        this.mapFill = { size, pat };
      }
      ctx.fillStyle = this.mapFill.pat;
    } else {
      ctx.fillStyle = '#132';
    }
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1 / scale;
    ctx.stroke();
    ctx.globalAlpha = 1;

    const t = state.time;
    for (const c of game.world.cycles.values()) {
      const col = trailOf(game.names.get(c.id));
      if (!c.alive && t - c.deathTime > game.settings.wallsStayUp + 0.7 && game.settings.wallsStayUp >= 0) continue;
      ctx.strokeStyle = rgb(col);
      ctx.lineWidth = 1.5 / scale;
      ctx.beginPath();
      c.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      const d = game.display(c);
      ctx.lineTo(c.alive ? d.x : c.x, c.alive ? d.y : c.y);
      ctx.stroke();
      if (c.alive) {
        ctx.fillStyle = rgb(game.names.get(c.id)?.color ?? [1, 1, 1]);
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.rotate(Math.atan2(c.dy, c.dx));
        const k = 5 / scale;
        ctx.beginPath();
        ctx.moveTo(0.5 * k * 2, 0);
        ctx.lineTo(-0.5 * k * 2, 0.5 * k * 2);
        ctx.lineTo(-0.5 * k * 2, -0.5 * k * 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
    // explosions: the same rays, flat
    for (const e of game.explosions) {
      const age = t - e.time;
      if (age < 0 || age > 2) continue;
      ctx.strokeStyle = rgb(e.color);
      ctx.globalAlpha = Math.max(0, Math.min(1, 2 - age));
      ctx.beginPath();
      const a1 = (age + 0.01) * 100, e0 = Math.max(0, age + 0.01 - 1) * 100;
      for (const [dx, dy] of e.rays) {
        ctx.moveTo(e.x + dx * e0, e.y + dy * e0);
        ctx.lineTo(e.x + dx * a1, e.y + dy * a1);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
}

const MAP_MODES = [
  { mode: 'full', rotation: 'spawn' },
  { mode: 'cycle', rotation: 'camera', zoom: 3, clip: 'ellipse' },
  { mode: 'cycle', rotation: 'cycle', zoom: 3 },
  { mode: 'cycle', rotation: 'spawn', zoom: 4 },
  { mode: 'full', rotation: 'fixed' },
];

function sample(gradient, f) {
  for (let i = 0; i + 1 < gradient.length; i++) {
    const [a, ca] = gradient[i], [b, cb] = gradient[i + 1];
    if (f <= b) {
      const t = b > a ? (f - a) / (b - a) : 0;
      return ca.map((v, k) => v + (cb[k] - v) * t);
    }
  }
  return gradient[gradient.length - 1][1];
}
