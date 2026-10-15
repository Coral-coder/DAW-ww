// Why a native plugin failed, in words a musician can act on: CPU architecture (Intel-only plugins on Apple
// silicon run in a second, Rosetta-translated plugin host), macOS quarantine, crashes, timeouts. Also picks the
// host architecture for a plugin binary. Pure (no I/O): used by the audio server, the Plugins dialog and tests.

/** Mach-O CPU types (mach/machine.h). */
const CPU_TYPES = { 0x01000007: 'x86_64', 0x0100000c: 'arm64', 7: 'i386', 12: 'arm', 18: 'ppc', 0x01000012: 'ppc64' };

/**
 * Architectures of a Mach-O binary from its first bytes (thin or universal / fat, 32- or 64-bit fat tables)
 * -> ['arm64', 'x86_64', …], or null when the bytes are not Mach-O (ELF, PE, a text file…).
 */
export function machoArchs(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length < 8) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const be = dv.getUint32(0, false);
  const name = (t) => CPU_TYPES[t >>> 0] || `cpu${(t >>> 0).toString(16)}`;
  if (be === 0xcafebabe || be === 0xcafebabf) { // FAT_MAGIC / FAT_MAGIC_64 (big-endian table)
    const n = dv.getUint32(4, false);
    if (n === 0 || n > 32) return null; // Java class files share 0xCAFEBABE (their "count" is a version >= 45)
    const size = be === 0xcafebabf ? 32 : 20;
    const out = [];
    for (let i = 0; i < n && 8 + i * size + 4 <= b.length; i++) out.push(name(dv.getInt32(8 + i * size, false)));
    return out.length ? [...new Set(out)] : null;
  }
  const le = dv.getUint32(0, true);
  if (le === 0xfeedfacf || le === 0xfeedface) return [name(dv.getInt32(4, true))]; // thin, little-endian
  if (be === 0xfeedfacf || be === 0xfeedface) return [name(dv.getInt32(4, false))]; // thin, big-endian (PowerPC)
  return null;
}

/** The architecture the app's plugin host runs as on this machine (Node's process.arch). */
export const hostArchOf = (nodeArch) => (nodeArch === 'arm64' ? 'arm64' : nodeArch === 'x64' ? 'x86_64' : String(nodeArch || ''));

/**
 * Which plugin host a binary needs: { arch: '' } = the app's own host, { arch: 'x86_64' | 'arm64' } = a second
 * host translated / run as that architecture (macOS `arch -x86_64`), { arch: null, error } = none can load it.
 * Unknown archs (not Mach-O, unreadable) -> the own host.
 */
export function pickHostArch(archs, hostArch, platform = 'darwin') {
  if (!Array.isArray(archs) || !archs.length || platform !== 'darwin') return { arch: '' };
  const has = (a) => archs.includes(a) || (a === 'arm64' && archs.includes('arm64e'));
  if (has(hostArch)) return { arch: '' };
  if (hostArch === 'arm64' && has('x86_64')) return { arch: 'x86_64', intelOnly: true };
  if (hostArch === 'x86_64' && has('arm64')) return { arch: 'arm64' }; // Intel app under Rosetta on Apple silicon
  const what = archs.filter((a) => a !== 'arm64e').join(' / ') || archs.join(' / ');
  return { arch: null, error: `This plugin is built for ${what} only, which this Mac cannot run` };
}

/** Loader text that means "this binary is for another CPU". */
export const isArchError = (text) => /incompatible architecture|wrong architecture|bad CPU type|no matching architecture|have '[\w]+', need '[\w]+'|wrong ELF class|not a valid Win32 application|%1 is not a valid/i.test(String(text || ''));

/** `arch -x86_64 …` failed because Rosetta 2 is not installed. */
export const isRosettaMissing = (text) => /bad CPU type in executable|posix_spawnp.*(?:86|arch)|rosetta/i.test(String(text || ''));

export const ROSETTA_FIX = 'Install Rosetta 2 (Terminal: softwareupdate --install-rosetta --agree-to-license), then retry';

/** The Terminal command that lifts macOS' quarantine from a plugin bundle. */
export const quarantineCommand = (path) => `xattr -dr com.apple.quarantine "${String(path || '').replace(/"/g, '\\"')}"`;
export const quarantineFix = (path) => `macOS has quarantined this plugin (downloaded, not notarized). Allow it in System Settings › Privacy & Security, or run in Terminal: ${quarantineCommand(path)}`;

/** Electron wraps errors from the main process: "Error invoking remote method 'daw3:native': Error: <message>". */
export function cleanErrorMessage(e) {
  let s = String(e?.message ?? e ?? '');
  s = s.replace(/^Error invoking remote method '[^']*':\s*/, '');
  s = s.replace(/^(?:Uncaught )?(?:[A-Z][A-Za-z]*)?Error:\s*/, '');
  return s.trim() || 'Unknown error';
}

export const FAILURE_LABELS = {
  quarantined: 'Quarantined by macOS', 'intel-only': 'Intel-only', 'wrong-arch': 'Wrong architecture', crashed: 'Crashed',
  timeout: 'Timed out', error: 'Could not load',
};

/**
 * A failed scan entry -> { reason, label, detail, hint }. reason is one of FAILURE_LABELS' keys; `detail` is the
 * loader's own text, `hint` what to do about it ('' when there is nothing specific).
 */
export function classifyFailure(f = {}) {
  const err = String(f.error || '');
  let reason = 'error', hint = '';
  if (f.quarantined) { reason = 'quarantined'; hint = quarantineFix(f.path); }
  else if (f.intelOnly || (f.arch === 'x86_64' && isRosettaMissing(err))) { reason = 'intel-only'; hint = isRosettaMissing(err) || f.rosettaMissing ? ROSETTA_FIX : 'This plugin only has an Intel (x86_64) binary: it runs in a Rosetta-translated plugin host. Ask the vendor for an Apple-silicon / Universal version for lower CPU use'; }
  else if (f.crashed) { reason = 'crashed'; hint = 'The plugin crashed the scanner. Update it, or block it so it is never scanned again'; }
  else if (f.timedOut) { reason = 'timeout'; hint = 'The plugin took too long to load (it may be waiting for a licence / authorisation window). Open it once in its own app or retry'; }
  else if (isArchError(err)) { reason = 'wrong-arch'; hint = 'The plugin binary is for another CPU type than this computer'; }
  return { reason, label: FAILURE_LABELS[reason], detail: err, hint };
}
