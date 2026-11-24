// Does the PHP here fit what a project asks for? The project's wish is `require.php` of its composer.json, read with
// Composer's own rules for version constraints (https://getcomposer.org/doc/articles/versions.md):
//   ^8.1 (>=8.1.0 <9.0.0; ^0.3 is <0.4), ~8.1 (<9.0) and ~8.1.2 (<8.2.0), >=, >, <=, <, !=, an exact 8.2 (== 8.2.0),
//   8.2.* and 8.*, * for any, a space or a comma for AND, | or || for OR, `8.1 - 8.3` for a range (a partial upper
//   end means "up to the next one": <8.4; a full one means <=), a stability flag (@stable) is left out.
// A shape it cannot read (dev-master, a branch, garbage, not text) is said as such and never guessed.
// Pure: nothing here runs a command. The reading of what this computer has and offers is in phpsys.mjs.

const OPS = ['>=', '<=', '!=', '==', '=', '>', '<', '^', '~'];

/** "v8.2.*" → { n: [8, 2], wild: true }; "8.2.1" → { n: [8, 2, 1], wild: false }; anything else → null. */
function readVersion(s) {
  const t = String(s).replace(/^v/i, '');
  const parts = t.split('.');
  if (!parts.length || parts.length > 4) return null;
  const n = [];
  let wild = false;
  for (const [i, p] of parts.entries()) {
    if (/^[*x]$/i.test(p) && i === parts.length - 1) wild = true;
    else if (/^\d{1,9}$/.test(p)) n.push(Number(p));
    else return null;
  }
  return n.length || wild ? { n, wild } : null;
}

const pad = (n) => [...n, 0, 0, 0, 0].slice(0, 4);
/** The version after `n` cut to `at + 1` parts: up([8, 1], 0) → [9, 0, 0, 0]. */
const up = (n, at) => pad([...n.slice(0, at), (n[at] || 0) + 1]);
export function compare(a, b) {
  for (let i = 0; i < 4; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0) ? -1 : 1;
  return 0;
}

/** One term ("^8.1", ">=8", "8.2.*") → [{ op, v }] (all must hold), or null when it cannot be read. */
function term(raw) {
  const t = raw.replace(/@(stable|rc|beta|alpha|dev)$/i, '');
  if (t === '*' || /^v?[*x]$/i.test(t)) return [];
  const op = OPS.find((o) => t.startsWith(o)) || '';
  const v = readVersion(t.slice(op.length));
  if (!v) return null;
  if (v.wild) {
    if (op && op !== '=' && op !== '==') return null; // ">=8.*" is not a form Composer documents
    return v.n.length ? [{ op: '>=', v: pad(v.n) }, { op: '<', v: up(v.n, v.n.length - 1) }] : [];
  }
  const n = v.n;
  switch (op) {
    case '^': {
      const at = n[0] !== 0 || n.length < 2 ? 0 : n[1] !== 0 || n.length < 3 ? 1 : 2;
      return [{ op: '>=', v: pad(n) }, { op: '<', v: up(n, at) }];
    }
    case '~': return [{ op: '>=', v: pad(n) }, { op: '<', v: up(n, Math.max(n.length - 2, 0)) }];
    case '': case '=': case '==': return [{ op: '==', v: pad(n) }];
    default: return [{ op, v: pad(n) }];
  }
}

/** `a - b`: from a; up to b, or below the next one after a partial b ("8.1 - 8.3" is <8.4). */
function range(a, b) {
  const lo = readVersion(a);
  const hi = readVersion(b);
  if (!lo || !hi || lo.wild || hi.wild) return null;
  return [{ op: '>=', v: pad(lo.n) }, hi.n.length < 3 ? { op: '<', v: up(hi.n, hi.n.length - 1) } : { op: '<=', v: pad(hi.n) }];
}

/**
 * Read a constraint. → { ok: true, alts: [[{ op, v }]] } (any alternative fits when all its terms hold), or
 * { ok: false, why } in words.
 */
export function parseConstraint(input) {
  if (typeof input !== 'string') return { ok: false, why: 'it is not a version text' };
  const s = input.trim();
  if (!s || s.length > 200) return { ok: false, why: s ? 'it is too long' : 'it is empty' };
  const alts = [];
  for (const alt of s.split(/\s*\|\|?\s*/)) {
    // ">= 8.1" is one term: the space after an operator is not an AND.
    const tokens = alt.replace(/(>=|<=|!=|==|=|>|<|\^|~)\s+/g, '$1').split(/\s*,\s*|\s+/).filter(Boolean);
    if (!tokens.length) return { ok: false, why: 'it has an empty part' };
    const terms = [];
    for (let i = 0; i < tokens.length; i++) {
      const got = tokens[i + 1] === '-' ? range(tokens[i], tokens[(i += 2)]) : term(tokens[i]);
      if (!got) return { ok: false, why: 'it is not a form Hoprig can read' };
      terms.push(...got);
    }
    alts.push(terms);
  }
  return { ok: true, alts };
}

/** "8.5.4-0ubuntu1.5" → [8, 5, 4, 0]; null when there is no version in it. */
export function versionNumbers(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text || ''));
  return m ? pad([Number(m[1]), Number(m[2]), Number(m[3] || 0)]) : null;
}

const holds = (v, { op, v: w }) => {
  const c = compare(v, w);
  return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : op === '!=' ? c !== 0 : c === 0;
};

/**
 * Does `version` fit the read constraint? → { fits, side }: side 'newer' when it is above every alternative, 'older'
 * when below every one, 'other' when it falls between them or on an excluded version.
 */
export function fitOf(version, parsed) {
  const v = versionNumbers(version);
  if (!v || !parsed || !parsed.ok) return { fits: false, side: 'other' };
  const sides = new Set();
  for (const alt of parsed.alts) {
    const failed = alt.filter((t) => !holds(v, t));
    if (!failed.length) return { fits: true, side: null };
    const each = failed.map((t) => (t.op === '<' || t.op === '<=' ? 'newer' : t.op === '>' || t.op === '>=' ? 'older' : t.op === '==' ? (compare(v, t.v) > 0 ? 'newer' : 'older') : 'other'));
    sides.add(new Set(each).size === 1 ? each[0] : 'other');
  }
  return { fits: false, side: sides.size === 1 ? [...sides][0] : 'other' };
}

/**
 * fitOf for a version that may be a series only ("8.5": what a package manager names before it is installed). A series
 * fits when its first and its last patch release both fit, and is on one side when both are; otherwise whether it fits
 * depends on the patch release, which is not known: side 'unsure'.
 */
export function seriesFit(version, parsed) {
  const m = /^(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!m) return fitOf(version, parsed);
  const first = fitOf(`${m[1]}.${m[2]}.0`, parsed);
  const last = fitOf(`${m[1]}.${m[2]}.999999`, parsed);
  if (first.fits && last.fits) return first;
  if (!first.fits && !last.fits && first.side === last.side) return first;
  return { fits: false, side: 'unsure' };
}

/** [8, 1, 0, 0] → "8.1", [8, 1, 2, 0] → "8.1.2". */
const fmt = (v) => (v[2] ? `${v[0]}.${v[1]}.${v[2]}` : `${v[0]}.${v[1]}`);

/**
 * The read constraint in words, for someone who does not read Composer's syntax: "^8.1 <8.4" → "PHP 8.1 up to 8.3",
 * "^8.1" → "PHP 8.1 or a later 8.x", ">=8.2" → "PHP 8.2 or newer". null when it has no short wording (several
 * alternatives, an exact or excluded version): the composer.json text is said instead.
 */
export function rangeWords(parsed) {
  if (!parsed || !parsed.ok || parsed.alts.length !== 1) return null;
  const terms = parsed.alts[0];
  if (!terms.length) return 'any PHP';
  if (terms.some((t) => !['>=', '<', '<='].includes(t.op))) return null;
  const los = terms.filter((t) => t.op === '>=').map((t) => t.v).sort(compare);
  const his = terms.filter((t) => t.op !== '>=').sort((a, b) => compare(a.v, b.v));
  const lo = los.at(-1);
  const hi = his[0];
  if (!hi) return `PHP ${fmt(lo)} or newer`;
  const [X, Y, Z] = hi.v;
  const below = hi.op === '<' && !Z && (Y || X) ? (Y ? `${X}.${Y - 1}` : null) : null;
  // "<=8.3" is <=8.3.0 in Composer: said with its patch number, so 8.3.6 is not read as fitting.
  const last = `${X}.${Y}.${Z}`;
  if (!lo) return hi.op === '<=' ? `PHP ${last} or older` : below ? `PHP ${below} or older` : `PHP below ${fmt(hi.v)}`;
  if (hi.op === '<=') return `PHP ${fmt(lo)} up to ${last}`;
  if (!Z && !Y && lo[0] === X - 1) return lo[1] || lo[2] ? `PHP ${fmt(lo)} or a later ${X - 1}.x` : `PHP ${X - 1}.x`;
  if (below && lo[0] === X && lo[1] === Y - 1) return lo[2] ? `PHP ${fmt(lo)} or a later ${below}.x` : `PHP ${below}.x`;
  if (below) return `PHP ${fmt(lo)} up to ${below}`;
  return `PHP ${fmt(lo)} up to below ${fmt(hi.v)}`;
}

/**
 * The PHP series that have an official Docker image (https://hub.docker.com/_/php, its tags checked 18 Nov 2026),
 * newest first. The only list of PHP versions in Hoprig: a container is offered from it and never from a number in a
 * composer.json, so no constraint, however large its numbers, makes up an image or makes Hoprig walk a range. Add the
 * next series here once its image is on Docker Hub (php:8.6 was not, on that day).
 */
export const PHP_SERIES = ['8.5', '8.4', '8.3', '8.2', '8.1', '8.0', '7.4', '7.3', '7.2', '7.1', '7.0', '5.6', '5.5', '5.4', '5.3'];

/**
 * The newest PHP series of PHP_SERIES whose last release fits (the image of a series is its newest patch release:
 * ">=8.1 <=8.3" is <=8.3.0, so 8.3's image does not fit and 8.2's does), or null. At most fifteen checks.
 */
function containerSeries(parsed) {
  if (!parsed.ok || parsed.alts.length !== 1) return null;
  return PHP_SERIES.find((s) => fitOf(`${s}.999999`, parsed).fits) || null;
}

/** The version as its numbers say it: "8.5.4-0ubuntu1.5" → "8.5.4", an offered series "8.5" stays "8.5". */
const label = (version) => (/\d+\.\d+(?:\.\d+)?/.exec(String(version)) || [String(version)])[0];

/**
 * The note for one project's wish, in plain words.
 *   want    { project, where, wants } (where: "" for the project's root, else "code/x"; wants: require.php as found)
 *   have    { version, from: 'installed' | 'offered' | null }  the PHP `php` runs, or what the package manager would give
 *   others  [{ name, version }]   other PHPs on PATH (php8.3 …)
 *   series  [{ series, version, argv, run }]   other PHP series the package manager offers, beside the default one
 * → { project, verdict: fits | newer | older | other | unreadable | unknown, text, offer: { series, argv, run } | null, use }
 */
export function phpNote(want, have, { others = [], series = [] } = {}) {
  const name = want.where ? `${want.project} (${want.where})` : want.project;
  const asks = typeof want.wants === 'string' ? `${name} asks for PHP ${want.wants} in its composer.json` : `${name}'s composer.json`;
  const parsed = parseConstraint(want.wants);
  const out = { project: want.project, where: want.where || '', wants: typeof want.wants === 'string' ? want.wants : null, verdict: 'unreadable', text: '', offer: null, use: null };
  if (!parsed.ok) {
    out.text = typeof want.wants === 'string'
      ? `${asks}, in a form Hoprig cannot read (${parsed.why}), so it is not compared: check it yourself.`
      : `${asks} names PHP in a form Hoprig cannot read (it is not a version text), so it is not compared: check it yourself.`;
    return out;
  }
  // In words where the constraint has a short wording; Composer's own text only where it has none.
  const words = rangeWords(parsed);
  const needs = words ? `${name} needs ${words}` : asks;
  if (!have || !have.version) {
    out.verdict = 'unknown';
    out.text = `${needs}. There is no PHP here yet, and which version the package manager installs is not known before it is installed: check it with php -v afterwards.`;
    return out;
  }
  const f = seriesFit(have.version, parsed);
  if (f.side === 'unsure') {
    out.verdict = 'unknown';
    out.text = `${needs}. There is no PHP here yet; the PHP kit would install PHP ${label(have.version)}, and whether its patch release fits is not known before it is installed: check it with php -v afterwards.`;
    return out;
  }
  const here = have.from === 'installed' ? `PHP ${label(have.version)} here` : `No PHP here yet; the PHP kit would install PHP ${label(have.version)}, which`;
  if (f.fits) {
    out.verdict = 'fits';
    out.text = have.from === 'installed' ? `${needs}: ${here} fits.` : `${needs}. ${here} fits.`;
    return out;
  }
  out.verdict = f.side;
  const how = f.side === 'newer' ? 'is too new' : f.side === 'older' ? 'is too old' : 'does not fit';
  const what = [];
  const fitting = others.find((o) => fitOf(o.version, parsed).fits);
  const newer = (s) => compare(versionNumbers(s.series), versionNumbers(label(have.version)).slice(0, 2)) > 0;
  const fits = [...series].sort((a, b) => compare(versionNumbers(b.version), versionNumbers(a.version))).filter((s) => seriesFit(s.version, parsed).fits);
  const offered = fits.find((s) => !(s.takesOverIfNewer && newer(s)));
  const takesOver = !offered && fits.find((s) => s.takesOverIfNewer && newer(s));
  if (fitting) {
    out.use = fitting.name;
    what.push(`run ${want.project}'s commands with ${fitting.name} (PHP ${label(fitting.version)}, here already) instead of php; for Composer: ${fitting.name} "$(command -v composer)" install`);
  } else if (offered) {
    out.offer = offered;
    what.push(`install PHP ${offered.series} beside it (the command below, only after your yes) and run ${want.project}'s commands with ${offered.run}`);
  }
  const box = containerSeries(parsed);
  what.push(`run ${want.project} in Docker with the official ${box ? `php:${box}` : 'php'} image${box ? '' : ' of a version that fits'} (the Docker kit)`);
  if (takesOver) what.push(`PHP ${takesOver.series} of the package manager is not offered: installed beside PHP ${label(have.version)}, it would become what the php command runs for every project`);
  out.text = have.from === 'installed'
    ? `${needs}, and ${here} ${how}. What you can do: ${what.join('; or ')}.`
    : `${needs}. ${here} ${how}. What you can do: ${what.join('; or ')}.`;
  return out;
}
