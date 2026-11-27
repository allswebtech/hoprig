// The values of the files a project's credential links point at (project.json "credentials", docs/WORKSPACE.md),
// hidden wherever Tia reads a session or a chat: a coding tool in a session can be asked to show a credentials file,
// and its screen then goes to her provider. Read here on this computer only, never kept longer than a few seconds,
// never written or said anywhere: what comes out of maskValues() holds the places of the values as a fixed phrase.
//
// What counts as a value:
//   - a file of KEY=value lines (an .env file, with "export", quotes and comments as usual): each value;
//   - a JSON file: each string in it;
//   - any other file (a key, a certificate): each of its lines.
// A value too short to be a secret ("true", "3000") is left, so ordinary words are not hidden. A value that a narrow
// terminal broke over two lines is found too.
import fs from 'node:fs';
import path from 'node:path';
import { credsDir } from '../workspace/credlinks.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';

export const HIDDEN = '[hidden: a credential value]';
const MIN = 6;
const FILE_MAX = 256 * 1024;
const FILES_MAX = 60;
const VALUES_MAX = 400;
const WRAP_MAX = 400;
const PLAIN = /^(?:true|false|null|none|undefined|localhost|production|development|[0-9]{1,5})$/i;

/** The values of one file's text. */
export function valuesOfText(text) {
  const out = new Set();
  const keep = (v) => {
    const s = String(v).trim();
    if (s.length >= MIN && !PLAIN.test(s)) out.add(s);
  };
  let json = null;
  if (/^\s*[{[]/.test(text)) {
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: read as lines */
    }
  }
  if (json !== null) {
    const walk = (x, depth = 0) => {
      if (depth > 8) return;
      if (typeof x === 'string') keep(x);
      else if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1));
      else if (x && typeof x === 'object') Object.values(x).forEach((y) => walk(y, depth + 1));
    };
    walk(json);
    return [...out];
  }
  const lines = text.split(/\r?\n/);
  const assign = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*(.*)$/;
  const hasAssign = lines.some((l) => !l.trim().startsWith('#') && assign.test(l));
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#')) continue;
    if (hasAssign) {
      const m = assign.exec(l);
      if (!m) continue;
      let v = m[1].trim();
      const q = /^(["'])(.*)\1/.exec(v);
      v = q ? q[2] : v.replace(/\s+#.*$/, '');
      keep(v);
    } else keep(t);
  }
  return [...out];
}

/** The files at `p` (a file, or a folder's files, at most FILES_MAX), as real paths inside `real` (the credentials folder). */
function filesAt(p, real) {
  const out = [];
  const stack = [p];
  while (stack.length && out.length < FILES_MAX) {
    const x = stack.pop();
    let r;
    try {
      r = fs.realpathSync(x);
    } catch {
      continue;
    }
    if (r !== real && !r.startsWith(real + path.sep)) continue;
    let st;
    try {
      st = fs.statSync(r);
    } catch {
      continue;
    }
    if (st.isFile() && st.size <= FILE_MAX) out.push(r);
    else if (st.isDirectory()) {
      try {
        for (const n of fs.readdirSync(r)) if (n !== '.git') stack.push(path.join(r, n));
      } catch {
        /* not readable */
      }
    }
  }
  return out;
}

/** The project folders: the projects folder's, and one level below a folder that is not a project itself (a group). */
async function projectRoots(dir, projects) {
  const seen = new Set();
  const add = (d) => {
    if (fs.existsSync(path.join(d, 'project.json'))) seen.add(d);
  };
  try {
    const { projectsHere } = await import('../workspace/where.mjs');
    for (const f of await projectsHere({ dir, projects })) add(f.dir);
  } catch {
    /* no map: the plain folders below */
  }
  try {
    for (const e of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = path.join(projects, e.name);
      add(d);
    }
  } catch {
    /* no projects folder */
  }
  return [...seen];
}

let cache = { at: 0, key: '', list: [] };

/** The values to hide: those of the files each project.json credential link points at, on this computer. */
export async function credentialValues({ dir = workspaceDir(), projects = projectsIn(), ttl = 3000 } = {}) {
  const key = `${dir}\n${projects}`;
  if (cache.key === key && Date.now() - cache.at < ttl) return cache.list;
  const values = new Set();
  const creds = credsDir(dir);
  let real = null;
  try {
    real = fs.realpathSync(creds);
  } catch {
    /* no credentials folder here */
  }
  if (real) {
    for (const root of await projectRoots(dir, projects)) {
      let targets = [];
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, 'project.json'), 'utf8'));
        const c = m && m.credentials;
        if (c && typeof c === 'object' && !Array.isArray(c)) targets = Object.values(c).filter((t) => typeof t === 'string' && t && !t.includes('..'));
      } catch {
        /* no readable project.json: nothing of it */
      }
      for (const t of targets) {
        for (const f of filesAt(path.join(creds, ...t.split('/')), real)) {
          try {
            for (const v of valuesOfText(fs.readFileSync(f, 'utf8'))) values.add(v);
          } catch {
            /* not readable */
          }
          if (values.size >= VALUES_MAX) break;
        }
      }
    }
  }
  const list = [...values].sort((a, b) => b.length - a.length).slice(0, VALUES_MAX);
  cache = { at: Date.now(), key, list };
  return list;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every value of the credential links' files replaced by one fixed phrase. */
export async function maskValues(text, opts) {
  if (typeof text !== 'string' || !text) return text;
  const values = await credentialValues(opts);
  let out = text;
  for (const v of values) {
    if (out.includes(v)) out = out.split(v).join(HIDDEN);
    // Broken over a line by a narrow terminal: a line end (with its return), and the indent a coding tool puts on the
    // continuation line (spaces, a tab, a box line or a corner mark), between any two characters.
    if (v.length >= 12 && v.length <= WRAP_MAX) {
      const re = new RegExp([...v].map(esc).join('(?:\\r?\\n[ \\t\u2502\u23bf]*)?'), 'g');
      out = out.replace(re, HIDDEN);
    }
  }
  return out;
}

/** For a test: forget what was read. */
export const forgetValues = () => {
  cache = { at: 0, key: '', list: [] };
};
