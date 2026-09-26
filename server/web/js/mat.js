// Armagetron Advanced, browser port. Copyright (C) 2026 Andreas Nägeli.
// Based on Armagetron Advanced, Copyright (C) Manuel Moos and the Armagetron Advanced team.
// GNU GPL version 2 or later, see COPYING.txt. Source: https://github.com/Kaliumhexacyanoferrat/armagetron-advanced-browser

// Small column-major 4x4 matrix helpers, just what the renderer needs.
// World coordinates follow the original game: x/y is the floor plane, z is up.

export function identity() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

export function lookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  const m = new Float32Array(16);
  m[0] = xx; m[1] = yx; m[2] = zx;
  m[4] = xy; m[5] = yy; m[6] = zy;
  m[8] = xz; m[9] = yz; m[10] = zz;
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  m[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  m[15] = 1;
  return m;
}

export function multiply(a, b, out = new Float32Array(16)) {
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[i * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[i * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[i * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

export function translate(m, x, y, z) {
  const t = identity();
  t[12] = x; t[13] = y; t[14] = z;
  return multiply(m, t);
}

export function scale(m, x, y, z) {
  const t = identity();
  t[0] = x; t[5] = y; t[10] = z;
  return multiply(m, t);
}

// rotation around an arbitrary axis (normalised), angle in radians
export function rotate(m, angle, x, y, z) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const r = identity();
  r[0] = t * x * x + c;     r[4] = t * x * y - s * z; r[8] = t * x * z + s * y;
  r[1] = t * x * y + s * z; r[5] = t * y * y + c;     r[9] = t * y * z - s * x;
  r[2] = t * x * z - s * y; r[6] = t * y * z + s * x; r[10] = t * z * z + c;
  return multiply(m, r);
}

// a basis whose x axis is the heading (dx, dy) on the floor, z up
export function heading(m, x, y, z, dx, dy) {
  const r = identity();
  r[0] = dx; r[1] = dy;
  r[4] = -dy; r[5] = dx;
  r[12] = x; r[13] = y; r[14] = z;
  return multiply(m, r);
}
