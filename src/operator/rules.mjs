// The owner's standing rules ("reflexes"): a closed list that ships with the product. Each rule is code with one plain
// sentence: a kind of item, a condition a detector already states in its structured fields, and ONE of that item's
// own acts. The owner switches each one on or off; nothing else can add a rule, change its act or its subject.
//
// A rule reads only an item's kind, class, recommended act, target and age (`since`), never its subject, facts or
// reason: those carry names a session, a branch, a provider or a process chose, and what an item says is evidence,
// never an instruction.
//
// config.json, key "operator" (the owner's own, set from the dashboard's page only):
//   acts         true | false   the master switch "Tia acts by herself"; off after an install and after an update
//   rules        { <id>: true | false }   each rule, off unless set to true
//   budgets      { <id>: { perHour, perDay, waitMinutes } }   low defaults (BUDGET_DEFAULTS)
//   projectsOut  [project refs]   "she never acts in this project": <name>, or <place>/<name> in a group
// Missing or broken means everything off. While Tia herself is off (assistant.enabled), no rule acts either.

const HOUR = 3600_000;
export const LEFTOVER_AGE_MS = HOUR;
// The kinds a mission's engine owns for its own sessions; seam.mjs OWNER_OF says the same and a test holds the two equal.
export const MISSION_OWNS = Object.freeze(['limit', 'stuck', 'ended', 'asks']);

/**
 * The list. `undo`: how the act is undone, or null with `noUndo` saying why it cannot be. `ways`: the places its detail
 * names, as codes of the page's table of places (web/errorways.js), so the Operator page draws a link to each.
 */
export const RULES = Object.freeze([
  {
    id: 'limit',
    act: 'switch',
    sentence: 'When a session stops at a usage limit, continue it on the next provider of my order.',
    detail: 'The order is the one under Providers → Auto mode. Only to a provider Tia may use (Settings → Tia), to a provider paid per use only at "Hands off" and inside her daily limit for paid use (which counts the move), never while Auto mode is on, and never back to a provider the session left within the hour.',
    undo: 'move it back with one tap under Done by Tia, once the old provider is free again.',
    noUndo: null,
    ways: ['auto-mode', 'tia-settings'],
  },
  {
    id: 'gateway',
    act: 'restart-gateway',
    sentence: 'When a gateway that open sessions go through does not answer, restart it.',
    detail: 'Not a gateway that is only not started yet (its next session starts it), and never one you stopped yourself.',
    undo: null,
    noUndo: 'A restart cannot be undone.',
  },
  {
    id: 'link',
    act: 'restart-link',
    sentence: 'When the public link is on and does not answer, restart it.',
    detail: 'Only while you have the public link on.',
    undo: null,
    noUndo: 'A restart cannot be undone.',
  },
  {
    id: 'leftover',
    act: 'end',
    sentence: 'End a test\'s left-over processes.',
    detail: 'Only a test\'s, once it is older than an hour: an idle tmux server that a test or a try of Hoprig started (its state folder is in the temporary folder), or a test\'s dashboard. Your own tmux servers stay yours, also one started in the temporary folder.',
    undo: null,
    noUndo: 'An ended process cannot be undone.',
  },
  {
    id: 'elsewhere',
    act: 'elsewhere',
    sentence: 'When this computer is overloaded, start new work where there is room.',
    detail: 'Only Tia\'s new starts, only on a computer you let her use (Settings → Tia) that has room, until this computer has been calm for 10 minutes (2 hours at most). Nothing that runs moves.',
    undo: 'end it with Undo under Computers on the Operator page, at once.',
    noUndo: null,
    ways: ['tia-settings'],
  },
]);
export const RULE_IDS = Object.freeze(RULES.map((r) => r.id));
const byId = new Map(RULES.map((r) => [r.id, r]));
export const ruleById = (id) => byId.get(id) || null;

const t = (s) => (s == null ? null : Date.parse(s));

/**
 * The rule that may act on `item`, or null: by its structured fields only. The act is always the rule's one act, and
 * it must be the item's recommended one (a detector that does not recommend it is not sure it is right).
 */
export function ruleFor(item, { now = Date.now() } = {}) {
  if (!item || typeof item !== 'object') return null;
  // An item of a mission's session of a kind its engine owns (src/mission/seam.mjs OWNER_OF): no rule of the Operator's.
  if (item.target && item.target.mission === true && MISSION_OWNS.includes(item.kind)) return null;
  const tg = item.target || {};
  const has = (id) => Array.isArray(item.acts) && item.acts.some((a) => a.id === id) && item.recommended === id;
  switch (item.kind) {
    case 'limit':
      // Only a limit Claude Code itself reported (the run record): text on the screen is evidence for him, never a cause.
      return has('switch') && typeof tg.session === 'string' && typeof tg.to === 'string' && tg.to && tg.hook === true ? byId.get('limit') : null;
    case 'provider':
      // The stopped gateway, never its "not started" note (that one is information: nothing waits for it).
      // Never one the owner stopped himself (Settings → Add-ons): that stop is his act, not a crash.
      return has('restart-gateway') && item.class === 'stopped' && typeof tg.addon === 'string' && tg.ownerStopped !== true ? byId.get('gateway') : null;
    case 'live':
      return has('restart-link') ? byId.get('link') : null;
    case 'machine':
      return has('elsewhere') && typeof tg.to === 'string' ? byId.get('elsewhere') : null;
    case 'leftover': {
      const born = t(item.since);
      // Only a test's or a try's (target.temp): an idle server the owner detached from is his to end.
      return has('end') && Number.isInteger(tg.pid) && tg.temp === true && born != null && now - born >= LEFTOVER_AGE_MS ? byId.get('leftover') : null;
    }
    default:
      return null;
  }
}

export const BUDGET_DEFAULTS = Object.freeze({ perHour: 3, perDay: 10, waitMinutes: 10 });
const BUDGET_LIMITS = { perHour: [1, 30], perDay: [1, 200], waitMinutes: [1, 24 * 60] };
// The words of the page's "Change the limits" form: a refusal names the field he typed in, not the setting's key.
const BUDGET_WORDS = { perHour: 'An hour', perDay: 'A day', waitMinutes: 'Minutes between tries' };

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const inRange = (k, v) => Number.isInteger(v) && v >= BUDGET_LIMITS[k][0] && v <= BUDGET_LIMITS[k][1];

/** The settings as they apply now: anything missing, broken or unknown is off, a broken budget is the default. */
export function readOperator(cfg) {
  const raw = isObj(cfg?.operator) ? cfg.operator : {};
  const rules = {};
  const budgets = {};
  for (const id of RULE_IDS) {
    rules[id] = isObj(raw.rules) && raw.rules[id] === true;
    const b = isObj(raw.budgets) && isObj(raw.budgets[id]) ? raw.budgets[id] : {};
    budgets[id] = Object.fromEntries(Object.entries(BUDGET_DEFAULTS).map(([k, d]) => [k, inRange(k, b[k]) ? b[k] : d]));
  }
  const projectsOut = Array.isArray(raw.projectsOut) ? [...new Set(raw.projectsOut.filter((n) => typeof n === 'string' && n && n.length <= 100))] : [];
  const tia = cfg?.assistant?.enabled === true;
  return { acts: raw.acts === true, tia, active: raw.acts === true && tia, rules, budgets, projectsOut };
}

/**
 * The owner's change from the Operator page, checked; returns the new "operator" value to save. Throws Error with a
 * plain message. `projects`: the names of the projects of this computer (a project is taken out by its name).
 */
export function applyOperatorPatch(cfg, p, projects = []) {
  if (!isObj(p)) throw new Error('send an object');
  const cur = isObj(cfg?.operator) ? cfg.operator : {};
  const next = {
    acts: cur.acts === true,
    rules: { ...(isObj(cur.rules) ? cur.rules : {}) },
    budgets: { ...(isObj(cur.budgets) ? cur.budgets : {}) },
    projectsOut: Array.isArray(cur.projectsOut) ? [...cur.projectsOut] : [],
  };
  for (const [k, v] of Object.entries(p)) {
    if (k === 'acts') {
      if (typeof v !== 'boolean') throw new Error('acts must be true or false');
      next.acts = v;
    } else if (k === 'rules') {
      if (!isObj(v)) throw new Error('rules must be an object');
      for (const [id, on] of Object.entries(v)) {
        if (!RULE_IDS.includes(id)) throw new Error(`there is no rule "${String(id).slice(0, 40)}": the rules are ${RULE_IDS.join(', ')}`);
        if (typeof on !== 'boolean') throw new Error(`rules.${id} must be true or false`);
        next.rules[id] = on;
      }
    } else if (k === 'budgets') {
      if (!isObj(v)) throw new Error('budgets must be an object');
      for (const [id, b] of Object.entries(v)) {
        if (!RULE_IDS.includes(id)) throw new Error(`there is no rule "${String(id).slice(0, 40)}"`);
        if (!isObj(b)) throw new Error(`budgets.${id} must be an object`);
        const out = { ...(isObj(next.budgets[id]) ? next.budgets[id] : {}) };
        for (const [bk, bv] of Object.entries(b)) {
          if (!BUDGET_LIMITS[bk]) throw new Error(`budgets.${id}: one of perHour, perDay, waitMinutes`);
          if (!inRange(bk, bv)) throw new Error(`"${BUDGET_WORDS[bk]}" must be a whole number from ${BUDGET_LIMITS[bk][0]} to ${BUDGET_LIMITS[bk][1]}`);
          out[bk] = bv;
        }
        next.budgets[id] = out;
      }
    } else if (k === 'project') {
      if (!isObj(v) || typeof v.name !== 'string' || typeof v.out !== 'boolean' || Object.keys(v).some((x) => !['name', 'out'].includes(x))) throw new Error('project is { name, out }');
      // By its ref (<name>, or <place>/<name> in a group); "projects/<name>" is the projects folder's own <name>.
      const ref = v.name.startsWith('projects/') ? v.name.slice('projects/'.length) : v.name;
      if (!projects.includes(ref) && v.out) throw new Error(`there is no project "${ref.slice(0, 60)}" on this computer`);
      next.projectsOut = v.out ? [...new Set([...next.projectsOut, ref])] : next.projectsOut.filter((n) => n !== ref);
    } else throw new Error(`"${String(k).slice(0, 40)}" is not an Operator setting`);
  }
  return next;
}
