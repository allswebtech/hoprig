// Recognise "Claude Code hit a usage limit" in the text of a tmux pane.
//
// The strings come from the Claude Code binary itself (version 2.1.323, `strings` on the executable): the client
// keeps its own list of limit-message openings (the one it uses to tell a limit message from other errors), and
// these lines are what it prints. Examples as rendered:
//   You've hit your 5-hour limit · resets 5pm (Europe/Berlin)
//   You've hit your weekly limit · resets Nov 18, 9am (UTC)
//   You've reached your Fable limit for this week. Switch models?
//   You're out of usage credits. See Usage in Settings
//   Usage limit reached · continuing automatically in 2h 10m · esc to cancel      (auto-continue is on)
//   Stop and wait for limit to reset                                              (the limit menu is open)
//
// Only the last lines of the screen are looked at and a line must START with one of these (after the bullets and
// box characters Claude Code draws), so Claude merely talking about limits in a reply rarely matches. It is a
// heuristic on screen text: when Claude Code changes its wording, update the lists and the tests together.

// Openings of a "you are at a limit" line (Claude Code's own list, plus the older "session limit" wording).
export const LIMIT_PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  'Your org is out of usage',
  "Your seat type doesn't include usage",
  'Your usage allocation has been disabled by your admin',
  "Your group's usage limit is set to $0",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
  'Usage limit reached',
  'Fable limit reached',
];

// Lines that only make sense while a limit is in force: the limit menu and the paused / waiting banners.
export const LIMIT_LINES = [
  /^Stop and wait for limit to reset\b/,
  /^Wait for limit to reset\b/,
  /^Paused · (continues after the )?usage limit/,
  /^(?:Fable|Haiku|Mythos|Opus|Sonnet)(?: [^·\n]{1,40})? requires usage credits\./,
];

// Typographic apostrophes and the middle dot as a terminal may show them.
const norm = (s) => s.replace(/[‘’ʼ]/g, "'").replace(/ /g, ' ');
// Decoration Claude Code puts before a line: spaces, bullets (● ⏺ ⎿ ✻ * -), box sides (│ ┃), prompt arrows (❯ >).
const LEAD = /^[\s│┃⎿●⏺✻❯>*·•-]*/;

/**
 * Look at the last `lines` non-empty lines of `screen`. Returns null, or { text, resets } with the matching line
 * and, when the line says it, when the limit resets ("5pm (Europe/Berlin)").
 */
export function detectLimit(screen, lines = 25) {
  if (typeof screen !== 'string' || !screen) return null;
  const tail = screen.split('\n').map((l) => norm(l).replace(/\s+$/, '')).filter((l) => l.trim()).slice(-lines);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i].replace(LEAD, '').replace(/^\d{1,2}\.\s+/, ''); // menu items are numbered "1. Stop and wait…"
    if (LIMIT_PREFIXES.some((p) => line.startsWith(p) && /limit|usage|credits/i.test(line)) || LIMIT_LINES.some((re) => re.test(line))) {
      const m = /\bresets (?:at )?([^·\n]{1,60})/i.exec(line);
      return { text: line.slice(0, 200), resets: m ? m[1].trim() : '' };
    }
  }
  return null;
}
