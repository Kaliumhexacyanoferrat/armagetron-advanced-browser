// Thin WebGL helpers: programs, buffers, textures. The scene itself is in render.js.

export function createContext(canvas) {
  const opts = { antialias: true, alpha: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  const gl = canvas.getContext('webgl2', opts);
  if (!gl) throw new Error('WebGL 2 is not available in this browser.');
  return gl;
}

export function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  const attribs = {};
  const m = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < m; i++) {
    const info = gl.getActiveAttrib(p, i);
    attribs[info.name] = gl.getAttribLocation(p, info.name);
  }
  return { p, u: uniforms, a: attribs };
}

// A growable interleaved vertex buffer with a VAO, for geometry rebuilt often (walls, particles).
export class DynamicMesh {
  constructor(gl, prog, layout, mode) {
    this.gl = gl;
    this.mode = mode ?? gl.TRIANGLES;
    this.layout = layout; // [[name, size], ...] floats
    this.stride = layout.reduce((s, [, n]) => s + n, 0);
    this.data = new Float32Array(this.stride * 1024);
    this.count = 0;
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    this.capacity = 0;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    let off = 0;
    for (const [name, size] of layout) {
      const loc = prog.a[name];
      if (loc !== undefined && loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, this.stride * 4, off * 4);
      }
      off += size;
    }
    gl.bindVertexArray(null);
  }

  reset() { this.count = 0; }

  ensure(vertices) {
    const need = (this.count + vertices) * this.stride;
    if (need > this.data.length) {
      let len = this.data.length;
      while (len < need) len *= 2;
      const d = new Float32Array(len);
      d.set(this.data.subarray(0, this.count * this.stride));
      this.data = d;
    }
  }

  // push one vertex; values in layout order
  v(...values) {
    this.ensure(1);
    this.data.set(values, this.count * this.stride);
    this.count++;
  }

  upload() {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const bytes = this.count * this.stride * 4;
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, this.data.byteLength);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.count * this.stride);
  }

  draw() {
    if (!this.count) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(this.mode, 0, this.count);
    gl.bindVertexArray(null);
  }
}

// A static indexed mesh.
export class StaticMesh {
  constructor(gl, prog, layout, vertices, indices) {
    this.gl = gl;
    const stride = layout.reduce((s, [, n]) => s + n, 0);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    let off = 0;
    for (const [name, size] of layout) {
      const loc = prog.a[name];
      if (loc !== undefined && loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
      }
      off += size;
    }
    if (indices) {
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
      this.count = indices.length;
      this.indexed = true;
    } else {
      this.count = vertices.length / stride;
    }
    gl.bindVertexArray(null);
  }

  draw(mode) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    if (this.indexed) gl.drawElements(mode ?? gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    else gl.drawArrays(mode ?? gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
  }
}

export function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load ' + url));
    img.src = url;
  });
}

// Textures behave like the original's: repeat, mipmapped, anisotropic where available.
export function texture(gl, img, { repeat = true, clampS = false, clampT = false, mipmap = true } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, clampS ? gl.CLAMP_TO_EDGE : wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, clampT ? gl.CLAMP_TO_EDGE : wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mipmap) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return t;
}

// a 1x1 texture of one colour, for untextured draws through the textured shader
export function solid(gl, r = 255, g = 255, b = 255, a = 255) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, a]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}
