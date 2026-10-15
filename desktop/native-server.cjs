// The native audio server's logic (runs in an Electron utility process: desktop/audio-server.cjs).
// Owns the daw3_audio addon (device I/O) and the out-of-process plugin host. Electron-free, so the
// Node tests drive it end to end with the real addon + plugin host when they are built.
'use strict';
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { listBundles, describeBundle, PlugHost, bundleExecutable, readHead, isQuarantined, bundleMtime } = require('./plughost.cjs');

// ES modules can't be imported from inside app.asar reliably: the packaged app unpacks src/native (asarUnpack)
const SRC = path.resolve(__dirname, '..', 'src', 'native').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const load = (f) => import(pathToFileURL(path.join(SRC, f)).href);
const MAX_RENDER_OUT = 32; // = protocol.js MAX_OUT_CHANNELS / HOST_MAX_CHANNELS

class NativeServer {
  /** opts: { addon, binary, dataDir, tmpDir?, post(event)?, nullBackend?, home?, platform?, extraFolders?,
   *          hostArch?, quarantined?(path), binaryArchs?(bundle, binary), archTool? }  (the last three: test hooks) */
  static async create(opts) {
    const [protocol, db, latency, diag, prefs] = await Promise.all([load('protocol.js'), load('plugin-db.js'), load('latency.js'), load('plugin-diagnostics.js'), load('plugin-prefs.js')]);
    const s = new NativeServer(opts, { protocol, db, latency, diag, prefs });
    await s._init();
    return s;
  }

  constructor(opts, mods) {
    this.o = opts;
    this.m = mods;
    this.addon = opts.addon;
    this.post = opts.post || (() => {});
    this.tmpDir = opts.tmpDir || os.tmpdir();
    this.instances = new Map(); // inst -> { desc, info, host }
    this.nextInst = 1;
    this.hosts = new Map(); // arch ('' = the app's own, 'x86_64' = Rosetta on Apple silicon) -> PlugHost
    this._hostStarting = new Map();
    this.status = 'stopped';
    this.platform = opts.platform || process.platform;
    this.hostArch = opts.hostArch || (mods.diag ? mods.diag.hostArchOf(process.arch) : process.arch);
  }

  /** The app's own plugin host (the one for plugins of this machine's architecture). */
  get host() { return this.hosts.get('') || null; }

  async _init() {
    this.addon.audioInit({ nullBackend: !!this.o.nullBackend });
    this.config = this.m.protocol.normalizeAudioConfig(await this._readJson('audio.json'));
    this.db = this.m.db.parseDb(await this._readJson('plugins.json'));
    this.prefs = this.m.prefs.normalizePrefs(await this._readJson('plugin-prefs.json'));
    if (this.config.enabled) { try { this._open(); } catch (e) { this.lastError = e.message; } }
  }

  async _readJson(name) {
    if (!this.o.dataDir) return null;
    try { return JSON.parse(await fsp.readFile(path.join(this.o.dataDir, name), 'utf8')); } catch { return null; }
  }

  async _writeJson(name, data) {
    if (!this.o.dataDir) return;
    await fsp.mkdir(this.o.dataDir, { recursive: true });
    const f = path.join(this.o.dataDir, name);
    await fsp.writeFile(f + '.tmp', JSON.stringify(data));
    await fsp.rename(f + '.tmp', f);
  }

  // ------------------------------------------------------------------------------------- control
  async handle(method, args = []) {
    this.m.protocol.validateCall(method, args);
    const fn = this[`_${method.replace('.', '_')}`];
    if (!fn) throw new Error(`Not implemented: ${method}`);
    return fn.apply(this, args);
  }

  _open() {
    const st = this.addon.audioOpen(this.m.protocol.engineOptions(this.config));
    this.status = 'running';
    this.lastError = null;
    return st;
  }

  _audio_available() { return { ok: true, platform: process.platform }; }

  _audio_listDevices() {
    const all = this.addon.audioListDevices();
    return { outputs: all.filter((d) => !d.isInput), inputs: all.filter((d) => d.isInput) };
  }

  _audio_getConfig() { return this.config; }

  async _audio_setConfig(cfg) {
    const next = this.m.protocol.normalizeAudioConfig({ ...this.config, ...cfg });
    const deviceChanged = ['outputId', 'inputId', 'inputEnabled', 'sampleRate', 'bufferFrames', 'deviceOutChannels', 'deviceInChannels', 'outOffset', 'safetyFrames']
      .some((k) => next[k] !== this.config[k]);
    if (deviceChanged) { next.latencyMs = null; next.latencySamples = null; }
    const rateChanged = next.sampleRate !== this.config.sampleRate;
    this.config = next;
    await this._writeJson('audio.json', next);
    let error = null;
    if (next.enabled && (deviceChanged || this.status !== 'running')) {
      // renegotiates the stream in place: the device reopens at the new rate / buffer / channels
      try { this._open(); } catch (e) { error = e.message; this.lastError = error; this.status = 'error'; }
    } else if (!next.enabled) {
      this.addon.audioClose();
      this.status = 'stopped';
    }
    // loaded plugins follow the device rate (re-activated in place: state and parameters are kept)
    let plugins = null;
    if (rateChanged) plugins = await this._plugins_setSampleRate(next.sampleRate).catch((e) => ({ error: e.message }));
    this.post({ event: 'audio-config', config: this.config, rateChanged, plugins });
    return { config: this.config, status: this._audio_status(), error, plugins };
  }

  _audio_status() {
    const s = this.addon.audioStats();
    return { ...s, state: this.status, error: this.lastError || null, bridgeLatencyFrames: this.m.protocol.bridgeLatencyFrames(this.config),
      latencyMs: this.config.latencyMs, latencySamples: this.config.latencySamples };
  }

  async _audio_calibrate(opts = {}) {
    const st = this.addon.audioStats();
    if (!st.running) throw new Error('Turn on the native audio engine first');
    const sr = st.sampleRate || this.config.sampleRate;
    const chirp = this.m.latency.makeChirp(sr);
    const outCh = Math.max(0, Math.min((opts.outChannel ?? this.config.outOffset) | 0, st.deviceOutChannels - 1));
    const inCh = Math.max(0, Math.min((opts.inChannel ?? 0) | 0, Math.max(0, st.deviceInChannels - 1)));
    if (!st.deviceInChannels) throw new Error('Enable an input device to measure the round-trip latency');
    if (!this.addon.audioStartPing(chirp, outCh, inCh, Math.round(sr * 0.75))) throw new Error('A measurement is already running');
    const t0 = Date.now();
    let cap = null;
    while (!(cap = this.addon.audioTakePing()) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    if (!cap) throw new Error('The measurement did not complete (is the device running?)');
    const r = this.m.latency.analyzePing(cap, chirp, sr);
    if (r.ok) {
      this.config = { ...this.config, latencyMs: r.latencyMs, latencySamples: r.latencySamples };
      await this._writeJson('audio.json', this.config);
    }
    return { ...r, outChannel: outCh, inChannel: inCh, sampleRate: sr };
  }

  // ------------------------------------------------------------------------------------- plugins
  folders() {
    const f = this.m.db.defaultFolders(this.o.home || os.homedir(), this.o.platform || process.platform, process.env);
    if (this.o.extraFolders) for (const [k, v] of Object.entries(this.o.extraFolders)) f[k] = [...(f[k] || []), ...v];
    if (this.o.platform && this.o.platform !== 'darwin') f.au = [];
    return f;
  }

  /**
   * Describe one bundle, in the right plugin host: the binary's CPU types are read from its Mach-O header and an
   * Intel-only plugin on Apple silicon is scanned (and later served) by the helper run as x86_64 under Rosetta;
   * a loader "wrong architecture" error also triggers that retry. macOS quarantine is detected on the bundle.
   */
  async _describe(format, p, { timeoutMs = 30000 } = {}) {
    const D = this.m.diag;
    const parse = this.m.db.parseDescribeOutput;
    const log = [];
    const mac = this.platform === 'darwin' && format !== 'au';
    let archs = null, quarantined = false;
    if (mac) {
      const bin = await bundleExecutable(p);
      archs = this.o.binaryArchs ? await this.o.binaryArchs(p, bin) : bin ? D.machoArchs(await readHead(bin)) : null;
      quarantined = await (this.o.quarantined || isQuarantined)(p);
      log.push(`binary: ${bin || '(none)'}${archs ? ` [${archs.join(', ')}]` : ''}; host: ${this.hostArch}${quarantined ? '; quarantined (com.apple.quarantine)' : ''}`);
    }
    let pick = D.pickHostArch(archs, this.hostArch, this.platform);
    if (pick.arch === null) return { ok: false, error: pick.error, archs: archs || [], quarantined, plugins: [], log };
    const archTool = this.o.archTool;
    let r = await describeBundle(this.o.binary, format, p, { parse, timeoutMs, arch: pick.arch, archTool });
    log.push(...(r.log || []));
    if (!r.ok && mac && !pick.arch && D.isArchError(r.error)) {
      // the header said nothing (or something unexpected): the loader knows better -> try the other architecture
      const alt = this.hostArch === 'arm64' ? 'x86_64' : 'arm64';
      log.push(`loader reported an architecture mismatch: retrying as ${alt}`);
      const r2 = await describeBundle(this.o.binary, format, p, { parse, timeoutMs, arch: alt, archTool });
      log.push(...(r2.log || []));
      if (r2.ok || !D.isRosettaMissing(r2.error)) { r = r2; pick = { arch: alt, intelOnly: alt === 'x86_64' }; }
    }
    const rosettaMissing = pick.arch === 'x86_64' && !r.ok && D.isRosettaMissing(r.error);
    if (rosettaMissing) r = { ...r, error: `Intel-only plugin and Rosetta 2 is not installed (${r.error})` };
    return { ...r, arch: pick.arch || '', archs: archs || [], intelOnly: !!pick.intelOnly, rosettaMissing, quarantined, log };
  }

  async _plugins_scan(opts = {}) {
    // one scan at a time: a second caller (app start + dialog open) waits for the running one
    if (this._scanning) { await this._scanning.catch(() => {}); if (!opts.force && !opts.retry) return this._scanSummary(); }
    this._scanning = this._scan(opts);
    try { return await this._scanning; } finally { this._scanning = null; }
  }

  async _scan(opts) {
    const P = this.m.prefs;
    const exes = new Map();
    const io = {
      listBundles: (format, dirs) => listBundles(format, dirs),
      mtime: async (p) => {
        if (this.platform !== 'darwin') return bundleMtime(p);
        if (!exes.has(p)) exes.set(p, await bundleExecutable(p));
        return bundleMtime(p, { binary: exes.get(p) });
      },
      describe: (format, p) => this._describe(format, p, { timeoutMs: opts.timeoutMs || 30000 }),
    };
    const formats = opts.formats || this.m.db.FORMATS.filter((f) => f !== 'au' || this.platform === 'darwin');
    const retry = opts.retry;
    const before = new Set(this.db.plugins.map((p) => p.key));
    this.db = await this.m.db.scanPlugins({ db: this.db, folders: this.folders(), io, formats,
      force: retry ? (format, p) => format === retry.format && p === retry.path : !!opts.force,
      skip: (format, p) => P.isBundleBlocked(this.prefs, format, p),
      exclude: (d) => P.isPluginBlocked(this.prefs, d),
      onProgress: (p) => this.post({ event: 'scan-progress', ...p }) });
    await this._writeJson('plugins.json', this.db);
    const added = this.db.plugins.filter((p) => !before.has(p.key)).map((p) => p.name);
    this.post({ event: 'plugins-changed', count: this.db.plugins.length, added: added.length });
    return { ...this._scanSummary(), added };
  }

  _scanSummary() { return { count: this.db.plugins.length, failed: this.db.failed, warnings: this._warnings(), scannedAt: this.db.scannedAt }; }

  /** Bundles that loaded but carry a problem worth showing (macOS quarantine). */
  _warnings() {
    const out = [];
    for (const [bk, b] of Object.entries(this.db.bundles || {})) {
      if (!b?.ok || !b.quarantined) continue;
      const i = bk.indexOf('|');
      const format = bk.slice(0, i), p = bk.slice(i + 1);
      out.push({ format, path: p, kind: 'quarantined', message: this.m.diag.quarantineFix(p) });
    }
    return out;
  }

  /** Rescan one bundle (the Plugins dialog's "Retry"): { format, path } -> scan summary + { ok, error? } for it. */
  async _plugins_retry(o) {
    if (this.m.prefs.isBundleBlocked(this.prefs, o.format, o.path)) throw new Error('This plugin is on the blocklist: unblock it first');
    const r = await this._plugins_scan({ retry: { format: o.format, path: o.path } }); // every format: the scan rebuilds the whole DB
    const f = this.db.failed.find((x) => x.format === o.format && x.path === o.path);
    return { ...r, ok: !f, error: f?.error || null };
  }

  /** The stored scan log of one bundle ('' when it was never scanned). */
  _plugins_scanLog(o) {
    const b = this.db.bundles?.[`${o.format}|${o.path}`];
    return b ? { log: b.log || '', at: b.at || 0, ok: !!b.ok, arch: b.arch || '', quarantined: !!b.quarantined } : { log: '', at: 0, ok: false };
  }

  _plugins_getPrefs() { return this.prefs; }

  async _plugins_setPrefs(p) {
    const prev = this.prefs;
    this.prefs = this.m.prefs.normalizePrefs(p);
    await this._writeJson('plugin-prefs.json', this.prefs);
    // newly blocked plugins leave the DB now; unblocked bundles come back with the next scan
    const P = this.m.prefs;
    const n = this.db.plugins.length;
    this._blockedDescs = new Map(this.db.plugins.filter((d) => P.isPluginBlocked(this.prefs, d)).map((d) => [d.key, d])); // for a clear "blocked" error on load
    // forget the scan records of blocked bundles, so unblocking scans them again
    for (const d of this._blockedDescs.values()) if (d.format !== 'au') delete this.db.bundles[`${d.format}|${d.path}`];
    for (const bk of Object.keys(this.db.bundles)) { const i = bk.indexOf('|'); if (P.isBundleBlocked(this.prefs, bk.slice(0, i), bk.slice(i + 1))) delete this.db.bundles[bk]; }
    this.db.plugins = this.db.plugins.filter((d) => !P.isPluginBlocked(this.prefs, d));
    this.db.failed = this.db.failed.filter((f) => !P.isBundleBlocked(this.prefs, f.format, f.path));
    const unblocked = prev.blocked.some((b) => !this.prefs.blocked.some((x) => P.blockId(x) === P.blockId(b)));
    await this._writeJson('plugins.json', this.db);
    this.post({ event: 'plugin-prefs', prefs: this.prefs });
    if (n !== this.db.plugins.length) this.post({ event: 'plugins-changed', count: this.db.plugins.length });
    return { prefs: this.prefs, rescan: unblocked };
  }

  _plugins_list() {
    return { plugins: this.db.plugins, failed: this.db.failed, warnings: this._warnings(), scannedAt: this.db.scannedAt, folders: this.folders(),
      prefs: this.prefs, hostArch: this.hostArch, scanning: !!this._scanning };
  }

  async _host(arch = '') {
    const cur = this.hosts.get(arch);
    if (cur?.alive) return cur;
    if (this._hostStarting.has(arch)) return this._hostStarting.get(arch);
    const h = new PlugHost({ binary: this.o.binary, addon: this.addon, tmpDir: this.tmpDir, sampleRate: this.config.sampleRate, maxChannels: this.m.protocol.HOST_MAX_CHANNELS, arch, archTool: this.o.archTool,
      env: this.o.home ? { ...process.env, HOME: this.o.home, DAW3_HOME: this.o.home } : undefined }); // the host finds preset folders below HOME (Windows: DAW3_HOME)
    h.on('event', (e) => this.post({ event: 'plugin', ...e }));
    h.on('timeout', (inst) => this.post({ event: 'plugin-timeout', inst }));
    h.on('exit', (code, signal) => {
      const lost = [...this.instances].filter(([, v]) => v.host === h).map(([k]) => k);
      for (const k of lost) this.instances.delete(k);
      if (this.hosts.get(arch) === h) this.hosts.delete(arch);
      this.post({ event: 'plugin-host-exit', code, signal, insts: lost, arch });
    });
    const starting = h.start().then(() => { this.hosts.set(arch, h); return h; }, (e) => {
      if (arch === 'x86_64' && this.m.diag.isRosettaMissing(e.message)) throw new Error(`This is an Intel-only plugin and Rosetta 2 is not installed. ${this.m.diag.ROSETTA_FIX}`);
      throw e;
    }).finally(() => { this._hostStarting.delete(arch); });
    this._hostStarting.set(arch, starting);
    return starting;
  }

  async _plugins_load(o) {
    const desc = this.db.plugins.find((p) => p.key === o.key) || (o.format && o.uid ? { key: o.key, format: o.format, uid: o.uid, path: o.path || '', name: o.name || o.uid } : null);
    if (this.m.prefs.isPluginBlocked(this.prefs, desc || this._blockedDescs?.get(o.key) || { key: o.key, format: o.key.split(':')[0], path: o.path || '' })) {
      throw new Error(`${desc?.name || o.name || o.key} is on the plugin blocklist (Plugins › Native: unblock it to use it)`);
    }
    if (!desc) throw new Error(`Plugin not installed on this computer: ${o.name || o.key}`);
    const host = await this._host(desc.arch || '');
    const inst = this.nextInst++;
    const r = await host.call('load', { inst, plugin: desc, state: o.state || '', sampleRate: o.sampleRate || this.config.sampleRate, maxFrames: o.maxFrames || 2048 }, 60000);
    this.instances.set(inst, { desc, info: r.info, host });
    return { inst, ...r.info };
  }

  async _inst(inst) {
    const i = this.instances.get(inst);
    if (!i || !i.host.alive) throw new Error('That plugin instance is not loaded (the plugin host may have restarted)');
    return i;
  }

  async _plugins_unload(inst) { const i = this.instances.get(inst); this.instances.delete(inst); if (i?.host.alive) await i.host.call('unload', { inst }); return true; }
  async _plugins_info(inst) { const i = await this._inst(inst); return (await i.host.call('info', { inst })).info; }
  async _plugins_setParam(inst, param, value) { const i = await this._inst(inst); await i.host.call('setParam', { inst, param, value }); return true; }
  async _plugins_getState(inst) { const i = await this._inst(inst); return (await i.host.call('getState', { inst })).state; }
  async _plugins_setState(inst, state) { const i = await this._inst(inst); return (await i.host.call('setState', { inst, state })).info; }
  async _plugins_openEditor(inst) { const i = await this._inst(inst); await i.host.call('openEditor', { inst }); return true; }
  async _plugins_closeEditor(inst) { const i = await this._inst(inst); await i.host.call('closeEditor', { inst }); return true; }
  async _plugins_setOffline(inst, off) { const i = await this._inst(inst); await i.host.call('setOffline', { inst, offline: off }); return true; }

  /** Factory presets + preset files of an instance -> [{ id, name, category, kind: 'factory'|'file', path? }]. */
  async _plugins_presets(inst) { const i = await this._inst(inst); return (await i.host.call('presets', { inst }, 30000)).presets; }

  /** Load a preset (an id from plugins.presets) -> the instance info (new parameter values). */
  async _plugins_loadPreset(inst, preset) {
    const i = await this._inst(inst);
    const info = (await i.host.call('loadPreset', { inst, preset }, 30000)).info;
    i.info = info;
    return info;
  }

  /** Save the current state as a user preset file (.vstpreset / .aupreset) in the standard preset folder -> path. */
  async _plugins_savePreset(inst, name) {
    const i = await this._inst(inst);
    const ext = { vst3: '.vstpreset', au: '.aupreset' }[i.desc.format];
    if (!ext) throw new Error('CLAP has no standard preset file format: use “Save state” to keep the settings in the project');
    const file = path.join(this.presetFolder(i.desc), `${name}${ext}`);
    await i.host.call('savePreset', { inst, path: file }, 30000);
    return file;
  }

  /** The user preset folder of a plugin: ~/Library/Audio/Presets/<vendor>/<name> (Linux: ~/.vst3/presets/…,
   *  Windows: Documents\VST3 Presets\…, Steinberg's per-user location — the plugin host lists the same roots). */
  presetFolder(desc) {
    const seg = (x) => String(x || '').replace(/[/:\\]/g, '_');
    const home = this.o.home || os.homedir();
    const plat = this.o.platform || process.platform;
    const root = plat === 'darwin' ? path.join(home, 'Library', 'Audio', 'Presets')
      : plat === 'win32' ? path.join(home, 'Documents', 'VST3 Presets') : path.join(home, '.vst3', 'presets');
    return path.join(root, seg(desc.vendor), seg(desc.name));
  }

  /** Re-activate every loaded instance at a new sample rate -> { sampleRate, latency: {inst: samples}, failed }. */
  async _plugins_setSampleRate(rate) {
    for (const h of this.hosts.values()) h.sampleRate = rate;
    const live = [...this.hosts.values()].filter((h) => h.alive);
    if (!live.length || !this.instances.size) return { sampleRate: rate, latency: {}, failed: [] };
    const out = { sampleRate: rate, latency: {}, failed: [] };
    for (const h of live) { // one host per CPU architecture (Rosetta-hosted plugins live in their own)
      const r = await h.call('setSampleRate', { sampleRate: rate }, 60000);
      for (const [k, v] of Object.entries(r.latency || {})) { const i = this.instances.get(Number(k)); if (i?.info) i.info.latency = v; }
      out.sampleRate = r.sampleRate;
      Object.assign(out.latency, r.latency || {});
      out.failed.push(...(r.failed || []));
    }
    return out;
  }

  /**
   * Faster-than-realtime render of an instance (instrument, or an effect fed `input`): MIDI events [[frame, status, d1, d2]…] and parameter
   * automation [[frame, paramId, value]…] (sample-accurate: each change lands on its frame) over `frames` frames
   * -> { output: Float32Array (planar, numOut * frames: every output bus, bus after bus), numOut, buses }.
   */
  async _plugins_render(o) {
    const i = await this._inst(o.inst);
    const plug = i.info?.plugin || {};
    const numOut = Math.max(1, Math.min(MAX_RENDER_OUT, plug.totalOutputs || plug.numOutputs || 2));
    const numIn = Math.max(0, Math.min(8, plug.numInputs || 0));
    const block = 1024;
    if (i.info?.offline !== false) await i.host.call('setOffline', { inst: o.inst, offline: true });
    const valid = (e, n) => Array.isArray(e) && e.length >= n && e.every((x) => Number.isFinite(x));
    const events = (o.events || []).filter((e) => valid(e, 4)).sort((a, b) => a[0] - b[0]);
    const params = (o.params || []).filter((e) => valid(e, 3) && e[1] >= 0).map((e, k) => [e[0], e[1], e[2], k]).sort((a, b) => a[0] - b[0] || a[3] - b[3]);
    const output = new Float32Array(numOut * o.frames);
    const silence = new Float32Array(numIn * block);
    // optional input audio (effects): planar Float32Array, channels × frames (1 channel feeds every input)
    const src = o.input instanceof Float32Array && o.input.length >= o.frames && o.frames > 0 && numIn > 0 ? o.input : null;
    const srcCh = src ? Math.max(1, Math.floor(src.length / o.frames)) : 0;
    let ei = 0, pi = 0;
    for (let f = 0; f < o.frames;) {
      let n = Math.min(block, o.frames - f);
      // the shared-memory block holds 512 MIDI / 256 parameter events: dense passages get shorter blocks
      if (events.length - ei > 500 && events[ei + 500][0] < f + n) n = Math.max(1, events[ei + 500][0] - f);
      if (params.length - pi > 250 && params[pi + 250][0] < f + n) n = Math.max(1, params[pi + 250][0] - f);
      const midi = [], pv = [];
      while (ei < events.length && events[ei][0] < f + n) { const e = events[ei++]; midi.push(Math.max(0, e[0] - f), e[1], e[2], e[3]); }
      while (pi < params.length && params[pi][0] < f + n) { const e = params[pi++]; pv.push(Math.max(0, e[0] - f), e[1], e[2]); }
      let input = silence;
      if (src) { // planar effect input: channel c of this block = src[c * frames + f …]
        input = new Float32Array(numIn * n);
        for (let c = 0; c < numIn; c++) input.set(src.subarray(Math.min(c, srcCh - 1) * o.frames + f, Math.min(c, srcCh - 1) * o.frames + f + n), c * n);
      }
      const r = i.host.process({ inst: o.inst, nframes: n, numIn, numOut, input, midi: new Float64Array(midi), params: new Float64Array(pv), timeoutMs: 5000 });
      if (!r) throw new Error('The plugin stopped responding during the render');
      for (let c = 0; c < numOut; c++) output.set(r.output.subarray(c * n, c * n + n), c * o.frames + f);
      f += n;
    }
    if (i.info?.offline !== false) await i.host.call('setOffline', { inst: o.inst, offline: false }).catch(() => {});
    return { output, numOut, frames: o.frames, buses: plug.outputBuses || [{ name: 'Main', channels: numOut }] };
  }

  // ------------------------------------------------------------------------------------- stream
  /** One stream-port message -> reply message (or null). Synchronous. */
  stream(msg) {
    if (!this.m.protocol.validateStreamMessage(msg)) return null;
    if (msg.t === 'out') { if (this.status === 'running') this.addon.audioWrite(msg.data); return null; }
    if (msg.t === 'proc') {
      const i = this.instances.get(msg.inst);
      const r = i?.host.alive ? i.host.process({ inst: msg.inst, nframes: 128, numIn: msg.numIn, numOut: msg.numOut, input: msg.input, midi: msg.midi, params: msg.params,
        numSc: msg.numSc || 0, sidechain: msg.sidechain, timeoutMs: 100 }) : null;
      return { t: 'procd', inst: msg.inst, block: msg.block, output: r ? r.output : null, status: r ? r.status : -1, outParams: r ? r.outParams : new Float64Array(0) };
    }
    return null;
  }

  /** Captured device input since the last call -> { t:'in', data, channels } | null. */
  pollInput() {
    if (this.status !== 'running' || !this.config.inputEnabled) return null;
    const data = this.addon.audioRead(16384);
    if (!data.length) return null;
    const channels = this.addon.audioStats().deviceInChannels || 1;
    return { t: 'in', data, channels };
  }

  shutdown() {
    try { this.addon.audioClose(); } catch { /* */ }
    for (const h of this.hosts.values()) h.stop();
  }
}

/** Executable suffix of the native helpers on this OS ('.exe' on Windows). */
const EXE = process.platform === 'win32' ? '.exe' : '';

/** Where the native binaries live: packaged app -> Resources/native, dev -> desktop/native/build. */
function nativePaths({ resourcesPath, isPackaged } = {}) {
  const dir = isPackaged && resourcesPath ? path.join(resourcesPath, 'native') : path.join(__dirname, 'native', 'build');
  const addon = path.join(dir, 'daw3_audio.node');
  const binary = path.join(dir, `daw3-plughost${EXE}`);
  const link = path.join(dir, `daw3-link${EXE}`);
  return { dir, addon, binary, link: fs.existsSync(link) ? link : null, available: fs.existsSync(addon) && fs.existsSync(binary) };
}

module.exports = { NativeServer, nativePaths, EXE };
