// Hybrid logical clock. Timestamps are strings that sort lexicographically in causal-ish
// order: "<wall ms base36, 9 chars>.<counter base36, 4 chars>.<replica id>".
// Two ops never share a timestamp (the replica id breaks ties), so every LWW comparison is total
// and every replica reaches the same winner. Pure / Node-safe.

const pad = (n, w) => n.toString(36).padStart(w, '0');

export function formatTs(l, c, replica) { return `${pad(l, 9)}.${pad(c, 4)}.${replica}`; }

export function parseTs(ts) {
  const i = ts.indexOf('.'), j = ts.indexOf('.', i + 1);
  return { l: parseInt(ts.slice(0, i), 36), c: parseInt(ts.slice(i + 1, j), 36), replica: ts.slice(j + 1) };
}

export const replicaOf = (ts) => ts.slice(ts.indexOf('.', ts.indexOf('.') + 1) + 1);

export class HLC {
  /** now: () => wall-clock ms (injectable for deterministic tests). */
  constructor(replica, now = () => Date.now()) {
    if (!replica || /[.\u001f]/.test(replica)) throw new Error('HLC: bad replica id');
    this.replica = replica;
    this.now = now;
    this.l = 0;
    this.c = 0;
  }

  /** Next local timestamp. */
  tick() {
    const wall = Math.floor(this.now());
    if (wall > this.l) { this.l = wall; this.c = 0; } else this.c++;
    return formatTs(this.l, this.c, this.replica);
  }

  /** Fold a remote timestamp in so later local ticks sort after it. */
  observe(ts) {
    if (typeof ts !== 'string') return;
    const { l, c } = parseTs(ts);
    if (!Number.isFinite(l)) return;
    if (l > this.l) { this.l = l; this.c = c; } else if (l === this.l && c > this.c) this.c = c;
  }
}
