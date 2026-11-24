// The owner's switches and limits for missions ("Tia works on this by herself"), in the dashboard's config under
// `missions`. Off by default, twice: the master switch `on` (its off is "Tia OFF") and one switch per project. With
// either off, a goal given to Tia is a plain plan proposal and its tasks are his to start, as before.
//
//   on          the master switch (false: "Tia OFF")            projects   { <name>: { on, test: [argv] } }: her
//   atOnce      sessions of hers at once (1 to 4; never more than      switch per project, and the command that
//               "runs by themselves at once")                          runs its tests (a code task's gate)
//   hours       null, or { from: "HH:MM", to: "HH:MM" } in Work's time zone: nothing of hers starts outside them
//   capUsd      the spend cap per day in dollars, from each run's own cost line (0: none set, nothing starts)
//   capTokens   the token cap per day for runs whose provider reports no cost (0: such runs are not counted)
//   providers   the providers she may use, in his order (none: nothing starts)
//   selfAccept  the kinds whose results she accepts by herself when their gate and review passed: "docs", "tests"
//   offStops    what "Tia OFF" does to what runs: false (it runs to its end, nothing further) or true (stopped)
//   minutes     the time limit of each session (1 to 240)          model   null (each role's own) or one model for all
//   rolesOff    roles she does not use (their tasks are his)
import { MODELS } from '../config.mjs';
import { ROLE_NAMES } from './roles.mjs';

export const DEFAULTS = Object.freeze({ on: false, projects: {}, atOnce: 1, hours: null, capUsd: 0, capTokens: 0, providers: [], selfAccept: [], offStops: false, minutes: 30, model: null, rolesOff: [] });
export const SELF_KINDS = Object.freeze({ docs: 'writer', tests: 'tester' });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ARG_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => Object.assign(new Error(message), { status: 400, details: { code: 'bad-request' } });

const cleanProjects = (v, strict, known) => {
  if (!isObj(v)) {
    if (strict) throw fail('projects is an object of project names');
    return {};
  }
  const out = {};
  for (const [name, p] of Object.entries(v)) {
    const ok = PROJECT_RE.test(name) && isObj(p) && (!known || known.includes(name));
    const test = isObj(p) && Array.isArray(p.test) && p.test.length <= 10 && p.test.every((a) => typeof a === 'string' && ARG_RE.test(a)) ? [...p.test] : null;
    if (strict && !ok) throw fail(`"${String(name).slice(0, 60)}" is not a project of the workspace`);
    if (strict && isObj(p) && p.test !== undefined && p.test !== null && !test) throw fail('a test command is up to 10 words, each one line');
    if (ok) out[name] = { on: p.on === true, test: test && test.length ? test : null };
  }
  return out;
};

/** The settings as the config has them, read tolerantly: a value that is not understood is its default. */
export function missionSettings(cfg = {}) {
  const raw = isObj(cfg.missions) ? cfg.missions : {};
  const int = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000 ? v : 0);
  const hours = isObj(raw.hours) && HHMM.test(raw.hours.from) && HHMM.test(raw.hours.to) && raw.hours.from !== raw.hours.to ? { from: raw.hours.from, to: raw.hours.to } : null;
  return {
    on: raw.on === true,
    projects: cleanProjects(raw.projects, false),
    atOnce: int(raw.atOnce, 1, 4, 1),
    hours,
    capUsd: num(raw.capUsd),
    capTokens: Number.isInteger(raw.capTokens) && raw.capTokens >= 0 && raw.capTokens <= 1e9 ? raw.capTokens : 0,
    providers: Array.isArray(raw.providers) ? [...new Set(raw.providers.filter((p) => typeof p === 'string' && NAME_RE.test(p)))].slice(0, 20) : [],
    selfAccept: Array.isArray(raw.selfAccept) ? Object.keys(SELF_KINDS).filter((k) => raw.selfAccept.includes(k)) : [],
    offStops: raw.offStops === true,
    minutes: int(raw.minutes, 1, 240, 30),
    model: MODELS.includes(raw.model) ? raw.model : null,
    rolesOff: Array.isArray(raw.rolesOff) ? ROLE_NAMES.filter((r) => raw.rolesOff.includes(r)) : [],
  };
}

/** A change from the page, checked strictly against the workspace's projects and the providers. → the whole settings. */
export function cleanPatch(patch, current, { projects = [], providers = [] } = {}) {
  if (!isObj(patch)) throw fail('send the settings as an object');
  const next = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) throw fail(`"${String(k).slice(0, 30)}" is not a setting of Tia's missions`);
    if (k === 'on' || k === 'offStops') {
      if (typeof v !== 'boolean') throw fail(`${k} is true or false`);
      next[k] = v;
    } else if (k === 'projects') next.projects = { ...current.projects, ...cleanProjects(v, true, projects) };
    else if (k === 'atOnce' || k === 'minutes') {
      const hi = k === 'atOnce' ? 4 : 240;
      if (!Number.isInteger(v) || v < 1 || v > hi) throw fail(`${k === 'atOnce' ? 'sessions at once' : 'the time limit'} is a whole number from 1 to ${hi}`);
      next[k] = v;
    } else if (k === 'hours') {
      if (v !== null && !(isObj(v) && Object.keys(v).length === 2 && HHMM.test(v.from) && HHMM.test(v.to) && v.from !== v.to)) throw fail('working hours are { from, to } as HH:MM, or none');
      next.hours = v ? { from: v.from, to: v.to } : null;
    } else if (k === 'capUsd') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10_000) throw fail('the spend cap is dollars from 0 to 10000');
      next.capUsd = Math.round(v * 100) / 100;
    } else if (k === 'capTokens') {
      if (!Number.isInteger(v) || v < 0 || v > 1e9) throw fail('the token cap is a whole number');
      next.capTokens = v;
    } else if (k === 'providers') {
      if (!Array.isArray(v) || v.length > 20 || new Set(v).size !== v.length || v.some((p) => !providers.includes(p))) throw fail('name providers of this computer that serve Claude Code, each once');
      next.providers = [...v];
    } else if (k === 'selfAccept') {
      if (!Array.isArray(v) || v.some((x) => !(x in SELF_KINDS))) throw fail('Tia accepts by herself only docs and tests');
      next.selfAccept = Object.keys(SELF_KINDS).filter((x) => v.includes(x));
    } else if (k === 'model') {
      if (v !== null && !MODELS.includes(v)) throw fail(`the model is one of: ${MODELS.join(', ')}, or none`);
      next.model = v;
    } else if (k === 'rolesOff') {
      if (!Array.isArray(v) || v.some((x) => !ROLE_NAMES.includes(x))) throw fail(`the roles are: ${ROLE_NAMES.join(', ')}`);
      next.rolesOff = ROLE_NAMES.filter((x) => v.includes(x));
    }
  }
  return next;
}

/** What is still to be set before she starts anything, in the order of the page: [{ key, done, words }]. */
export const stepsOf = (s) => [
  { key: 'on', done: s.on === true, words: 'turn on "Tia works by herself"' },
  { key: 'project', done: Object.values(s.projects).some((p) => p.on === true), words: 'turn her on for a project' },
  { key: 'capUsd', done: s.capUsd > 0, words: 'set a spend cap per day above $0' },
  { key: 'providers', done: s.providers.length > 0, words: 'allow a provider' },
];

/** Whether Tia works on `project` by herself now: both switches on. */
export const worksOn = (s, project) => s.on === true && !!(s.projects[project] && s.projects[project].on === true);
