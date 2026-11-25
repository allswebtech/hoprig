// One line of help under a switch, and the rest under a closed "More" right under it (the owner: short labels, one
// line of help under each switch, the advanced things folded away). A hint is a string or nodes: one line, as before.
// Or { line, more }: the line, and a "More" fold under it, closed at first. What changes with the state, and a
// warning that something costs money, sends something out or cannot be undone, is in the line: never in the fold.
import { h } from './lib.js';
import { icon } from './icons.js';

export const MORE = 'More';
let n = 0;

/** A hint given as { line, more } (not a node, not an array of nodes). */
export const isSplit = (x) => !!x && typeof x === 'object' && !Array.isArray(x) && !(typeof Node !== 'undefined' && x instanceof Node) && 'line' in x;

/**
 * The "More" fold: closed at first; its summary is reached with Tab and opened with Enter or Space. It stands inside
 * the switch's <label>, where a click would also turn the switch: the click is taken (preventDefault) and the fold
 * opened by hand, so "More" never turns a switch.
 */
export function moreFold(more) {
  const fold = h('details.help-more',
    h('summary.help-more-summary', { onclick: (e) => {
      e.preventDefault();
      fold.open = !fold.open;
    } }, h('span', MORE), icon('chevronDown', { size: 14 })),
    h('div.help-more-body.hint', more));
  return fold;
}

/**
 * The nodes of a hint under a switch's label: one line (`tag`), and with { line, more } the fold under it. `input`:
 * the switch; with a fold its name is its label alone and the line describes it ("More" is not part of its name).
 */
export function helpParts(hint, { tag = 'span.hint', input = null, label = null } = {}) {
  if (!hint) return [];
  if (!isSplit(hint)) return [h(tag, hint)];
  const id = `help-line-${++n}`;
  const line = hint.line ? h(tag, { id }, hint.line) : null;
  if (input && typeof label === 'string') input.setAttribute('aria-label', label);
  if (input && line) input.setAttribute('aria-describedby', id);
  return [line, hint.more ? moreFold(hint.more) : null].filter(Boolean);
}

/**
 * A help text written elsewhere (the server's words) as { line, more }: its first sentence, and the rest. A sentence
 * ends at ".", "!" or "?" (after it a closing bracket or quote may stand) followed by a space.
 */
export function splitHelp(text) {
  const s = String(text || '').trim();
  const m = /^(.*?[.!?][)"”]?)\s+(\S.*)$/s.exec(s);
  return m ? { line: m[1], more: m[2] } : { line: s, more: null };
}
