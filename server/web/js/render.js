// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Draws the arena the way the original does (src/engine/eDisplay.cpp,
// src/tron/gWall.cpp, gCycle.cpp, gExplosion.cpp): the two-texture grid floor,
// the tall rim walls, opaque trails with the lightning texture and a bright
// top line, the fading head of each trail, the cycle models lit by two
// coloured lights, explosions as a burst of lines, sparks when grinding.

import { createContext, program, DynamicMesh, StaticMesh, loadImage, texture, solid } from './gl.js';
import * as M from './mat.js';
import { MODELS } from './models.js';

const VS_BASIC = `#version 300 es
in vec3 aPos; in vec2 aUv; in vec4 aColor;
uniform mat4 uMvp;
out vec2 vUv; out vec4 vColor;
void main() { vUv = aUv; vColor = aColor; gl_Position = uMvp * vec4(aPos, 1.0); }`;

const FS_BASIC = `#version 300 es
precision highp float;
in vec2 vUv; in vec4 vColor;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv) * vColor; }`;

const VS_FLOOR = `#version 300 es
in vec3 aPos;
uniform mat4 uMvp;
out vec2 vWorld;
void main() { vWorld = aPos.xy; gl_Position = uMvp * vec4(aPos, 1.0); }`;

// FLOOR_DETAIL two textures: lines along x from floor_a, along y from floor_b (added)
const FS_FLOOR = `#version 300 es
precision highp float;
in vec2 vWorld;
uniform sampler2D uA; uniform sampler2D uB;
uniform vec3 uFloor; uniform float uGrid;
out vec4 outColor;
void main() {
  vec4 a = texture(uA, vec2(vWorld.x * 0.01 / uGrid, vWorld.y / uGrid));
  vec4 b = texture(uB, vec2(vWorld.x / uGrid, 0.5));
  vec3 c = uFloor * (a.r * a.a + b.r);
  outColor = vec4(min(c, vec3(1.0)), 1.0);
}`;

const VS_MODEL = `#version 300 es
in vec3 aPos; in vec3 aNormal; in vec2 aUv;
uniform mat4 uMvp; uniform mat4 uModel;
out vec2 vUv; out vec3 vNormal;
void main() {
  vUv = aUv;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

// Two directional lights like the original's fixed function setup; with
// specular at shininess 0 any face towards a light saturates to the texture.
const FS_MODEL = `#version 300 es
precision highp float;
in vec2 vUv; in vec3 vNormal;
uniform sampler2D uTex; uniform float uAlpha;
out vec4 outColor;
const vec3 L0 = normalize(vec3(320.0, 240.0, 200.0));
const vec3 L1 = normalize(vec3(-240.0, -100.0, 200.0));
void main() {
  vec3 n = normalize(vNormal);
  vec3 light = vec3(0.04);
  float d0 = dot(n, L0), d1 = dot(n, L1);
  if (d0 > 0.0) light += vec3(1.0, 0.7, 0.7) * (min(1.0, 2.0 * d0) + 1.0);
  if (d1 > 0.0) light += vec3(0.7, 0.7, 1.0) * (min(1.0, 2.0 * d1) + 1.0);
  vec4 t = texture(uTex, vUv);
  outColor = vec4(t.rgb * min(light, vec3(1.0)), uAlpha);
}`;

const LAYOUT = [['aPos', 3], ['aUv', 2], ['aColor', 4]];

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = createContext(canvas);
    const gl = this.gl;
    this.basic = program(gl, VS_BASIC, FS_BASIC);
    this.floorProg = program(gl, VS_FLOOR, FS_FLOOR);
    this.modelProg = program(gl, VS_MODEL, FS_MODEL);

    this.walls = new DynamicMesh(gl, this.basic, LAYOUT);       // opaque trails
    this.heads = new DynamicMesh(gl, this.basic, LAYOUT);       // the fading head sections
    this.lines = new DynamicMesh(gl, this.basic, LAYOUT, gl.LINES);
    this.glow = new DynamicMesh(gl, this.basic, LAYOUT, gl.LINES);  // additive: sparks
    this.rim = new DynamicMesh(gl, this.basic, LAYOUT);
    this.shadows = new DynamicMesh(gl, this.basic, LAYOUT);
    this.floorMesh = new DynamicMesh(gl, this.floorProg, [['aPos', 3]]);

    const part = (m) => new StaticMesh(gl, this.modelProg, [['aPos', 3], ['aNormal', 3], ['aUv', 2]], m.v, m.i);
    this.body = part(MODELS.body);
    this.front = part(MODELS.front);
    this.rear = part(MODELS.rear);

    this.white = solid(gl);
    this.tinted = new Map();
    this.visual = new Map();
    this.sparks = [];
    this.rimHeights = [];
    this.floorColor = [0.5, 0.5, 0.7];
    this.gridSize = 1;
    this.ready = this.load();
  }

  async load() {
    const gl = this.gl;
    const names = ['floor_a', 'floor_b', 'dir_wall', 'rim_wall', 'shadow', 'cycle_body', 'cycle_wheel'];
    const images = await Promise.all(names.map((n) => loadImage(`tex/${n}.png`)));
    const img = Object.fromEntries(names.map((n, i) => [n, images[i]]));
    this.images = img;
    this.tex = {
      floorA: texture(gl, img.floor_a),
      floorB: texture(gl, img.floor_b),
      wall: texture(gl, img.dir_wall, { clampT: true }),
      rim: texture(gl, img.rim_wall, { clampT: true }),
      shadow: texture(gl, img.shadow, { repeat: false }),
    };
  }

  // a new round: nothing carries over from the last one
  reset() {
    this.visual.clear();
    this.sparks = [];
    this.rimHeights = [];
  }

  // cycle_body/cycle_wheel with the player's colour where they are transparent
  tint(color) {
    const key = color.map((c) => Math.round(c * 255)).join(',');
    let t = this.tinted.get(key);
    if (t) return t;
    const make = (image) => {
      const cv = document.createElement('canvas');
      cv.width = image.width;
      cv.height = image.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, cv.width, cv.height);
      const d = data.data;
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        d[i] = a * d[i] + (1 - a) * color[0] * 255;
        d[i + 1] = a * d[i + 1] + (1 - a) * color[1] * 255;
        d[i + 2] = a * d[i + 2] + (1 - a) * color[2] * 255;
        d[i + 3] = 255;
      }
      ctx.putImageData(data, 0, 0);
      return texture(this.gl, cv, { repeat: true });
    };
    t = { body: make(this.images.cycle_body), wheel: make(this.images.cycle_wheel) };
    this.tinted.set(key, t);
    return t;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * (this.scale ?? 1);
    // read the layout once a frame; project() and the name tags use these
    this.cssW = this.canvas.clientWidth;
    this.cssH = this.canvas.clientHeight;
    const w = Math.max(1, Math.round(this.cssW * dpr));
    const h = Math.max(1, Math.round(this.cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h };
  }

  // The original's field of view is horizontal: 90 degrees, stretched on wide screens.
  projection(fovDegrees, aspect) {
    const xmul = Math.max(aspect / 1.5, 1) * Math.tan((fovDegrees * Math.PI) / 360);
    const ymul = xmul / aspect;
    return M.perspective(2 * Math.atan(ymul), aspect, 0.1, 5000);
  }

  project(x, y, z) {
    const m = this.mvp;
    if (!m) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.01) return null;
    return { x: (cx / cw + 1) / 2 * this.cssW, y: (1 - cy / cw) / 2 * this.cssH, depth: cw };
  }

  draw(scene, camera, time, dt) {
    const gl = this.gl;
    const { w, h } = this.resize();
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.tex || !scene.world) return;

    const proj = this.projection(camera.fov, w / h);
    const view = M.lookAt(camera.eye, camera.target, [0, 0, 1]);
    this.mvp = M.multiply(proj, view);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);

    this.drawFloor(scene);
    this.drawRim(scene, camera, dt);
    this.buildWalls(scene, time);
    this.drawOpaque();
    this.drawCycles(scene, time, dt);
    this.drawTransparent(scene, time, dt);
  }

  drawFloor(scene) {
    const gl = this.gl;
    const s = scene.world.map.size;
    const f = this.floorMesh;
    if (this.floorSize !== s) {
      this.floorSize = s;
      f.reset();
      f.v(0, 0, 0); f.v(s, 0, 0); f.v(s, s, 0);
      f.v(0, 0, 0); f.v(s, s, 0); f.v(0, s, 0);
      f.upload();
    }
    gl.useProgram(this.floorProg.p);
    gl.uniformMatrix4fv(this.floorProg.u.uMvp, false, this.mvp);
    gl.uniform3fv(this.floorProg.u.uFloor, this.floorColor);
    gl.uniform1f(this.floorProg.u.uGrid, this.gridSize);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.floorA);
    gl.uniform1i(this.floorProg.u.uA, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.floorB);
    gl.uniform1i(this.floorProg.u.uB, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    f.draw();
  }

  // Rim walls: "infinitely" high, texture every 100 units along and 50 up, the
  // bottom stripe at the floor. A wall between the camera and its target is
  // lowered so the view stays free, and grows back afterwards.
  drawRim(scene, camera, dt) {
    const gl = this.gl;
    const rim = scene.world.rim;
    const r = this.rim;
    r.reset();
    let along = 0;
    const full = 1000;
    rim.forEach((seg, i) => {
      const dx = seg.x1 - seg.x0, dy = seg.y1 - seg.y0;
      const len = Math.hypot(dx, dy);
      // is the camera on the outside of this wall, looking in across it?
      const nx = -dy / len, ny = dx / len;
      const side = (camera.eye[0] - seg.x0) * nx + (camera.eye[1] - seg.y0) * ny;
      const inside = (scene.world.map.size / 2 - seg.x0) * nx + (scene.world.map.size / 2 - seg.y0) * ny;
      let hh = this.rimHeights[i] ?? full;
      if (side * inside < 0 && camera.eye[2] < full) {
        hh = Math.min(hh, Math.max(0.25, camera.eye[2] * 0.5));
      } else {
        hh = Math.min(full, hh * (1 + 10 * dt) + 5 * dt);
      }
      this.rimHeights[i] = hh;
      const light = 0.7 + 0.3 * (dx * dx) / (dx * dx + dy * dy);
      const u0 = along / 100, u1 = (along + len) / 100;
      const v1 = 1 - hh / 50;
      r.v(seg.x0, seg.y0, 0, u0, 1, light, light, light, 1);
      r.v(seg.x1, seg.y1, 0, u1, 1, light, light, light, 1);
      r.v(seg.x1, seg.y1, hh, u1, v1, light, light, light, 1);
      r.v(seg.x0, seg.y0, 0, u0, 1, light, light, light, 1);
      r.v(seg.x1, seg.y1, hh, u1, v1, light, light, light, 1);
      r.v(seg.x0, seg.y0, hh, u0, v1, light, light, light, 1);
      along += len;
    });
    r.upload();
    gl.useProgram(this.basic.p);
    gl.uniformMatrix4fv(this.basic.u.uMvp, false, this.mvp);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.rim);
    gl.uniform1i(this.basic.u.uTex, 0);
    r.draw();
  }

  // The trails: every segment of every cycle, minus holes, minus the head
  // section of a living cycle (drawn separately, fading into the bike).
  buildWalls(scene, time) {
    const world = scene.world;
    const s = world.s;
    const walls = this.walls, lines = this.lines, heads = this.heads;
    walls.reset();
    lines.reset();
    heads.reset();

    for (const c of world.cycles.values()) {
      let hfrac = 1, bright = 0, lineAlpha = 1;
      if (!c.alive && s.wallsStayUp >= 0) {
        const since = time - c.deathTime - s.wallsStayUp;
        if (since > 0) {
          const t = since * 2;
          if (t >= 1) continue;
          hfrac = 1 - t;
          bright = 0.5 / (t + 0.5);
          lineAlpha = 1 - t;
        }
      }
      const base = trailOf(scene.names.get(c.id));
      const disp = scene.display(c);
      const end = c.alive ? disp.dist : c.dist;
      const headStart = c.alive ? Math.max(0, end - 5) : Infinity;
      const tail = s.wallsLength > 0 ? end - s.wallsLength : -Infinity;
      const pts = c.points;

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = i + 1 < pts.length ? pts[i + 1] : (c.alive ? { x: disp.x, y: disp.y, d: end } : { x: c.x, y: c.y, d: c.dist });
        const len = q.d - p.d;
        if (len <= 1e-6) continue;
        const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
        const shade = 0.7 + 0.3 * (ux * ux) / (ux * ux + uy * uy || 1);
        const r = Math.min(1, base[0] * shade + bright), g = Math.min(1, base[1] * shade + bright), b = Math.min(1, base[2] * shade + bright);

        // visible stretches: [p.d, min(q.d, headStart)] minus holes and the cut-off tail
        let from = Math.max(p.d, tail);
        const to = Math.min(q.d, headStart);
        if (to <= from) continue;
        const pieces = [];
        for (const hole of c.holes) {
          if (hole[1] <= from || hole[0] >= to) continue;
          if (hole[0] > from) pieces.push([from, hole[0]]);
          from = Math.max(from, hole[1]);
        }
        if (from < to) pieces.push([from, to]);

        const top = hfrac;
        for (const [a, bb] of pieces) {
          const ax = p.x + ux * (a - p.d), ay = p.y + uy * (a - p.d);
          const bx = p.x + ux * (bb - p.d), by = p.y + uy * (bb - p.d);
          const ua = a / 2.5, ub = bb / 2.5;
          walls.v(ax, ay, 0, ua, hfrac, r, g, b, 1);
          walls.v(bx, by, 0, ub, hfrac, r, g, b, 1);
          walls.v(bx, by, top, ub, 0, r, g, b, 1);
          walls.v(ax, ay, 0, ua, hfrac, r, g, b, 1);
          walls.v(bx, by, top, ub, 0, r, g, b, 1);
          walls.v(ax, ay, top, ua, 0, r, g, b, 1);
          lines.v(ax, ay, top, 0, 0, r, g, b, lineAlpha);
          lines.v(bx, by, top, 0, 0, r, g, b, lineAlpha);
        }
      }

      if (c.alive) this.buildHead(c, disp, end, base, scene);
    }
    walls.upload();
    lines.upload();
    heads.upload();
  }

  // RenderBegin: the newest five units rise off the floor towards the rear of
  // the bike, getting whiter and more transparent.
  buildHead(c, disp, end, base, scene) {
    const heads = this.heads, lines = this.lines;
    const pts = c.points;
    const startD = Math.max(pts[0].d, end - 5);
    if (end - startD < 1e-3) return;
    const ppx = disp.x - c.dx * 1.5, ppy = disp.y - c.dy * 1.5;
    const skew = this.visual.get(c.id)?.skew ?? 0;

    // sample distances: every unit, plus the corners inside the head
    const ds = [];
    for (let k = 0; k <= 5; k++) ds.push(startD + (end - startD) * k / 5);
    for (const p of pts) if (p.d > startD && p.d < end) ds.push(p.d);
    ds.sort((a, b) => a - b);

    const at = (d) => {
      // the trail point at distance d
      for (let i = pts.length - 1; i >= 0; i--) {
        if (pts[i].d <= d + 1e-9) {
          const p = pts[i];
          const q = i + 1 < pts.length ? pts[i + 1] : { x: disp.x, y: disp.y, d: end };
          const len = q.d - p.d;
          if (len <= 1e-9) return { x: p.x, y: p.y };
          const f = (d - p.d) / len;
          return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
        }
      }
      return { x: pts[0].x, y: pts[0].y };
    };

    const verts = ds.map((d) => {
      const rat = Math.max(0, Math.min(1, 1 - (end - d) / 5));
      const w = at(d);
      const f = (0.2 * rat + rat * rat) / 2;
      const x = w.x + (ppx - w.x) * f, y = w.y + (ppy - w.y) * f;
      const H = 1 - (rat * rat) / 2;
      const lean = H * skew * rat * rat;
      const r2 = rat * rat;
      return {
        x, y, H, u: d / 2.5,
        tx: x + c.dy * lean, ty: y - c.dx * lean,
        r: Math.min(1, base[0] + r2), g: Math.min(1, base[1] + r2), b: Math.min(1, base[2] + r2), a: 1 - r2,
      };
    });

    for (let i = 0; i + 1 < verts.length; i++) {
      const A = verts[i], B = verts[i + 1];
      heads.v(A.x, A.y, 0, A.u, 1, A.r, A.g, A.b, A.a);
      heads.v(B.x, B.y, 0, B.u, 1, B.r, B.g, B.b, B.a);
      heads.v(B.tx, B.ty, B.H, B.u, 0, B.r, B.g, B.b, B.a);
      heads.v(A.x, A.y, 0, A.u, 1, A.r, A.g, A.b, A.a);
      heads.v(B.tx, B.ty, B.H, B.u, 0, B.r, B.g, B.b, B.a);
      heads.v(A.tx, A.ty, A.H, A.u, 0, A.r, A.g, A.b, A.a);
      lines.v(A.tx, A.ty, A.H, 0, 0, A.r, A.g, A.b, A.a);
      lines.v(B.tx, B.ty, B.H, 0, 0, B.r, B.g, B.b, B.a);
    }
    void scene;
  }

  drawOpaque() {
    const gl = this.gl;
    gl.useProgram(this.basic.p);
    gl.uniformMatrix4fv(this.basic.u.uMvp, false, this.mvp);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.wall);
    gl.disable(gl.BLEND);
    this.walls.draw();
    // the top line, a hair in front of the wall
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.depthMask(false);
    this.lines.draw();
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.BLEND);
  }

  // The bikes, their wheels turning with the speed and leaning into turns.
  drawCycles(scene, time, dt) {
    const gl = this.gl;
    const world = scene.world;
    const shadows = this.shadows;
    shadows.reset();

    gl.useProgram(this.modelProg.p);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.uniform1i(this.modelProg.u.uTex, 0);
    gl.uniform1f(this.modelProg.u.uAlpha, 1);

    for (const c of world.cycles.values()) {
      let v = this.visual.get(c.id);
      if (!v) this.visual.set(c.id, v = { front: 0, rear: 0, skew: 0, skewDot: 0, turns: c.turns, dir: c.dir });
      if (!c.alive) continue;

      // the lean: a spring, kicked by turns, pushed away from walls close by
      if (c.turns !== v.turns) {
        const d = ((c.dir - v.dir + 4) % 4) === 1 ? 1 : -1;
        v.skewDot += -4 * d;
        v.turns = c.turns;
        v.dir = c.dir;
      }
      const step = Math.min(dt, 0.2);
      const lr = this.sideRoom(world, c);
      v.skewDot -= 128 * (v.skew + lr / 2) * step;
      v.skewDot /= 1 + 24 * step;
      v.skew = Math.max(-0.5, Math.min(0.5, v.skew + v.skewDot * step));
      const speed = c.frozen ? 0 : c.speed();
      v.front += (2 * speed * step) / 0.43;
      v.rear += (2 * speed * step) / 0.73;

      if (scene.hide === c.id) continue;

      const disp = scene.display(c);
      const color = scene.names.get(c.id)?.color ?? [1, 1, 1];
      const tex = this.tint(color);

      let m = M.heading(M.identity(), disp.x, disp.y, 0, c.dx, c.dy);
      m = M.scale(m, 0.5, 0.5, 0.5);
      m = M.translate(m, -1.5, 0, 0);
      m = M.rotate(m, Math.atan(v.skew), 1, 0, 0);

      this.model(this.body, m, tex.body);
      this.model(this.rear, M.rotate(M.translate(m, 0, 0, 0.73), v.rear, 0, 1, 0), tex.wheel);
      this.model(this.front, M.rotate(M.translate(m, 1.84, 0, 0.43), v.front, 0, 1, 0), tex.wheel);

      // the shadow blob under the bike
      const px = -c.dy, py = c.dx;
      const q = (a, l) => [disp.x + c.dx * a + px * l, disp.y + c.dy * a + py * l];
      const [x0, y0] = q(-1.05, -0.2), [x1, y1] = q(0.3, -0.2), [x2, y2] = q(0.3, 0.2), [x3, y3] = q(-1.05, 0.2);
      shadows.v(x0, y0, 0.01, 0, 1, 0, 0, 0, 1);
      shadows.v(x1, y1, 0.01, 0, 0, 0, 0, 0, 1);
      shadows.v(x2, y2, 0.01, 1, 0, 0, 0, 0, 1);
      shadows.v(x0, y0, 0.01, 0, 1, 0, 0, 0, 1);
      shadows.v(x2, y2, 0.01, 1, 0, 0, 0, 0, 1);
      shadows.v(x3, y3, 0.01, 1, 1, 0, 0, 0, 1);
    }
    gl.disable(gl.CULL_FACE);
    void time;
  }

  model(mesh, m, tex) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.modelProg.u.uMvp, false, M.multiply(this.mvp, m));
    gl.uniformMatrix4fv(this.modelProg.u.uModel, false, m);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    mesh.draw();
  }

  // (free room left - free room right) / reach, from two short feelers at 45 degrees
  sideRoom(world, c) {
    const reach = 0.25;
    const probe = (side) => {
      const rx = c.dx - side * c.dy, ry = c.dy + side * c.dx;
      const hit = world.ray(c.x, c.y, rx / Math.SQRT2, ry / Math.SQRT2, reach, c, c.time);
      return hit ? hit.t : reach;
    };
    return (probe(1) - probe(-1)) / reach;
  }

  drawTransparent(scene, time, dt) {
    const gl = this.gl;
    gl.useProgram(this.basic.p);
    gl.uniformMatrix4fv(this.basic.u.uMvp, false, this.mvp);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    // shadows first, on the floor
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -2);
    this.shadows.upload();
    gl.bindTexture(gl.TEXTURE_2D, this.tex.shadow);
    this.shadows.draw();
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.bindTexture(gl.TEXTURE_2D, this.tex.wall);
    this.heads.draw();

    // explosions and chat pyramids as lines and triangles
    const lines = this.lines;
    lines.reset();
    for (const e of scene.explosions) {
      const t = time - e.time;
      if (t < 0) continue;
      const a1 = (t + 0.01) * 100;
      const e0 = Math.max(0, t + 0.01 - 1) * 100;
      const alpha = Math.max(0, Math.min(1, 2 - t));
      if (alpha <= 0) continue;
      const [r, g, b] = e.color;
      for (const [dx, dy, dz] of e.rays) {
        lines.v(e.x + dx * e0, e.y + dy * e0, dz * e0, 0, 0, r, g, b, alpha);
        lines.v(e.x + dx * a1, e.y + dy * a1, dz * a1, 0, 0, r, g, b, alpha);
      }
    }
    this.pyramids(scene, time, lines);
    lines.upload();
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    lines.draw();

    this.drawSparks(scene, dt);

    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // the spinning pyramid over somebody who is typing a chat message
  pyramids(scene, time, lines) {
    for (const c of scene.world.cycles.values()) {
      if (!c.alive || !scene.chatting?.has(c.id)) continue;
      const disp = scene.display(c);
      const cx = disp.x - c.dx * 0.75, cy = disp.y - c.dy * 0.75;
      for (let k = 0; k < 2; k++) {
        const a = time + (k * Math.PI) / 2;
        const f = k ? 0.7 : 1;
        const ox = Math.cos(a) * 0.19, oy = Math.sin(a) * 0.19;
        const tri = [[cx - ox, cy - oy, 1.63], [cx + ox, cy + oy, 1.63], [cx, cy, 1.25]];
        for (let i = 0; i < 3; i++) {
          const p = tri[i], q = tri[(i + 1) % 3];
          lines.v(p[0], p[1], p[2], 0, 0, f, f, 0, 1);
          lines.v(q[0], q[1], q[2], 0, 0, f, f, 0, 1);
        }
      }
    }
  }

  // Sparks when a cycle grinds a wall: short streaks, bouncing, added on top.
  drawSparks(scene, dt) {
    const gl = this.gl;
    const world = scene.world;
    const step = Math.min(dt, 0.1);
    for (const c of world.cycles.values()) {
      if (!c.alive || c.frozen) continue;
      for (let side = 1; side >= -1; side -= 2) {
        const hit = world.ray(c.x, c.y, -c.dy * side, c.dx * side, 0.25, c, c.time);
        if (!hit || this.sparks.length > 600) continue;
        if (Math.random() > 0.6) continue;
        const own = scene.names.get(c.id)?.color ?? [1, 1, 1];
        const other = hit.owner ? scene.names.get(hit.owner.id)?.color ?? [1, 1, 1] : [1, 1, 1];
        const disp = scene.display(c);
        for (let k = 0; k < 4; k++) {
          const along = 1, across = 4 * (Math.random() - 0.5);
          // away from the wall, mostly along the drive
          const sx = -c.dy * -side, sy = c.dx * -side;
          let vx = c.dx * across + sx * along, vy = c.dy * across + sy * along, vz = 4 * (Math.random() - 0.5);
          const l = Math.hypot(vx, vy, vz) || 1;
          vx /= l; vy /= l; vz = vz / l + 1;
          const sp = 2 + Math.random() * 2;
          this.sparks.push({
            x: disp.x - c.dx * 0.1 + (-c.dy * side) * hit.t, y: disp.y - c.dy * 0.1 + (c.dx * side) * hit.t, z: 0.5,
            vx: vx * sp + c.dx * c.speed() * 0.3, vy: vy * sp + c.dy * c.speed() * 0.3, vz: vz * sp,
            heat: 2 + Math.random(), bounce: 0, color: k % 2 ? own : other,
          });
        }
      }
    }
    const glow = this.glow;
    glow.reset();
    let kept = 0;
    for (const s of this.sparks) {
      s.vz -= 5 * step;
      s.x += s.vx * step;
      s.y += s.vy * step;
      s.z += s.vz * step;
      s.bounce += step;
      if (s.z < 0) {
        s.z = -s.z;
        s.vz *= -0.5;
        s.bounce = 0;
      }
      s.heat -= step;
      const a = Math.max(0, Math.min(1, s.heat + 1.5 - 2));
      if (s.heat < -1.5) continue;
      const tl = Math.min(0.2, s.bounce) * 0.8;
      glow.v(s.x, s.y, s.z, 0, 0, s.color[0], s.color[1], s.color[2], a);
      glow.v(s.x - s.vx * tl, s.y - s.vy * tl, Math.max(0, s.z - s.vz * tl), 0, 0, s.color[0], s.color[1], s.color[2], a);
      this.sparks[kept++] = s;
    }
    this.sparks.length = kept;
    glow.upload();
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    glow.draw();
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }
}

// the trail colour of a player, worked out once
export function trailOf(info) {
  if (!info) return WHITE;
  return (info.trail ??= trailColor(info.color));
}

const WHITE = [1, 1, 1];

// se_MakeColorValid(c, 0.5): a trail too dark or too close to the floor gets lifted
export function trailColor(color, factor = 0.5) {
  const c = [...color];
  const floor = [0.5, 0.5, 0.7];
  for (let i = 0; i < 100; i++) {
    if (c.every((x) => x >= 0.95)) break;
    const diff = Math.abs(floor[0] - c[0] * factor) + Math.abs(floor[1] - c[1] * factor) + Math.abs(floor[2] - c[2] * factor);
    if (!(diff < 0.5 || (c[0] + c[1] + c[2]) * factor < 0.5)) break;
    const sum = c[0] + c[1] + c[2];
    for (let k = 0; k < 3; k++) {
      c[k] = Math.min(1, c[k] + (sum < 0.02 ? 1 / 135 : (c[k] / sum) / 45));
    }
  }
  return c;
}
