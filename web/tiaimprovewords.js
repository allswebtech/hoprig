// The words of Settings → Tia → "Improve Tia" (tiaimprove.js), apart from the page so a test reads them without a browser.
import { money } from './chat/words.js';

export const WHAT = 'Hoprig tries rewordings of Tia\'s skills, tool descriptions and instructions, measures each with her tests, and shows you only the ones that do measurably better. Nothing changes until you accept one, and every change has Undo.';
export const PAID_LINE = 'This counts against your daily limit for paid use.';
export const SUB_LINE = 'On a subscription the round uses that subscription\'s limits, not money by use.';
export const CODE_LINE = 'Her code is never changed by a round: only these texts, and only when you accept one.';

export const targetWords = (kind, name) => (kind === 'tool' ? `the description of her tool ${name}` : kind === 'skill' ? `her skill ${name}` : `the part "${name}" of her instructions`);
/** What the round does now, from its phase. */
export function phaseWords(phase) {
  const m = /^(proposing|checking|measuring) (tool|skill|prompt) (.+)$/.exec(String(phase || ''));
  if (!m) return phase === 'baseline' ? 'Measuring her tests as they are now' : 'Finishing';
  const t = targetWords(m[2], m[3]);
  return { proposing: `Asking the model for a rewording of ${t}`, checking: `Trying the rewording of ${t} on the failing, held-out and injection cases`, measuring: `Measuring the rewording of ${t} on all of her tests` }[m[1]];
}
/** The last round's result in one sentence. */
export function resultWords(r) {
  if (!r) return null;
  if (r.failed) return `The round could not finish: ${r.failed}`;
  const n = (r.proposals || []).length;
  const better = n ? `${n} better ${n === 1 ? 'version is' : 'versions are'} waiting in Skills → Proposals` : null;
  if (r.stopped) return `Stopped: ${r.stopped}.${better ? ` ${better}.` : ''}`;
  if (r.nothing) return `Every one of her tests passes now: there was nothing to improve.`;
  return better || 'No version did better this time';
}
export const triedWords = (t) => `${targetWords(t.kind, t.name)}: ${t.result === 'better' ? 'better, proposed' : t.result === 'refused' ? `refused (${t.why})` : t.result === 'not better' ? `not better (${t.why})` : `not measured (${t.why})`}`;
/** The estimate in one sentence: dollars only for a provider billed by use, where a figure is known. */
export function estimateWords(e, paid) {
  const runs = `${e.caseRuns} runs of her test cases and 3 model calls at most`;
  return paid && e.usd !== null ? `About ${money(e.usd)} at most: ${runs}, from ${e.basis}.` : `About ${runs}.`;
}
/** The weekly switch's words: the provider, the estimate and the limit, by name. */
export function weeklyWords(p, e, cap) {
  if (!p) return 'Choose a provider above first. Off until you switch it on.';
  const cost = p.paid ? `, about ${money(Math.min(e.usd ?? cap, cap))} at most each time (the cap above), within your daily limit for paid use` : ', within that subscription\'s limits';
  return `Once a week Hoprig starts a round by itself on ${p.label}${cost}. It only proposes: nothing changes until you accept. Off until you switch it on.`;
}
