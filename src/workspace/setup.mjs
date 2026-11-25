// `hoprig workspace setup`: create only what is missing of the tree (layout.mjs). A folder or file that exists is
// never moved, renamed, overwritten or "fixed"; it is reported. Claude Code's own folder (~/.claude) is never
// touched here: linking it into the brain is the separate, explicit `workspace link` (link.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tilde } from '../paths.mjs';
import { initRepo } from '../pcsetup/workspace.mjs';
import { leaves, leavesWords, mkdirIn, myLinkCommand, writeIn } from './inside.mjs';
import { capture, showCommands } from '../setup/system.mjs';
import { TREE, isDir, workspaceStatus } from './layout.mjs';

const RULES_TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'working-rules.md');

export const CREDENTIALS_README = `# Credentials

Keys and passwords for local work, one folder per project. This folder is never put in git, and only you can
open it (owner-only permissions). Projects reach a file here through a link (for example their \`.env.local\`).
AI tools may use these files, but must never print, log or paste a value.
`;

/** The brain's starting files (only written when there is no brain at all). Paths are relative to ai_brain/. */
export function brainScaffold(rules = fs.readFileSync(RULES_TEMPLATE, 'utf8')) {
  return {
    'BRAIN.md': `# AI brain

The AI knowledge shared by all your projects, kept in its own private git repository so every computer gets
the same:

- \`claude/CLAUDE.md\`       the rules Claude Code gets in every project (\`hoprig workspace link\` links
                             Claude Code's global rules file to it)
- \`skills/\`                skills for every project (linked as Claude Code's skills folder)
- \`claude-memory/home/\`    Claude Code's memory for work started in the home folder
- \`learnings.md\`           what was learned the hard way, one line each
- \`active_context.md\`      what is being worked on now
- \`daily_logs/\`            one file per day (YYYY-MM-DD.md)
- \`scripts/\`               your own helper scripts

A project's own memory lives in that project's parent repository (\`projects/<project>/ai_brain/\`), never here.
Keys and passwords never go here: they stay in \`credentials/\`.
`,
    'learnings.md': '# Learnings\n\nWhat we learned the hard way, one line each.\n',
    'active_context.md': '# Active context\n\nWhat is being worked on now.\n',
    'daily_logs/.gitkeep': '',
    'claude-memory/home/.gitkeep': '',
    'skills/.gitkeep': '',
    'scripts/.gitkeep': '',
    'claude/CLAUDE.md': rules,
    '.gitignore': '.env\n.env.*\n*.pem\n*.key\ncredentials/\n.DS_Store\n',
  };
}

const empty = (d) => {
  try {
    return fs.readdirSync(d).length === 0;
  } catch {
    return false;
  }
};

/**
 * Create what is missing. → { dir, dryRun, did: [{ path, what }], left: [{ path, why }], git: { done, why? } | null }
 * `did` lists what was (or, with dryRun, would be) created; `left` what exists and was left as it is.
 */
export async function workspaceSetup({ dryRun = false, cfg, projectsDir, run = capture, platform = process.platform, only = null } = {}) {
  const st = workspaceStatus({ cfg, projectsDir, platform });
  const did = [];
  const left = [];
  // `only`: one folder of the tree (setUpFolder below); a workspace that is not set up is left to the whole set-up.
  if (only && !st.exists) return { dir: st.dir, dryRun, did, left: [{ path: st.short, why: 'the workspace is not set up on this computer yet: nothing was made' }], git: null };
  // Every folder and file is made inside the workspace, never through a link (inside.mjs). A folder of the tree that
  // is a link (the owner's database folder on another disk) is not followed and never stops the rest: it is named,
  // with the command that names it as his own, and setup goes on.
  const at = { root: st.dir, dir: st.dir };
  const notFollowed = (p, b) => left.push({ path: tilde(p), why: `${leavesWords(b)}: not followed; if that link is yours:  ${myLinkCommand(b.path)}` });
  const make = (p, what, fn) => {
    const b = leaves(st.dir, p, at);
    if (b) return (notFollowed(p, b), false);
    did.push({ path: tilde(p), what });
    if (dryRun) return true;
    try {
      fn();
    } catch (e) {
      if (e.code !== 'ELEAVES') throw e;
      did.pop(); // it became a link between the look and the act
      notFollowed(p, e.leaves);
      return false;
    }
    return true;
  };
  if (!st.exists) {
    if (fs.existsSync(st.dir)) return { dir: st.dir, dryRun, did, left: [{ path: st.short, why: 'a file is in the way: nothing was created' }], git: null };
    make(st.dir, 'the workspace folder', () => fs.mkdirSync(st.dir, { recursive: true })); // the workspace itself: the owner's own folder
  }
  let brainMade = false;
  for (const f of TREE) {
    if (only && f.id !== only) continue;
    const p = path.join(st.dir, f.rel);
    const s = st.folders.find((x) => x.id === f.id);
    if (f.id === 'projects' && !st.projectsInWorkspace && !s.exists) {
      left.push({ path: tilde(p), why: `not made: your projects stay in ${st.projectsShort}` });
      continue;
    }
    if (f.id === 'ai_brain' && (!s.exists || (s.kind === 'folder' && empty(p)))) {
      brainMade = make(p, 'the AI brain: BRAIN.md, learnings, current context, daily logs, home memory, skills, scripts, claude/CLAUDE.md', () => {
        for (const [rel, text] of Object.entries(brainScaffold())) {
          const file = path.join(p, rel);
          mkdirIn(at, path.dirname(file));
          writeIn(at, file, text, { excl: true });
        }
      });
      continue;
    }
    if (s.exists || s.kind !== 'missing') {
      left.push({ path: tilde(p), why: s.exists ? 'already there' : s.warning });
      continue;
    }
    if (f.id === 'credentials') {
      make(p, 'credentials, only you can open it, with a short README', () => {
        mkdirIn(at, p, { mode: 0o700 }); // exactly 0700, whatever the umask
        writeIn(at, path.join(p, 'README.md'), CREDENTIALS_README, { excl: true, mode: 0o600 });
      });
      continue;
    }
    make(p, f.rel, () => mkdirIn(at, p, f.mode === undefined ? {} : { mode: f.mode }));
  }
  let git = null;
  if (brainMade) git = await brainGit(path.join(st.dir, 'ai_brain'), { dryRun, run, ws: st.dir });
  return { dir: st.dir, dryRun, did, left, git };
}

/**
 * Make one folder of the tree when it is missing, exactly as set-up does (a kit's own folder: database/mysql with
 * MariaDB). Nothing that is there is touched, nothing is put inside it. → the same as workspaceSetup.
 */
export const setUpFolder = (id, o = {}) => workspaceSetup({ ...o, only: id });

/** git init and a first commit for a new brain, only when git knows a name and an e-mail (a commit needs them). */
async function brainGit(dir, { dryRun, run, ws }) {
  const who = await Promise.all(['user.name', 'user.email'].map((k) => run(['git', 'config', '--get', k], { timeout: 10_000, cwd: os.tmpdir() }).then((r) => (r.ok ? (r.stdout || '').trim() : ''), () => '')));
  const steps = showCommands([['git', '-C', dir, 'init', '-b', 'main'], ['git', '-C', dir, 'add', '-A'], ['git', '-C', dir, 'commit', '-m', 'Start the AI brain']]);
  if (!who[0] || !who[1]) return { done: false, needsIdentity: true, steps, why: `git does not know your name and e-mail yet: set them (git config --global user.name / user.email), then: ${steps}` };
  if (dryRun) return { done: false, why: 'dry run: would run git init and make a first commit' };
  if (!isDir(dir)) return { done: false, why: 'no brain folder' };
  const r = await initRepo(dir, 'Start the AI brain', run, { root: dir, dir: ws });
  return r.ok ? { done: true } : { done: false, why: r.error };
}
