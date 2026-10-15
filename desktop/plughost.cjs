// App side of the out-of-process plugin host (desktop/native/build/daw3-plughost):
//   PlugHost        a running `--serve` host: JSON-line control on stdin/stdout + shared-memory audio blocks
//   describeBundle  runs a one-shot `--describe` scanner process per bundle (a crashing plugin fails alone)
//   listBundles     finds plugin bundles in folders
// No Electron imports: runs in the audio server (utility process) and in Node tests.
'use strict';
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const EXT = { vst3: '.vst3', clap: '.clap', au: '.component' };

/** Plugin bundles below `dirs` for a format (AU: the system registry -> ['all']). */
async function listBundles(format, dirs, { maxDepth = 5, fs = fsp } = {}) {
  if (format === 'au') return dirs.length ? ['all'] : [];
  const ext = EXT[format];
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth || out.length > 5000) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.name.toLowerCase().endsWith(ext)) out.push(p);
      else if (e.isDirectory() || e.isSymbolicLink()) await walk(p, depth + 1);
    }
  };
  for (const d of dirs) await walk(d, 0);
  return [...new Set(out)].sort();
}

/** macOS: run a universal helper as another CPU type (`arch -x86_64 <binary> …`, Rosetta 2 for Intel-only plugins). */
const ARCH_TOOL = '/usr/bin/arch';
function hostCommand(binary, args, arch, tool = ARCH_TOOL) {
  return arch ? { cmd: tool || ARCH_TOOL, args: [`-${arch}`, binary, ...args] } : { cmd: binary, args };
}

/**
 * Run the scanner on one bundle -> { ok, plugins, error, crashed?, timedOut?, log } (never rejects).
 * arch: '' = the helper as it is, 'x86_64' / 'arm64' = run as that architecture (macOS).
 */
function describeBundle(binary, format, bundlePath, { timeoutMs = 30000, parse, arch = '', archTool } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    const { cmd, args } = hostCommand(binary, ['--describe', format, bundlePath], arch, archTool);
    const log = (r) => [`scanner${arch ? ` (as ${arch})` : ''}: ${r.timedOut ? 'timed out' : r.crashed ? 'crashed' : r.ok ? 'ok' : 'failed'}`, ...(err.trim() ? [`stderr: ${err.trim().slice(-1500)}`] : [])];
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ ok: false, error: e.message, plugins: [], log: [`spawn failed: ${e.message}`] }); return; }
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ ...r, log: log(r) }); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ ok: false, timedOut: true, error: `Scanning timed out after ${Math.round(timeoutMs / 1000)} s`, plugins: [] }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
    child.on('error', (e) => finish({ ok: false, error: e.message, plugins: [] }));
    child.on('close', (code, signal) => { // 'close': stdout fully drained (unlike 'exit')
      const answered = /^\s*\{/m.test(out);
      const lastErr = err.trim().split('\n').pop() || '';
      let r;
      try { r = parse ? parse(out) : JSON.parse(out.trim().split('\n').pop() || '{}'); } catch { r = { ok: false, plugins: [] }; }
      if (signal || (code !== 0 && code !== 1 && !answered)) finish({ ok: false, crashed: !!signal || code > 1, error: `The plugin crashed the scanner (${signal || `exit ${code}`})${lastErr ? `: ${lastErr}` : ''}`, plugins: [] });
      else if (!answered) finish({ ok: false, error: lastErr || `The plugin scanner returned nothing (exit ${code})`, plugins: [] }); // e.g. `arch`: Bad CPU type
      else finish(r.ok ? r : { ...r, ok: false, error: r.error || 'Could not load the plugin' });
    });
  });
}

/** macOS bundle -> its executable (Info.plist CFBundleExecutable, else the first file in Contents/MacOS);
 *  a plain file is its own binary. '' when there is none. */
async function bundleExecutable(bundlePath, { fs = fsp } = {}) {
  let st;
  try { st = await fs.stat(bundlePath); } catch { return ''; }
  if (!st.isDirectory()) return bundlePath;
  const macos = path.join(bundlePath, 'Contents', 'MacOS');
  try {
    const plist = await fs.readFile(path.join(bundlePath, 'Contents', 'Info.plist'), 'utf8');
    const m = /<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (m) { const p = path.join(macos, m[1].trim()); await fs.stat(p); return p; }
  } catch { /* binary plist or missing: fall back */ }
  try {
    const names = (await fs.readdir(macos)).filter((n) => !n.startsWith('.')).sort();
    if (names.length) return path.join(macos, names[0]);
  } catch { /* not a macOS bundle */ }
  return '';
}

/** First `n` bytes of a file (empty when unreadable). */
async function readHead(file, n = 4096, { fs = fsp } = {}) {
  let fh;
  try {
    fh = await fs.open(file, 'r');
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } catch { return new Uint8Array(0); } finally { await fh?.close().catch(() => {}); }
}

/** macOS: is com.apple.quarantine set on the path (`xattr -p`, exit 0 = present)? false elsewhere / on error. */
function isQuarantined(p, { platform = process.platform, run = execFile } = {}) {
  if (platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    try { run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', p], { timeout: 5000 }, (e) => resolve(!e)); } catch { resolve(false); }
  });
}

/** Newest mtime of a bundle, its Contents folder, Info.plist and binary: an in-place plugin update changes one of them. */
async function bundleMtime(bundlePath, { fs = fsp, binary } = {}) {
  const st = await fs.stat(bundlePath); // throws for a vanished bundle (the scan reports it)
  let m = st.mtimeMs;
  if (!st.isDirectory()) return m;
  const extra = [path.join(bundlePath, 'Contents'), path.join(bundlePath, 'Contents', 'Info.plist')];
  if (binary) extra.push(binary);
  for (const p of extra) { try { m = Math.max(m, (await fs.stat(p)).mtimeMs); } catch { /* */ } }
  return m;
}

let hostSeq = 0;

/**
 * A running plugin host process. Instances live in the host; audio blocks go through the shared
 * memory channel created by the addon (`addon.hostCreate`), control through JSON lines.
 * Events: 'event' (plugin events: param / latency / params-changed / editor-closed), 'exit' (code, signal).
 */
class PlugHost extends EventEmitter {
  constructor({ binary, addon, tmpDir, maxFrames = 2048, maxChannels = 32, sampleRate = 48000, env, arch = '', archTool }) {
    super();
    Object.assign(this, { binary, addon, tmpDir, maxFrames, maxChannels, sampleRate, env, arch, archTool });
    this.pending = new Map();
    this.nextId = 1;
    this.alive = false;
    this.name = `host${++hostSeq}`;
  }

  start() {
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      this.channel = this.addon.hostCreate({ dir: this.tmpDir, maxFrames: this.maxFrames, maxChannels: this.maxChannels, sampleRate: this.sampleRate });
      const c = this.channel;
      const { cmd, args } = hostCommand(this.binary, ['--serve', '--shm', c.shm, '--req', c.req, '--done', c.done], this.arch, this.archTool);
      this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(this.env ? { env: this.env } : {}) });
      this.proc.stdin.on('error', () => {});
      this.proc.on('error', (e) => { clearTimeout(t); if (!this.alive) { try { this.addon.hostDestroy(c.id); } catch { /* */ } reject(new Error(`The plugin host failed to start: ${e.message}`)); } });
      const rl = readline.createInterface({ input: this.proc.stdout });
      const t = setTimeout(() => reject(new Error('The plugin host did not start')), 15000);
      rl.on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.event === 'ready') { clearTimeout(t); this.alive = true; this.pid = m.pid; this.runningArch = m.arch || ''; resolve(this); return; }
        if (m.event) { this.emit('event', m); return; }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(m); else p.reject(new Error(m.error || 'Plugin host error'));
      });
      this.proc.stderr.on('data', (d) => { this.lastStderr = String(d).slice(-2000); });
      this.proc.on('exit', (code, signal) => {
        clearTimeout(t);
        const wasAlive = this.alive;
        this.alive = false;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(signal ? `The plugin host crashed (${signal})` : 'The plugin host quit')); }
        this.pending.clear();
        try { this.addon.hostDestroy(c.id); } catch { /* */ }
        if (!wasAlive) reject(new Error(`The plugin host failed to start (${signal || code})${this.lastStderr ? `: ${this.lastStderr.trim()}` : ''}`));
        this.emit('exit', code, signal);
      });
    });
    return this._starting;
  }

  /** Control command -> reply object (rejects on error / timeout / crash). */
  call(cmd, fields = {}, timeoutMs = 20000) {
    if (!this.alive) return Promise.reject(new Error('The plugin host is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Plugin host: ${cmd} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ ...fields, id, cmd }) + '\n');
    });
  }

  /** One audio block through instance `inst` (synchronous; null when the host hung / died). */
  process(opts) {
    if (!this.alive) return null;
    const r = this.addon.hostProcess(this.channel.id, opts);
    if (r === null) this.emit('timeout', opts.inst);
    return r;
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.stdin.end(); } catch { /* */ }
    const p = this.proc;
    setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* */ } }, 2000).unref?.();
  }
}

module.exports = { listBundles, describeBundle, PlugHost, EXT, bundleExecutable, readHead, isQuarantined, bundleMtime, hostCommand };
