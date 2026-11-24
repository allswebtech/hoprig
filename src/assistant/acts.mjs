// Every act a person can do with Hoprig, and what Tia does of it: the inventory (inventory.json, data) and what the
// code itself has (the commands of bin/hoprig.mjs, every route that changes something, the built-in skills). The test
// test/assistant/inventory.test.mjs builds the code's list from the code and holds the two together, so a new command
// or route cannot come without a row that says whether it is hers, and a row cannot outlive its act.
//
// A row: { act, kind: "command" | "route" | "skill", hers: [{ tool, action?, level, risk, card }] } (a command that is
// only partly hers also has `not` and `why` for the rest), or
// { act, kind, not: <group>, why: "one sentence" }, or { act, kind, same: "<tool> <action>", why } for an act she does
// by another route of the same effect. `level` is the tool's (or action's) usual level, "by-argument" where the code
// decides it from the input; `card` is yes, maybe (the server raises it from facts) or no; `risk` is the contract's
// class (R0 reads and notes, R1 acts he sees, R2 money or what goes out, R3 deletion, rights, any command).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const INVENTORY_FILE = path.join(ROOT, 'src', 'assistant', 'inventory.json');

/** Why an act is not hers: a short closed list. The first nine are his alone in every mode. */
export const GROUPS = Object.freeze({
  money: 'money and prices: what a provider costs, which provider billed by use or model is used',
  'sign-in': 'a sign-in, a password, a key or a token, and who may control this computer',
  'push-merge': 'a push or a merge into a default branch',
  release: 'a release',
  'sent-out': 'anything sent out of the computer or opened to the internet',
  'delete-outside': 'a delete outside a session\'s own folder',
  admin: 'administrator rights',
  'safety-rule': 'switching a safety rule off (permission modes, Hands-off, bypass, what installs by itself)',
  'her-rights': 'raising her own rights (her settings, her cards, her jobs, a shell without a card)',
  'his-review': 'your yes to something you read on your own page (a diff, a proposal, a need): the page is the card',
  'by-a-session': 'work in a project\'s files and git, which a coding session she starts does inside its folder',
  'not-an-act': 'not an act of a person: a view of the page, a file from your device, a program\'s own door',
});

export const LEVELS = ['L0', 'L1', 'L2', 'by-argument'];
export const RISKS = ['R0', 'R1', 'R2', 'R3'];
export const CARDS = ['yes', 'maybe', 'no'];

/** The commands of the command line: the cases of bin/hoprig.mjs's one switch. */
export function commandsIn(text) {
  return [...new Set([...String(text).matchAll(/^ {4}case '([a-z][a-z-]*)':/gm)].map((m) => m[1]))];
}

/** "POST ^\/api\/x\/([^/]+)$" → "POST /api/x/<id>"; a group of fixed words stays as (a|b). */
export function routeKey(method, re) {
  const src = wordGroups((re instanceof RegExp ? re.source : String(re)).replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/'));
  return `${method} ${src.replace(/\(([^()]*)\)/g, (m, g) => (/^[a-z-]+(\|[a-z-]+)+$/.test(g) ? m : '<id>'))}`;
}

/** A group of fixed words that is not a part of the key, (?:skill|tool), stands for its first word. */
const wordGroups = (src) => src.replace(/\(\?:([a-z-]+)(?:\|[a-z-]+)*\)/g, '$1');

/** A path the route's pattern takes: each group filled with a value of its own form. */
export function sampleOf(re) {
  const src = wordGroups(re.source.replace(/^\^/, '').replace(/\$$/, ''));
  const filled = src.replace(/\(([^()]*)\)/g, (m, g) => {
    if (/^[a-z-]+(\|[a-z-]+)+$/.test(g)) return g.split('|')[0];
    if (g.startsWith('[0-9a-f]{8}-')) return '01234567-89ab-4def-8123-456789abcdef';
    const hex = /^(?:([a-z])_)?\[0-9a-f\]\{(\d+)\}$/.exec(g);
    if (hex) return `${hex[1] ? `${hex[1]}_` : ''}${'0123456789abcdef'.repeat(4).slice(0, Number(hex[2]))}`;
    if (g === '[a-z-]+:[a-z-]+') return 'alpha:beta';
    if (g === '[a-z]+') return 'opencode';
    if (new RegExp(`^(?:${g})$`).test('alpha')) return 'alpha';
    // An id of a form of its own (m-<…>, <date>-<time>-<word>-<name>): each character class filled by its kind.
    return g.replace(/\[([^\]]+)\](?:\{(\d+)(?:,\d*)?\}|(\+)|(\*))?/g, (m, cls, n, plus, star) => (cls.includes('a-z') || cls.startsWith('^') ? 'a' : cls.includes('0-9') ? '0' : cls[0]).repeat(n !== undefined ? Number(n) : star ? 0 : 1));
  });
  return filled.replace(/\\\//g, '/').replace(/\\-/g, '-').replace(/\\\./g, '.');
}

/**
 * A path for EVERY choice of the route's word groups ("(install|update|start|stop)" gives four): a door entry that
 * takes only some of a route's words still matches one of them.
 */
export function samplesOf(re) {
  const m = /\(([a-z-]+(?:\|[a-z-]+)+)\)/.exec(re.source);
  if (!m) return [sampleOf(re)];
  return m[1].split('|').flatMap((w) => samplesOf(new RegExp(re.source.slice(0, m.index) + w + re.source.slice(m.index + m[0].length))));
}

/**
 * Routes a feature answers in its own `handle` (before the route tables): found in the source by the comparisons
 * that pick them (`p === '/api/…' && req.method === 'POST'`, a constant of the file, a pattern constant's test).
 */
export function handledRoutes(dir = path.join(ROOT, 'src')) {
  const out = [];
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    const text = fs.readFileSync(file, 'utf8');
    const consts = new Map([...text.matchAll(/^(?:export )?const ([A-Z_]{3,}) = '([^']+)';/gm)].map((m) => [m[1], m[2]]));
    const patterns = new Map([...text.matchAll(/^const ([A-Z_]{3,}) = \/(.+)\/;/gm)].map((m) => [m[1], m[2]]));
    for (const line of text.split('\n')) {
      if (!/'POST'/.test(line) || !/[!=]==/.test(line)) continue;
      for (const m of line.matchAll(/[!=]== '(\/api\/[^'…]+)'/g)) out.push(new RegExp(`^${m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      for (const m of line.matchAll(/(?:[!=]== |\b)([A-Z_]{3,})\b(\.test\(p\))?/g)) {
        if (m[2] && patterns.has(m[1])) out.push(new RegExp(patterns.get(m[1])));
        else if (!m[2] && (consts.get(m[1]) || '').startsWith('/api/')) out.push(new RegExp(`^${consts.get(m[1]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      }
    }
  }
  return out;
}

/** Every route of a built server (createServer) that changes something: its tables, the machines' table, the handled ones. */
export function changingRoutes(app) {
  const machines = app.features.find((f) => f.name === 'machines');
  const tables = [...app.routes, ...((machines && machines.machines && machines.machines.table) || [])];
  const list = [...tables.filter(([m]) => m !== 'GET' && m !== 'HEAD').map(([method, re]) => ({ method, re })), ...handledRoutes().map((re) => ({ method: 'POST', re }))];
  const seen = new Map();
  for (const r of list) {
    const key = routeKey(r.method, r.re);
    if (!seen.has(key)) seen.set(key, { ...r, key });
  }
  return [...seen.values()];
}

/** The built-in skills: one folder each under skills/. */
export function skillsIn(dir = path.join(ROOT, 'skills')) {
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).map((e) => e.name).sort();
}

export const loadInventory = (file = INVENTORY_FILE) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A row's act as the code names it: "hoprig <cmd>", "<METHOD> <route key>", "skill <name>". */
export const actOf = { command: (c) => `hoprig ${c}`, route: (r) => r.key, skill: (s) => `skill ${s}` };

/**
 * What the code would say of a row's tool and action: { level, card } as the catalog has them, or a problem.
 * `tools`: the catalog (tools.mjs TOOLS).
 */
export function catalogFacts(tools, toolName, action) {
  const t = tools.find((x) => x.name === toolName);
  if (!t) return { problem: `there is no tool ${toolName}` };
  if (t.actions) {
    const a = t.actions[action];
    if (!a) return { problem: `${toolName} has no action ${action}` };
    const level = typeof a.level === 'function' ? 'by-argument' : a.level;
    const card = level === 'by-argument' || a.policy ? 'maybe' : level === 'L2' ? 'yes' : 'no';
    return { level, card };
  }
  if (action !== undefined) return { problem: `${toolName} takes no action` };
  // A command tool (riskByArgument) asks by its command too: policy.mjs runs an administrator command with no card at
  // Full and refuses it at Off, so its card is "maybe", not "always".
  return { level: t.level, card: t.card === 'maybe' || t.riskByArgument ? 'maybe' : t.level === 'L2' ? 'yes' : 'no' };
}

/** Every problem of the inventory against the code's lists; [] when they agree. */
export function inventoryProblems(rows, { commands, routes, skills, tools }) {
  const problems = [];
  const want = new Set([...commands.map(actOf.command), ...routes.map(actOf.route), ...skills.map(actOf.skill)]);
  const have = new Map();
  for (const row of rows) {
    if (have.has(row.act)) problems.push(`${row.act}: two rows`);
    have.set(row.act, row);
    if (!want.has(row.act)) problems.push(`${row.act}: no such ${row.kind || 'act'} in the code any more`);
    // hers, or same (another route of hers does it), or not; a command that is partly hers has hers AND not (its rest).
    if ((!row.hers && !row.same && !row.not) || (row.hers && row.same) || (row.same && row.not)) problems.push(`${row.act}: give hers, same or not (hers may carry a not for what stays his)`);
    if ((row.not || row.same) && (typeof row.why !== 'string' || row.why.length < 20 || /\n/.test(row.why))) problems.push(`${row.act}: one sentence of why`);
    if (row.not && !GROUPS[row.not]) problems.push(`${row.act}: "${row.not}" is not one of the groups`);
    if (row.same) {
      const [tool, action] = row.same.split(' ');
      const f = catalogFacts(tools, tool, action);
      if (f.problem) problems.push(`${row.act}: ${f.problem}`);
    }
    for (const h of row.hers || []) {
      const f = catalogFacts(tools, h.tool, h.action);
      if (f.problem) {
        problems.push(`${row.act}: ${f.problem}`);
        continue;
      }
      if (h.level !== f.level) problems.push(`${row.act}: ${h.tool} ${h.action || ''} is ${f.level} in the code, the row says ${h.level}`);
      if (h.card !== f.card) problems.push(`${row.act}: ${h.tool} ${h.action || ''} has card "${f.card}" in the code, the row says "${h.card}"`);
      if (!RISKS.includes(h.risk)) problems.push(`${row.act}: risk is one of ${RISKS.join(', ')}`);
      // The contract: money, what goes out, deletion and rights wait for a tap (a card, or one the server raises).
      if ((h.risk === 'R2' || h.risk === 'R3') && h.card === 'no') problems.push(`${row.act}: risk ${h.risk} with no card`);
      // The contract: no chat tool is R3, except one whose risk is set by its argument (a command tool) and says so.
      if (h.risk === 'R3' && !tools.find((x) => x.name === h.tool)?.riskByArgument) problems.push(`${row.act}: ${h.tool} is R3 but does not declare its risk by its argument`);
    }
  }
  for (const a of want) if (!have.has(a)) problems.push(`${a}: no row in the inventory`);
  return problems;
}
