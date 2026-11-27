// What the site's pages (site/content/) say about the product, held to the code that does it: a default, a range,
// a switch's name. When the code changes, the sentence has to change with it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const flat = (s) => s.replace(/\s+/g, ' ');
const SLEEP = 'site/content/use-cases/work-while-you-sleep.md';

test('a mission\'s tasks run one after another at first; Sessions at once lets up to four, never more than Runs by themselves at once', async () => {
  const mission = await import('../src/mission/settings.mjs');
  const auto = await import('../src/automation/settings.mjs');
  const { whyNot } = await import('../src/mission/limits.mjs');
  // The defaults: one session of hers at once, and one run by itself at once on the computer.
  assert.equal(mission.missionSettings({}).atOnce, 1, 'Sessions at once is 1 at first');
  assert.equal(auto.readSettings({}).schedules.atOnce, 1, 'Runs by themselves at once is 1 at first');
  // The range of Sessions at once: 1 to 4.
  const cur = mission.missionSettings({});
  assert.equal(mission.cleanPatch({ atOnce: 4 }, cur).atOnce, 4);
  assert.throws(() => mission.cleanPatch({ atOnce: 5 }, cur), /1 to 4/);
  assert.throws(() => mission.cleanPatch({ atOnce: 0 }, cur), /1 to 4/);
  // The smaller of the two holds: four of hers at once, but the computer runs one, so a second waits.
  const s = { ...mission.missionSettings({ missions: { on: true, atOnce: 4, capUsd: 5, projects: { shop: { on: true } } } }) };
  const c = { s, project: 'shop', clock: '12:00', spent: { usd: 0, tokens: 0 }, machine: {} };
  assert.equal(whyNot({ ...c, running: 0, slots: 1 }), null, 'the first starts');
  assert.match(whyNot({ ...c, running: 1, slots: 1 }), /at most 1 at once/, 'the computer\'s one place holds');
  assert.equal(whyNot({ ...c, running: 3, slots: 4 }), null, 'with four places, a fourth starts');
  assert.match(whyNot({ ...c, running: 4, slots: 4 }), /at most 4 at once/);
  // The page's names are the dashboard's.
  assert.match(read('web/mission.js'), /num\('Sessions at once', 'atOnce'/);
  assert.match(read('web/automation.js'), /choiceRow\('At most this many at once'/);
  const page = flat(read(SLEEP));
  assert.doesNotMatch(page, /in a mission whose plan you accepted, one after another/);
  assert.match(page, /Her tasks run one after another at first\. \*\*Sessions at once\*\* on Work → Team lets up to four run side by side, never more than \*\*At most this many at once\*\* on Work → Schedules \(also one at first\)\./);
});

test('the index: the tests run on the systems and Node.js versions of the workflow; what is new was tried by hand on Linux only', () => {
  const wf = read('.github/workflows/test.yml');
  assert.match(wf, /os: \[ubuntu-latest, macos-latest\]\n\s+node: \[24, 26\]/, 'the blocking job: Linux and macOS, Node 24 and 26');
  const index = flat(read('site/content/index.md'));
  assert.match(index, /Its tests run on Linux and macOS with Node\.js 24 and 26 on every change\./);
  // The tests run on macOS too, so "run on Linux only" would be untrue; by hand is what only Linux had.
  assert.doesNotMatch(index, /was run on Linux only/);
  assert.match(index, /The newer parts \(the chat, the editor, the desktop, Work\) were tried by hand on Linux only, not on a real Mac/);
});

test('the index: setup ends with a QR code, and on a server with how to reach it instead', async (t) => {
  // With a phone address setup's last step makes a one-time sign-in link, kept in <state folder>/login-links.json.
  // The folders are this test's own: in the run's shared state folder the link landed while test/docs-claims.test.mjs
  // checked that this folder stays as it was, and that check failed when the two files ran side by side.
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-site-setup-'));
  const before = { config: process.env.HOPRIG_CONFIG_DIR, state: process.env.HOPRIG_STATE_DIR };
  process.env.HOPRIG_CONFIG_DIR = path.join(own, 'config');
  process.env.HOPRIG_STATE_DIR = path.join(own, 'state');
  t.after(() => {
    for (const [k, v] of [['HOPRIG_CONFIG_DIR', before.config], ['HOPRIG_STATE_DIR', before.state]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(own, { recursive: true, force: true });
  });
  const { stepSummary } = await import('../src/setup/setup.mjs');
  const { makeUi } = await import('../src/setup/ui.mjs');
  const end = async (state) => {
    let text = '';
    await stepSummary(makeUi({ interactive: false, write: (s) => (text += s), askLine: async () => '' }), state, { user: 'alex', publicIps: [], env: {} });
    return text;
  };
  assert.match(await end({ phoneUrl: 'http://192.168.1.20:7433/' }), /Scan with your phone's camera/);
  assert.doesNotMatch(await end({ server: { kind: 'ssh' } }), /Scan with/, 'no QR code on a server');
  assert.match(flat(read('site/content/index.md')), /ends with a QR code \(on a server: how to reach it from your own computer\)\./);
});

test('the tmux compare page: on a server (public address, SSH without a desktop, a cloud) setup does not offer "devices on my network"', async () => {
  const { liveReason } = await import('../src/setup/server.mjs');
  assert.equal(liveReason({ env: {}, platform: 'linux', publicIps: ['203.0.113.5'], dmi: {} }).kind, 'public');
  // The question leaves the network choice out whenever setup counts the computer as a server.
  assert.match(read('src/setup/setup.mjs'), /\.\.\.\(exposed \? \[\] : \[\['network', 'devices on my network, e\.g\. my phone on the same Wi-Fi: inside your own Wi-Fi only and not encrypted, so not for a shared or public Wi-Fi'\]\]\)/);
  assert.match(read('src/setup/server.mjs'), /kind: 'public'[\s\S]*kind: 'ssh'[\s\S]*kind: 'cloud'/);
  const page = flat(read('site/content/compare/tmux-ssh-vpn.md'));
  assert.match(page, /On a server \(a computer with a public address, or, on Linux, also one you reach over SSH with no desktop or one in a cloud\), "devices on my network" is not offered\./);
  // Enter takes the network; 1 is this computer only.
  assert.match(read('src/setup/setup.mjs'), /const shown = \[\['local', 'only this computer'\]/);
  assert.match(page, /Pressing Enter makes it reachable from devices on your network[^.]*; choose 1 to keep it on this computer only\./);
});

test('the Tia use case: at Hands off a paid start runs without a card only inside a daily cap, which is empty at first', async () => {
  const { DEFAULTS } = await import('../src/assistant/tia.mjs');
  const { SpendLedger } = await import('../src/assistant/spend.mjs');
  assert.equal(DEFAULTS.dailyCapUsd, null, 'no daily cap at first');
  const ledger = new SpendLedger({ file: null });
  assert.match(ledger.take(DEFAULTS.dailyCapUsd), /no daily limit for paid use is set/, 'without a cap a paid act is a card');
  assert.equal(ledger.take(5), null, 'inside a cap it runs');
  assert.match(read('web/tia.js'), /'Daily limit for paid use \(US \$\)'/);
  const page = flat(read('site/content/use-cases/tell-the-assistant.md'));
  assert.match(page, /At \*\*Hands off\*\* she may start other jobs on the paid API providers you allowed her without asking, but only within the \*\*Daily limit for paid use \(US \$\)\*\* you set in Settings → Tia\. That limit is empty at first, and while it is empty she asks you first\./);
});

test('the plan use case: Tia starts a plan\'s tasks and accepts results only once her switches are on, all off at first', async () => {
  const mission = await import('../src/mission/settings.mjs');
  const s = mission.missionSettings({});
  assert.equal(s.on, false, 'Tia works by herself is off at first');
  assert.deepEqual(s.selfAccept, [], 'Accept by itself: no kind at first');
  assert.deepEqual(Object.keys(mission.SELF_KINDS), ['docs', 'tests'], 'only documents and tests can be accepted by her');
  assert.equal(mission.worksOn(s, 'shop'), false);
  assert.equal(mission.worksOn(mission.missionSettings({ missions: { on: true, projects: { shop: { on: true } } } }), 'shop'), true);
  assert.match(read('web/mission.js'), /toggle\('Tia works by herself', s\.on/);
  assert.match(read('web/mission.js'), /h\('h3\.ms-h3', 'Accept by itself'\)/);
  assert.match(read('web/workitems.js'), /h\('span\.field-label', 'Run by AI'\)/);
  const page = flat(read('site/content/use-cases/plan-with-ai.md'));
  assert.doesNotMatch(page, /Nothing starts by itself\. Every task starts on your \*\*Do it\*\*/);
  assert.match(page, /At first nothing starts by itself\. A task starts on your \*\*Do it\*\*, or at the time you set on it with \*\*Run by AI\*\*\./);
  assert.match(page, /\*\*Tia works by herself\*\* on Work → Team lets Tia start a plan's tasks herself\. Its \*\*Accept by itself\*\* switches let her accept the results of documents and tests\. All of them are off at first\./);
});

test('the night-work use case: a schedule runs once, every day, on some days or every month, as Work → Schedules offers', () => {
  assert.match(read('web/automation.js'), /seg\('How often', \[\['daily', 'Every day'\], \['weekly', 'On some days'\], \['monthly', 'Every month'\], \['once', 'Once'\]\]/);
  const page = flat(read(SLEEP));
  assert.match(page, /\*\*Schedules\*\*: at a set time \(once, every day, on some days of the week or every month\)/);
});

test('the Operator use case: the order of the list, and every switch of Tia off at first with the limits the page names', async () => {
  const { CLASSES, ACTS } = await import('../src/operator/item.mjs');
  const { readOperator, RULE_IDS, BUDGET_DEFAULTS } = await import('../src/operator/rules.mjs');
  const { readDecide } = await import('../src/operator/decide-store.mjs');
  const { readLook } = await import('../src/operator/look.mjs');
  const { STUCK_MS } = await import('../src/operator/detect/stuck.mjs');
  // The order of the list, in the page's words (web/operator.js CLASS_WORDS).
  assert.deepEqual(CLASSES, ['harm', 'stopped', 'waits', 'machine', 'info']);
  assert.match(read('web/operator.js'), /harm: 'Can lose work', stopped: 'Stopped', waits: 'Waits for you', machine: 'This computer', info: 'For your information'/);
  for (const [id, label] of [['switch', 'Continue on the next provider'], ['restart-gateway', 'Restart the gateway'], ['push', 'Push the branch'], ['dismiss', 'Not now']]) assert.equal(ACTS[id].label, label);
  assert.equal(ACTS.push.risk, 'others');
  assert.equal(STUCK_MS, 20 * 60_000);
  // Off at first: the main switch, every rule, Tia decides, its missions, the looks; none acts while Tia is off.
  const op = readOperator({});
  assert.equal(op.acts, false);
  for (const id of RULE_IDS) assert.equal(op.rules[id], false, `rule ${id} off at first`);
  assert.equal(readOperator({ operator: { acts: true }, assistant: { enabled: false } }).active, false, 'nothing acts while Tia is off');
  assert.equal(readOperator({ operator: { acts: true }, assistant: { enabled: true } }).active, true);
  assert.deepEqual(BUDGET_DEFAULTS, { perHour: 3, perDay: 10, waitMinutes: 10 });
  const d = readDecide({});
  assert.equal(d.on, false);
  assert.equal(d.missions, false);
  assert.equal(d.perDay, 30);
  assert.equal(d.tokensPerDay, 125_000);
  const l = readLook({});
  assert.equal(l.on, false);
  assert.equal(l.perDay, 2);
  assert.equal(l.dollarsPerDay, 3);
  // The switches' names are the page's own.
  assert.match(read('web/operator-tia.js'), /sw\('Tia acts by herself'/);
  assert.match(read('web/operator-decide.js'), /toggle\('Tia decides'/);
  assert.match(read('web/operator-decide.js'), /toggle\('Also a mission\\'s choices'/);
  assert.match(read('web/operator-look.js'), /toggle\('Tia looks into what nobody can explain'/);
  assert.match(read('web/operator-decide.js'), /about 3,400 tokens/);
  const page = flat(read('site/content/use-cases/what-needs-you.md'));
  assert.match(read('site/content/use-cases/what-needs-you.md'), /^---\norder: 19\n/);
  assert.match(page, /While Tia's rules, \*\*Tia decides\*\* and her looks are off, nothing happens until you tap\. All of them are off at first\./);
  assert.match(page, /\*\*Needs you\*\* lists the items in this order: \*\*Can lose work\*\*, \*\*Stopped\*\*, \*\*Waits for you\*\*, \*\*This computer\*\*, then \*\*For your information\*\*\. Inside each group the oldest comes first\./);
  assert.match(page, /A rule acts at most 3 times an hour and 10 times a day, with 10 minutes between two tries on the same thing/);
  assert.match(page, /about 3,400 tokens of her provider, at most 30 decisions and 125,000 tokens a day at first/);
  assert.match(page, /at most 2 looks and \$3 a day at first/);
  assert.match(page, /a session with no progress for 20 minutes/);
  assert.match(page, /!\[The Operator page: [^\]]+\]\(\/screenshots\/operator-desktop-light\.webp\)/);
});

test('the Operator use case: the switches in the panel\'s order, what each needs, and a tap that can move work to a paid key', async () => {
  const page = flat(read('site/content/use-cases/what-needs-you.md'));
  // The panel draws: the main switch, Tia decides, the looks, the corrections, the rules (web/operator-tia.js tiaPanel).
  // The local panel is the function's last return (the first one draws another computer's panel).
  const tia = read('web/operator-tia.js');
  const fn = tia.slice(tia.indexOf('export function tiaPanel('));
  const panel = fn.slice(fn.lastIndexOf("return h('section.op-tia'"), fn.indexOf('\n}\n'));
  const order = ['master,', 'decidePart(', 'lookPart(', 'correctionsPart(', "h('ul.op-rules'"].map((w) => panel.indexOf(w));
  assert.ok(order.every((at, i) => at > -1 && (i === 0 || at > order[i - 1])), `the panel's order: ${order}`);
  const said = ['**Tia acts by herself** is the main switch', '- **Tia decides**:', '- **Tia looks into what nobody can explain**:', '- **Tia keeps your corrections**:', '- Last come her five rules'].map((w) => page.indexOf(w));
  assert.ok(said.every((at, i) => at > -1 && (i === 0 || at > said[i - 1])), `the page's order: ${said}`);
  // Tia OFF is drawn only while she may act; turning the main switch on asks first.
  assert.match(read('web/operator-tia.js'), /const off = v\.acts \? h\('button\.btn\.danger\.op-off'/);
  assert.match(read('web/operator-tia.js'), /if \(on && !\(await confirm\(\)\)\)/);
  assert.match(page, /Turning it on asks you to confirm first\. .*While it is on, the button \*\*Tia OFF\*\* stands at the top of this part and stops her at once\./);
  // Five rules, and the guide that lists them.
  const { RULES } = await import('../src/operator/rules.mjs');
  assert.equal(RULES.length, 5);
  assert.match(page, /The \[Operator guide\]\(\/docs\/operator\/\) lists all five\./);
  // Corrections: off at first, 200 a day, 90 days, kept with the main switch off (only their own switch counts).
  const C = await import('../src/operator/corrections.mjs');
  assert.equal(C.readCorrections({}).on, false);
  assert.deepEqual([C.PER_DAY, C.KEEP_DAYS], [200, 90]);
  assert.equal(C.noteCorrection({ operator: { acts: false, corrections: { on: true } } }, { kind: 'declined', about: { rule: 'limit' } }), true);
  assert.match(page, /at most 200 a day, for 90 days, on this computer only\..* It only keeps records, so it works also while the main switch is off\./);
  // Look at my other computers too: off at first, at most once a minute.
  const { lookOthersOn } = await import('../src/operator/rooms.mjs');
  assert.equal(lookOthersOn({}), false);
  assert.match(read('web/operator-rooms.js'), /export const LOOK_SENTENCE = 'Look at my other computers too';/);
  assert.match(read('web/operator-rooms.js'), /at most once a minute/);
  assert.match(page, /the switch \*\*Look at my other computers too\*\* \(off at first\) lets the dashboard read your other computers by itself, at most once a minute\./);
  // Continue on the next provider asks nothing (risk low: no question, web/operator.js confirmFor) ...
  const { ACTS } = await import('../src/operator/item.mjs');
  assert.equal(ACTS.switch.risk, 'low');
  assert.match(read('web/operator.js'), /const RISK_WORDS = \{ stops: 'the work that runs now stops', others: 'others will see it' \};/);
  // ... and goes to the next provider of the order, which keeps a pay-per-use key when the order holds one.
  const P = await import('../src/profiles.mjs');
  const A = await import('../src/autoswitch.mjs');
  const { saveConfig, loadConfig } = await import('../src/config.mjs');
  const before = loadConfig();
  P.writeProfile('subx', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'demo-not-a-token' } });
  P.writeProfile('keyx', { env: { ANTHROPIC_API_KEY: 'demo-not-a-key' } });
  try {
    saveConfig({ ...before, autoSwitch: { order: ['subx', 'keyx'] } });
    assert.equal(A.getAutoSwitch().payPerUse, true, 'never chosen, the order holds a paid key: it is used');
    assert.equal(A.nextProfile('subx'), 'keyx');
  } finally {
    saveConfig(before);
    P.deleteProfile('subx');
    P.deleteProfile('keyx');
  }
  // A rule of Tia's refuses that move below Hands off (src/operator/reflex.mjs).
  assert.match(read('src/operator/reflex.mjs'), /const paid = !p \|\| p\.kind === 'api' \|\| p\.paid === true;\n\s*if \(paid && tia\.level !== 'handsoff'\) throw refusal\('paid'/);
  assert.match(page, /\*\*Continue on the next provider\*\* goes to the next provider of your order under Providers → Auto mode, and it does not ask first\. When that order holds a pay-per-use API key, the work from there on costs money\. A rule of Tia's or \*\*Tia decides\*\* makes that move only at her level \*\*Hands off\*\*/);
  // Operator is in the group More (web/shell.js), on a phone too (the tab More).
  assert.match(read('web/shell.js'), /h\('div\.side-group-title', 'More'\)/);
  assert.match(page, /\*\*Operator\*\* is in the menu's group \*\*More\*\*, on a phone too\./);
  assert.doesNotMatch(page, /last fetch|never fetches/);
});

test('the index names the Operator and Tia, and says Tia and what she does by herself are off at first', async () => {
  const { readOperator, RULE_IDS } = await import('../src/operator/rules.mjs');
  const { readDecide } = await import('../src/operator/decide-store.mjs');
  const { readLook } = await import('../src/operator/look.mjs');
  const off = readOperator({});
  assert.equal(off.tia, false, 'Tia is off at first (assistant.enabled)');
  assert.ok(!off.acts && RULE_IDS.every((id) => !off.rules[id]) && !readDecide({}).on && !readLook({}).on);
  const index = flat(read('site/content/index.md'));
  assert.match(index, /### What are the Operator and Tia\?/);
  assert.match(index, /\[see on one page what needs you\]\(\/use-cases\/what-needs-you\/\)/);
  assert.match(index, /She is experimental and off until you turn her on, and so is everything she may do by herself: \[Tia, the assistant\]\(\/docs\/tia\/\)\./);
});

test('money, the stop and Auto mode: a rule and Tia decides spend on a paid provider only at Hands off inside the daily cap, which counts it; the stop needs the tick; Auto mode is judged by its order', async () => {
  const { sandbox } = await import('./server/helpers.mjs');
  const box = sandbox('docs-money');
  try {
    const { saveConfig, loadConfig } = await import('../src/config.mjs');
    const { operatorFeature } = await import('../src/operator/feature.mjs');
    const { SETTLE_MS } = await import('../src/operator/decider.mjs');
    const { SpendLedger, spendFile } = await import('../src/assistant/spend.mjs');
    const { DEFAULTS } = await import('../src/assistant/tia.mjs');
    const { decideLevel } = await import('../src/assistant/policy.mjs');
    const { byName } = await import('../src/assistant/tools.mjs');
    const projects = path.join(box.workspace, 'projects');
    fs.mkdirSync(path.join(projects, 'alpha'), { recursive: true });
    const NOW = Date.parse('2026-03-10T14:00:00Z');
    const ago = (min) => new Date(NOW - min * 60_000).toISOString();
    const limited = () => ({ name: 'alpha', tool: 'claude', provider: 'plan-a', state: 'waiting', statusAt: ago(1), startedAt: ago(90), progressAt: ago(1), folder: path.join(projects, 'alpha'), limit: { at: ago(3), text: 'Usage limit reached', source: 'hook', resetsAt: null }, asks: [], askType: null, askAt: null, toolNow: null, agents: [], canSwitch: true, nextProvider: 'paid-x' });
    class HttpError extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }
    /** One Operator with the limit rule (or Tia decides) on, Tia at `level` with the daily cap `cap`: what moved. */
    const run = async (level, way, cap = null) => {
      fs.rmSync(path.join(box.state, 'operator'), { recursive: true, force: true });
      saveConfig({ projectsDir: projects, assistant: { enabled: true, level, accounts: ['plan-a', 'paid-x'], dailyCapUsd: cap }, operator: { acts: true, rules: way === 'rule' ? { limit: true } : {}, ...(way === 'decide' ? { decide: { on: true } } : {}) } });
      let sessions = [limited()];
      const moved = [];
      const clock = { t: NOW };
      const ticker = { fn: null };
      const ctx = { HttpError, caller: () => 'page', readJson: async (req) => req.body ?? {}, config: () => loadConfig(), saveConfig, state: async () => ({}), onTick: (fn) => { ticker.fn = fn; return () => {}; } };
      const f = operatorFeature(ctx, {
        sources: { sessions: () => sessions, gateways: () => [], live: () => null, leftovers: () => [], machine: () => null },
        now: () => clock.t,
        cacheMs: 0,
        accounts: async () => ({ profiles: [{ name: 'plan-a', kind: 'subscription' }, { name: 'paid-x', kind: 'api' }], autoSwitch: { enabled: false } }),
        turn: async () => ({ ok: true, text: 'switch-provider\nThe next provider can go on now.', tokens: 900, usd: 0 }),
        session: { move: async (name, to) => { moved.push(to); sessions = sessions.map((s) => (s.name === name ? { ...s, provider: to, limit: null } : s)); } },
        acts: {},
      });
      try {
        if (way === 'rule') await f.reflex.round();
        else {
          await ticker.fn();
          await f.deciding?.();
          clock.t += SETTLE_MS;
          await ticker.fn();
          await f.deciding?.();
        }
      } finally {
        f.close();
      }
      return moved;
    };
    assert.equal(DEFAULTS.level, 'work', 'her level is "Do the work" at first');
    assert.equal(DEFAULTS.dailyCapUsd, null, 'no daily cap at first');
    for (const way of ['rule', 'decide']) {
      assert.deepEqual(await run('work', way), [], `${way}: no move onto the paid provider at "Do the work"`);
      assert.deepEqual(await run('work', way, 5), [], `${way}: none at "Do the work" inside a cap either`);
      assert.deepEqual(await run('handsoff', way), [], `${way}: none at "Hands off" with no cap set`);
    }
    // With no cap the ledger saw nothing; inside a cap each move is held in it, as her own paid act.
    assert.equal(fs.existsSync(spendFile()), false, 'nothing written to the spending ledger');
    for (const way of ['rule', 'decide']) {
      fs.rmSync(spendFile(), { force: true });
      assert.deepEqual(await run('handsoff', way, 5), ['paid-x'], `${way}: the move at "Hands off" inside the cap`);
      assert.deepEqual(new SpendLedger().today(), { spent: 0, held: 0.5 }, `${way}: the move counts against the cap`);
    }
    // Her own move to a paid provider is a card below Hands off; at Hands off the level lets it (the cap then decides).
    const tool = byName.get('switch_account');
    const facts = { account: { name: 'paid-x', kind: 'api', allowed: true }, mine: true, session: { account: 'plan-a' } };
    const tia = (level) => ({ level, allowed: ['plan-a', 'paid-x'] });
    assert.equal(decideLevel(tool, { session: 'alpha', account: 'paid-x' }, facts, tia('work')).level, 'L2');
    assert.equal(decideLevel(tool, { session: 'alpha', account: 'paid-x' }, facts, tia('handsoff')).level, 'L1');
  } finally {
    box.cleanup();
  }
  // What changes the computer stays a card at Hands off: Hands off lifts no card of manage_computer.
  {
    const { decideLevel } = await import('../src/assistant/policy.mjs');
    const { byName } = await import('../src/assistant/tools.mjs');
    const mc = byName.get('manage_computer');
    for (const action of ['update', 'coding_tool', 'setup_fix', 'set_up', 'end_process', 'addon', 'reboot', 'power_off']) {
      assert.equal(decideLevel(mc, { computer: 'this', action }, { mine: true }, { level: 'handsoff', allowed: [] }).level, 'L2', `${action}: a card at Hands off`);
    }
    // Her own paid acts go through the daily cap, at Hands off too: no cap set (the default) is a card.
    const { SpendLedger } = await import('../src/assistant/spend.mjs');
    const { DEFAULTS } = await import('../src/assistant/tia.mjs');
    assert.match(new SpendLedger({ file: null }).take(DEFAULTS.dailyCapUsd), /no daily limit for paid use is set/);
  }
  // Run through her core: at Hands off a paid start is a card without a cap and runs inside one; below Hands off a paid
  // start is a card even inside the cap, while a message into a paid chat runs inside it (and is a card without one).
  {
    const { AuditLog } = await import('../src/assistant/audit.mjs');
    const { CardStore } = await import('../src/assistant/cards.mjs');
    const { createAssistantCore } = await import('../src/assistant/core.mjs');
    const { JobStore } = await import('../src/assistant/jobs.mjs');
    const { SpendLedger } = await import('../src/assistant/spend.mjs');
    const { FakeOps, baseState } = await import('./assistant/fake-dashboard.mjs');
    const FOLDER = '/home/owner/projects/api';
    const tryLevel = async (level, cap) => {
      const st = baseState();
      st.assistant = { enabled: true, level, accounts: ['sub', 'api'], ...(cap == null ? {} : { dailyCapUsd: cap }) };
      const ops = new FakeOps(st);
      const now = () => new Date(2026, 10, 18, 22, 0).getTime();
      const core = createAssistantCore({ ops, now, cards: new CardStore({ now }), audit: new AuditLog({ file: null, now }), jobs: new JobStore({ dir: null, now }), spend: new SpendLedger({ file: null, now }) });
      const call = (t, a) => core.call(t, a, { conversation: 'c1' });
      const start = await call('start_session', { folder: FOLDER, account: 'api', message: 'x' });
      assert.ok(!(await call('start_chat', { folder: FOLDER, account: 'sub', message: 'y' })).card);
      const chat = ops.s.sessions.find((c) => c.kind === 'chat' && c.cwd === FOLDER);
      chat.profile = { name: 'api', label: 'API key', kind: 'api' };
      chat.status = 'waiting';
      const write = await call('send_to_chat', { session: chat.name, text: 'run the tests' });
      return { start: start.card ? 'card' : 'ran', write: write.card ? 'card' : 'ran' };
    };
    assert.deepEqual(await tryLevel('handsoff', null), { start: 'card', write: 'card' }, 'Hands off, no cap');
    assert.deepEqual(await tryLevel('handsoff', 2), { start: 'ran', write: 'ran' }, 'Hands off, inside a cap');
    assert.deepEqual(await tryLevel('work', null), { start: 'card', write: 'card' }, 'Do the work, no cap');
    assert.deepEqual(await tryLevel('work', 2), { start: 'card', write: 'ran' }, 'Do the work, inside a cap');
  }
  // The pages say it so.
  const tia = "So does what costs money, except where you choose otherwise. Within a daily spending cap you set \\(none at first\\), she may write to sessions on paid providers unless her level is \\*\\*Ask me\\*\\*, and at \\*\\*Hands off\\*\\* also start or move her sessions there. At \\*\\*Hands off\\*\\*, the Operator's limit rule or \\*\\*Tia decides\\*\\*, once you turn them on, may also move a session at a usage limit onto a paid provider, only within that cap, and each move counts against it";
  // Her own requests that change the computer are cards (above); the Operator's rules and Tia decides restart and end
  // things by themselves once turned on, so the pages name them next to that sentence.
  const { RULES, RULE_IDS } = await import('../src/operator/rules.mjs');
  const { prepared, offeredSteps } = await import('../src/operator/decide-table.mjs');
  const actOf = (id) => RULES.find((r) => r.id === id)?.act;
  assert.ok(['gateway', 'link', 'leftover'].every((id) => RULE_IDS.includes(id)));
  assert.deepEqual(['gateway', 'link', 'leftover'].map(actOf), ['restart-gateway', 'restart-link', 'end']);
  const item = (kind, acts, extra = {}) => ({ kind, class: 'stopped', acts: acts.map((id) => ({ id })), target: {}, ...extra });
  assert.deepEqual(prepared(item('provider', ['restart-gateway'], { target: { addon: 'gw' } })).map((x) => x.id), ['restart-gateway']);
  assert.deepEqual(prepared(item('live', ['restart-link'])).map((x) => x.id), ['restart-link']);
  // Stop is offered only with his tick "Tia may end a stuck session in this project"; a note, whatever it says, never
  // offers it by itself.
  assert.deepEqual(offeredSteps({ steps: ['nudge', 'stop'] }, false), ['nudge'], 'stop is offered only with the tick');
  assert.deepEqual(offeredSteps({ steps: ['nudge', 'stop'] }, true), ['nudge', 'stop'], 'the tick on: stop is offered');
  for (const note of ['stop it when stuck', 'ask me before stopping a session', 'never stop a session']) assert.deepEqual(offeredSteps({ steps: ['nudge', 'stop'] }, note), ['nudge'], `a note is not the tick: ${note}`);
  const { SYSTEM } = await import('../src/operator/decide-prompt.mjs');
  assert.match(SYSTEM, /: end the session\. Never the usual step, also not after a nudge: only when the owner's note says to stop such a session; otherwise ask_owner\./);
  // Her own stop of a session she started is no card at "Do the work": the README's list of cards says "she did not start".
  const { decideLevel: levelOf } = await import('../src/assistant/policy.mjs');
  const stop = (await import('../src/assistant/tools.mjs')).byName.get('stop_session');
  assert.equal(levelOf(stop, { session: 's' }, { mine: true, session: { status: 'working' } }, { level: 'work', allowed: [] }).level, 'L1');
  assert.equal(levelOf(stop, { session: 's' }, { mine: false, session: { status: 'working' } }, { level: 'handsoff', allowed: [] }).level, 'L2');
  // A decision's call and a look pick their provider by pickProvider: one paid per use only at Hands off and inside the
  // daily cap, and only when every allowed one is; their hold goes into her spending ledger (src/operator/money.mjs).
  const { pickProvider } = await import('../src/operator/decider.mjs');
  const acc = { profiles: [{ name: 'paid-x', kind: 'api' }] };
  assert.ok(pickProvider({ assistant: { enabled: true, level: 'work', accounts: ['paid-x'] } }, acc).error, 'only a paid provider, "Do the work": no call');
  assert.ok(pickProvider({ assistant: { enabled: true, level: 'handsoff', accounts: ['paid-x'] } }, acc).error, 'only a paid provider, "Hands off", no cap: no call');
  assert.deepEqual(pickProvider({ assistant: { enabled: true, level: 'handsoff', accounts: ['paid-x'], dailyCapUsd: 5 } }, acc), { provider: 'paid-x', paid: true, cap: 5 });
  const mixed = { profiles: [{ name: 'paid-x', kind: 'api' }, { name: 'plan-a', kind: 'subscription' }] };
  assert.deepEqual(pickProvider({ assistant: { enabled: true, level: 'handsoff', accounts: ['paid-x', 'plan-a'] } }, mixed), { provider: 'plan-a' });
  // Auto mode counts as paid per use here when its order holds a provider billed by use: allowed alone, no call below
  // Hands off, and at Hands off only inside the cap, with a reason that names it. An order of subscriptions only is free.
  const auto = { autoSwitch: { enabled: true, order: ['plan-a', 'paid-x'] }, profiles: mixed.profiles };
  assert.ok(pickProvider({ assistant: { enabled: true, level: 'work', accounts: ['auto'] } }, auto).error, 'only Auto mode, "Do the work": no call');
  assert.ok(pickProvider({ assistant: { enabled: true, level: 'handsoff', accounts: ['auto'] } }, auto).error, 'only Auto mode, "Hands off", no cap: no call');
  assert.deepEqual(pickProvider({ assistant: { enabled: true, level: 'handsoff', accounts: ['auto'], dailyCapUsd: 5 } }, auto), { provider: 'auto', paid: true, cap: 5 });
  assert.deepEqual(pickProvider({ assistant: { enabled: true, level: 'work', accounts: ['auto', 'plan-a'] } }, auto), { provider: 'plan-a' });
  assert.match(pickProvider({ assistant: { enabled: true, level: 'work', accounts: ['auto'] } }, auto).error, /^Auto mode's order holds a provider billed by use \(paid-x\)/);
  assert.deepEqual(pickProvider({ assistant: { enabled: true, level: 'work', accounts: ['auto'] } }, { autoSwitch: { enabled: true, order: ['plan-a'] }, profiles: mixed.profiles }), { provider: 'auto' }, 'an order of subscriptions only: free of charge');
  assert.match(read('src/operator/look.mjs'), /const c = pickProvider\(ctx\.config\(\), acc\);/);
  // The Operator's paid acts are held by her own ledger's take(), in the one file that holds them.
  assert.match(read('src/operator/money.mjs'), /return l\.take\(c, \{ id \}\) \? capLine\(what, c\) : null;/);
  assert.match(read('src/operator/money.mjs'), /import \{ HOLD_USD, SpendLedger, isPaid, paidName, spendFile \} from '\.\.\/assistant\/spend\.mjs';/);
  const computer = 'What she asks to install, update, restart or power off on your computer, or to end a process there, comes to you as a card first, at every level\\.';
  const calls = "At \\*\\*Hands off\\*\\*, the short call of \\*\\*Tia decides\\*\\* and a look into what nobody can explain may also run on such a provider when every provider you allowed her is paid per use \\(Auto mode counts as paid per use here when its order holds such a provider\\), only within that cap too, and each counts against it\\.";
  const rules = "The Operator's rules, once you turn them on, restart a gateway or the public link that does not answer and end a test's left-over processes by themselves\\. \\*\\*Tia decides\\*\\* may make the same restarts, type one fixed line of Hoprig's into a stuck session to nudge it, and end a stuck session only in a project where you ticked \\*\\*Tia may end a stuck session in this project\\*\\* on the project's page";
  const MAY_END = /export const MAY_END = '([^']+)';/.exec(read('web/operator-decide.js'))?.[1];
  assert.equal(MAY_END, 'Tia may end a stuck session in this project');
  const { NUDGE } = await import('../src/operator/decide-table.mjs');
  assert.ok(NUDGE.startsWith('Hoprig here: '), 'the nudge is one fixed line of Hoprig\'s');
  const index = flat(read('site/content/index.md'));
  const readme = flat(read('README.md'));
  for (const [name, page] of [['index', index], ['README', readme]]) {
    assert.doesNotMatch(page, /changes your computer comes to you as a card first, unless you set her level to \*\*Hands off\*\*/, name);
    assert.doesNotMatch(page, /What installs, updates, ends or restarts something on your computer comes to you as a card first/, name);
  }
  // The landing page and README say the one name of the limit, as its field does: "daily limit for paid use".
  const limitWords = (x) => x.replace('a daily spending cap you set', 'a daily limit for paid use you set in Settings → Tia').replace('that cap', 'that limit');
  assert.match(index, new RegExp(`${computer} ${limitWords(tia)}\\. ${limitWords(calls)} ${rules}`), 'index');
  // README says "billed by use", the Providers page's word, where the landing page still says "paid per use".
  const billed = (x) => x.replaceAll('paid per use', 'billed by use').replaceAll('on paid providers', 'on providers billed by use').replaceAll('a paid provider', 'a provider billed by use');
  assert.match(readme, new RegExp(`${computer} ${billed(limitWords(tia))}\\. ${billed(limitWords(calls))} ${rules}`), 'README');
  assert.doesNotMatch(readme, /paid per use|\bpaid providers?\b/, 'README: one word, billed by use');
  assert.doesNotMatch(readme, /spending cap|daily cap|\bthat cap\b/i, 'README: the old names of the limit');
  assert.match(readme, /Whatever costs money, ends a session she did not start, installs or updates something/);
  // A stuck item is made for any session the board holds, with no word on who started it, and with the tick it offers
  // stop: so Tia decides may end a session she did not start, and the pages that list her cards say so.
  const { detectStuck } = await import('../src/operator/detect/stuck.mjs');
  const board = { sessions: [{ name: 'fixer', state: 'working', progressAt: new Date(Date.now() - 3_600_000).toISOString() }] };
  const [stuck] = detectStuck(board);
  assert.ok(stuck && stuck.kind === 'stuck', 'a quiet session nobody marked as hers is a stuck item');
  const steps = prepared(stuck, board).map((x) => x.id);
  assert.deepEqual(offeredSteps({ steps }, true), ['nudge', 'stop']);
  assert.deepEqual(offeredSteps({ steps }, false), ['nudge'], 'without the tick only the nudge is offered');
  assert.match(readme, /Once you turn it on, \*\*Tia decides\*\* may also end a stuck session, whoever started it, but only in a project where you ticked \*\*Tia may end a stuck session in this project\*\*/);
  // Typing into a session on a provider paid per use is held by the cap (money.mjs TYPING, paidTyping; reflex.mjs
  // typingCheck): every page that names the nudge says so.
  const { TYPING, paidTyping } = await import('../src/operator/money.mjs');
  assert.ok(TYPING.includes('nudge') && TYPING.includes('answer-1'));
  assert.deepEqual(paidTyping({ kind: 'stuck', target: { session: 'a' } }, { sessions: [{ name: 'a', provider: 'paid-x' }] }, acc), { to: 'paid-x', what: 'Typing into this session on paid-x' });
  assert.equal(paidTyping({ kind: 'stuck', target: { session: 'a' } }, { sessions: [{ name: 'a', provider: 'plan-a' }] }, mixed), null);
  const typing = 'Typing into a session that runs on a provider paid per use, the nudge too, is money: \\*\\*Tia decides\\*\\* does it only at \\*\\*Hands off\\*\\* and within';
  for (const [name, page] of [['index', index], ['README', readme], ['ai-team', flat(read('site/content/use-cases/ai-team.md'))], ['tell', flat(read('site/content/use-cases/tell-the-assistant.md'))]]) assert.match(page, new RegExp(`to nudge it.*${name === 'README' ? billed(typing) : typing}`), name);
  // Finding: every thing Tia decides may do to a session without a card is named, the nudge's fixed line and the stop.
  assert.match(flat(read('site/content/use-cases/tell-the-assistant.md')), /a stop or a message she would send to that session is a card too\. \*\*Tia decides\*\* on the Operator page, once you turn it on, may still do two things to that session without a card when it is stuck: type one fixed line of Hoprig's into it to nudge it, once while it makes no progress, and end it, but only in a project where you ticked \*\*Tia may end a stuck session in this project\*\* on the project's page/);
  for (const [name, page] of [['index', index], ['README', readme]]) assert.doesNotMatch(page, /no check of Hoprig reads your words|the cap does not count that move|in a project you wrote a note for/, name);
  assert.doesNotMatch(readme, /Whatever costs money, stops work,/);
  assert.doesNotMatch(readme, /and moves the ones she started there, without asking\. A/);
  assert.match(readme, /At the level \*\*Hands off\*\* \(the default is \*\*Do the work\*\*\) she also starts chats and sessions there and moves the ones she started there, without asking, within that limit\. At \*\*Hands off\*\*, the Operator's limit rule or \*\*Tia decides\*\*, once you turn them on, may also move any session at a usage limit onto such a provider, only within that limit, and each move counts against it/);
  assert.match(readme, /Typing into a session that runs on a provider billed by use, the nudge too, is money: \*\*Tia decides\*\* does it only at \*\*Hands off\*\* and within that limit, and it counts against it\./);
  const team = flat(read('site/content/use-cases/ai-team.md'));
  assert.doesNotMatch(team, /the one exception is the level \*\*Hands off\*\*/);
  assert.match(team, /Whatever she asks to install, update, restart or power off on your computer, or to end a process there, comes to you as a card first, at every level, and only you turn the public link on\. So does whatever costs money, except where you choose otherwise\. Within a daily limit for paid use you set in Settings → Tia \(none at first\), she may write to sessions on the paid API providers you allowed her unless her level is \*\*Ask me\*\*, and at the level \*\*Hands off\*\* also start or move her sessions there without asking\. At \*\*Hands off\*\*, the Operator's limit rule or \*\*Tia decides\*\*, once you turn them on, may also move a session at a usage limit onto such a provider, only within that limit, and each move counts against it\./);
  assert.match(team, new RegExp(`counts against it\\. ${calls.replace('that cap too', 'that limit too')} ${rules}`));
  const tell = flat(read('site/content/use-cases/tell-the-assistant.md'));
  assert.doesNotMatch(tell, /One move is not counted by that cap/);
  assert.doesNotMatch(tell, /The cap does not count what the Operator page's switches spend/);
  assert.match(tell, /The same limit holds what the Operator page's switches spend, once you turn them on\. At \*\*Hands off\*\*, the limit rule or \*\*Tia decides\*\* may move a session at a usage limit onto such a provider, only within that limit, and each move counts against it\. The short call of \*\*Tia decides\*\* and a look into what nobody can explain may also run on one when every provider you allowed her is paid per use \(Auto mode counts as paid per use here when its order holds such a provider\), only within that limit too/);
  assert.doesNotMatch(tell, /\bcap\b/i, 'the use case names Tia\'s limit as its field does');
  const needs = flat(read('site/content/use-cases/what-needs-you.md'));
  assert.match(needs, /\*\*Tia decides\*\* and the looks cost tokens of a provider you allowed her\. One paid per use is used only at her level \*\*Hands off\*\*, only when every provider you allowed her is paid per use \(Auto mode counts as paid per use here when its order holds such a provider\), and only within her daily limit for paid use \(Settings → Tia\), which counts each of them\./);
  // The item's line and its button are the code's (money.mjs capLine, web/operator.js).
  const { capLine, CAP_SWITCH } = await import('../src/operator/money.mjs');
  assert.equal(capLine('Moving this session to paid-x', null), 'Moving this session to paid-x costs money by use, and Tia has no daily limit for paid use.');
  assert.equal(CAP_SWITCH, '#/settings/tia?show=tia-daily-cap');
  assert.match(read('web/operator.js'), /'Set a daily limit for paid use'/);
  assert.doesNotMatch(read('web/operator.js'), /'Set the daily cap'/);
  assert.match(needs, /A rule of Tia's or \*\*Tia decides\*\* makes that move only at her level \*\*Hands off\*\* \(Settings → Tia\) and only within her daily limit for paid use, which counts it\. With no limit set, or the limit used up, the move stays yours: the card says so in one line and offers \*\*Set a daily limit for paid use\*\*\. Your own tap is not counted\./);
  const changelog = flat(read('site/content/changelog.md'));
  assert.doesNotMatch(changelog, /A repository, a message to a session, money, a sign-in, a push and a release are never a rule\./);
  assert.match(changelog, /Money is one only at \*\*Hands off\*\* and within Tia's daily limit for paid use \(Settings → Tia\): there the limit rule may move a session onto a provider paid per use, and the limit counts that move\./);
  assert.match(changelog, /to a provider paid per use only at her level \*\*Hands off\*\*, never while Auto mode is on/);
  assert.match(changelog, /A move of a session at a usage limit by her limit rule or \*\*Tia decides\*\* at "Hands off" is one of those too: it needs the limit and counts against it, and so does a nudge or an answer \*\*Tia decides\*\* types into a session on such a provider/);
  assert.match(changelog, /So are a call of \*\*Tia decides\*\* and a look into what nobody can explain: they run on such a provider only at "Hands off", only when every provider she may use is one \(Auto mode counts as one when its order holds one\), and only within the limit, which counts what they cost/);
  assert.match(changelog, /a step that ends a session is offered only where you ticked \*\*Tia may end a stuck session in this project\*\* beside the note on the project's page \(Advanced, "How Tia decides here"\)\./);
  assert.match(changelog, /Inside it, unless her level is "Ask me", she may write to or carry on a session or a chat on a provider with an API key without asking, and at "Hands off" also start or move one\./);
  assert.doesNotMatch(changelog, /No step touches a repository, pushes, spends money or deletes/);
  const op = flat(read('docs/OPERATOR.md'));
  assert.doesNotMatch(op, /anything that is yours alone \(money,/);
  assert.doesNotMatch(op, /spending cap|daily cap|\bthe cap\b|\bno cap\b/i, 'OPERATOR: the limit has the one name its field shows');
  assert.equal((await import('../src/assistant/spend.mjs')).HOLD_USD, 0.5, 'a move or a look holds $0.50');
  assert.match(op, /Money has one exception: at her level \*\*Hands off\*\* the limit rule may move a session onto a provider billed by use, but only within the daily limit for paid use \(Settings → Tia\), and each move counts \$0\.50 against it, as her own move does\. With no limit set, or the limit used up, the move is yours: the item says so in one line, with the button \*\*Set a daily limit for paid use\*\*\. Your own tap on \*\*Continue on the next provider\*\* is not counted\./);
  assert.match(op, /Its provider is chosen as a decision's is \(above, \*\*Which model\*\*: one billed by use only at "Hands off", only when every provider you allowed Tia is one, and only within the daily limit for paid use\)\. Such a look holds \$0\.50 of the limit before it starts, its budget is at most what is left of the limit, and what it reported it cost is counted there; its own limits below hold it too\./);
  assert.doesNotMatch(op, /end the session, only where your note for the project asks for it/);
  assert.match(op, /\| stuck \| nudge it once with one fixed sentence Hoprig holds; end the session, offered only where you ticked \*\*Tia may end a stuck session in this project\*\* \(see \*\*Your note\*\* below\) \|/);
  assert.doesNotMatch(op, /no check of Hoprig reads your words/);
  assert.match(op, /Below it is the tick \*\*Tia may end a stuck session in this project\*\* \(off at first, and off after an update for every project, also one with a note\): only with it on is "end the session" offered for that project's stuck sessions, and then she is told to pick it only when your note says to stop such a session\. Off, she never ends one there, whatever the note says\./);
  assert.match(op, /one billed by use only at "Hands off" and within the daily limit for paid use, which holds \$0\.50 before the call and then counts what the call reported it cost\. Auto mode counts as billed by use here when its order holds a provider billed by use, and the reason on the item names it; with an order of subscriptions only, it counts as free of charge\./);
  for (const [name, page] of [['index', index], ['README', readme], ['ai-team', team]]) assert.doesNotMatch(page, /end a stuck session where your note for the project asks for it/, name);
  assert.match(op, /Money is in one: "continue on the next provider" goes to a provider billed by use only at her level \*\*Hands off\*\* and within the daily limit for paid use, as the limit rule does, and the move counts against the limit\. Typing into a session that runs on a provider billed by use \(the nudge, an answer to its question\) is money too: offered only at \*\*Hands off\*\* and within the limit, and each counts \$0\.50 against it\. Below \*\*Hands off\*\*, or with no room in the limit, such a step is not offered, and neither is the stop of a stuck session whose nudge is still owed: an item whose only step it was is yours, with no call, and the item says so in one line \(with \*\*Set a daily limit for paid use\*\* when the limit is why\)\. What "Tia decides" may do to a session without a card is in this table and nothing else: the nudge types the one fixed sentence above, and the stop needs the project's tick, which is read again right before the session is ended\./);
});
