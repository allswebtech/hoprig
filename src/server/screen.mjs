// What Claude Code's screen shows it doing right now. The hooks (../hook.mjs) say most of it, but two moments pass
// without any event: the owner allowed a tool and it now runs (nothing until it ends), and the owner said "No"
// or pressed Esc (the turn is over, and no event ever tells). The screen shows both. As drawn (2.1.325):
//
//   working                                       waiting for a message (also after Esc)
//     ● Bash(npm test)                              ⎿  Interrupted · What should Claude do instead?
//     ✻ Osmosing… (12s · ↓ 18 tokens)               ✻ Cooked for 12s · done 10:56 AM
//     ──────────────────────────────                ──────────────────────────────
//     ❯                                             ❯
//     ──────────────────────────────                ──────────────────────────────
//       ⏵⏵ bypass … · esc to interrupt                ⏵⏵ bypass permissions on · ? for shortcuts
//
// A question (a permission, AskUserQuestion, the plan) takes the place of the message box and of the line with the
// moving star, so while one is on the screen there is no message box and this says nothing.
// Like limits.mjs and prompts.mjs it reads screen text: when Claude Code changes how it draws, update this and
// its tests together. It only ever answers when it is sure; "nothing" leaves the card as the hooks have it.

const norm = (s) => s.replace(/\u00a0/g, ' ').replace(/\s+$/, ''); // a no-break space (drawn after ❯ and ⎿) as a space
// The rules above and below the message box (older versions drew a rounded box around it).
const RULE = /^\s*[╭╰]?[─━]{6,}[╮╯]?\s*$/;
// The message box's first line: the prompt arrow, alone or with what the owner is typing.
const BOX = /^\s*(?:│\s*)?[❯>](?:\s|$)/;
// The line with the moving star while Claude works: "✻ Osmosing… (12s · ↓ 18 tokens)", "✽ Skedaddling…". When the
// turn is over it reads "✻ Cooked for 12s" (no "…"), and what is left of it later is never just above the box.
const WORKING = /^\s*[·✢✳✶✻✽*+]\s[^…]{1,80}…(?:\s+\(.*)?$/;

/**
 * 'working' (the message box is there and Claude works above it), 'idle' (the message box is there and nothing
 * runs), or null (a question, a menu, another view, not Claude Code: no answer).
 */
export function screenLook(screen) {
  if (typeof screen !== 'string' || !screen) return null;
  const lines = screen.split('\n').map(norm).filter((l) => l.trim());
  // The message box is the last thing but the footer: look for its arrow right under a rule, from the bottom up.
  let box = -1;
  for (let i = lines.length - 1; i >= Math.max(1, lines.length - 14); i--) {
    if (BOX.test(lines[i]) && RULE.test(lines[i - 1])) {
      box = i;
      break;
    }
  }
  if (box < 0) return null;
  const end = lines.findIndex((l, i) => i > box && RULE.test(l));
  if (end < 0 || end - box > 12) return null; // no rule under it: not the message box
  if (lines.slice(end + 1).some((l) => /\besc to interrupt\b/i.test(l))) return 'working';
  // Above the box: the star line, with at most a tip (several lines on a narrow screen) and a hint between it
  // and the rule.
  if (lines.slice(Math.max(0, box - 13), box - 1).some((l) => WORKING.test(l))) return 'working';
  return 'idle';
}

/**
 * The last thing above the message box is Claude Code's note that the owner stopped the turn at a question with Esc
 * (2.1.326; the real screens are in test/server/fixtures/claude-screens):
 *   a permission, or Claude at work    ⎿  Interrupted · What should Claude do instead?
 *   the question tool                  ● Declined to answer Claude's questions:   (then "⎿  · <question> (<answers>)")
 *   the plan's approval                ⎿  Rejected Claude's plan:                  (then the plan in a box)
 * Each may wrap on a narrow terminal. Only meaningful where screenLook says 'idle'.
 */
export function interrupted(screen) {
  if (typeof screen !== 'string' || !screen) return false;
  const lines = screen.split('\n').map(norm).filter((l) => l.trim());
  let box = -1;
  for (let i = lines.length - 1; i >= Math.max(1, lines.length - 14); i--) {
    if (BOX.test(lines[i]) && RULE.test(lines[i - 1])) {
      box = i - 1;
      break;
    }
  }
  if (box < 1) return false;
  const text = (from, to) => lines.slice(Math.max(0, from), to).map((l) => l.trim()).join(' ').replace(/\s+/g, ' ');
  if (/⎿ Interrupted · What should Claude do instead\?$/.test(text(box - 4, box))) return true;
  // What follows the other two notes: the plan's box, or the questions declined (each "⎿  · …", wrapped deeper).
  let k = box - 1;
  const top = Math.max(0, box - 60);
  if (/^\s{3,}╰/.test(lines[k] || '')) {
    while (k > top && !/^\s{3,}╭/.test(lines[k])) k--;
    return /^\s*⎿\s+Rejected Claude's plan:$/.test(lines[k - 1] || '');
  }
  while (k > top && /^\s{2,}(?:⎿\s+·|\s{3,}\S)/.test(lines[k])) k--;
  return k < box - 1 && /^● Declined to answer Claude's questions:$/.test(lines[k]);
}

/** How long the screen must look idle before a run that says "working" or "needs your OK" is not believed. */
export const IDLE_MS = 4000;

/**
 * The status to show for `run` when its screen has looked like `look`, idle for `idleFor` ms:
 *   - it waits for an OK (not an API error) and the screen shows Claude working: the OK was given, it works;
 *   - it says working or waits for an OK, and the screen has sat at an empty message box: the turn was stopped
 *     (Esc, or "No" to the question). With subagents still running in the background that is "working".
 * Anything else is what the run says.
 */
export function shownStatus(run, look, idleFor = 0) {
  const background = Array.isArray(run.background) && run.background.length > 0;
  const asking = run.status === 'attention' && !run.failure;
  if (asking && look === 'working') return 'working';
  if (look === 'idle' && idleFor >= IDLE_MS && (asking || (run.status === 'working' && !background))) return background ? 'working' : 'waiting';
  return run.status;
}
