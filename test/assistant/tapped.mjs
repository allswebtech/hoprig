// A start of an earlier conversation (continue, resume, fork) is never alone: the owner taps the card. A test that is about what
// the start DOES (its text, its data, its job) taps it here: the call, the owner's confirm, and what Tia is told of the outcome.
export function tapped(core, call, conversation = 'c1') {
  return async (tool, args, ...rest) => {
    const r = await call(tool, args, ...rest);
    if (!r.card) return r;
    core.takeOutcomes(conversation);
    const ok = await core.confirm(r.card.id);
    const told = core.takeOutcomes(conversation).map((o) => o.text).join('\n');
    const text = told.replace(/^The owner confirmed card \S+ \(\w+\)\.(?: |\n)/, '').replace(/^The owner confirmed card \S+ \(\w+\), but it (?:failed|could not run)\.\n/, '');
    return { isError: !ok.ok, text: text || String(ok.error || ''), ok, card: undefined };
  };
}
