// A throw-away workspace for the needs tests: a map of version 2 with a plain group `kits` holding the project
// `parts`, the project `shop` in the projects folder that needs `kits/parts`, a project only in the map (`docs`), a
// group that is a repository (`tools`), and a credentials folder. Nothing in it is a real repository: the needs only
// read the map, project.json files and the disk. `accept`: the owner's yes on this computer for the needs as named
// (Hoprig's own settings, needsyes.mjs); false: a project.json nobody here has said yes to.
import fs from 'node:fs';
import path from 'node:path';
import { tempHome, writeTree } from './helpers.mjs';

export const url = (n) => `https://git.example.test/team/${n}.git`;

/** Write the owner's yes for these needs into this home's settings, keeping what is there: { project: [need] }. */
export function acceptAll(byProject) {
  const f = path.join(process.env.HOPRIG_CONFIG_DIR, 'config.json');
  let cur = {};
  try {
    cur = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    /* none yet */
  }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ...cur, acceptedNeeds: { ...(cur.acceptedNeeds || {}), ...byProject } }));
}

export function needsWorld(name = 'needs', { shopNeeds = ['kits/parts'], partsNeeds = [], accept = true } = {}) {
  const h = tempHome(name);
  const ws = h.ws;
  const projects = path.join(ws, 'projects');
  const map = {
    version: 2,
    brain: { url: url('brain') },
    groups: [{ dir: 'kits' }, { dir: 'tools', url: url('tools') }],
    projects: [
      { name: 'shop', url: url('shop'), repos: [] },
      { name: 'parts', in: 'kits', url: url('parts'), repos: [] },
      { name: 'docs', url: url('docs'), repos: [] },
      { name: 'blog', url: url('blog'), repos: [] },
    ],
    others: [],
  };
  writeTree(ws, {
    'ai_brain/workspace.json': JSON.stringify(map, null, 2),
    'credentials/shop/key.txt': 'SECRET-PLUM\n',
    'projects/shop/project.json': JSON.stringify({ name: 'shop', repos: [], memories: {}, needs: shopNeeds }),
    'projects/shop/README.md': 'shop\n',
    'projects/blog/README.md': 'blog\n',
    'kits/parts/project.json': JSON.stringify({ name: 'parts', repos: [], memories: {}, needs: partsNeeds, credentials: { '.env': 'shop/key.txt' } }),
    'kits/parts/README.md': 'parts readme: blue-falcon\n',
    'kits/parts/ai-ignore-dir/secret.txt': 'private-note: red-otter\n',
    'kits/parts/hidden/x.txt': 'hidden: green-lynx\n',
    'kits/parts/.claude/settings.json': JSON.stringify({ permissions: { deny: ['Read(./hidden/**)', 'Bash(curl:*)'], allow: ['Edit(**)', 'Bash(rm:*)'] } }),
    'kits/parts/.claude/settings.local.json': JSON.stringify({ permissions: { deny: ['Read(notes.txt)'] } }),
  });
  fs.symlinkSync(path.join(ws, 'credentials', 'shop', 'key.txt'), path.join(ws, 'kits', 'parts', '.env'));
  fs.mkdirSync(path.join(ws, 'kits', 'parts', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'credentials', 'parts'), { recursive: true });
  fs.symlinkSync(path.join(ws, 'credentials', 'parts'), path.join(ws, 'kits', 'parts', 'deep', 'keys')); // a folder of its own credentials
  if (accept) acceptAll({ shop: shopNeeds, 'kits/parts': partsNeeds });
  const ctx = { dir: ws, projects };
  // On Windows a folder a process just ended in (a dashboard's session, a chat's stand-in) stays held for a moment:
  // the home is removed with retries there (models/partneeds failed with EPERM on rm right after the dashboard closed).
  const cleanup = process.platform === 'win32' ? () => fs.rmSync(h.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) : h.cleanup;
  return { ...h, cleanup, ws, projects, ctx, map, shop: path.join(projects, 'shop'), parts: path.join(ws, 'kits', 'parts') };
}
