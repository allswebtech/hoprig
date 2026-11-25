// One way to delete a conversation, by construction (read from the sources): the functions that move or remove a
// conversation's files are those of ONE module, the trash (src/chat/trash.mjs); only the delete routes
// (src/chat/deletes.mjs) put one into it; every page that offers Delete goes through web/chat/deletes.js. So the trash,
// its journal and the rule that a conversation someone else writes is never moved hold everywhere.
//
// The rule: a file under src/ that can touch the disk (it imports node:fs, node:fs/promises or node:child_process) AND
// names where conversations are is one of a CLOSED list below, each with what it does there. A new such file fails,
// however it would move a file. A listed file has no move or remove name in its code (comments and sentences in
// strings left out) beyond the ones named for it.
//
// What this still cannot see: a file that reaches the disk through another module of ours (a helper that wraps fs or
// starts programs) instead of importing it; a function that is handed a conversation's path by its caller and so never
// names the folder; a name made at run time (`fs['re' + 'name']`, a name read from data); the folder reached through
// the environment (CLAUDE_CONFIG_DIR read by hand) without claudeDir(). Those are left to review.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Every file with extension `ext` under `dir` of the repository: [relative path, text]. */
function sources(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith(ext) || /vendor/.test(e.parentPath ?? e.path)) continue;
    const full = path.join(e.parentPath ?? e.path, e.name);
    out.push([path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]);
  }
  return out;
}

/**
 * The code of `text`: comments blanked (lines kept), a string literal kept only when it is one word (a name such as
 * 'renameSync' or 'mv' stays visible), else made empty; a template's ${…} parts stay code.
 */
export function codeOf(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  const literal = (q) => {
    let j = i + 1;
    let body = '';
    let code = '';
    while (j < n && text[j] !== q) {
      if (text[j] === '\\') {
        body += text.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (q === '`' && text[j] === '$' && text[j + 1] === '{') {
        let depth = 1;
        let k = j + 2;
        while (k < n && depth) {
          if (text[k] === '{') depth++;
          else if (text[k] === '}') depth--;
          k++;
        }
        code += ` ${codeOf(text.slice(j + 2, k - 1))} `;
        body += ' ';
        j = k;
        continue;
      }
      if (text[j] === '\n' && q !== '`') break;
      body += text[j++];
    }
    const lines = text.slice(i, j + 1).split('\n').length - 1; // keep the line count of a template over several lines
    i = j + 1;
    return (/^[\w$.-]+$/.test(body) ? `'${body}'` : "''") + code + '\n'.repeat(lines);
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const e = text.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      out += text.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      out += literal(c);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Can touch the disk: imports node:fs, node:fs/promises or node:child_process (also without "node:", by require or import()).
const DISK = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*)['"](?:node:)?(?:fs|fs\/promises|child_process)['"]/;
// Names where conversations are: the functions that give their folder or files, a chat's or the engine's file(), or
// Claude Code's folder and "projects" anywhere in the same file (also apart: `const base = claudeDir(); … 'projects'`).
const FOLDER = /\b(?:projectDir|projectsRoot|conversationFiles|sessionsIn)\b|\b(?:chat|c|this|engine|claude)\.file\(/;
export const namesTheFolder = (text) => FOLDER.test(text) || (/\bclaudeDir\b/.test(text) && /['"`/]projects['"`/]/.test(text));
// A name that moves or removes a file, however it is reached (fs.x, fs.x?.(), fs['x'], const y = fs.x, an import of
// it, a program of that name started from the file).
const MOVE = /(?<![\w$])(?:rename|rm|unlink|rmdir|cp|copyFile|mv)(?:Sync)?(?![\w$])/;

// THE CLOSED LIST: each file that can touch the disk and names where conversations are, with what it does there and
// the move or remove names of its code that are not of a conversation (each line must match one of them).
const KNOWN = {
  'src/chat/trash.mjs': { why: 'THE one module that moves and removes a conversation\'s files', any: true },
  'src/chat/deletes.mjs': { why: 'the delete routes: they hand a conversation to the trash' },
  'src/sessions.mjs': { why: 'reads the conversations of a folder and their titles; copySessions copies them under another folder\'s key, never over a file that is there, and the old ones stay', not: [/^\s*fs\.copyFileSync\(a, b, fs\.constants\.COPYFILE_EXCL\);$/] }, // a copy, not a move: nothing of the old folder goes
  'src/adopt/apply.mjs': { why: 'adopt apply: the coding tool\'s memory and conversations of an old folder are copied (copySessions, mergeInto); it moves and removes none', not: [/^\s*if \((?:rec && )?readMarker\(marker\)\?\.token === (?:rec\.)?token\) fs\.rmSync\(marker, \{ force: true \}\);$/, /^\s*fs\.cpSync\(c\.from, c\.to, \{ recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false \}\);$/, /^\s*fs\.rmSync\(path\.join\(root, RUN_TOKEN\), \{ force: true \}\);$/, /^\s*fs\.rmSync\(tmp, \{ force: true \}\);$/] }, // its run's marker, the plan's copies of repositories and neighbours, the run's token, the marker's temporary file
  'src/adopt/cli.mjs': { why: 'adopt plan: names Claude Code\'s folder so the plan can count its conversations (reads)' },
  'src/chat/reading.mjs': { why: 'reads a chat\'s conversation' },
  'src/chat/feature.mjs': { why: 'the open chats\' record', not: [/fs\.renameSync\(tmp, file\(\)\)/] }, // chats.json, written whole
  'src/chat/engines/claude.mjs': { why: 'starts Claude Code on a conversation', not: [/fs\.rmSync\(this\.settingsFile, \{ force: true \}\)/, /^\s*rename\(title\) \{/, /\brename: true\b/] }, // its per-process settings file; the conversation's name told to the tool
  'src/chat/engines/claude-transcript.mjs': { why: 'reads a transcript' },
  'src/menu.mjs': { why: 'lists the conversations to continue' },
  'src/work/sessionlog.mjs': { why: 'reads a session\'s conversation for its title, for the history; it moves and removes nothing there', not: [/fs\.renameSync\(tmp, file\)/] }, // its own log, written whole
  'src/demo/work.mjs': { why: 'the demo: writes one made-up conversation with its helpers\' records under the demo\'s own home (who did what); it moves and removes nothing' },
  'src/work/pulsefiles.mjs': { why: 'reads the coding tool\'s workflow records beside a conversation, for progress; it moves and removes nothing' },
  'src/models/parts.mjs': { why: 'reads the helpers\' records beside a Lead chat\'s conversation, for who did what; it moves and removes nothing' },
  'src/codetools/stores.mjs': { why: 'reads each coding tool\'s conversations' },
  'src/operator/sources.mjs': { why: 'reads a run\'s conversation for the Operator' },
  'src/server/deck.mjs': { why: 'finds a terminal session\'s conversation file' },
  'src/providers/transcripts.mjs': { why: 'reads the coding tool\'s records of sessions Hoprig did not start, for the Operator; it moves and removes nothing there', not: [/fs\.renameSync\(tmp, file\(\)\)/] }, // its own kept list of conversation ids, replaced whole (state/operator/conversations.json)
  'src/server/folders.mjs': { why: 'lists a folder\'s conversations' },
  'src/server/server.mjs': { why: 'lists conversations for the routes', not: [/backend\.rename\(name, b\.name\)/] }, // a terminal session's name (tmux)
  'src/work/alone.mjs': { why: 'a project folder of its own (its own projectDir)', not: [/fs\.renameSync\(tmp, waitFile\(\)\)/] }, // its wait record
  'src/workspace/brain.mjs': { why: 'reads where Claude Code keeps the home\'s memory' },
  'src/workspace/dropfind.mjs': { why: 'finds what Claude Code keeps of a project before a drop (reads)' },
  'src/workspace/link.mjs': { why: 'links Claude Code\'s memory folder of a project to the brain', not: [/fs\.copyFileSync\(p\.link, backup/, /fs\.rmSync\(''\s*p\.link\s*, \{ force: true \}\)/, /fs\.renameSync\(''\s*p\.link\s*, p\.link\)/, /fs\.renameSync\(p\.link, backup\)/, /fs\.renameSync\(backup, p\.link\)/] }, // the memory link, never a conversation
  'src/pcsetup/workspace.mjs': { why: 'checks the memory links of the workspace', not: [/showCommand\(\['rm', link\]\)/, /fs\.renameSync\(link, backup\)/] }, // a command shown, not run; a memory link kept aside
  'src/setup/moveplan.mjs': { why: 'the look of the move to an ordinary user: counts what Claude Code\'s folder holds before it is copied (reads); the copy keeps root\'s conversations and never moves or removes one' },
  'src/pcsetup/wsrules.mjs': { why: 'writes Claude Code\'s rules file', not: [/fs\.rmSync\(tmp, \{ force: true \}\)/, /fs\.renameSync\(tmp, s\.file\)/] }, // the rules file, replaced whole
};

/** The files of `files` ([path, text]) that can touch the disk and name where conversations are. */
export const touchers = (files) => files.filter(([, t]) => DISK.test(t) && namesTheFolder(t)).map(([f]) => f);
/** Lines of `text` (a listed file `f`) with a move or remove name that is not named for it: ["f:line: code"]. */
export function moversIn(f, text, known = KNOWN) {
  const k = known[f] || {};
  if (k.any) return [];
  const found = [];
  codeOf(text).split('\n').forEach((line, n) => {
    if (!MOVE.test(line) || (k.not || []).some((re) => re.test(line))) return;
    found.push(`${f}:${n + 1}: ${line.trim()}`);
  });
  return found;
}

test('only the trash moves a conversation: a file that can touch the disk and names where conversations are is on the closed list', () => {
  const now = touchers(sources('src', '.mjs')).sort();
  const extra = now.filter((f) => !KNOWN[f]);
  assert.deepEqual(extra, [], 'a new file touches the disk where conversations are: move or remove a conversation only through src/chat/trash.mjs, or add the file to KNOWN with what it does there');
  const gone = Object.keys(KNOWN).filter((f) => !now.includes(f));
  assert.deepEqual(gone, [], 'a listed file no longer touches the disk there (or was renamed): take it off the list');
  const trash = fs.readFileSync(path.join(root, 'src/chat/trash.mjs'), 'utf8');
  assert.match(trash, /function move\(from, to\)/, 'the trash\'s one move');
});

test('a listed file moves or removes nothing but what is named for it', () => {
  const found = [];
  for (const f of Object.keys(KNOWN)) found.push(...moversIn(f, fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(found, [], 'a move or remove in a file that knows where conversations are: give it to the trash');
});

test('the rule catches a second mover however it is written: in a new file, and in a listed one', () => {
  const where = "import fs from 'node:fs';\nimport { conversationFiles } from '../sessions.mjs';\n";
  const cases = {
    'an import renamed with as': "import { rename as moveIt } from 'node:fs/promises';\nawait moveIt(a, b);",
    'fs.promises': 'await fs.promises.rename(a, b);',
    'a destructuring of fs': 'const { rmSync: gone } = fs;\ngone(a);',
    'a copy': 'fs.copyFileSync(a, b);',
    'through .call': 'fs.renameSync.call(fs, a, b);',
    'a program that moves it': "execFileSync('mv', [a, b]);",
    // the four the second look found past the earlier text check
    'Claude Code\'s folder and "projects" apart': "const base = claudeDir();\nfs.rmSync(path.join(base, 'projects', slug, id + '.jsonl'));",
    'an optional call': 'fs.rmSync?.(conversationFiles(d, id)[0]);',
    'a name taken without a call': 'const del = fs.unlinkSync;\ndel(a);',
    'a name in brackets': "fs['renameSync'](a, b);",
  };
  for (const [what, code] of Object.entries(cases)) {
    const text = (what.includes('apart') ? "import fs from 'node:fs';\nimport { claudeDir } from '../paths.mjs';\n" : where) + code;
    assert.deepEqual(touchers([['src/chat/x.mjs', text]]), ['src/chat/x.mjs'], `a new file: ${what}`);
    assert.notDeepEqual(moversIn('src/sessions.mjs', `${fs.readFileSync(path.join(root, 'src/sessions.mjs'), 'utf8')}\n${code}`), [], `in a listed file: ${what}`);
  }
  // Words are not moves, and Claude Code's other files are not where conversations are.
  assert.deepEqual(moversIn('src/sessions.mjs', "const t = 'rename the conversation';\n// fs.rmSync(x)\n/* fs.renameSync(a, b) */"), []);
  assert.ok(!namesTheFolder("const f = path.join(claudeDir(), 'settings.json');"));
  assert.deepEqual(touchers([['src/x.mjs', "import { conversationFiles } from '../sessions.mjs';\nexport const n = 1;"]]), [], 'naming without the disk is not touching it');
});

test('only the delete routes put a conversation into the trash', () => {
  const users = sources('src', '.mjs').filter(([, t]) => /\bbin\.put\(|from '\.\/trash\.mjs'|from '\.\.\/chat\/trash\.mjs'/.test(t)).map(([f]) => f);
  for (const f of users) assert.ok(['src/chat/deletes.mjs', 'src/chat/feature.mjs'].includes(f), `${f} reaches the trash; only deletes.mjs (and the feature that starts it) may`);
});

test('every page that deletes a conversation goes through web/chat/deletes.js: one place asks the delete route', () => {
  const ask = sources('web', '.js').filter(([, t]) => t.includes('/api/chats/delete')).map(([f]) => f);
  assert.deepEqual(ask, ['web/chat/deletes.js'], 'a second page asks the delete route by itself');
  const via = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['web/chat/sheets.js', 'web/session.js', 'web/projects.js']) {
    assert.match(via(f), /deleteConversation\(/, `${f}: Delete of an ended conversation through deleteConversation`);
    assert.match(via(f), /import \{[^}]*\bdeleteConversation\b[^}]*\} from '\.\/(chat\/)?deletes\.js'/, `${f} imports it`);
  }
});
