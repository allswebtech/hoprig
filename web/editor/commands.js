// The editor's own commands and their keys, as VS Code has them on Linux (its keybindings page and printable Linux
// list). A browser tab keeps a few keys for its own tabs and windows (Ctrl+W, Ctrl+N, Ctrl+T, Ctrl+Shift+T, Ctrl+Tab,
// Ctrl+PageDown and Ctrl+PageUp): the page never sees them there. Where one of them does reach the page (the dashboard
// installed as an app gets every key) it works as in VS Code; and each such command has a key a browser tab leaves
// alone: VS Code for the Web's own where its page names one (setup/vscode-web), else one chord. The command palette
// (Ctrl+Shift+P, F1) lists every command with the key that works, and says which key the browser keeps; the editor's
// Keyboard Shortcuts (Ctrl+K Ctrl+S) lists them all under the one line below. Keys of the code editor itself (find,
// multi-cursor, move a line, comment, format, undo ...) are Monaco's and are not in this table.

export const BROWSER_LINE = 'A browser tab keeps Ctrl+W, Ctrl+N, Ctrl+T, Ctrl+Shift+T, Ctrl+Tab, Ctrl+Shift+Tab and Ctrl+PageDown/PageUp for itself: use the key shown beside the command. Installed as an app (the browser\'s Install), VS Code\'s own keys work too.';

/**
 * id, label (VS Code's words), keys (the keys that run it here; the first is the one shown), browser (VS Code's own
 * key where a browser tab keeps it: taken too where it reaches the page), palette: false for a command the palette
 * itself is (or has already), skipShell: the terminal panel gives its key to the page, not to the shell (VS Code's
 * terminal.integrated.commandsToSkipShell default has these; Ctrl+B or Ctrl+Shift+E go to the shell there too),
 * notTyping: keys that work only while neither the code editor nor a text box has the keyboard (VS Code's
 * when: !editorFocus): in text they type (AltGr+C is Ctrl+Alt+C on Windows, "ć" on a Polish keyboard).
 */
export const COMMANDS = [
  { id: 'save', label: 'File: Save', keys: ['Ctrl+S'] },
  { id: 'saveAll', label: 'File: Save All', keys: ['Ctrl+K S'] },
  { id: 'newFile', label: 'File: New File...', keys: ['Ctrl+Alt+N'], browser: 'Ctrl+N' },
  { id: 'quickOpen', label: 'Go to File...', keys: ['Ctrl+P'], skipShell: true },
  { id: 'palette', label: 'Show All Commands', keys: ['Ctrl+Shift+P', 'F1'], palette: false, skipShell: true },
  { id: 'goToLine', label: 'Go to Line/Column...', keys: ['Ctrl+G'], palette: false },
  { id: 'findInFiles', label: 'Search: Find in Files', keys: ['Ctrl+Shift+F'] },
  { id: 'replaceInFiles', label: 'Search: Replace in Files', keys: ['Ctrl+Shift+H'] },
  { id: 'searchDetails', label: 'Search: Toggle Search Details', keys: ['Ctrl+Shift+J'] },
  { id: 'explorer', label: 'View: Show Explorer', keys: ['Ctrl+Shift+E'] },
  { id: 'scm', label: 'View: Show Source Control', keys: ['Ctrl+Shift+G'] },
  { id: 'sidebar', label: 'View: Toggle Primary Side Bar Visibility', keys: ['Ctrl+B'] },
  { id: 'focusEditor', label: 'View: Focus First Editor Group', keys: ['Ctrl+1'] },
  { id: 'panel', label: 'View: Toggle Panel Visibility', keys: ['Ctrl+J'], skipShell: true },
  { id: 'terminal', label: 'View: Toggle Terminal', keys: ['Ctrl+`'], skipShell: true },
  { id: 'closeEditor', label: 'View: Close Editor', keys: ['Ctrl+Shift+Alt+N'], browser: 'Ctrl+W' },
  { id: 'closeAll', label: 'View: Close All Editors in Group', keys: ['Ctrl+K W'] },
  { id: 'closeSaved', label: 'View: Close Saved Editors in Group', keys: ['Ctrl+K U'] },
  { id: 'reopen', label: 'View: Reopen Closed Editor', keys: ['Ctrl+K Shift+T'], browser: 'Ctrl+Shift+T' },
  // Chrome keeps Ctrl+PageDown also as the second stroke of VS Code's Ctrl+K Ctrl+PageDown: the second key without Ctrl.
  { id: 'nextEditor', label: 'View: Open Next Editor', keys: ['Ctrl+K PageDown'], browser: 'Ctrl+PageDown' },
  { id: 'prevEditor', label: 'View: Open Previous Editor', keys: ['Ctrl+K PageUp'], browser: 'Ctrl+PageUp' },
  { id: 'keepOpen', label: 'View: Keep Editor', keys: ['Ctrl+K Enter'] },
  { id: 'pin', label: 'View: Pin Editor', keys: ['Ctrl+K Shift+Enter'] },
  // VS Code: Ctrl+Alt+C outside the code editor and Ctrl+K Ctrl+Alt+C in it (fileCommands.ts), Ctrl+K P (LX).
  { id: 'copyPath', label: 'File: Copy Path of Active File', keys: ['Ctrl+K P', 'Ctrl+Alt+C', 'Ctrl+K Ctrl+Alt+C'], notTyping: ['Ctrl+Alt+C'] },
  { id: 'copyRelativePath', label: 'File: Copy Relative Path of Active File', keys: ['Ctrl+Shift+Alt+C', 'Ctrl+K Ctrl+Shift+Alt+C'], notTyping: ['Ctrl+Shift+Alt+C'] },
  // VS Code's Ctrl+K R opens the file's folder in the system's file manager (revealActiveFileInWindows); a browser
  // cannot, so here it is the nearest thing, the file's row in the Explorer. VS Code gives this command no key.
  { id: 'reveal', label: 'File: Reveal Active File in Explorer View', keys: ['Ctrl+K R'] },
  { id: 'wordWrap', label: 'View: Toggle Word Wrap', keys: ['Alt+Z'] },
  { id: 'settings', label: 'Preferences: Open Settings', keys: ['Ctrl+,'] },
  { id: 'shortcuts', label: 'Preferences: Open Keyboard Shortcuts', keys: ['Ctrl+K Ctrl+S'] },
];

// The key of a keydown by its place on the keyboard (e.code), so Shift and Alt do not change it; the rest by e.key.
const CODES = { Backquote: '`', Backslash: '\\', Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: '\'', BracketLeft: '[', BracketRight: ']' };
const NAMES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Esc: 'Escape' };
/** The name of a keydown's key ("N", "`", "PageDown", "F1"), or null for a modifier alone. */
export function keyName(e) {
  const c = String(e.code || '');
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return c.slice(5);
  if (CODES[c]) return CODES[c];
  const k = String(e.key || '');
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(k)) return null;
  return NAMES[k] || (k.length === 1 ? k.toUpperCase() : k);
}

/**
 * "Ctrl+Shift+Alt+N" for a keydown: the modifiers in VS Code's order (Cmd counts as Ctrl), then the key. A key with
 * AltGr is a letter being typed, never a command (Windows reports AltGr as Ctrl+Alt): null.
 */
export function strokeOf(e) {
  if (typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return null;
  const k = keyName(e);
  if (!k) return null;
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', k].filter(Boolean).join('+');
}

/**
 * Reads strokes into commands, with VS Code's chords (Ctrl+K, then a second key). read(stroke, { inEditor, inText })
 * → { id } a command, { wait } the first stroke of a chord, { miss } a chord that is no command, or null: not this
 * table's key. `inEditor`: the code editor has the keyboard, and reads its own chords (this table's are added to it);
 * `inText`: a text box of the page has it. In either a notTyping key is left to the text.
 */
export function createKeyReader(commands = COMMANDS) {
  const map = new Map();
  for (const c of commands) for (const k of [...c.keys, ...(c.browser ? [c.browser] : [])]) map.set(k, c.id);
  const firsts = new Set([...map.keys()].filter((k) => k.includes(' ')).map((k) => k.split(' ')[0]));
  const typing = new Set(commands.flatMap((c) => c.notTyping || []));
  let pending = null;
  let editorChord = false; // the code editor reads a chord of its own: its second stroke is the editor's too
  return {
    read(stroke, { inEditor = false, inText = false } = {}) {
      if (!stroke) return null; // a modifier on its way to the second key
      if (editorChord) {
        editorChord = false;
        return null;
      }
      if (pending) {
        const k = `${pending} ${stroke}`;
        pending = null;
        return map.has(k) ? { id: map.get(k) } : { miss: k };
      }
      if (firsts.has(stroke)) {
        if (inEditor) {
          editorChord = true;
          return null;
        }
        pending = stroke;
        return { wait: stroke };
      }
      if (typing.has(stroke) && (inEditor || inText)) return null;
      return map.has(stroke) ? { id: map.get(stroke) } : null;
    },
    /** The first stroke of a chord on its way ("Ctrl+K"), read here or by the code editor. */
    get pending() {
      return pending || (editorChord ? 'Ctrl+K' : null);
    },
    reset() {
      pending = null;
      editorChord = false;
    },
  };
}

/** The keys the terminal panel gives to the page (skipShell): every other key, Ctrl+C and Ctrl+D among them, is the shell's. */
export const terminalKeyReader = () => createKeyReader(COMMANDS.filter((c) => c.skipShell));

const MONACO_NAMES = { '`': 'Backquote', '\\': 'Backslash', '=': 'Equal', '-': 'Minus', ',': 'Comma', '.': 'Period', '/': 'Slash', '[': 'BracketLeft', ']': 'BracketRight', Up: 'UpArrow', Down: 'DownArrow', Left: 'LeftArrow', Right: 'RightArrow' };
/** A key of this table ("Ctrl+K Shift+T") as Monaco's keybinding number, or null where Monaco has no such key. */
export function monacoKey(monaco, keys) {
  const { KeyMod, KeyCode } = monaco;
  const one = (s) => {
    const parts = s.split('+');
    let name = parts.pop();
    if (name === '' && parts[parts.length - 1] === '') name = '+';
    let n = 0;
    for (const p of parts) n |= p === 'Ctrl' ? KeyMod.CtrlCmd : p === 'Shift' ? KeyMod.Shift : p === 'Alt' ? KeyMod.Alt : 0;
    const code = /^[A-Z]$/.test(name) ? KeyCode[`Key${name}`] : /^\d$/.test(name) ? KeyCode[`Digit${name}`] : KeyCode[MONACO_NAMES[name] || name];
    return code === undefined ? null : n | code;
  };
  const strokes = keys.split(' ').map(one);
  if (strokes.some((x) => x === null)) return null;
  return strokes.length === 1 ? strokes[0] : KeyMod.chord(strokes[0], strokes[1]);
}

/** The keys the code editor itself is given for a command (tabs.js): all but those that type there (notTyping). */
export const editorKeys = (c) => c.keys.filter((k) => !(c.notTyping || []).includes(k));

/** The palette's words for a command: VS Code's, and which of VS Code's keys the browser keeps (the one plain line). */
export const paletteLabel = (c) => (c.browser ? `${c.label} (a browser tab keeps ${c.browser})` : c.label);
