// What Tia's own engine used: tokens and cost per turn, from the "result" event of Claude Code's stream-json
// output (total_cost_usd and usage.{input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens}; field names checked on the real CLI by the eval). One JSON line per turn in
// <stateDir>/assistant/usage.jsonl; summaries are computed when asked (today, 7 days, per conversation).
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';

export const usageFile = () => path.join(stateDir(), 'assistant', 'usage.jsonl');
const DAY = 86_400_000;
const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

/** A turn's figures from a parsed "done" event (engine.mjs parseEvents). */
export function turnUsage(done, { conversation, now = Date.now() } = {}) {
  const u = done.usage || {};
  return {
    at: now,
    conversation,
    costUsd: num(done.costUsd),
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

export function recordUsage(entry, file = usageFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function readUsage(file = usageFile()) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').flatMap((l) => {
      try {
        return l ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const add = (a, e) => ({
  turns: a.turns + 1, costUsd: a.costUsd + num(e.costUsd), input: a.input + num(e.input), output: a.output + num(e.output),
  cacheRead: a.cacheRead + num(e.cacheRead), cacheWrite: a.cacheWrite + num(e.cacheWrite),
});
const ZERO = { turns: 0, costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** { today, week, total, byConversation: { id: totals } }. "today" starts at local midnight. */
export function summarizeUsage(entries, now = Date.now()) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const out = { today: { ...ZERO }, week: { ...ZERO }, total: { ...ZERO }, byConversation: {} };
  for (const e of entries) {
    out.total = add(out.total, e);
    if (e.at >= midnight.getTime()) out.today = add(out.today, e);
    if (e.at >= now - 7 * DAY) out.week = add(out.week, e);
    out.byConversation[e.conversation] = add(out.byConversation[e.conversation] || { ...ZERO }, e);
  }
  for (const v of [out.today, out.week, out.total, ...Object.values(out.byConversation)]) v.costUsd = Math.round(v.costUsd * 10_000) / 10_000;
  return out;
}
