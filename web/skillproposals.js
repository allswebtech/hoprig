// Skills → proposals: better texts for Tia's skills, tool descriptions and prompt sections, found by an improvement
// loop and measured with Hoprig's own eval (src/skillhub/proposals.mjs). Each card says what would change and why, the
// numbers before and after and what finding it cost. Accept (a skill's text goes in place, the text before is kept; a
// tool's description or a prompt section is kept in Hoprig's state, the code is not changed), Undo, or Not now. An
// accepted text whose shipped text changed since it was measured no longer applies: its row says so, with Remove. An
// issue text, for a change to code, is shown with Copy.
import { api, btn, fill, h, toast } from './lib.js';
import { icon } from './icons.js';
import { money } from './chat/words.js';

const shortDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const what = (p) => (p.kind === 'skill' ? `Tia's skill "${p.name}"` : p.kind === 'prompt' ? `the part "${p.label || p.name}" of Tia's instructions` : `the description of Tia's tool "${p.name}"`);
const short = (p) => (p.kind === 'prompt' ? `"${p.label || p.name}"` : `"${p.name}"`);
const KIND_ICON = { skill: 'sparkle', tool: 'code', prompt: 'text' };
const KIND_TAG = { skill: ['low', 'skill'], tool: ['medium', 'tool description'], prompt: ['medium', 'instructions'] };
const frac = (x) => (x ? `${x.passed} of ${x.cases}` : '–');
// Each check of the loop in one plain sentence (an unknown name is shown as it is).
const CHECK = {
  whole: 'No worse on the whole eval than the text now',
  safety: 'Every safety case passed',
  heldout: 'No worse on cases it never saw while searching',
  size: 'Its size is within the limits',
  threat: 'No link, secret, machine path or new order to the model added',
  diff: 'Short enough to read as a diff',
  fit: 'It does not copy the eval\'s own messages',
};

// The server compares the numbers (p.verdict): a rise is green, a fall red with the word, so colour is never alone.
function numbers(p) {
  const n = p.numbers;
  const c = n.cost;
  const v = p.verdict || {};
  const row = (label, before, after, state) => h('div.pp-num', h('span.pp-label', label),
    h('span.pp-vals', h('span', before), icon('chevronRight', { size: 14 }), h(`strong${state === 'better' ? '.pp-up' : state === 'worse' ? '.pp-down' : ''}`, after), state === 'worse' ? h('span.pp-down', 'worse') : null));
  return h('div.pp-nums',
    row('Eval cases passed', frac(n.whole.before), frac(n.whole.after), v.whole),
    row('Cases it never saw while searching', frac(n.heldout.before), frac(n.heldout.after), v.heldout),
    // A case's tokens are all of its turns, cache reads included, so the number is per eval case, never per turn.
    row('Tokens per eval case (cache included)', n.tokens.before === null ? '–' : n.tokens.before.toLocaleString(), n.tokens.after === null ? '–' : n.tokens.after.toLocaleString(), false),
    // The fresh samples decide "better": both texts, the same cases, the same rounds; the spread is the text now
    // against itself, so a gain smaller than it would be chance.
    n.fresh ? h('p.hint.pp-cost', `Tried again on ${n.fresh.cases} case${n.fresh.cases === 1 ? '' : 's'}, ${n.fresh.rounds} times each: the text now passed ${n.fresh.live.join(', ')}; the new text ${n.fresh.candidate.join(', ')}. The text now varies by ${n.fresh.spread} between tries on its own, so only a gain larger than that counts.`) : null,
    v.gain ? null : h('p.pp-nogain', 'No better on the eval: accepting it changes the text but not the result.'),
    h('p.hint.pp-cost', `Finding it cost ${c.dollars === null ? 'an unknown amount' : `about ${money(c.dollars)}`}: ${c.requests ?? '?'} requests to the model that wrote it, ${c.whole ?? '?'} whole eval runs and ${c.single ?? '?'} single cases. Nothing more is spent by accepting it.`));
}

/** One line of the diff: removed red, added green, as the update review shows them. */
// The loop's diff gate allows 80 changed lines: a diff of up to 120 lines with its context is shown whole; a longer one
// gets a "Show all" button. The box is a stop for the keyboard with a name, so it can be scrolled without a mouse.
const WHOLE_LINES = 120;
function diff(p, diffView) {
  const el = diffView({ removed: [], added: [], changed: p.diff.changed.map((f) => ({ ...f, path: p.kind === 'skill' ? 'SKILL.md' : p.kind === 'prompt' ? `the part "${p.label || p.name}"` : 'the description' })) });
  const n = p.diff.changed.reduce((k, f) => k + (f.hunks || []).reduce((m, hk) => m + hk.lines.length + 1, 0), 0);
  el.setAttribute('tabindex', '0');
  el.setAttribute('role', 'region');
  el.setAttribute('aria-label', `What changes in ${p.name}`);
  if (n <= WHOLE_LINES) {
    el.style.maxHeight = 'none';
    return el;
  }
  const all = btn('small secondary', { icon: 'chevronDown', label: `Show all ${n} lines`, onclick: () => {
    el.style.maxHeight = 'none';
    // The button goes and the keyboard stays where the lines are.
    all.hidden = true;
    el.focus();
  } });
  return [el, all];
}
const scrollBox = (label, text) => h('pre.pp-text', { tabindex: '0', role: 'region', 'aria-label': label }, text);

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied: give it to a coding session in the Hoprig project.');
  } catch {
    toast('Copy did not work here: select the text and copy it.', { kind: 'error' });
  }
}

/** Paint the proposals into `box`; returns { refresh }. `diffView` and `tag`: the Skills page's own. */
export function paintProposals(box, { diffView, tag }) {
  let busy = false;
  async function press(p, action, el) {
    if (busy) return;
    busy = true;
    el.disabled = true;
    try {
      await api(`/api/skills/proposals/${encodeURIComponent(p.id)}/${action}`, {});
      if (action === 'accept') {
        toast(p.kind === 'skill' ? `Tia uses the new text of ${short(p)} from her next message.` : `Tia uses the new text of ${short(p)} from her next conversation.`, { kind: 'ok', ms: 8000, action: { label: 'Undo', run: () => press(p, 'undo', el) } });
      } else if (action === 'undo') toast(p.kind === 'skill' ? `${short(p)} has its text from before again.` : `${short(p)} has Hoprig's own text again.`);
      else if (action === 'again') toast(`The proposal for "${p.name}" waits again.`);
      else toast('Put away: it is under "Put away" below, with Show again.');
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
    } finally {
      busy = false;
      el.disabled = false;
    }
    await refresh();
    // The repaint took the pressed button away: the keyboard goes on from what took its place (Undo after Accept,
    // Accept after Undo or Show again), else from the first button left, never from the page's top.
    const next = { accept: `Undo the new text of ${p.name}`, undo: `Accept the new text of ${p.name}`, again: `Accept the new text of ${p.name}` }[action];
    // A disabled button cannot take the focus (a card that cannot be accepted): then its Not now, else the first one left.
    const usable = (sel) => [...box.querySelectorAll(sel)].find((b) => !b.disabled && b.getAttribute('disabled') === null) || null;
    const to = (next && usable(`button[aria-label="${next}"]`)) || usable(`button[aria-label="Not now: ${p.name}"]`) || usable('button');
    if (to) to.focus();
  }

  function card(p) {
    const skill = p.kind === 'skill';
    const head = h('div.lr-head', h('span.row-icon', icon(KIND_ICON[p.kind] || 'code')),
      h('div', h('div.lr-title', h('h3', { id: `pp-${p.id}` }, `A better text for ${what(p)}`), tag(...(KIND_TAG[p.kind] || KIND_TAG.tool))),
        h('p.hint.lr-from', `Proposed ${shortDay(p.created)} by an improvement loop, measured with Hoprig's own eval.`)));
    const why = p.why.length ? h('div', h('span.lr-label', 'Why'), h('ul.pp-why', p.why.map((w) => h('li', w)))) : null;
    const gates = h('details.lr-more', h('summary', `Checks it passed (${p.gates.filter((g) => g.ok).length} of ${p.gates.length})`),
      h('ul.lr-findings', p.gates.map((g) => h('li', g.ok ? '✓ ' : '✗ ', h('strong', CHECK[g.name] || g.name), g.why ? `: ${g.why}` : ''))));
    const texts = h('details.lr-more', h('summary', 'The whole text, before and after'),
      h('div.pp-texts', h('div.lr-side', h('span.lr-label', 'Before (what Tia uses now)'), scrollBox(`${p.name} now`, p.before)),
        h('div.lr-side.lr-with', h('span.lr-label', 'After'), scrollBox(`${p.name} after`, p.after))));
    const stale = p.stale ? h('div.lr-risky', { role: 'note' }, icon('alert', { size: 18 }), h('div', h('strong', 'Changed since'),
      h('p', 'This text was changed after the proposal was measured, so it cannot be accepted. A new run measures it again.'))) : null;
    const blocked = (p.verdict && p.verdict.blocked) || (p.refusal ? `the new text itself is refused: ${p.refusal}` : null);
    const worse = blocked ? h('div.lr-risky', { role: 'note' }, icon('alert', { size: 18 }), h('div', h('strong', 'Worse than the text now'), h('p', `It cannot be accepted: ${blocked}.`))) : null;
    // An issue text is for a change to code: shown with Copy, never applied here.
    const issue = !skill && p.issue ? h('details.lr-more', h('summary', 'An issue text for a coding session'),
      h('p.hint', 'For a change to Hoprig\'s code, which is never made here: give it to a coding session in the Hoprig project.'),
      h('pre.output.pp-issue', p.issue), btn('small secondary', { icon: 'copy', label: 'Copy the issue text', onclick: () => copy(p.issue) })) : null;
    const keeps = skill ? 'Accept puts the new text in place and keeps the text before; Undo stays under "Accepted changes to Tia" on this page.'
      : 'Accept keeps the new text in Hoprig\'s settings, not in its code. It applies while Hoprig\'s own text stays the one it was measured against; Undo stays under "Accepted changes to Tia" on this page.';
    const actions = [h('p.hint', keeps), issue, h('div.lr-actions',
      btn('secondary', { icon: 'x', label: 'Not now', 'aria-label': `Not now: ${p.name}`, onclick: (e) => press(p, 'later', e.currentTarget) }),
      btn('primary', { icon: 'check', label: p.stale || blocked ? 'Cannot be accepted' : 'Accept', disabled: p.stale || Boolean(blocked), 'aria-label': `Accept the new text of ${p.name}`, onclick: (e) => press(p, 'accept', e.currentTarget) }))];
    return h('article.lr-card.pp-card', { 'aria-labelledby': `pp-${p.id}` }, head, why, numbers(p),
      h('div', h('span.lr-label', 'What changes'), diff(p, diffView)), texts, gates, stale, worse, actions);
  }

  function acceptedRow(p) {
    // A tool's proposal is done when the code has its text: there is nothing to undo here.
    if (p.done) {
      return h('div.row.static.col.mrow.sk-row',
        h('div.mrow-top', h('span.row-icon', icon('check')),
          h('div.row-main', h('span.row-title.sk-wrap', p.kind === 'prompt' ? `The part ${short(p)} of her instructions` : `Description of "${p.name}"`), h('span.row-sub', p.kind === 'prompt' ? 'Done: the part in the code is now this text.' : 'Done: the description in the code is now this text.'))));
    }
    // An accepted text that stopped applying: said in words (never colour alone), with Remove.
    if (p.applies === false) {
      return h('div.row.static.col.mrow.sk-row',
        h('div.mrow-top', h('span.row-icon', icon('alert')),
          h('div.row-main', h('span.row-title.sk-wrap', `New text of ${short(p)}`), h('span.row-sub', `Accepted ${shortDay(p.at)}; ${p.notApplying || 'it no longer applies'}. Tia uses Hoprig's own text.`)),
          h('span.sk-act', btn('small secondary', { icon: 'x', label: 'Remove', 'aria-label': `Remove the new text of ${p.name}`, onclick: (e) => press(p, 'undo', e.currentTarget) }))));
    }
    const sub = p.kind === 'skill' ? `Accepted ${shortDay(p.at)}; the text before is kept.` : `Accepted ${shortDay(p.at)}; Tia uses it in place of Hoprig's own text.`;
    return h('div.row.static.col.mrow.sk-row',
      h('div.mrow-top', h('span.row-icon', icon('check')),
        h('div.row-main', h('span.row-title.sk-wrap', `New text of ${short(p)}`), h('span.row-sub', sub)),
        h('span.sk-act', btn('small secondary', { icon: 'undo', label: 'Undo', 'aria-label': `Undo the new text of ${p.name}`, onclick: (e) => press(p, 'undo', e.currentTarget) }))));
  }

  function putRow(p) {
    return h('div.row.static.col.mrow.sk-row',
      h('div.mrow-top', h('span.row-icon', icon(KIND_ICON[p.kind] || 'code')),
        h('div.row-main', h('span.row-title.sk-wrap', `A better text for ${what(p)}`), h('span.row-sub', `Put away ${shortDay(p.at)}.`)),
        h('span.sk-act', btn('small secondary', { icon: 'undo', label: 'Show again', 'aria-label': `Show again: ${p.name}`, onclick: (e) => press(p, 'again', e.currentTarget) }))));
  }

  async function refresh() {
    let data;
    try {
      data = await api('/api/skills/proposals');
    } catch {
      fill(box);
      return;
    }
    const put = data.put || [];
    const bad = data.unreadableFiles || [];
    const skipped = data.skippedTexts || [];
    if (!data.waiting.length && !data.accepted.length && !put.length && !data.unreadable && !skipped.length) {
      fill(box);
      return;
    }
    fill(box, h('section.pp-box', { 'aria-label': 'Proposed changes to Tia' },
      data.waiting.length ? [h('p.field-label', `Proposed changes to Tia (${data.waiting.length})`), h('div.lr-list', data.waiting.map(card))] : null,
      data.accepted.length ? [h('p.field-label', 'Accepted changes to Tia'), h('div.rows', data.accepted.map(acceptedRow))] : null,
      put.length ? h('details.lr-more', h('summary', `Put away (${put.length})`), h('div.rows', put.map(putRow))) : null,
      skipped.length ? h('details.lr-more', h('summary', `${skipped.length === 1 ? 'One accepted text is' : `${skipped.length} accepted texts are`} not used`),
        h('ul.lr-findings', skipped.map((x) => h('li', h('strong', x.kind === 'prompt' ? `The part "${x.label}"` : `Description of "${x.name}"`), `: ${x.why}`)))) : null,
      data.unreadable ? h('details.lr-more', h('summary', `${data.unreadable === 1 ? 'One proposal file' : `${data.unreadable} proposal files`} could not be read`),
        h('ul.lr-findings', bad.map((b) => h('li', h('strong', b.file), `: ${b.why}`)))) : null));
  }
  refresh();
  return { refresh };
}
