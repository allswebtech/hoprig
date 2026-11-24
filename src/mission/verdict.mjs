// A reviewer's verdict: the LAST line of its answer, one strict JSON shape, and nothing else moves a state.
//   {"verdict":"pass"}   or   {"verdict":"fix","points":["…", …]} (1 to 5 points, each one line of up to 200 characters)
// A code block around that one line is taken (its two fences go). Anything else (another key, another value, prose
// after it, no JSON) is "unreadable" and counts as not passed. The
// points are the reviewer's words: they go to a fix run fenced as such, never into what the mission's code decides.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const UNREADABLE = Object.freeze({ verdict: 'unreadable', points: [] });

export function parseVerdict(answer) {
  const lines = String(answer || '').split('\n').map((l) => l.trim()).filter(Boolean);
  // A code block around the verdict line alone (a small model writes one): its two fences go, nothing else does.
  const n = lines.length;
  if (n >= 3 && lines[n - 1] === '```' && /^```(json)?$/.test(lines[n - 3])) lines.splice(n - 3, 3, lines[n - 2]);
  if (!lines.length) return UNREADABLE;
  let v;
  try {
    v = JSON.parse(lines[lines.length - 1]);
  } catch {
    return UNREADABLE;
  }
  if (!isObj(v)) return UNREADABLE;
  const keys = Object.keys(v).sort().join(',');
  if (v.verdict === 'pass' && keys === 'verdict') return { verdict: 'pass', points: [] };
  if (v.verdict === 'fix' && keys === 'points,verdict' && Array.isArray(v.points) && v.points.length >= 1 && v.points.length <= 5
    && v.points.every((p) => typeof p === 'string' && p.trim() && p.length <= 200 && !/[\u0000-\u001f]/.test(p))) return { verdict: 'fix', points: v.points.map((p) => p.trim()) };
  return UNREADABLE;
}
