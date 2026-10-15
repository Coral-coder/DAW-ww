// SETI Scope 3D plot, WebGL: static box geometry for every (band, time-row) cell; the bar heights live in a small
// luminance texture (bands × rows ring buffer) that the vertex shader reads, so a frame uploads one texture row and
// a few uniforms. Works on WebGL2 or WebGL1 with vertex texture fetch; createGlScene returns null otherwise.
import { PLOT } from './plot.js';

const VS = `
attribute vec3 aCorner;
attribute vec2 aCell;
attribute float aShade;
uniform mat4 uVP;
uniform sampler2D uHist;
uniform vec2 uGrid;
uniform float uHead;
uniform float uFrac;
varying vec3 vColor;
vec3 ramp(float t) {
  vec3 c0 = vec3(0.04, 0.10, 0.45), c1 = vec3(0.08, 0.38, 1.0), c2 = vec3(0.10, 0.90, 0.32), c3 = vec3(1.0, 0.92, 0.10), c4 = vec3(1.0, 0.12, 0.05);
  if (t < 0.22) return mix(c0, c1, t / 0.22);
  if (t < 0.48) return mix(c1, c2, (t - 0.22) / 0.26);
  if (t < 0.74) return mix(c2, c3, (t - 0.48) / 0.26);
  return mix(c3, c4, clamp((t - 0.74) / 0.26, 0.0, 1.0));
}
void main() {
  float h = texture2D(uHist, vec2((aCell.x + 0.5) / uGrid.x, (aCell.y + 0.5) / uGrid.y)).r;
  float age = mod(uHead - aCell.y + uGrid.y, uGrid.y);
  float rowD = ${PLOT.depth.toFixed(4)} / uGrid.y;
  float zFront = -(age + uFrac) * rowD;
  float z = zFront - (1.0 - aCorner.z) * rowD * 0.72;
  float cw = ${(PLOT.width * 2).toFixed(4)} / uGrid.x;
  float x = -${PLOT.width.toFixed(4)} + (aCell.x + 0.12 + aCorner.x * 0.76) * cw;
  float y = aCorner.y * max(h, 0.006) * ${PLOT.height.toFixed(4)};
  float fade = 1.0 - (age + uFrac) / uGrid.y;
  vColor = ramp(h) * aShade * (0.62 + 0.38 * aCorner.y) * (0.25 + 0.75 * clamp(fade, 0.0, 1.0));
  gl_Position = uVP * vec4(x, y, z, 1.0);
}`;
const FS = `
precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;
const LINE_VS = `
attribute vec3 aPos;
uniform mat4 uVP;
void main() { gl_Position = uVP * vec4(aPos, 1.0); }`;
const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

// box faces (no bottom): corner triples (x, y, z in 0/1, z = 1 is the front / newer side) + shade
const FACES = [
  { shade: 1.0, q: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]] }, // top
  { shade: 0.8, q: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // front
  { shade: 0.55, q: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }, // back
  { shade: 0.62, q: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // left
  { shade: 0.7, q: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] }, // right
];
const TRI = [0, 1, 2, 0, 2, 3];

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
  return p;
}

/** -> scene { kind: 'webgl', resize(w, h), setGrid(nBands, nRows), uploadRow(row, Uint8Array), render(vp, head, frac), dispose() } | null */
export function createGlScene(canvas) {
  const attrs = { antialias: true, alpha: false, depth: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  let gl = null;
  try { gl = canvas.getContext('webgl2', attrs) || canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch { gl = null; }
  if (!gl) return null;
  if (!(gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) > 0)) return null;
  let barProg, lineProg;
  try { barProg = program(gl, VS, FS); lineProg = program(gl, LINE_VS, LINE_FS); } catch (e) { console.warn('[seti] WebGL shaders', e); return null; }
  const loc = {
    corner: gl.getAttribLocation(barProg, 'aCorner'), cell: gl.getAttribLocation(barProg, 'aCell'), shade: gl.getAttribLocation(barProg, 'aShade'),
    vp: gl.getUniformLocation(barProg, 'uVP'), hist: gl.getUniformLocation(barProg, 'uHist'), grid: gl.getUniformLocation(barProg, 'uGrid'),
    head: gl.getUniformLocation(barProg, 'uHead'), frac: gl.getUniformLocation(barProg, 'uFrac'),
    lpos: gl.getAttribLocation(lineProg, 'aPos'), lvp: gl.getUniformLocation(lineProg, 'uVP'), lcolor: gl.getUniformLocation(lineProg, 'uColor'),
  };
  const barBuf = gl.createBuffer();
  const lineBuf = gl.createBuffer();
  const tex = gl.createTexture();
  let nB = 0, nR = 0, nVerts = 0, nLineVerts = 0, lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

  function setGrid(bands, rows) {
    nB = bands; nR = rows;
    const data = new Float32Array(nB * nR * FACES.length * 6 * 6);
    let o = 0;
    for (let r = 0; r < nR; r++) for (let b = 0; b < nB; b++) {
      for (const f of FACES) for (const k of TRI) {
        const c = f.q[k];
        data[o++] = c[0]; data[o++] = c[1]; data[o++] = c[2]; data[o++] = b; data[o++] = r; data[o++] = f.shade;
      }
    }
    nVerts = o / 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, barBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, nB, nR, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(nB * nR));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // floor grid: frequency lines every 1/8 of the width, time lines every 1/8 of the depth, plus the frame
    const L = [];
    const W = PLOT.width, D = PLOT.depth;
    for (let i = 0; i <= 8; i++) { const x = -W + (2 * W * i) / 8; L.push(x, 0, 0, x, 0, -D); }
    for (let i = 0; i <= 8; i++) { const z = (-D * i) / 8; L.push(-W, 0, z, W, 0, z); }
    // back wall power scale (left side)
    for (let i = 1; i <= 4; i++) { const y = (PLOT.height * i) / 4; L.push(-W, y, -D, W, y, -D, -W, y, 0, -W, y, -D); }
    L.push(-W, 0, -D, -W, PLOT.height, -D, W, 0, -D, W, PLOT.height, -D, -W, 0, 0, -W, PLOT.height, 0);
    nLineVerts = L.length / 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(L), gl.STATIC_DRAW);
  }

  function uploadRow(row, bytes) {
    if (lost || !nB) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, nB, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
  }

  function resize(w, h) {
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }

  function render(vp, head, frac) {
    if (lost || !nB) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    // grid
    gl.useProgram(lineProg);
    gl.uniformMatrix4fv(loc.lvp, false, vp);
    gl.uniform4f(loc.lcolor, 0.13, 0.33, 0.78, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
    gl.enableVertexAttribArray(loc.lpos);
    gl.vertexAttribPointer(loc.lpos, 3, gl.FLOAT, false, 12, 0);
    gl.drawArrays(gl.LINES, 0, nLineVerts);
    gl.disableVertexAttribArray(loc.lpos);
    // bars
    gl.useProgram(barProg);
    gl.uniformMatrix4fv(loc.vp, false, vp);
    gl.uniform2f(loc.grid, nB, nR);
    gl.uniform1f(loc.head, head);
    gl.uniform1f(loc.frac, frac);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc.hist, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, barBuf);
    gl.enableVertexAttribArray(loc.corner);
    gl.enableVertexAttribArray(loc.cell);
    gl.enableVertexAttribArray(loc.shade);
    gl.vertexAttribPointer(loc.corner, 3, gl.FLOAT, false, 24, 0);
    gl.vertexAttribPointer(loc.cell, 2, gl.FLOAT, false, 24, 12);
    gl.vertexAttribPointer(loc.shade, 1, gl.FLOAT, false, 24, 20);
    gl.drawArrays(gl.TRIANGLES, 0, nVerts);
    gl.disableVertexAttribArray(loc.corner);
    gl.disableVertexAttribArray(loc.cell);
    gl.disableVertexAttribArray(loc.shade);
  }

  function dispose() {
    try {
      gl.deleteBuffer(barBuf); gl.deleteBuffer(lineBuf); gl.deleteTexture(tex);
      gl.deleteProgram(barProg); gl.deleteProgram(lineProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* */ }
  }

  return { kind: 'webgl', gl, resize, setGrid, uploadRow, render, dispose, get lost() { return lost; } };
}
