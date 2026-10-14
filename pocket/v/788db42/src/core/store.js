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
    // Optional undo provider (collaboration: undo only your own ops) — { undo, redo, canUndo, canRedo }.
    this.history = null;
    // How the last top-level transaction was made ({ label, undo, coalesce }) — read by 'change' listeners.
    this.lastCommit = null;
  }

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
    this._batchDepth++;
    let result;
    try {
      result = fn(this.project);
    } finally {
      this._batchDepth--;
    }
    if (this._batchDepth === 0) {
      this.lastCommit = { label, undo: recordUndo, coalesce: !!opts.coalesce };
      this.project.modifiedAt = new Date().toISOString();
      this._emitChange(label);
    }
    return result;
  }

  _emitChange(label) {
    this.emit('change', this.project, label);
  }

  canUndo() { return this.history ? this.history.canUndo() : this.undoStack.length > 0; }
  canRedo() { return this.history ? this.history.canRedo() : this.redoStack.length > 0; }

  undo() {
    if (this.history) return this.history.undo();
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ label: step.label, snap: this._snapshot() });
    this._restore(step.snap);
    this._lastLabel = null;
    this._emitChange('undo');
    return step.label;
  }

  redo() {
    if (this.history) return this.history.redo();
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
    this.lastCommit = { label: 'load', undo: false, coalesce: false };
    this.emit('load', this.project);
    this._emitChange('load');
  }
}
