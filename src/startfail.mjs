// A coding tool that ends at its start is said, never left as a quiet shell. Claude Code refuses bypass permissions
// mode for root and exits 1 within a second; a missing sign-in or network ends it as fast. The launcher hands the
// terminal to the tool whole (stdio inherited), so it never sees what the tool printed: it notes the early end in a
// file of its own beside the run records (the record itself goes with the launcher), and prints one fixed line after
// the tool's last words. The dashboard (server/deck.mjs) finds the note for a terminal that is back at its shell,
// reads the screen above that line, and the card reads "did not start" with what the tool printed last.
//
//   <runsDir>/<runId>.startfail   { at, code, tool, termId, tmuxPane, cwd, profile, reason? }   (listRuns reads only *.json;
//                                 `reason` once the dashboard has read it from the screen)
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './assistant/secrets.mjs';
import { runsDir } from './paths.mjs';

/** "Its first seconds": an end with an error code sooner than this after the start is an end at the start. */
export const EARLY_MS = 10_000;
/** The reason on a card: at most this many characters. */
export const REASON_MAX = 300;
const SUFFIX = '.startfail';
const KEEP_MS = 24 * 3600_000; // a note nobody looked at for a day goes (sweepStartFailures)
const TOOLS = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** The launcher's own line after the tool ended at its start. A fixed text: the dashboard finds it on the screen. */
export const endedLine = (tool, code) => `hoprig: ${TOOLS[tool] || 'The coding tool'} ended at its start (exit code ${code}).`;
const ENDED_RE = /^hoprig: (?:Claude Code|Codex|OpenCode|The coding tool) ended at its start \(exit code -?\d+\)\.$/;
// The launcher's line before the tool starts (launch.mjs): what is above it is not the tool's.
const PROFILE_RE = /^hoprig: (?:profile \S+ · |\S+ · provider )/;

/** Whether an end is an end at the start: an error code, soon after the start, not stopped by a signal or a move. */
export const endedAtStart = ({ code, ms, signalled = false, moved = false }) => code !== 0 && !signalled && !moved && ms >= 0 && ms < EARLY_MS;

/**
 * Note that the tool of `run` (its run record, read before it goes) ended at its start with `code`. Only for a
 * terminal the dashboard can name (a tmux pane or one of its own terminals): no other place shows a card.
 */
export function noteStartFailure(run, { code, tool = 'claude', at = Date.now() } = {}) {
  if (!run || !run.runId || !(run.termId || run.tmuxPane)) return null;
  const file = path.join(runsDir(), `${path.basename(String(run.runId))}${SUFFIX}`);
  try {
    fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ at, code, tool, termId: run.termId || null, tmuxPane: run.tmuxPane || null, cwd: run.cwd || null, profile: run.profile || null }), { mode: 0o600 });
    return file;
  } catch {
    return null; // never in the way of ending a launch
  }
}

/** Every note: [{ file, at, code, tool, termId, tmuxPane, cwd, profile }]. One that cannot be read is skipped. */
export function startFailures() {
  let names;
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  const out = [];
  for (const f of names) {
    if (!f.endsWith(SUFFIX)) continue;
    const file = path.join(runsDir(), f);
    try {
      const n = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (n && Number.isFinite(n.at)) out.push({ ...n, file });
    } catch {
      /* being written, or not ours */
    }
  }
  return out;
}

export const dropStartFailure = (n) => n && n.file && fs.rmSync(n.file, { force: true });

/** Keep `reason` (reasonFrom, already cleaned) in note `n`, so the card says it after the screen has changed. */
export function keepReason(n, reason) {
  if (!n || !n.file) return;
  const { file, ...rest } = n;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...rest, reason: String(reason).slice(0, REASON_MAX) }), { mode: 0o600 });
  } catch {
    /* the terminal went meanwhile */
  }
}

/** Notes older than a day go (a terminal closed long ago). */
export function sweepStartFailures(now = Date.now()) {
  for (const n of startFailures()) if (now - n.at > KEEP_MS) dropStartFailure(n);
}

/** The terminal `t` (a backend's list entry) of note `n`: the same id, and the note written after it was made. */
export const noteOfTerminal = (n, t) => !!n && !!t && (t.id === n.termId || t.id === n.tmuxPane) && n.at >= (t.created || 0) - 1000;

// Escape codes (colours, cursor moves, a title), then any other control character.
const ESC_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]|[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * What the tool printed last, from the terminal's `screen`: the lines above the launcher's line (endedLine), up to
 * its own line before the start, cleaned (escape codes and secrets out, spaces made one) and cut to REASON_MAX,
 * keeping the end. '' when the line is not on the screen.
 */
export function reasonFrom(screen) {
  const lines = String(screen || '').split(/\r?\n/).map((l) => l.replace(ESC_RE, '').trimEnd());
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (ENDED_RE.test(lines[i].trim())) { end = i; break; }
  if (end < 0) return '';
  const said = [];
  for (let i = end - 1; i >= 0 && said.length < 6; i--) {
    const l = lines[i].trim();
    if (PROFILE_RE.test(l) || ENDED_RE.test(l)) break;
    if (l) said.unshift(l);
  }
  const text = redact(said.join(' · ')).replace(/\s+/g, ' ').trim();
  return text.length > REASON_MAX ? `…${text.slice(text.length - REASON_MAX + 1)}` : text;
}

/** What a card says when the tool's own words are not on the screen any more. */
export const noReasonWords = (tool, code) => `${TOOLS[tool] || 'The coding tool'} ended at its start (exit code ${code}). What it printed is in the terminal.`;
