#!/usr/bin/env node
// The demo's stand-in for Claude Code (`hoprig demo`): a program that looks like a Claude Code session in a
// terminal — a prompt, tool lines, a diff, a result — and keeps a run record like the real launcher, so the
// dashboard shows it as working, waiting, needing an OK or at a limit. It talks to no model and costs nothing.
//
// Called like the launcher: session.mjs <account> [--resume <id>] …   The folder's name picks the story
// (STORIES below); a message typed into it gets a short scripted answer. All names, paths and projects are
// made up.
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { createRun, removeRun, updateRun } from '../runs.mjs';

const [account = 'max', ...args] = process.argv.slice(2);
const resumed = args.includes('--resume');
const folder = path.basename(process.cwd());
const id = (s) => crypto.createHash('sha256').update(s).digest('hex').replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*/, '$1-$2-4$3-a$4-$5');
const sessionId = resumed ? args[args.indexOf('--resume') + 1] : id(`demo:${folder}`);

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
  // Needs your OK: a permission question on screen.
  'mobile-app': async () => {
    user('Add the chart to the stats screen');
    tool('Read', 'app/screens/Stats.tsx', 'Read 96 lines');
    say('The chart needs one new package.');
    box([c.bold('Bash command'), '', '  npm install react-native-svg@15.8.0', c.dim('  Add the SVG library the chart needs'), '', 'Do you want to proceed?', `${c.blue('❯')} 1. Yes`, '  2. Yes, and don\'t ask again for npm install commands', '  3. No, and tell Claude what to do differently (esc)']);
    set({ status: 'attention', note: 'Claude needs your permission to use Bash: npm install react-native-svg', lastMessage: 'The chart needs one new package.' });
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
};
// Any other folder: a fresh session that waits for its first message.
const story = STORIES[folder] || (async () => set({ status: 'waiting' }));

// ---------- a message typed into it gets a short, scripted answer ----------
let busyMessage = false;
async function answer(text) {
  busyMessage = true;
  w();
  user(text.trim() || 'continue');
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

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  if (!busyMessage) answer(l);
}).on('close', bye);

header();
if (resumed) {
  user('(the same conversation, now on another provider)');
  say(`Picked up the conversation on the "${account}" provider; nothing was lost.`);
  set({ status: 'waiting', lastMessage: `Picked up the conversation on the "${account}" provider.` });
  promptBox();
} else {
  story().then(() => {
    if (!busyMessage) promptBox(folder === 'mobile-app' ? 'Enter to confirm · Esc to exit' : '? for shortcuts');
  });
}
