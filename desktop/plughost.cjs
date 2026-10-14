// App side of the out-of-process plugin host (desktop/native/build/daw3-plughost):
//   PlugHost        a running `--serve` host: JSON-line control on stdin/stdout + shared-memory audio blocks
//   describeBundle  runs a one-shot `--describe` scanner process per bundle (a crashing plugin fails alone)
//   listBundles     finds plugin bundles in folders
// No Electron imports: runs in the audio server (utility process) and in Node tests.
'use strict';
const { spawn } = require('node:child_process');
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

/** Run the scanner on one bundle -> { ok, plugins, error, crashed?, timedOut? } (never rejects). */
function describeBundle(binary, format, bundlePath, { timeoutMs = 30000, parse } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let child;
    try {
      child = spawn(binary, ['--describe', format, bundlePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { resolve({ ok: false, error: e.message, plugins: [] }); return; }
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } finish({ ok: false, timedOut: true, error: `Scanning timed out after ${Math.round(timeoutMs / 1000)} s`, plugins: [] }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192); });
    child.on('error', (e) => finish({ ok: false, error: e.message, plugins: [] }));
    child.on('close', (code, signal) => { // 'close': stdout fully drained (unlike 'exit')
      const r = parse ? parse(out) : JSON.parse(out.trim().split('\n').pop() || '{}');
      if (signal || (code !== 0 && code !== 1)) finish({ ok: false, crashed: true, error: `The plugin crashed the scanner (${signal || `exit ${code}`})${err ? `: ${err.trim().split('\n').pop()}` : ''}`, plugins: [] });
      else finish(r.ok ? r : { ...r, ok: false, error: r.error || 'Could not load the plugin' });
    });
  });
}

let hostSeq = 0;

/**
 * A running plugin host process. Instances live in the host; audio blocks go through the shared
 * memory channel created by the addon (`addon.hostCreate`), control through JSON lines.
 * Events: 'event' (plugin events: param / latency / params-changed / editor-closed), 'exit' (code, signal).
 */
class PlugHost extends EventEmitter {
  constructor({ binary, addon, tmpDir, maxFrames = 2048, maxChannels = 32, sampleRate = 48000, env }) {
    super();
    Object.assign(this, { binary, addon, tmpDir, maxFrames, maxChannels, sampleRate, env });
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
      this.proc = spawn(this.binary, ['--serve', '--shm', c.shm, '--req', c.req, '--done', c.done], { stdio: ['pipe', 'pipe', 'pipe'], ...(this.env ? { env: this.env } : {}) });
      this.proc.stdin.on('error', () => {});
      const rl = readline.createInterface({ input: this.proc.stdout });
      const t = setTimeout(() => reject(new Error('The plugin host did not start')), 15000);
      rl.on('line', (line) => {
        let m;
        try { m = JSON.parse(line); } catch { return; }
        if (m.event === 'ready') { clearTimeout(t); this.alive = true; this.pid = m.pid; resolve(this); return; }
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

module.exports = { listBundles, describeBundle, PlugHost, EXT };
