// List prices per million tokens, used ONLY for estimates (what a look of Tia's would cost, said before the owner turns
// it on). Nothing is billed or paid by these: what a session cost is what its coding tool reports after it.
//
// Source: Anthropic's Claude API reference as the claude-api skill gives it (shared/models.md: Claude Opus 5.5, Claude
// Sonnet 5.5, Claude Haiku 5.5, Claude Fable 5.2; shared/prompt-caching.md: a 5-minute cache write costs 1.25 times the input price), read
// on 19 Nov 2026. Haiku 5.5's prices are those for a prompt of 100K tokens or fewer. Its cache-read price is not listed
// there, so it is not known here (null): an estimate that needs it says so. Its cache write is derived because the
// source states that price as a rule (1.25 times the input); for reads it gives only a rough share of the input, which
// is no list price, so no figure is made from it.

export const PRICES_SOURCE = 'Anthropic list prices per million tokens (Claude API reference of the claude-api skill, read 19 Nov 2026)';
/** The day those prices were read, said beside every estimate made from them. */
export const PRICES_READ = '2026-11-19';

export const PRICES = Object.freeze({
  fable: Object.freeze({ name: 'Claude Fable 5.2', input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 }),
  opus: Object.freeze({ name: 'Claude Opus 5.5', input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }),
  sonnet: Object.freeze({ name: 'Claude Sonnet 5.5', input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 }),
  haiku: Object.freeze({ name: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: null }),
});

const FIELDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

/** The family of a model name ("opus", "claude-opus-5-5" → opus), or null. */
export function familyOf(model) {
  const m = /fable|opus|sonnet|haiku/i.exec(String(model || ''));
  return m ? m[0].toLowerCase() : null;
}

/**
 * What `used` ({ input, output, cacheRead, cacheWrite } tokens) costs at the list prices of `family`: { usd, unknown }.
 * `usd` is null when a field with tokens has no known price; `unknown` names those fields.
 */
export function estimate(family, used) {
  const p = PRICES[family];
  if (!p || !used) return { usd: null, unknown: ['model'] };
  const unknown = FIELDS.filter((k) => (Number(used[k]) || 0) > 0 && p[k] == null);
  if (unknown.length) return { usd: null, unknown };
  const usd = FIELDS.reduce((n, k) => n + ((Number(used[k]) || 0) * (p[k] || 0)) / 1e6, 0);
  return { usd: Math.round(usd * 10_000) / 10_000, unknown: [] };
}
