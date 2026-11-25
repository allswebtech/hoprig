// "Who did what" of a Lead session: per helper, its kind, model and tokens, read from Claude Code's own records (the
// helpers' transcripts beside the conversation: <projects>/<slug>/<conversation>/subagents/agent-*.jsonl), never from
// what a model says of itself. One message is written on several lines (one per block) with the same usage: it is
// counted once, by its id. The lead's own use is read from the conversation's file the same way.
import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from '../sessions.mjs';
import { KINDS } from './tiers.mjs';

const MAX_FILES = 200;
const MAX_BYTES = 20 * 1024 * 1024; // of one transcript
const TIER_OF = Object.fromEntries(KINDS.kinds.map((k) => [`hoprig-${k.id}`, k.tier]));
const LABEL_OF = Object.fromEntries(KINDS.kinds.map((k) => [`hoprig-${k.id}`, k.label]));
const AGENT_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

// Kept apart: a cache read costs about a tenth of new input and output several times it, so one sum of all four would
// make a part that wrote 200 tokens read as 125,000. `in`: new input (with what was written to the cache), `out`: the
// output, `cached`: read from the cache. `tokens` (in + out) is the headline: cache reads are left out of it.
const NUM = (u, k) => (Number.isFinite(u && u[k]) ? u[k] : 0);
const useOf = (u) => ({ in: NUM(u, 'input_tokens') + NUM(u, 'cache_creation_input_tokens'), out: NUM(u, 'output_tokens'), cached: NUM(u, 'cache_read_input_tokens') });
const add = (a, b) => ({ in: a.in + b.in, out: a.out + b.out, cached: a.cached + b.cached });
const ZERO = Object.freeze({ in: 0, out: 0, cached: 0 });

/**
 * What one transcript file holds: { agent, model, tokens, use: { in, out, cached }, cacheWrite (of in), byModel: [{ model,
 * in, out, cached, cacheWrite, write1h (of cacheWrite, written for an hour; null: the record does not split it) }], first,
 * last (the times of its first and last message, ms; null when a message has none), messages } (null when it cannot be read).
 */
export function readTranscriptUse(file) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const seen = new Set();
  const models = new Map();
  let agent = null;
  let use = ZERO;
  let cacheWrite = 0; // of `in`, what was written to the cache (its price differs: operator/prices.mjs)
  const per = new Map(); // model → its share of this file, so a fallback turn on another model is priced as that model
  let first = Infinity;
  let last = -Infinity;
  let untimed = false;
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let x;
    try {
      x = JSON.parse(line);
    } catch {
      continue;
    }
    if (!x || x.type !== 'assistant' || !x.message) continue;
    if (!agent && typeof x.attributionAgent === 'string' && AGENT_RE.test(x.attributionAgent)) agent = x.attributionAgent;
    const id = typeof x.message.id === 'string' ? x.message.id : null;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const model = typeof x.message.model === 'string' && x.message.model !== '<synthetic>' ? x.message.model.slice(0, 120) : null;
    const n = useOf(x.message.usage);
    if (model) models.set(model, (models.get(model) || 0) + n.in + n.out + n.cached);
    use = add(use, n);
    const w = NUM(x.message.usage, 'cache_creation_input_tokens');
    cacheWrite += w;
    const split = x.message.usage && x.message.usage.cache_creation;
    const h1 = w === 0 ? 0 : split && Number.isFinite(split.ephemeral_1h_input_tokens) ? split.ephemeral_1h_input_tokens : null;
    const key = model || '';
    const m = per.get(key) || { model, in: 0, out: 0, cached: 0, cacheWrite: 0, write1h: 0 };
    per.set(key, { ...m, in: m.in + n.in, out: m.out + n.out, cached: m.cached + n.cached, cacheWrite: m.cacheWrite + w, write1h: m.write1h === null || h1 === null ? null : m.write1h + h1 });
    const t = typeof x.timestamp === 'string' ? Date.parse(x.timestamp) : NaN;
    if (Number.isFinite(t)) {
      first = Math.min(first, t);
      last = Math.max(last, t);
    } else untimed = true;
  }
  // The model that used most of the tokens: a helper runs on one, but a fallback may answer a turn or two.
  const model = [...models].sort((a, b) => b[1] - a[1])[0];
  const timed = !untimed && seen.size > 0;
  return { agent, model: model ? model[0] : null, tokens: use.in + use.out, use, cacheWrite, byModel: [...per.values()], first: timed ? first : null, last: timed ? last : null, messages: seen.size };
}

/**
 * The parts of conversation `conversation` in folder `cwd`: { lead: { model, tokens, use }, parts: [{ agent, kind, tier,
 * model, tokens, use }], tiers: [{ tier, models, tokens, use, parts }] } (use: { in, out, cached }, tokens: in + out). Helpers of other names (Claude Code's own, a
 * workflow's) are listed with tier null.
 */
export function partsOf(cwd, conversation, { dir = projectDir(cwd) } = {}) {
  if (typeof conversation !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(conversation)) return { lead: null, parts: [], tiers: [] };
  const lead = readTranscriptUse(path.join(dir, `${conversation}.jsonl`));
  const sub = path.join(dir, conversation, 'subagents');
  let names = [];
  try {
    names = fs.readdirSync(sub).filter((n) => /^agent-[A-Za-z0-9_-]{1,100}\.jsonl$/.test(n)).sort();
  } catch {
    /* no helper ran */
  }
  const parts = [];
  for (const n of names.slice(0, MAX_FILES)) {
    const f = path.join(sub, n);
    const u = readTranscriptUse(f);
    if (!u || !u.messages) continue;
    let at = 0;
    try {
      at = fs.statSync(f).birthtimeMs || fs.statSync(f).mtimeMs;
    } catch {
      /* gone */
    }
    parts.push({ agent: u.agent, kind: LABEL_OF[u.agent] || null, tier: TIER_OF[u.agent] || null, model: u.model, tokens: u.tokens, use: u.use, cacheWrite: u.cacheWrite, byModel: u.byModel, first: u.first, last: u.last, at });
  }
  parts.sort((a, b) => a.at - b.at);
  const tiers = [];
  for (const p of parts) {
    const key = p.tier || 'other';
    let t = tiers.find((x) => x.tier === key);
    if (!t) tiers.push((t = { tier: key, models: [], tokens: 0, use: ZERO, parts: 0 }));
    if (p.model && !t.models.includes(p.model)) t.models.push(p.model);
    t.tokens += p.tokens;
    t.use = add(t.use, p.use);
    t.parts++;
  }
  // When the conversation's messages were written, the lead's and every helper's: null when one of them carries no time.
  const all = [...(lead && lead.messages ? [lead] : []), ...parts];
  const span = all.length && all.every((x) => x.first !== null) ? { first: Math.min(...all.map((x) => x.first)), last: Math.max(...all.map((x) => x.last)) } : null;
  return { lead: lead && lead.messages ? { model: lead.model, tokens: lead.tokens, use: lead.use } : null, parts: parts.map(({ at, first, last, ...p }) => p), tiers, ...(span ? { span } : {}) };
}
