// The AI brain, read-only, for the dashboard: what the AI knows on this computer.
//   brainIndex()   what there is to read, as plain data (one entry per file, with an id)
//   brainRead(id)  the text of ONE item, addressed by an id from the index (never by a path from the browser)
// Every file goes through guard.mjs when it is listed and again when it is read. What is shown:
//   the global rules: Claude Code's CLAUDE.md (~/.claude or $CLAUDE_CONFIG_DIR) and its rules/ folder
//   the brain:        BRAIN.md, learnings.md, active_context.md, PENDING.md, claude/CLAUDE.md, daily_logs/
//   skills:           Claude Code's skills folder (and the brain's, when it is not the same folder)
//   memory:           the home folder's (Claude Code's memory for work started there) and each project's
//   each project:     AGENTS.md, decisions.md, ai_brain/learnings.md, ai_brain/active_context.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../assistant/secrets.mjs';
import { claudeDir, tilde } from '../paths.mjs';
import { projectsDir as currentProjectsDir } from '../pcsetup/projects.mjs';
import { NAME_RE, validateManifest } from '../pcsetup/workspace.mjs';
import { projectSlug } from '../sessions.mjs';
import { parseFrontMatter } from '../skillhub/frontmatter.mjs';
import { MAX_BYTES, SAFE_NAME, checkFile, listable, readChecked, within } from './guard.mjs';
import { isGitRepo, listProjects, workspaceDir } from './layout.mjs';

const MAX_LIST = 200; // per list; `count` still says how many there are
const ID_RE = /^[a-z-]{1,20}(:[A-Za-z0-9_ ._()+-]{1,151}){0,3}$/;
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const clip = (s, n = 200) => {
  const t = redact(String(s || '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** The first lines of a checked file, for its front matter (never more than 8 KB). */
const head = (abs, root) => {
  try {
    return readChecked(abs, root, 8192).text;
  } catch {
    return '';
  }
};

/**
 * Build the index. → { data (for the page), files: Map(id → { abs, root, title, file }) }. `files` stays on the
 * server: brainRead looks an id up in it, so only what was listed can ever be read.
 */
function collect({ dir = workspaceDir(), base = claudeDir(), home = os.homedir(), projects = currentProjectsDir() } = {}) {
  const files = new Map();
  /** One file item, or null when the guard refuses it or it is not there. */
  const item = (id, title, abs, root, extra = {}) => {
    const c = checkFile(abs, root);
    if (!c.ok) return null;
    const it = { id, title, file: tilde(abs), size: c.size, modified: c.mtime.toISOString(), ...extra };
    files.set(id, { abs, root, title, file: it.file });
    return it;
  };
  /** The .md files of a folder (one level), newest first. */
  const mdFiles = (folder) => listable(folder).filter((d) => /\.(md|markdown|txt)$/i.test(d.name) && (d.isFile() || d.isSymbolicLink()));

  const brain = path.join(dir, 'ai_brain');
  const brainReal = real(brain);
  const inBrain = (p) => Boolean(brainReal && real(p) && within(real(p), brainReal));
  const B = (key, name, title) => (brainReal ? item(`brain:${key}`, title, path.join(brain, name), brain) : null);

  // The global rules: the file Claude Code reads in every project. A link is followed to its one file only.
  const rulesFile = path.join(base, 'CLAUDE.md');
  const rulesReal = real(rulesFile);
  const linked = (() => {
    try {
      return fs.lstatSync(rulesFile).isSymbolicLink();
    } catch {
      return false;
    }
  })();
  const extraRules = path.join(base, 'rules');
  const global = {
    rules: rulesReal ? item('global:rules', 'Rules for every project (CLAUDE.md)', rulesFile, rulesReal) : null,
    linked,
    inBrain: inBrain(rulesFile),
    more: mdFiles(extraRules).map((d) => item(`global:rule:${d.name}`, d.name, path.join(extraRules, d.name), extraRules)).filter(Boolean),
  };

  // Daily logs: newest first (the date in the name, else the time the file changed).
  const logsDir = path.join(brain, 'daily_logs');
  const logs = (brainReal ? mdFiles(logsDir) : [])
    .map((d) => item(`log:${d.name}`, d.name.replace(/\.(md|markdown|txt)$/i, ''), path.join(logsDir, d.name), brain, { date: (/(\d{4}-\d{2}-\d{2})/.exec(d.name) || [])[1] || null }))
    .filter(Boolean)
    .sort((a, b) => (b.date || b.modified).localeCompare(a.date || a.modified));

  // Skills: a folder with a SKILL.md; its name and one-line description from the front matter.
  const skills = [];
  const skillFolders = [{ where: 'claude', folder: path.join(base, 'skills') }];
  const brainSkills = path.join(brain, 'skills');
  if (brainReal && real(brainSkills) && real(brainSkills) !== real(skillFolders[0].folder)) skillFolders.push({ where: 'brain', folder: brainSkills });
  for (const { where, folder } of skillFolders) {
    if (!real(folder)) continue;
    for (const d of listable(folder)) {
      const md = path.join(folder, d.name, 'SKILL.md');
      const fm = parseFrontMatter(head(md, folder));
      const it = item(`skill:${where}:${d.name}`, d.name, md, folder, { where, name: clip(fm.data.name || d.name, 80), description: clip(fm.data.description) });
      if (it) skills.push(it);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  /** One memory folder: one entry per file with name, description and type from its front matter. */
  const memory = (folder, idBase) => {
    if (!real(folder)) return [];
    return mdFiles(folder).map((d) => {
      const abs = path.join(folder, d.name);
      const fm = parseFrontMatter(head(abs, folder)).data;
      const type = typeof fm.type === 'string' ? fm.type : fm.metadata && typeof fm.metadata.type === 'string' ? fm.metadata.type : null;
      return item(`${idBase}:${d.name}`, d.name, abs, folder, { name: clip(fm.name || d.name.replace(/\.md$/i, ''), 80), description: clip(fm.description), type: type ? clip(type, 30) : d.name === 'MEMORY.md' ? 'index' : null });
    }).filter(Boolean).sort((a, b) => (a.type === 'index' ? -1 : b.type === 'index' ? 1 : b.modified.localeCompare(a.modified)));
  };
  const homeMemDir = path.join(base, 'projects', projectSlug(home), 'memory');
  const homeMem = real(homeMemDir) ? homeMemDir : path.join(brain, 'claude-memory', 'home');
  const homeItems = memory(homeMem, 'mem:home');

  // Projects: each parent in the projects folder. Its memory folders: project.json's "memories" (checked by the
  // same validator as everywhere), else ai_brain/claude-memory.
  const projectList = listProjects(projects).filter((p) => p.parent && NAME_RE.test(p.name) && SAFE_NAME.test(p.name)).map((p) => {
    const P = (rel, key, title) => item(`project:${p.name}:${key}`, title, path.join(p.dir, rel), p.dir);
    let mems = ['ai_brain/claude-memory'];
    try {
      const v = validateManifest(JSON.parse(fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8')));
      if (v.ok && Object.keys(v.manifest.memories).length) mems = [...new Set(Object.values(v.manifest.memories))];
    } catch {
      /* no or unreadable project.json: the default folder */
    }
    const mem = mems.flatMap((rel, i) => memory(path.join(p.dir, rel), `pmem:${p.name}:${i}`).map((m) => {
      const f = files.get(m.id);
      const c = checkFile(f.abs, p.dir); // the memory folder must also be inside the project
      if (c.ok) f.root = p.dir;
      else files.delete(m.id);
      return c.ok ? { ...m, folder: rel } : null;
    })).filter(Boolean);
    return {
      name: p.name,
      git: p.git,
      agents: P('AGENTS.md', 'agents', 'AGENTS.md'),
      decisions: P('decisions.md', 'decisions', 'Decisions'),
      learnings: P('ai_brain/learnings.md', 'learnings', 'Learnings'),
      activeContext: P('ai_brain/active_context.md', 'active', 'Active context'),
      memory: { count: mem.length, items: mem.slice(0, MAX_LIST) },
    };
  });

  const data = {
    workspace: { dir, short: tilde(dir) },
    brain: {
      dir: brain,
      short: tilde(brain),
      exists: Boolean(brainReal),
      git: Boolean(brainReal) && isGitRepo(brain),
      about: B('about', 'BRAIN.md', 'About the brain'),
      learnings: B('learnings', 'learnings.md', 'Learnings'),
      activeContext: B('active', 'active_context.md', 'Active context'),
      pending: B('pending', 'PENDING.md', 'Pending'),
      rules: B('rules', 'claude/CLAUDE.md', 'The brain\'s rules for every project'),
    },
    global,
    dailyLogs: { count: logs.length, items: logs.slice(0, MAX_LIST) },
    skills: { count: skills.length, items: skills.slice(0, MAX_LIST) },
    memory: { home: { dir: tilde(homeMem), linked: homeMem === homeMemDir && inBrain(homeMemDir), count: homeItems.length, items: homeItems.slice(0, MAX_LIST) } },
    projects: projectList,
    limits: { maxBytes: MAX_BYTES },
  };
  // Only what is in `data` may be read: drop ids that were listed past a cap.
  const shown = new Set();
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.id === 'string') shown.add(v.id);
      Object.values(v).forEach(walk);
    }
  };
  walk(data);
  for (const id of [...files.keys()]) if (!shown.has(id)) files.delete(id);
  return { data, files };
}

/** What there is to read. */
export function brainIndex(opts = {}) {
  return collect(opts).data;
}

/** The text of one item from the index. → { id, title, file, text, size, cut, masked, modified } */
export function brainRead(id, opts = {}) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw Object.assign(new Error('no such item'), { status: 400 });
  const f = collect(opts).files.get(id);
  if (!f) throw Object.assign(new Error('no such item'), { status: 404 });
  const r = readChecked(f.abs, f.root);
  return { id, title: f.title, file: f.file, text: r.text, size: r.size, cut: r.cut, masked: r.masked, modified: r.mtime.toISOString() };
}
