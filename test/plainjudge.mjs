// Shared by the property tests of the plain delete (plaindelete, plaindisk, plaindisk-judge2).
import fs from 'node:fs';

// How many random lines they try: the full number on Linux and on any computer outside CI (the check before a release),
// a tenth on a CI runner of another system (macOS starts a process several times slower and the whole job has 15
// minutes: the full number took six minutes per test there). HOPRIG_FULL_PROPERTY=1 asks for the full number anywhere.
export const SHARE = process.platform === 'linux' || !process.env.CI || process.env.HOPRIG_FULL_PROPERTY === '1' ? 1 : 0.1;

/** `full` scaled by SHARE (at least 1); `root: true` scales by its square root, for one of two factors of a product. */
export const scaled = (full, { root = false } = {}) => Math.max(1, Math.round(full * (root ? Math.sqrt(SHARE) : SHARE)));

// The tree under `dir` as lines (a folder with a slash, a link with where it leads), for a violation's report.
export function listing(dir, max = 300) {
  const out = [];
  const walk = (d, rel) => {
    let names;
    try {
      names = fs.readdirSync(d, { encoding: 'buffer' }).sort(Buffer.compare);
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= max) return;
      const p = Buffer.concat([Buffer.from(d), Buffer.from('/'), n]);
      const r = rel ? `${rel}/${n.toString('utf8')}` : n.toString('utf8');
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push(`${JSON.stringify(r)} -> ${JSON.stringify(fs.readlinkSync(p, { encoding: 'buffer' }).toString('utf8'))}`);
      else if (st.isDirectory()) {
        out.push(`${JSON.stringify(r)}/`);
        walk(p, r);
      } else out.push(JSON.stringify(r));
    }
  };
  walk(Buffer.from(dir), '');
  return out.join('\n');
}
