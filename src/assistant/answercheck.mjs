// Rule 7 at run time: for "what is running", "how far", "how long", "what did you do", the lines of Work's progress
// ARE the answer the owner gets. When Tia read progress (manage_work progress) in a turn, the page shows its lines
// under her reply, made by code. Her own words may stand above them; but a time or a count in her words that no tool
// gave her in that turn makes the product show the lines only (her words of that turn are hidden), and her Activity
// notes it once. Figures are digits ("40", "1,200", "23:40"); a time the tools gave counts in its 12-hour form too.

const FIG = /\d{1,3}(?:,\d{3})+|\d+(?::\d{2})?/g;
/** The figures in `text`, as compared: "05:30" is "5:30", "1,200" is "1200". */
export const figuresOf = (text) => (String(text || '').match(FIG) || []).map((x) => x.replace(/,/g, '').replace(/^0(\d)/, '$1'));

/** The figures of `text` that none of `given` (the texts the tools gave her in the turn) holds. */
export function foreignFigures(text, given = []) {
  const ok = new Set(given.flatMap(figuresOf));
  for (const g of [...ok]) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(g);
    if (m) ok.add(`${Number(m[1]) % 12 || 12}:${m[2]}`);
  }
  return figuresOf(text).filter((x) => !ok.has(x));
}

/**
 * What the page shows for a turn in which she read progress. texts: her words of the turn [{ i, text }]; results: the
 * texts of every tool result she got in it; lines: the progress lines. → { lines, replaced, hides: [event i], foreign }.
 */
export function progressAnswer({ texts = [], results = [], lines = [] }) {
  const foreign = foreignFigures(texts.map((t) => t.text).join('\n'), [...results, lines.join('\n')]);
  return { lines, replaced: foreign.length > 0, hides: foreign.length ? texts.map((t) => t.i) : [], foreign };
}
