// 3D waterfall rendering: a perspective camera over stacked spectra (x = frequency −1..1, y = level, z = time, front
// = newest). waterfallMatrix() builds the projection (fitted to the viewport), projectPoint() maps model points to
// CSS pixels (labels and the canvas 2D fallback), createWaterfallGL() draws the rows as opaque ribbons + bright
// outlines with WebGL (null when WebGL is unavailable).

// ---- 4x4 column-major matrices
const ident = () => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function perspective(fovy, aspect, n, f) {
  const m = new Float32Array(16);
  const t = 1 / Math.tan(fovy / 2);
  m[0] = t / aspect; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f);
  return m;
}
function translate(x, y, z) { const m = ident(); m[12] = x; m[13] = y; m[14] = z; return m; }
function rotX(a) { const m = ident(); const c = Math.cos(a), s = Math.sin(a); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
function scale(x, y, z) { const m = ident(); m[0] = x; m[5] = y; m[10] = z; return m; }
function apply(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/** Model -> clip matrix for a w × h viewport, tilt angle (degrees) and height scale, fitted to fill the viewport. */
export function waterfallMatrix(w, h, angleDeg = 40, height = 1) {
  const aspect = Math.max(0.2, w / Math.max(1, h));
  const m0 = mul(mul(mul(perspective((38 * Math.PI) / 180, aspect, 0.1, 50), translate(0, 0, -4.2)), rotX((angleDeg * Math.PI) / 180)), scale(1, 1, 0.85));
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const x of [-1, 1]) for (const y of [0, 0.6 * height]) for (const z of [-1, 1]) {
    const v = apply(m0, x, y, z);
    const nx = v[0] / v[3], ny = v[1] / v[3];
    x0 = Math.min(x0, nx); x1 = Math.max(x1, nx); y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
  }
  const s = Math.min(1.86 / Math.max(1e-3, x1 - x0), 1.7 / Math.max(1e-3, y1 - y0));
  const F = ident();
  F[0] = s; F[5] = s; F[12] = -s * (x0 + x1) / 2; F[13] = -s * (y0 + y1) / 2 - 0.04;
  return mul(F, m0);
}

/** Model point -> [x, y] in CSS pixels of a w × h viewport. */
export function projectPoint(m, x, y, z, w, h) {
  const v = apply(m, x, y, z);
  return [((v[0] / v[3] + 1) / 2) * w, ((1 - v[1] / v[3]) / 2) * h];
}

function parseColor(c) {
  const s = String(c).trim();
  if (s[0] === '#') {
    const x = s.length === 4 ? s.slice(1).split('').map((d) => d + d).join('') : s.slice(1, 7);
    return [parseInt(x.slice(0, 2), 16) / 255, parseInt(x.slice(2, 4), 16) / 255, parseInt(x.slice(4, 6), 16) / 255];
  }
  const m = s.match(/[\d.]+/g);
  return m ? m.slice(0, 3).map((v) => Number(v) / 255) : [0, 0, 0];
}

const VS = `attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uM; varying vec3 vCol;
void main() { gl_Position = uM * vec4(aPos, 1.0); vCol = aCol; }`;
const FS = `precision mediump float; varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.0); }`;

/** WebGL renderer on `canvas`, or null when WebGL is unavailable. draw() returns false when the context is lost. */
export function createWaterfallGL(canvas) {
  let gl = null;
  try { gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false }) || canvas.getContext('experimental-webgl'); } catch { gl = null; }
  if (!gl) return null;
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { console.warn('[waterfall] WebGL setup failed, using canvas 2D', e); return null; }
  const aPos = gl.getAttribLocation(prog, 'aPos'), aCol = gl.getAttribLocation(prog, 'aCol');
  const uM = gl.getUniformLocation(prog, 'uM');
  const vbo = gl.createBuffer();
  let data = new Float32Array(0);

  return {
    draw({ rows, depth, lut, matrix, bg, height = 1 }) {
      if (lost || gl.isContextLost()) return false;
      const dpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      const W = Math.max(1, Math.round(r.width * dpr)), H = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      const [br, bgc, bb] = parseColor(bg);
      gl.clearColor(br, bgc, bb, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const P = rows[0]?.length || 0;
      if (!P) return true;
      const per = 3 * P; // 2P strip vertices + P outline vertices
      const need = rows.length * per * 6;
      if (data.length < need) data = new Float32Array(need);
      let o = 0;
      const ymax = 0.6 * height;
      for (let ri = rows.length - 1; ri >= 0; ri--) { // back to front
        const row = rows[ri];
        const z = 1 - (2 * ri) / Math.max(1, depth - 1);
        const fadeBack = 0.55 + 0.45 * (1 - ri / Math.max(1, depth - 1)); // older rows slightly dimmer
        for (let i = 0; i < P; i++) {
          const x = (i / (P - 1)) * 2 - 1, v = row[i];
          const li = Math.round(v * 255) * 4;
          const cr = lut[li] / 255, cg = lut[li + 1] / 255, cb = lut[li + 2] / 255;
          // ribbon: top tinted towards the colour, bottom = background (opaque curtain hides the rows behind)
          const t = 0.4 * fadeBack;
          data[o] = x; data[o + 1] = v * ymax; data[o + 2] = z;
          data[o + 3] = br + (cr - br) * t; data[o + 4] = bgc + (cg - bgc) * t; data[o + 5] = bb + (cb - bb) * t;
          data[o + 6] = x; data[o + 7] = 0; data[o + 8] = z; data[o + 9] = br; data[o + 10] = bgc; data[o + 11] = bb;
          o += 12;
        }
        for (let i = 0; i < P; i++) {
          const x = (i / (P - 1)) * 2 - 1, v = row[i];
          const li = Math.round(Math.min(1, v * 0.9 + 0.1) * 255) * 4;
          data[o] = x; data[o + 1] = v * ymax + 0.002; data[o + 2] = z;
          data[o + 3] = (lut[li] / 255) * fadeBack + br * (1 - fadeBack);
          data[o + 4] = (lut[li + 1] / 255) * fadeBack + bgc * (1 - fadeBack);
          data[o + 5] = (lut[li + 2] / 255) * fadeBack + bb * (1 - fadeBack);
          o += 6;
        }
      }
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, o), gl.STREAM_DRAW);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(aCol);
      gl.vertexAttribPointer(aCol, 3, gl.FLOAT, false, 24, 12);
      gl.uniformMatrix4fv(uM, false, matrix);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(1, 1);
      for (let k = 0; k < rows.length; k++) {
        const base = k * per;
        gl.drawArrays(gl.TRIANGLE_STRIP, base, 2 * P);
        gl.drawArrays(gl.LINE_STRIP, base + 2 * P, P);
      }
      return true;
    },
    dispose() { try { gl.deleteBuffer(vbo); gl.deleteProgram(prog); gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* */ } },
  };
}
