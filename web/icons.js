// Inline SVG icons (24×24, stroke-based, drawn for this project). Built with DOM calls, never innerHTML.
const P = {
  back: ['M15 18l-6-6 6-6'],
  chevronRight: ['M9 6l6 6-6 6'],
  chevronDown: ['M6 9l6 6 6-6'],
  up: ['M6 15l6-6 6 6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  down: ['M6 9l6 6 6-6'],
  plus: ['M12 5v14', 'M5 12h14'],
  minus: ['M5 12h14'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  checkAll: ['M2 12.5l4.5 4.5L16 7.5', 'M11.5 16l1 1L22 7.5'],
  tasks: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M3.5 6l1.5 1.5 2.5-3', 'M3.5 12l1.5 1.5 2.5-3', 'M3.5 18l1.5 1.5 2.5-3'],
  folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
  folderUp: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', 'M12 16v-5', 'M9.5 13.5L12 11l2.5 2.5'],
  terminal: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M7 10l3 2-3 2', 'M12 15h5'],
  sessions: ['M4 5h16v5H4z', 'M4 14h16v5H4z', 'M7 7.5h.01', 'M7 16.5h.01'],
  book: ['M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z', 'M5 19.5A1.5 1.5 0 0 0 6.5 21H19', 'M9 7h6'],
  brain: ['M9 4a3 3 0 0 0-3 3v.2A3 3 0 0 0 4 10a3 3 0 0 0 1 2.2A3 3 0 0 0 6 17a3 3 0 0 0 3 3h0V4z', 'M15 4a3 3 0 0 1 3 3v.2A3 3 0 0 1 20 10a3 3 0 0 1-1 2.2A3 3 0 0 1 18 17a3 3 0 0 1-3 3h0V4z', 'M9 4v16', 'M15 4v16'],
  home: ['M4 11l8-7 8 7', 'M6 9.5V20h4.5v-5.5h3V20H18V9.5'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  cpu: ['M7 7h10v10H7z', 'M10 10h4v4h-4z', 'M10 3v4', 'M14 3v4', 'M10 17v4', 'M14 17v4', 'M3 10h4', 'M3 14h4', 'M17 10h4', 'M17 14h4'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 17h4', 'M12 17h8', 'M16 5v4', 'M10 15v4'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  swap: ['M7 7h12', 'M15 3l4 4-4 4', 'M17 17H5', 'M9 13l-4 4 4 4'],
  // A branch: two commits on a line and one off it (git).
  git: ['M6 3v12', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
  zap: ['M13 3L5 14h6l-1 7 8-11h-6z'],
  // A filled rounded square (FILLED below): a stop sign, not an empty box.
  stop: ['M8 5.5h8A2.5 2.5 0 0 1 18.5 8v8a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 16V8A2.5 2.5 0 0 1 8 5.5z'],
  send: ['M12 19V5', 'M6 11l6-6 6 6'],
  paperclip: ['M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L15 6.9'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  moreV: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'], // ⋮, the App's more menu as the desktop app draws it
  copy: ['M9 9h10v10H9z', 'M5 15V5h10'],
  clipboard: ['M9 4h6v3H9z', 'M8 5.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6.5a1 1 0 0 0-1-1h-2'],
  pencil: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  alert: ['M12 3l9.5 17h-19z', 'M12 10v4.5', 'M12 17.5h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  bell: ['M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
  refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v4.5h-4.5'],
  logout: ['M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4', 'M10 16l-4-4 4-4', 'M6 12h10'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  key: ['M15 3a6 6 0 1 1-5.2 9H3v-3h2V7h3v2h1.8A6 6 0 0 1 15 3z', 'M16.5 7.5h.01'],
  power: ['M12 3v8', 'M6.3 6.8a8 8 0 1 0 11.4 0'],
  lock: ['M6 11h12v10H6z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  pin: ['M9 4h6l-1 6 3 3H7l3-3-1-6z', 'M12 13v7'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
  sparkle: ['M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z'],
  sun: ['M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 2v2', 'M12 20v2', 'M4.9 4.9l1.4 1.4', 'M17.7 17.7l1.4 1.4', 'M2 12h2', 'M20 12h2', 'M4.9 19.1l1.4-1.4', 'M17.7 6.3l1.4-1.4'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z'],
  text: ['M5 6h14', 'M5 10h14', 'M5 14h10', 'M5 18h7'],
  play: ['M8 5l11 7-11 7z'],
  terminalGo: ['M14 5H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5', 'M7 10l3 2-3 2', 'M16 3h5v5', 'M21 3l-7 7'], // a terminal, an arrow out: the conversation goes there
  panelLeft: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M9 5v14'], // a panel at the left
  rail: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M15 5v14'], // a panel at the right
  code: ['M8 7l-5 5 5 5', 'M16 7l5 5-5 5', 'M13.5 5l-3 14'],
  // A screen on a stand (the desktop); one square and two stacked ones (a window's maximise and restore).
  monitor: ['M3 4.5h18v12H3z', 'M8.5 20.5h7', 'M12 16.5v4'],
  square: ['M5 5h14v14H5z'],
  restore: ['M8 8h11v11H8z', 'M5 15V5h10'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  // Files: an upload (the download's arrow the other way) and an eye (hidden files shown).
  upload: ['M12 15V4', 'M7 9l5-5 5 5', 'M5 20h14'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  // Files: one glyph per action, so a bar of icons alone never shows the same one twice.
  folderPlus: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z', 'M12 11v5', 'M9.5 13.5h5'],
  filePlus: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M12 11v6', 'M9 14h6'],
  archive: ['M3 4h18v4H3z', 'M5 8v12h14V8', 'M10 12h4'],
  trashBack: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M12 17v-6', 'M9.5 13.5L12 11l2.5 2.5'],
  // Services: a stack of running parts (the power glyph reads as "turn the computer off").
  stack: ['M12 3l9 4.5-9 4.5-9-4.5z', 'M3 12l9 4.5 9-4.5', 'M3 16.5l9 4.5 9-4.5'],
  // A microphone (voice typing), and one struck through (the browser cannot hear).
  mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21', 'M9 21h6'],
  micOff: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M5.5 11a6.5 6.5 0 0 0 13 0', 'M12 17.5V21', 'M9 21h6', 'M4 4l16 16'],
  // The App's session list: Group and sort (three lines, each shorter).
  sort: ['M4 7h16', 'M7 12h10', 'M10 17h4'],
  // The Sessions button of a phone's title bar: three lines of one length (a list).
  list: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  // A comment on a line of a diff.
  comment: ['M4 5h16v11H9l-5 4z'],
};

const NS = 'http://www.w3.org/2000/svg';
// Pictures drawn solid, not as an outline.
const FILLED = new Set(['stop']);

/** An icon as an <svg> element. `label` makes it visible to screen readers; otherwise it is decorative. */
export function icon(name, { size = 20, label = '' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', FILLED.has(name) ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', 'icon');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  for (const d of P[name] || P.info) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(P);
