// View-scoped commands (Node-safe data): keys that only act in one view — piano roll, arrange / timeline, step rack,
// mixer. They live in the same rebindable command map as the global commands (src/control/commands.js) with
// `scope` = the view id, so the same key can mean different things in different views (Delete deletes notes in the
// piano roll and clips in the arrangement) and Preferences → Shortcuts / the command palette list them.
// Each view registers what `action` does: app.viewActions[view][action](e) (return false = nothing to do, the key
// falls through).

export const VIEW_SCOPES = { piano: 'Piano roll', arrange: 'Arrange', rack: 'Step rack', mixer: 'Mixer' };

const P = 'piano', A = 'arrange', R = 'rack', M = 'mixer';
const c = (scope, action, label, keys, extra = {}) => ({ id: `${scope}.${action}`, scope, action, label, keys, category: VIEW_SCOPES[scope], ...extra });

export const VIEW_COMMANDS = [
  // piano roll
  c(P, 'delete', 'Delete selected notes', ['delete', 'backspace']),
  c(P, 'selectAll', 'Select all notes', ['mod+a']),
  c(P, 'copy', 'Copy notes', ['mod+c']),
  c(P, 'cut', 'Cut notes', ['mod+x']),
  c(P, 'paste', 'Paste notes', ['mod+v']),
  c(P, 'duplicate', 'Duplicate notes to the right', ['mod+d']),
  c(P, 'deselect', 'Deselect notes', ['escape']),
  c(P, 'nudgeLeft', 'Move notes left (one grid step)', ['arrowleft'], { repeat: true }),
  c(P, 'nudgeRight', 'Move notes right (one grid step)', ['arrowright'], { repeat: true }),
  c(P, 'nudgeLeftFine', 'Move notes left (1/32)', ['alt+arrowleft'], { repeat: true }),
  c(P, 'nudgeRightFine', 'Move notes right (1/32)', ['alt+arrowright'], { repeat: true }),
  c(P, 'up', 'Transpose notes +1 semitone', ['arrowup'], { repeat: true }),
  c(P, 'down', 'Transpose notes −1 semitone', ['arrowdown'], { repeat: true }),
  c(P, 'octaveUp', 'Transpose notes +1 octave', ['shift+arrowup'], { repeat: true }),
  c(P, 'octaveDown', 'Transpose notes −1 octave', ['shift+arrowdown'], { repeat: true }),
  c(P, 'quantize', 'Quantize note starts', ['q']),
  c(P, 'groove', 'Apply groove…', []),
  // arrange / timeline
  c(A, 'delete', 'Delete selected clips', ['delete', 'backspace']),
  c(A, 'rippleDelete', 'Ripple delete clips (close the gap)', ['shift+delete', 'shift+backspace']),
  c(A, 'split', 'Split clips at the playhead', ['s']),
  c(A, 'duplicate', 'Duplicate clips', ['mod+d']),
  c(A, 'copy', 'Copy clips', ['mod+c']),
  c(A, 'cut', 'Cut clips', ['mod+x']),
  c(A, 'paste', 'Paste clips at the playhead', ['mod+v']),
  c(A, 'selectAll', 'Select all clips', ['mod+a']),
  c(A, 'deselect', 'Deselect clips', ['escape']),
  c(A, 'nudgeLeft', 'Move clips left (snap step)', ['arrowleft'], { repeat: true }),
  c(A, 'nudgeRight', 'Move clips right (snap step)', ['arrowright'], { repeat: true }),
  c(A, 'nudgeBarLeft', 'Move clips left one bar', ['shift+arrowleft'], { repeat: true }),
  c(A, 'nudgeBarRight', 'Move clips right one bar', ['shift+arrowright'], { repeat: true }),
  c(A, 'laneUp', 'Move clips to the track above', ['arrowup'], { repeat: true }),
  c(A, 'laneDown', 'Move clips to the track below', ['arrowdown'], { repeat: true }),
  // step rack
  c(R, 'focusUp', 'Focus the row above', ['arrowup'], { repeat: true }),
  c(R, 'focusDown', 'Focus the row below', ['arrowdown'], { repeat: true }),
  c(R, 'shiftLeft', 'Shift the focused row left one step', ['arrowleft'], { repeat: true }),
  c(R, 'shiftRight', 'Shift the focused row right one step', ['arrowright'], { repeat: true }),
  c(R, 'clearRow', 'Clear the focused row', ['delete', 'backspace']),
  c(R, 'copyRow', 'Copy the focused row', ['mod+c']),
  c(R, 'pasteRow', 'Paste into the focused row', ['mod+v']),
  c(R, 'randomizeRow', 'Randomize the focused row', ['alt+r']),
  c(R, 'generateBeat', 'Generate a beat', ['g']),
  // mixer
  c(M, 'prevStrip', 'Select the channel to the left', ['arrowleft'], { repeat: true }),
  c(M, 'nextStrip', 'Select the channel to the right', ['arrowright'], { repeat: true }),
  c(M, 'mute', 'Mute the selected channel', ['shift+m']),
  c(M, 'solo', 'Solo the selected channel', ['shift+s']),
  c(M, 'resetVolume', 'Selected channel volume to 0 dB', ['0']),
  c(M, 'volumeUp', 'Selected channel volume +1 dB', ['shift+arrowup'], { repeat: true }),
  c(M, 'volumeDown', 'Selected channel volume −1 dB', ['shift+arrowdown'], { repeat: true }),
];

/**
 * Registry entries for the view commands. run(e): the view's handler (false when the view is not open / nothing
 * to do). From the palette (no event) a command first switches to its view.
 */
export function viewCommandEntries(app) {
  return VIEW_COMMANDS.map((d) => ({
    ...d,
    label: d.label,
    run: (e) => {
      const fn = app.viewActions?.[d.scope]?.[d.action];
      if (!e && app.ui && app.ui.get('view') !== d.scope) {
        app.ui.set({ view: d.scope });
        setTimeout(() => { try { app.viewActions?.[d.scope]?.[d.action]?.(null); } catch (err) { console.error(err); } }, 60);
        return true;
      }
      return fn ? fn(e || null) : false;
    },
  }));
}
