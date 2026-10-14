// Project store with transactional edits and undo/redo.
// Samples (large base64 payloads) are kept out of undo snapshots and shared by reference.
import { Emitter } from './util.js';
import { createProject, normalizeProject } from './model.js';

const MAX_UNDO = 200;

export class Store extends Emitter {
  constructor(project = createProject()) {
    super();
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this._batchDepth = 0;
    this._pendingEmit = false;
    this._lastLabel = null;
    this._lastTime = 0;
    this.guards = []; // edit guards: {capture(project), check(captured, project) -> violation|null, restore(violation, project)}
  }

  /**
   * Install an edit guard (e.g. core/freeze.js createFreezeGuard): checked after every top-level transaction; a
   * violation is rolled back by the guard and reported as store.on('blocked', {label, message}).
   */
  addGuard(guard) { this.guards.push(guard); return () => { this.guards = this.guards.filter((g) => g !== guard); }; }

  get() { return this.project; }

  _snapshot() {
    const { samples, ...rest } = this.project;
    return JSON.stringify(rest);
  }

  _restore(snap) {
    const samples = this.project.samples;
    this.project = { ...JSON.parse(snap), samples };
  }

  /**
   * Mutate the project inside fn(project). Records an undo step.
   * opts.coalesce: merge with previous step if same label within 800ms (knob drags).
   * opts.undo === false: no undo step (transient things like playhead / UI-only fields).
   * opts.guard === false: skip the edit guards (addGuard) — for whole-project restores (version history).
   */
  transact(label, fn, opts = {}) {
    const recordUndo = opts.undo !== false;
    if (recordUndo && this._batchDepth === 0) {
      const now = Date.now();
      const coalesce = opts.coalesce && this._lastLabel === label && now - this._lastTime < 800;
      if (!coalesce) {
        this.undoStack.push({ label, snap: this._snapshot() });
        if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
        this.redoStack.length = 0;
      }
      this._lastLabel = label;
      this._lastTime = now;
    }
    const caps = this._batchDepth === 0 && this.guards.length && opts.guard !== false ? this.guards.map((g) => g.capture(this.project)) : null;
    this._batchDepth++;
    let result;
    try {
      result = fn(this.project);
    } finally {
      this._batchDepth--;
    }
    if (caps) {
      this.guards.forEach((g, i) => {
        const v = g.check(caps[i], this.project);
        if (!v) return;
        g.restore(v, this.project);
        this.emit('blocked', { label, message: v.message, detail: v });
      });
    }
    if (this._batchDepth === 0) {
      this.project.modifiedAt = new Date().toISOString();
      this._emitChange(label);
    }
    return result;
  }

  _emitChange(label) {
    this.emit('change', this.project, label);
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ label: step.label, snap: this._snapshot() });
    this._restore(step.snap);
    this._lastLabel = null;
    this._emitChange('undo');
    return step.label;
  }

  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ label: step.label, snap: this._snapshot() });
    this._restore(step.snap);
    this._lastLabel = null;
    this._emitChange('redo');
    return step.label;
  }

  /** Replace the whole project (load / new). Clears history. */
  load(project) {
    this.project = normalizeProject(project);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._lastLabel = null;
    this.emit('load', this.project);
    this._emitChange('load');
  }
}
