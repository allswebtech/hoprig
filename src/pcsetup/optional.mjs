// The optional kits' extras, read from this computer: the suggestions from the projects that are here, the PHP note
// for each PHP project, and the Java line where a project needs Java. Everything here only reads: no install, no clone, no fetch, and the
// workspace map is never written. What the package manager would install is read without root and without the network
// (apt: `apt-cache`; Homebrew: its local formula information); elsewhere it is "not known before it is installed".
import fs from 'node:fs';
import path from 'node:path';
import { MAX_SERIES, detectPhp, newestFirst, plainVersion } from './detect.mjs';
import { findJava } from './java.mjs';
import { kitById, pmInstall } from './kits.mjs';
import { phpNote, versionNumbers } from './phpver.mjs';
import { javaWanted, phpWishes, projectsLeftOut, suggestKits } from './suggest.mjs';

const MAX_READ = 256 * 1024;

/**
 * A reader for suggest.mjs over the real disk, inside `root` only: a link is followed only when it stays inside the
 * projects folder (a link out, or a loop of links, counts as nothing there). Files over 256 KiB are not read.
 */
export function diskReader(root) {
  let top = null;
  try {
    top = fs.realpathSync(root);
  } catch {
    /* no projects folder: nothing is there */
  }
  const inside = (p) => {
    if (!top) return null;
    try {
      const real = fs.realpathSync(p);
      return real === top || real.startsWith(top + path.sep) ? real : null;
    } catch {
      return null; // missing, or a loop of links
    }
  };
  return {
    list: (dir) => {
      const real = inside(dir);
      try {
        return real ? fs.readdirSync(real) : [];
      } catch {
        return [];
      }
    },
    kind: (p) => {
      const real = inside(p);
      if (!real) return 'none';
      try {
        const st = fs.statSync(real);
        return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'none';
      } catch {
        return 'none';
      }
    },
    read: (p) => {
      const real = inside(p);
      try {
        return real && fs.statSync(real).isFile() && fs.statSync(real).size <= MAX_READ ? fs.readFileSync(real, 'utf8') : null;
      } catch {
        return null;
      }
    },
  };
}

/** apt's candidate "2:8.5+99ubuntu1" → "8.5"; "(none)" → null. */
export function aptCandidate(text) {
  const m = /Candidate:\s*(\S+)/.exec(String(text || ''));
  if (!m || m[1] === '(none)') return null;
  return plainVersion(m[1].replace(/^\d+:/, ''));
}

const BREW_ENV = { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1' };

/**
 * What the package manager offers for PHP, read without root or network: { default: version | null, series: [{ series,
 * version, argv, run }] } (series: other PHP series of the same archive, installed BESIDE the default one).
 */
export async function phpOffers(sys) {
  const none = { default: null, series: [] };
  if (sys.pm === 'apt' && sys.has('apt-cache')) {
    // php-cli is a metapackage ("2:8.5+99ubuntu1": a series only); the PHP it brings is the package it depends on
    // (php8.5-cli 8.5.4-…), so that one's candidate is the version compared. Not readable: the series only.
    let def = aptCandidate((await sys.run(['apt-cache', 'policy', 'php-cli'])).stdout);
    const real = /Depends:\s*(php\d+\.\d+-cli)\b/.exec(String((await sys.run(['apt-cache', 'depends', 'php-cli'])).stdout || ''));
    if (def && real) def = aptCandidate((await sys.run(['apt-cache', 'policy', real[1]])).stdout) || def;
    const names = String((await sys.run(['apt-cache', 'pkgnames', 'php'])).stdout || '').split('\n').map((s) => s.trim()).filter((n) => /^php\d+\.\d+-cli$/.test(n));
    const series = [];
    for (const n of newestFirst(names, (x) => x.slice(3, -4)).slice(0, MAX_SERIES)) {
      const s = n.slice(3, -4);
      if (def && s === def.split('.').slice(0, 2).join('.')) continue; // the default one itself
      const version = aptCandidate((await sys.run(['apt-cache', 'policy', n])).stdout);
      // Debian's php<X.Y>-cli registers itself as `php` with the series as its priority (update-alternatives … 85 for
      // 8.5): a NEWER series takes over what `php` runs. So apt's series are offered beside only below the PHP here.
      if (version) series.push({ series: s, version, argv: pmInstall(sys, [n]), run: `php${s}`, takesOverIfNewer: true });
    }
    return { default: def, series };
  }
  if (sys.pm === 'brew' && sys.has('brew')) {
    const env = { ...sys.env, ...BREW_ENV };
    let def = null;
    try {
      const j = JSON.parse((await sys.run(['brew', 'info', '--json=v2', '--formula', 'php'], { env })).stdout);
      def = plainVersion(j.formulae[0].versions.stable);
    } catch {
      /* not readable: not known */
    }
    const names = String((await sys.run(['brew', 'formulae'], { env })).stdout || '').split('\n').map((s) => s.trim()).filter((n) => /^php@\d+\.\d+$/.test(n)).sort();
    // Homebrew keeps an older series out of PATH (keg-only): its php is run by its full path.
    // Only the series is known before it is installed: it is compared as a series (phpver.mjs seriesFit).
    const series = names.map((n) => ({ series: n.slice(4), version: n.slice(4), argv: ['brew', 'install', n], run: `"$(brew --prefix ${n})/bin/php"` }));
    return { default: def, series: series.filter((s) => !def || s.series !== def.split('.').slice(0, 2).join('.')) };
  }
  return none;
}

/** The PHP notes for the PHP projects here: [phpNote()]. No PHP project: []. */
export async function phpNotes(sys, projectsDir, { reader = diskReader(projectsDir), php = null } = {}) {
  const wishes = phpWishes(projectsDir, reader);
  if (!wishes.length) return [];
  const here = php || (await detectPhp(sys));
  const offers = await phpOffers(sys);
  const have = here.state === 'ok' ? { version: here.version, from: 'installed' } : offers.default ? { version: offers.default, from: 'offered' } : null;
  return wishes.map((w) => (w.error
    ? { project: w.project, where: w.where, wants: null, verdict: 'unreadable', offer: null, use: null, text: `${w.where ? `${w.project} (${w.where})` : w.project}: ${w.error}, so what PHP it asks for is not known.` }
    : phpNote(w, have, { others: here.others || [], series: offers.series })));
}

/**
 * Everything the optional kits add to a list of the kits, for `pc setup`, `pc status` and the Setup tab:
 * { suggested: [{ kit, project, reason }] (complete kits left out), php: [note], java: findJava() when a project here
 * needs Java (suggest.mjs javaWanted) and null otherwise, leftOut: projects past the cap that were not read (suggest.mjs) }.
 */
export async function optionalExtras(sys, projectsDir, found, { reader = diskReader(projectsDir) } = {}) {
  const missing = (k) => (found[k] || []).some((i) => i.state === 'missing');
  const covered = (k) => (found[k] || []).some((i) => i.state !== 'na');
  const suggested = suggestKits(projectsDir, reader).filter((s) => kitById(s.kit) && missing(s.kit) && covered(s.kit));
  const phpItem = (found.php || []).find((i) => i.id === 'php');
  const [php, java] = await Promise.all([
    covered('php') ? phpNotes(sys, projectsDir, { reader, php: phpItem }) : [],
    // Java is looked for only when a project here needs one: the look starts every Java it finds to ask its version,
    // and a computer whose projects use none has nothing to be told about it.
    javaWanted(projectsDir, reader) ? findJava(sys) : null,
  ]);
  return { suggested, php, java, leftOut: projectsLeftOut(projectsDir, reader) };
}

/**
 * The steps the PHP kit adds: another PHP series of the package manager that a project needs, installed beside the
 * other PHP (each once). Only when the PHP kit is chosen; never a package source, never a remove, never update-alternatives.
 */
export function extraSteps(extras) {
  const seen = new Set();
  const php = [];
  for (const n of (extras && extras.php) || []) {
    if (!n.offer || seen.has(n.offer.argv.join(' '))) continue;
    seen.add(n.offer.argv.join(' '));
    php.push({ argv: n.offer.argv, admin: n.offer.argv[0] === 'sudo', items: [], why: `PHP ${n.offer.series} beside the other one, for ${n.project}` });
  }
  return php.length ? { php } : {};
}
