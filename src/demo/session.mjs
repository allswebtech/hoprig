#!/usr/bin/env node
// The demo's stand-in for Claude Code (`hoprig demo`): a program that looks like a Claude Code session in a
// terminal — a prompt, tool lines, a diff, a result — and keeps a run record like the real launcher, so the
// dashboard shows it as working, waiting, needing an OK or at a limit. It talks to no model and costs nothing.
//
// Called like the launcher: session.mjs <account> [--resume <id> | --session-id <id>] …   The folder's name picks the story
// (STORIES below); a message typed into it gets a short scripted answer. All names, paths and projects are
// made up.
import crypto from 'node:crypto';
import path from 'node:path';
import { createRun, removeRun, updateRun } from '../runs.mjs';
import { applyLaunch } from '../launchfile.mjs';
import { readProfile } from '../profiles.mjs';

applyLaunch(); // started by the demo dashboard as the real launcher is: `--launch <file>` (../launchfile.mjs)

const [account = 'max', ...argv] = process.argv.slice(2);
// A first message comes last, after "--" (server/deck.mjs promptArgs), as Claude Code takes it: the session works on it
// at once. The flags are only what stands before it, so a message never reads as one.
const dash = argv.indexOf('--');
const args = dash < 0 ? argv : argv.slice(0, dash);
const firstMessage = dash < 0 ? '' : argv.slice(dash + 1).join(' ').trim();
// A session that moved to another provider comes with its id: --resume, or --session-id from a dashboard that
// finds no conversation on disk (this stand-in keeps none). Either way the demo's story goes on, it does not restart.
const idFlag = ['--resume', '--session-id'].find((f) => args.includes(f));
const resumed = Boolean(idFlag);
const folder = path.basename(process.cwd());
const id = (s) => crypto.createHash('sha256').update(s).digest('hex').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*/, '$1-$2-4$3-a$4-$5');
const sessionId = resumed ? args[args.indexOf(idFlag) + 1] : id(`demo:${folder}`);

// ---------- drawing, the way Claude Code looks ----------
const E = '\x1b[';
const c = {
  dim: (s) => `${E}2m${s}${E}22m`, bold: (s) => `${E}1m${s}${E}22m`,
  orange: (s) => `${E}38;2;215;119;87m${s}${E}39m`, green: (s) => `${E}38;2;78;186;101m${s}${E}39m`,
  red: (s) => `${E}38;2;255;107;128m${s}${E}39m`, grey: (s) => `${E}38;2;153;153;153m${s}${E}39m`,
  addBg: (s) => `${E}48;2;2;40;0m${s}${E}49m`, delBg: (s) => `${E}48;2;61;1;0m${s}${E}49m`, blue: (s) => `${E}38;2;177;185;249m${s}${E}39m`,
};
const w = (s = '') => process.stdout.write(`${s}\r\n`);
// Narrow enough for a phone: a box drawn wider than the screen breaks into pieces when the terminal narrows.
const cols = () => Math.max(30, Math.min(process.stdout.columns || 46, 46));
const box = (lines) => {
  const width = cols() - 2;
  w(c.grey(`╭${'─'.repeat(width - 2)}╮`));
  for (const l of lines) w(`${c.grey('│')} ${l}${' '.repeat(Math.max(0, width - 4 - l.replace(/\x1b\[[0-9;]*m/g, '').length))} ${c.grey('│')}`);
  w(c.grey(`╰${'─'.repeat(width - 2)}╯`));
};
const header = () => {
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H'); // a clean screen: nothing of the shell that started us stays visible
  box([`${c.orange('✻')} ${c.bold('Welcome to Claude Code')}`, '', c.dim('  /help for help'), '', c.dim(`  cwd: ~/Workspace/projects/${folder}`)]);
  w();
};
const user = (t) => { w(`${c.grey('>')} ${t}`); w(); };
const tool = (name, arg, result) => { w(`${c.green('⏺')} ${c.bold(name)}(${arg})`); if (result) w(`  ${c.grey('⎿')}  ${c.dim(result)}`); w(); };
const say = (t) => { w(`${c.blue('⏺')} ${t}`); w(); };
const diff = (file, lines) => {
  w(`${c.green('⏺')} ${c.bold('Update')}(${file})`);
  w(`  ${c.grey('⎿')}  ${c.dim(`Updated ${file} with ${lines.filter((l) => l[0] === '+').length} additions and ${lines.filter((l) => l[0] === '-').length} removals`)}`);
  lines.forEach((l, i) => {
    const n = String(40 + i).padStart(6);
    if (l[0] === '+') w(`  ${c.addBg(`${n} + ${l.slice(1)}`)}`);
    else if (l[0] === '-') w(`  ${c.delBg(`${n} - ${l.slice(1)}`)}`);
    else w(`  ${c.dim(`${n}   ${l}`)}`);
  });
  w();
};
// Claude Code's permission dialog as 2.1.326 draws it (test/server/fixtures/claude-screens/perm-bash-46.txt): a rule
// the full width, the tool, the model's description, the command in a dashed frame, the question, the answers (one
// that does not fit wraps six spaces deep), the footer. The dashboard reads it from the screen (server/prompts.mjs).
const dialog = ({ tool: name, about, command, answers }) => {
  const width = cols();
  w(c.grey('─'.repeat(width)));
  w(` ${c.bold(name)}`);
  w(` ${c.dim(about)}`);
  w(c.grey('╌'.repeat(width)));
  w(` ${command}`);
  w(c.grey('╌'.repeat(width)));
  w(' Do you want to proceed?');
  answers.forEach((text, i) => {
    const lines = [];
    for (const word of text.split(' ')) {
      if (lines.length && `${lines.at(-1)} ${word}`.length <= width - 6) lines[lines.length - 1] += ` ${word}`;
      else lines.push(word);
    }
    w(` ${i === 0 ? c.blue('❯') : ' '} ${i + 1}. ${lines[0]}`);
    for (const more of lines.slice(1)) w(`      ${more}`);
  });
  w();
  w(` ${c.dim('Esc to cancel · Tab to amend')}`);
};
const promptBox = (hint = '? for shortcuts') => {
  box([`${c.grey('>')} `]);
  w(`  ${c.dim(hint)}`);
};

// ---------- the run record the dashboard reads ----------
const { file } = createRun({ profile: account, cwd: process.cwd(), carryArgs: [] });
const set = (patch) => updateRun(file, patch);
set({ sessionId, status: 'starting' });
const bye = () => {
  removeRun(file);
  process.exit(0);
};
process.on('SIGHUP', bye);
process.on('SIGTERM', bye);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- stories, one per demo folder ----------
const STORIES = {
  // Working, with output flowing until a message arrives.
  'shop-frontend': async () => {
    user('Make the cart page work on small screens and add tests for the totals');
    tool('Read', 'src/cart/CartPage.tsx', 'Read 212 lines');
    tool('Grep', 'pattern: "formatPrice"', 'Found 9 matches in 4 files');
    diff('src/cart/CartPage.tsx', [' <div className="cart">', '-  <table className="cart-items">', '+  <ul className="cart-items" role="list">', '+    {items.map((item) => <CartRow key={item.id} item={item} />)}', '+  </ul>', ' </div>']);
    set({ status: 'working', lastMessage: 'Rewriting the cart table as a list so it fits on phones; tests next.' });
    const steps = [
      ['Bash', 'npm test -- cart', 'PASS  src/cart/totals.test.ts (14 tests)'],
      ['Write', 'src/cart/CartRow.tsx', 'Wrote 58 lines'],
      ['Bash', 'npx tsc --noEmit', 'No errors'],
      ['Edit', 'src/cart/totals.ts', 'Rounded line totals before summing'],
      ['Bash', 'npm run lint', '0 problems'],
    ];
    for (let i = 0; !busyMessage; i = (i + 1) % steps.length) {
      w(`${c.orange('✻')} ${c.dim(`Working… (${12 + i * 7}s · esc to interrupt)`)}`);
      await sleep(1800);
      process.stdout.write(`${E}1A${E}2K\r`);
      tool(...steps[i]);
    }
  },
  // Waiting for you, with a realistic last message.
  'api-server': async () => {
    user('Add rate limiting to the orders API');
    tool('Read', 'src/routes/orders.js', 'Read 148 lines');
    tool('Write', 'src/middleware/rateLimit.js', 'Wrote 41 lines');
    diff('src/routes/orders.js', [" const router = express.Router();", "+router.use(rateLimit({ perMinute: 100, key: (req) => req.apiKey }));", " router.get('/', listOrders);"]);
    tool('Bash', 'npm test', 'Tests: 48 passed, 48 total');
    const msg = 'Added rate limiting to /api/orders (100 requests a minute per API key) and 6 tests; all 48 pass. Should I apply the same limit to /api/cart?';
    say(msg);
    set({ status: 'waiting', lastMessage: msg });
  },
  // Needs your OK: a permission question on screen, answered with its number or Esc, as in Claude Code; the record
  // says what the hook would (hook.mjs: who asks, for what), so the dashboard's Allow works here too.
  'mobile-app': async () => {
    user('Add the chart to the stats screen');
    tool('Read', 'app/screens/Stats.tsx', 'Read 96 lines');
    say('The chart needs one new package.');
    const command = 'npm install react-native-svg@15.8.0';
    dialog({ tool: 'Bash command', about: 'Add the SVG library the chart needs', command, answers: ['Yes', 'Yes, and don\'t ask again for npm install commands', 'No'] });
    const note = `Claude needs your permission to use Bash: ${command}`;
    const at = Date.now();
    set({ status: 'attention', note, attentionKind: 'permission_prompt', askType: 'permission', askWhat: command, asks: ['main'], askers: { main: { type: 'permission', note, kind: 'permission_prompt', at, what: command } }, askAt: at, lastMessage: 'The chart needs one new package.' });
    const key = await keyFor(['1', '2', '\x1b']);
    const done = { asks: [], askers: {}, askType: null, askWhat: '', note: '', attentionKind: null };
    if (key === '\x1b') {
      w(`  ${c.grey('⎿')}  ${c.dim('Interrupted · What should Claude do instead?')}`);
      w();
      set({ ...done, status: 'waiting', lastMessage: 'Waiting: the package was not installed.' });
      return;
    }
    set({ ...done, status: 'working' });
    tool('Bash', command, 'added 1 package in 2s');
    await sleep(600);
    const msg = 'Installed react-native-svg and added the weekly chart to the stats screen.';
    say(msg);
    set({ status: 'waiting', lastMessage: msg });
  },
  // At a usage limit: the account ran out, the session waits for another one.
  'docs-site': async () => {
    user('Rewrite the getting-started guide for the new install script');
    tool('Read', 'docs/getting-started.md', 'Read 310 lines');
    diff('docs/getting-started.md', ['## Install', '-Download the zip and unpack it.', '+Run one command:', '+', '+    curl -fsSL https://example.com/install.sh | sh']);
    w(`  ${c.grey('⎿')}  ${c.red("You've hit your 5-hour limit · resets 6pm")}`);
    w(`     ${c.dim('/upgrade to increase your usage limit.')}`);
    w();
    set({ status: 'waiting', lastMessage: 'Halfway through the guide: the install section is done.', limit: { at: Date.now(), error: "You've hit your 5-hour limit · resets 6pm" } });
  },
  // Waiting, with messages queued for it (the demo adds the queue).
  'data-pipeline': async () => {
    user('Find out why the nightly import is slow');
    tool('Bash', 'python -m cProfile -s cumtime import_orders.py --dry-run', '92% of the time in parse_rows()');
    tool('Read', 'pipeline/parse.py', 'Read 77 lines');
    const msg = 'parse_rows() builds a pandas frame row by row; reading the CSV in one call would make the import about 8× faster. Want me to change it?';
    say(msg);
    set({ status: 'waiting', lastMessage: msg });
  },
  // A project whose CLAUDE.md brings in files from outside its folder: Claude Code asks first, before the session has
  // started, so the run stays "starting" (the dashboard reads the question from the screen, askcard.mjs). It is
  // answered in the terminal, with its number or Enter; the page never answers it.
  bookshop: async () => {
    w(` ${c.bold('Allow external CLAUDE.md file imports?')}`);
    w(` ${c.dim('This project\'s CLAUDE.md brings in files')}`);
    w(` ${c.dim('from outside its folder. Only use Claude')}`);
    w(` ${c.dim('Code with files you trust.')}`);
    w();
    w(` ${c.blue('❯')} 1. No, disable external imports`);
    w('   2. Yes, allow external imports');
    w();
    w(` ${c.dim('Enter to confirm · Esc to cancel')}`);
    const k = await keyFor(['1', '2', '\r', '\n', '\x1b']);
    w();
    say(k === '2' ? 'External imports are allowed for this project.' : 'External imports stay off for this project.');
    set({ status: 'waiting' });
  },
};
// Any other folder: a fresh session that waits for its first message.
const story = STORIES[folder] || (async () => set({ status: 'waiting' }));

// ---------- a message typed into it gets a short, scripted answer ----------
let busyMessage = false;
let onKey = null; // while a question stands: one key answers it (the terminal is raw then, as Claude Code's is)
// The next key of `keys` typed into the terminal.
const keyFor = (keys) => new Promise((resolve) => {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  onKey = (s) => {
    const k = keys.find((x) => s === x || (x !== '\x1b' && s.startsWith(x))); // an arrow key starts with Esc too
    if (!k) return;
    onKey = null;
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    resolve(k);
  };
});
async function answer(text) {
  busyMessage = true;
  w();
  user(text.trim());
  set({ status: 'working', limit: null, note: '' });
  await sleep(900);
  tool('Read', 'README.md', 'Read 64 lines');
  await sleep(900);
  tool('Bash', 'npm test', 'Tests: 52 passed, 52 total');
  await sleep(700);
  const msg = /continue/i.test(text) ? 'Picked up where the last provider stopped: the guide is finished and all links check out.' : `Done: ${text.trim().slice(0, 80)}. Everything still passes.`;
  say(msg);
  set({ status: 'waiting', lastMessage: msg });
  promptBox();
  busyMessage = false;
}

// Lines typed into it, or the key that answers a question that stands.
let typed = '';
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (onKey) return onKey(s);
  typed += s;
  const lines = typed.split(/\r\n|[\r\n]/);
  typed = lines.pop();
  // An empty line does nothing, as in Claude Code: the Enter the page sends after a number that answered a question
  // must not start work nobody asked for.
  for (const l of lines) if (!busyMessage && l.trim()) answer(l);
}).on('end', bye);

header();
if (resumed) {
  user('(the same conversation, now on another provider)');
  // The account by the label the page shows ("Team plan"), never its inner name.
  let label = account;
  try {
    label = (readProfile(account) || {}).label || account;
  } catch {}
  say(`Picked up the conversation on ${label}; nothing was lost.`);
  set({ status: 'waiting', lastMessage: `Picked up the conversation on ${label}.` });
  promptBox();
} else if (firstMessage) {
  answer(firstMessage);
} else {
  story().then(() => {
    if (!busyMessage) promptBox();
  });
}
