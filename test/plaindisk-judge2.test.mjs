// A second judge of what a plain delete may reach on disk (src/plaindisk.mjs), written by another reviewer with its own
// generator: random trees with names in many scripts and some that are not valid UTF-8, hidden names, links out of the
// folder (absolute, relative, chains, dangling), links to folders inside, repositories at depths 0 to 5 (a .git folder,
// a .git file, .GIT, bare ones), and random rm lines over them with globs, ?, quotes, a slash at the end, absolute forms
// and many targets. Every line the rule answers is run with the real rm through bash; every entry of the tree that
// changed must lie inside the folder, be reached by an argument rm got (not through a link or a mount), and be no
// repository's. A seeded source with a full period (mulberry32).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { plainDelete } = await import('../src/asking.mjs');

function judge(ROOT, worker, NT, NL, SEED) {
  const T = `${ROOT}/w${worker}/T`;
  const P = `${ROOT}/w${worker}/P`;
  const RMLOG = `${ROOT}/w${worker}/rm.log`;
  let seed = SEED * 7919 + worker * 104729;
  const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const B = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'));
  const L = (b) => B(b).toString('latin1'); // byte-exact key
  const NAMES = ['a', 'b', 'src', 'lib', 'dist', 'node_modules', 'x', 'y1', 'build', 'out', 'a b', 'é', 'ü2', '中文', '😀', 'q😀', '-rf', '-x', 'n\nl', 'tab\tt', 'a*b', 'q?', 'p.txt', 'r.js', 'café', 'café', 'k'.repeat(200), 'z9', 'HEAD', 'objects', 'refs', 'log'];
  const HIDDEN = ['.env', '.config', '.hid', '.cache'];
  const BAD = [Buffer.from([0xff]), Buffer.from([0x61, 0xfe, 0x62]), Buffer.from([0xed, 0xa0, 0x80])];

  const sh = (cmd, cwd) => spawnSync('bash', ['-c', cmd], { cwd, encoding: 'buffer' });
  function joinB(dir, name) {
    return Buffer.concat([B(dir), Buffer.from('/'), B(name)]);
  }

  // ---------- tree ----------
  function build() {
    fs.rmSync(path.dirname(T), { recursive: true, force: true });
    const run = `${T}/w/p/run`;
    for (const d of [`${T}/home`, `${T}/far/keep`, `${T}/w/p/sib/keep`, run]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(`${T}/far/keep/m`, 'far');
    fs.writeFileSync(`${T}/w/p/sib/keep/m`, 'sib');
    fs.writeFileSync(`${T}/w/p/marker`, 'p');
    fs.writeFileSync(`${T}/home/m`, 'h');
    const dirs = [Buffer.from(run)];
    const n = 4 + Math.floor(rnd() * 25);
    for (let i = 0; i < n; i++) {
      const parent = pick(dirs);
      const depth = L(parent).slice(run.length).split('/').length;
      let name = chance(0.08) ? pick(BAD) : chance(0.12) ? pick(HIDDEN) : pick(NAMES);
      const p = joinB(parent, name);
      if (fs.existsSync(p)) continue;
      const r = rnd();
      try {
        if (r < 0.45 && depth < 6) {
          fs.mkdirSync(p);
          dirs.push(p);
          fs.writeFileSync(joinB(p, 'f'), 'in');
        } else if (r < 0.6) fs.writeFileSync(p, 'file');
        else if (r < 0.7) fs.symlinkSync(pick([`${T}/far`, `${T}/far/keep`, `${T}/far/keep/m`, `${T}/w/p/sib`]), p); // absolute out
        else if (r < 0.76) fs.symlinkSync(path.relative(L(parent), `${T}/w/p/sib`) || '.', p); // relative out
        else if (r < 0.8) fs.symlinkSync('nowhere/at/all', p); // dangling
        else if (r < 0.84) {
          // a chain: link -> link2 -> far
          const l2 = joinB(parent, `${L(name)}2`);
          if (!fs.existsSync(l2)) fs.symlinkSync(`${T}/far`, l2);
          fs.symlinkSync(L(l2).slice(L(parent).length + 1), p);
        } else if (r < 0.88 && dirs.length > 1) fs.symlinkSync(L(pick(dirs)), p); // link to a folder inside
        else if (r < 0.94) {
          // a repository somewhere under a new folder, at depth 0-5
          fs.mkdirSync(p);
          dirs.push(p);
          let d = p;
          const k = Math.floor(rnd() * 6);
          for (let j = 0; j < k; j++) {
            d = joinB(d, pick(['s', 't', 'u']));
            fs.mkdirSync(d, { recursive: true });
          }
          const kind = pick(['dir', 'dir', 'file', 'bare', 'GIT', 'bare2']);
          if (kind === 'dir') {
            fs.mkdirSync(joinB(d, '.git/objects'), { recursive: true });
            fs.writeFileSync(joinB(d, '.git/HEAD'), 'ref');
            fs.writeFileSync(joinB(d, 'code.js'), 'wt');
          } else if (kind === 'file') fs.writeFileSync(joinB(d, '.git'), 'gitdir: ../elsewhere');
          else if (kind === 'GIT') fs.mkdirSync(joinB(d, '.GIT'));
          else {
            const g = kind === 'bare' ? d : joinB(d, 'mirror.git');
            fs.mkdirSync(joinB(g, 'objects/ab'), { recursive: true });
            fs.mkdirSync(joinB(g, 'refs/heads'), { recursive: true });
            fs.writeFileSync(joinB(g, 'HEAD'), 'ref');
            fs.writeFileSync(joinB(g, 'objects/ab/cd'), 'obj');
          }
        } else if (dirs.length > 1) {
          // a link named so that a/* matches a folder and a link
          fs.symlinkSync(`${T}/far`, joinB(parent, `${L(name)}L`));
        }
      } catch {
        /* skip */
      }
    }
    if (chance(0.01)) {
      const big = `${run}/big`;
      fs.mkdirSync(big);
      for (let i = 0; i < 5000; i++) fs.writeFileSync(`${big}/e${i}`, '');
    }
    return run;
  }

  // Every entry under T (not following links): key -> kind+content.
  function snapshot(dir = Buffer.from(T), out = new Map()) {
    let names;
    try {
      names = fs.readdirSync(dir, { encoding: 'buffer' });
    } catch {
      return out;
    }
    for (const n of names) {
      const p = joinB(dir, n);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.set(L(p), `l:${fs.readlinkSync(p, { encoding: 'buffer' }).toString('latin1')}`);
      else if (st.isDirectory()) {
        out.set(L(p), 'd');
        snapshot(p, out);
      } else out.set(L(p), `f:${fs.readFileSync(p).toString('latin1')}`);
    }
    return out;
  }

  // Repository territory: paths where a .git entry (any case) is, its parent (the repo root), bare repos.
  function repoKeys(snap) {
    const roots = new Set();
    for (const k of snap.keys()) {
      const base = k.slice(k.lastIndexOf('/') + 1);
      if (base.toLowerCase() === '.git') roots.add(k.slice(0, k.lastIndexOf('/')));
      if (base === 'HEAD' && snap.get(k).startsWith('f') && snap.get(`${k.slice(0, k.lastIndexOf('/'))}/objects`) === 'd') roots.add(`BARE${k.slice(0, k.lastIndexOf('/'))}`);
    }
    return [...roots];
  }

  // ---------- lines ----------
  function entriesUnder(run) {
    const out = [];
    const walk = (d, rel, depth) => {
      if (depth > 6) return;
      let names;
      try {
        names = fs.readdirSync(d, { encoding: 'buffer' });
      } catch {
        return;
      }
      for (const n of names) {
        const relp = rel ? `${rel}/${n.toString('utf8')}` : n.toString('utf8');
        out.push({ rel: relp, bad: n.toString('utf8') !== L(n) && Buffer.compare(Buffer.from(n.toString('utf8')), n) !== 0 });
        const p = joinB(d, n);
        try {
          if (fs.lstatSync(p).isDirectory()) walk(p, relp, depth + 1);
        } catch {}
      }
    };
    walk(Buffer.from(run), '', 0);
    return out.filter((e) => !e.bad);
  }

  function globify(part) {
    if (part.startsWith('.')) return part;
    const r = rnd();
    if (r < 0.3) return '*';
    if (r < 0.4) return '?';
    if (r < 0.5) return '??';
    if (r < 0.6 && part.length > 1) return `${[...part][0]}*`;
    if (r < 0.7 && part.length > 1) return `*${[...part].at(-1)}`;
    if (r < 0.78) return '*?';
    return part;
  }

  function target(entries, run) {
    const e = entries.length && chance(0.9) ? pick(entries).rel : pick(['a', 'nope', 'src/x', 'a/b/c']);
    let parts = e.split('/');
    // glob some parts after the first
    parts = parts.map((p, i) => (i > 0 && chance(0.45) ? globify(p) : p));
    if (chance(0.15)) parts.push(pick(['*', '?', 'f', '*/f', '*/*']));
    let t = parts.join('/');
    const r = rnd();
    if (r < 0.1) t += '/';
    else if (r < 0.13) t = `./${t}`;
    else if (r < 0.2) t = `${run}/${t}`;
    else if (r < 0.22) t += '/.';
    else if (r < 0.24) t = t.replace('/', '/./');
    else if (r < 0.26) t = t.replace('/', '//');
    return t;
  }

  function quote(t) {
    if (/[\n\t]/.test(t)) return chance(0.5) ? `'${t}'` : t;
    const r = rnd();
    if (r < 0.6 && !/[ ]/.test(t)) return t;
    if (r < 0.75) return `'${t}'`;
    if (r < 0.85) return `"${t}"`;
    // quote the first part only, leave globs bare
    const i = t.indexOf('/');
    return i > 0 ? `"${t.slice(0, i)}"${t.slice(i)}` : `"${t}"`;
  }

  function line(entries, run) {
    const cmds = chance(0.85) ? 1 : 2 + Math.floor(rnd() * 2);
    const out = [];
    for (let c = 0; c < cmds; c++) {
      const nt = chance(0.02) ? 300 : 1 + Math.floor(rnd() * 3);
      const ts = [];
      for (let i = 0; i < nt; i++) ts.push(quote(target(entries, run)));
      if (chance(0.05)) ts.push(ts[0]);
      const opt = pick(['-rf', '-rf', '-r', '-f', '-R', '-rfv', '--recursive --force', '-rf --', '-d', '']);
      const end = pick(['', '', '', ' 2>/dev/null', ' || true', ' >/dev/null 2>&1']);
      out.push(`rm ${opt ? `${opt} ` : ''}${ts.join(' ')}${end}`.replace(/  +/g, ' '));
    }
    return out.join(pick(['; ', ' && ']));
  }


  // ---------- run ----------
  const stats = { lines: 0, answered: 0, ran: 0, violations: 0 };
  const distinct = new Set();
  const distinctAnswered = new Set();
  const findings = [];
  fs.mkdirSync(path.dirname(T), { recursive: true });
  for (let t = 0; t < NT; t++) {
    const run = build();
    execFileSync('cp', ['-a', T, P]);
    const pristine = snapshot();
    const repos = repoKeys(pristine);
    const entries = entriesUnder(run);
    const places = { cwd: run, home: `${T}/home`, workspace: `${T}/ws`, projects: [`${T}/ws/projects`] };
    for (let k = 0; k < NL; k++) {
      const l = line(entries, run);
      stats.lines++;
      distinct.add(`${t}|${l}`);
      let ok;
      try {
        ok = plainDelete(l, places);
      } catch (e) {
        findings.push({ kind: 'throw', line: l, err: String(e) });
        continue;
      }
      if (!ok) continue;
      stats.answered++;
      distinctAnswered.add(`${t}|${l}`);
      // safety: absolute words must be under ROOT
      for (const w of l.replace(/['"]/g, '').split(/[ \t;]+/)) if (w.startsWith('/') && !w.startsWith(`${ROOT}/`) && w !== '/dev/null') throw new Error(`unsafe ${l}`);
      if (!run.startsWith(`${ROOT}/`)) throw new Error('unsafe cwd');
      // what bash hands to rm
      fs.rmSync(RMLOG, { force: true });
      fs.writeFileSync(RMLOG, '');
      spawnSync('/bin/bash', ['-c', l], { cwd: run, env: { PATH: `${ROOT}/bin`, RMLOG, LANG: 'en_US.UTF-8', HOME: `${T}/home` } });
      // What rm got as targets: an option before -- is an option (GNU rm takes options after targets too); after --
      // everything is a target (a file named -rf included).
      let afterDD = false;
      const args = fs.readFileSync(RMLOG).toString('latin1').split('\0').filter((a) => {
        if (!a) return false;
        if (!afterDD && a === '--') return !(afterDD = true);
        return afterDD || !/^-[rRfvd]+$|^--(recursive|force|verbose|dir)$/.test(a);
      });
      // the real rm, PATH with the system's rm
      spawnSync('/bin/bash', ['-c', l], { cwd: run, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: `${T}/home` } });
      stats.ran++;
      const after = snapshot();
      const runL = L(run);
      const argAbs = args.map((a) => path.posix.normalize(a.startsWith('/') ? a : `${runL}/${a}`).replace(/\/$/, ''));
      const bad = [];
      for (const [key, v] of pristine) {
        if (after.get(key) === v) continue;
        if (!key.startsWith(`${runL}/`)) bad.push(['outside', key]);
        else if (!argAbs.some((a) => key === a || key.startsWith(`${a}/`))) bad.push(['not-an-arg (link/mount)', key]);
        for (const r of repos) {
          const root = r.startsWith('BARE') ? r.slice(4) : r;
          if (key === root || (key.startsWith(`${root}/`) && (r.startsWith('BARE') || /\/\.git(\/|$)/i.test(key.slice(root.length))))) bad.push(['repo', key]);
        }
      }
      if (bad.length) {
        stats.violations++;
        const links = spawnSync('/usr/bin/find', [run.replace(T, P), '-type', 'l', '-printf', '%p -> %l\\n'], { encoding: 'buffer' }).stdout.toString('utf8').split(run.replace(T, P)).join('');
        findings.push({ tree: t, links, line: l, cwd: run, bad: bad.slice(0, 5).map(([a, b]) => [a, Buffer.from(b, 'latin1').toString('utf8').slice(L(T).length)]) });
      }
      // restore
      fs.rmSync(T, { recursive: true, force: true });
      execFileSync('cp', ['-a', P, T]);
    }
    fs.rmSync(P, { recursive: true, force: true });
  }

  return { stats: { ...stats, distinct: distinct.size, distinctAnswered: distinctAnswered.size }, findings };
}

test('the second judge: random trees and rm lines of another reviewer, each answered line run with the real rm: 0 violations', { skip: process.platform === 'win32' && 'needs bash and rm', timeout: 600_000 }, () => {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-judge2-')));
  fs.mkdirSync(path.join(ROOT, 'bin'));
  fs.writeFileSync(path.join(ROOT, 'bin', 'rm'), '#!/bin/bash\nfor a in "$@"; do printf \'%s\\0\' "$a" >> "$RMLOG"; done\n', { mode: 0o755 });
  try {
    const all = [0, 1].map((w) => judge(ROOT, w, 50, 40, 20261118));
    const sum = (k) => all.reduce((n, r) => n + r.stats[k], 0);
    process.stdout.write(`# judge 2: ${sum('lines')} lines in 100 trees (${sum('distinct')} distinct), ${sum('answered')} answered and run with the real rm, ${sum('violations')} violations\n`);
    assert.ok(sum('answered') > 500, `enough answered lines: ${sum('answered')}`);
    assert.deepEqual(all.flatMap((r) => r.findings), []);
  } finally {
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
