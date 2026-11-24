// A computer's Setup (#/computer/setup): the system status of the computer shown (this one, or another one through
// the hub), "Set up this computer", and recipes (the projects have their own page: projects.js). Installs run as a
// job in the page (setupjob.js): its steps and output show on Setup, and when sudo needs the computer's password
// the page asks for it once, for that job (the rule and why: src/pcsetup/admin.mjs). The terminal is the fallback.
import { COMMAND } from './brand.js';
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, link, machine, openSheet, promptSheet, toast, wayLink } from './lib.js';
import { fold } from './shell.js';
import { gitPanel, identitySheet, signinSheet } from './gitsetup.js';
import { setupJobCard, startSetup } from './setupjob.js';
import { claudeLoginButton } from './claudelogin.js';

const MARK = { ok: '✓', fail: '✗', warn: '!', info: '·' };
const STATE = { ok: '✓', missing: '✗', old: '!' };
const GROUP_TITLES = { system: 'This computer', 'kit:basics': 'Basics', 'kit:node': 'Node.js', 'kit:python': 'Python', 'kit:github': 'GitHub', 'kit:extras': 'Terminal extras', 'kit:docker': 'Docker', 'kit:php': 'PHP + database', 'kit:fvm': 'Flutter versions (fvm)', java: 'Java', claude: 'Claude Code', codetools: 'Coding tools', projects: 'Projects' };
async function post(path, body) {
  try {
    return await api(path, body);
  } catch (e) {
    toast(e, { kind: 'error', ms: 6000 });
    return null;
  }
}

/** "Set up this computer": kits with checkboxes, the exact commands, ONE confirmation, then the job on this page. */
async function setupSheet(started, only = null) {
  let d;
  try {
    d = await api('/api/pcsetup/kits');
  } catch (e) {
    toast(e, { kind: 'error' });
    return;
  }
  // From an optional kit's row: only that kit ticked, so its commands are what the one yes runs.
  const chosen = new Set(only ? d.kits.filter((k) => k.id === only).map((k) => k.id) : d.kits.filter((k) => k.defaultOn && k.items.some((i) => i.state === 'missing')).map((k) => k.id));
  const kits = await openSheet({ title: 'Set up this computer', subtitle: 'Choose what to install. What is already there is left alone.', wide: true }, (close) => {
    const cmds = h('div');
    const pre = (lines) => h('pre', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: '8px' } }, lines.join('\n'));
    const paint = () => {
      const picked = d.kits.filter((k) => chosen.has(k.id));
      const list = picked.flatMap((k) => k.commands);
      const admin = picked.some((k) => k.admin);
      fill(cmds,
        h('h3.section-title', 'Will run'),
        list.length ? pre(list) : h('p.hint', 'Nothing to install for these; sign-in steps still run.'),
        // The commands are the server's own (with sudo, or as root where there is none): the page adds no wording of its own.
        admin ? h('p.hint', 'Some steps need administrator rights: if they need your password, it is asked for next.') : null,
        // What a chosen kit cannot install here, and a service it leaves for you to start: said before the one yes.
        ...picked.flatMap((k) => (k.cannot || []).map((c) => h('p.hint', `${k.title}: ${c}`))),
        ...picked.filter((k) => k.commands.length && (k.start || []).length).flatMap((k) => [h('p.hint', `${k.title}: ${k.after}`), pre(k.start)]),
        ...picked.filter((k) => k.commands.length && k.after && !(k.start || []).length && k.id === 'php').map((k) => h('p.hint', `${k.title}: ${k.after}`)));
    };
    paint();
    return [
      h('div.rows.sj-kits', d.kits.map((k) =>
        h('label.row.static', { style: { cursor: 'pointer', alignItems: 'flex-start' } },
          h('input', { type: 'checkbox', checked: chosen.has(k.id), style: { width: '20px', height: '20px', marginTop: '2px', accentColor: 'var(--accent)' }, onchange: (e) => { if (e.target.checked) chosen.add(k.id); else chosen.delete(k.id); paint(); } }),
          h('span.row-main',
            h('span.row-title', k.title, k.defaultOn ? null : h('span.badge.soft', 'optional')),
            h('span.row-sub', { style: { whiteSpace: 'normal' } }, k.summary),
            h('span.row-sub', { style: { whiteSpace: 'normal' } }, k.items.map((i) => `${STATE[i.state] || '·'} ${i.name}${i.version ? ` ${i.version}` : ''}`).join('   ')),
            // Why a project here would use this optional kit; it stays unticked until you tick it.
            (k.suggested || []).length ? h('span.row-sub.sj-suggested', { style: { whiteSpace: 'normal' } }, `Suggested: ${k.suggested.join('; ')}`) : null,
            ...(k.notes || []).map((n) => h(`span.row-sub.sj-note.${n.verdict}`, { style: { whiteSpace: 'normal' } }, n.text)))))),
      // Java has no kit: Hoprig only looks for it and says what it found.
      d.java ? h('div.rows.sj-java', h('div.row.static',
        h('span.row-main', h('span.row-title', 'Java', h('span.badge.soft', 'not installed by Hoprig')),
          h('span.row-sub', { style: { whiteSpace: 'normal' } }, d.java.text),
          // Beside a Java that works only: when none works, its text already says what did not.
          ...(d.java.state === 'ok' ? d.java.broken || [] : []).map((b) => h('span.row-sub', { style: { whiteSpace: 'normal' } }, `Found but not working: ${b.place} (${b.why})`)),
          d.java.javaHome ? h('span.row-sub', { style: { whiteSpace: 'normal' } }, d.java.javaHomeHint, h('code.mono', { style: { display: 'block', wordBreak: 'break-all' } }, d.java.javaHome)) : d.java.javaHomeHint ? h('span.row-sub', { style: { whiteSpace: 'normal' } }, d.java.javaHomeHint) : null))) : null,
      d.leftOut ? h('p.hint', d.leftOut) : null,
      (d.notCovered || []).length ? h('p.hint', `${d.notCovered.join(' and ')}: not covered on Windows, so they are not offered here.`) : null,
      cmds,
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: () => close([...chosen]) }, 'Install')),
    ];
  });
  if (!kits || !kits.length) return;
  await startSetup('/api/pcsetup/setup', { kits }, { started });
}

async function recipeDownload() {
  const email = await openSheet({ title: 'Save as recipe', subtitle: 'Kits, the projects folder and repository addresses. No keys, no tokens.' }, (close) => [
    h('p.sheet-text', 'Put your commit e-mail in the recipe too?'),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close('no') }, 'Without e-mail'),
      h('button.btn.primary', { type: 'button', onclick: () => close('yes') }, 'With e-mail')),
  ]);
  if (!email) return;
  const r = await api(`/api/pcsetup/recipe${email === 'yes' ? '?email=1' : ''}`).catch((e) => toast(e, { kind: 'error' }));
  if (!r) return;
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r, null, 2) + '\n'], { type: 'application/json' })), download: `${COMMAND}-recipe.json` });
  a.click();
  toast(`Saved as ${COMMAND}-recipe.json in your downloads`);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function recipeApply(started) {
  const text = await promptSheet({ title: 'Set up from a recipe', text: 'Paste the recipe, or an https address of one. It is checked first: only known kits and Git addresses.', multiline: true, ok: 'Check and set up', check: (v) => (v.trim() ? '' : 'Paste a recipe or an address') });
  if (!text) return;
  const t = text.trim();
  await startSetup('/api/pcsetup/recipe', /^https:\/\//.test(t) ? { url: t } : { text: t }, { started });
}

export const isFine = (c) => c.status === 'ok' || (c.status === 'info' && !c.fixKit && !c.setupKit && !c.action && !c.note);
/** An optional extra (Docker, the working rules) offered with its button, or a note (a project's PHP version, the Java
 * search) that Hoprig cannot fix: shown with the optional ones, never counted as something to fix. */
export const isOptional = (c) => (c.status === 'info' && Boolean(c.fixKit || c.setupKit || c.action)) || (Boolean(c.note) && c.status !== 'ok');

/** The one sentence on top of Setup, from the checks: { fix, optional, offers, fine, text } (offers: the optional rows
 * with a button, the ones that are counted; a note is shown among them but is not an extra to want). */
export function setupSummary(checks) {
  const list = checks.filter((c) => c.group !== 'projects'); // the Workspace page shows those
  const fix = list.filter((c) => !isFine(c) && !isOptional(c));
  const optional = list.filter(isOptional);
  const fine = list.filter(isFine);
  const offers = optional.filter((c) => c.fixKit || c.setupKit || c.action);
  const text = fix.length ? `${fix.length} thing${fix.length === 1 ? '' : 's'} to fix` : 'Everything needed is installed';
  return { fix, optional, offers, fine, text };
}

/**
 * The line under "Could not check this computer": the reason (one period at its end), then the advice to look at
 * Overview only where that can help. A computer that no longer lets this dashboard in says so on Overview already,
 * and its reason says what to do.
 */
export function checkFailWords(e) {
  const why = String((e && e.message) || 'It did not answer').trim().replace(/[.\s]+$/, '');
  return e && e.code === 'computer-not-allowed' ? `${why}.` : `${why}. If it is another computer, see whether it answers on Overview, then check again.`;
}

/** What Setup shows when it could not check: the reason, and the button to the place its code names (Add a computer). */
export const checkFailParts = (e) => [h('strong', 'Could not check this computer'), h('span.hint', checkFailWords(e)), wayLink(e)];

const setupCache = new Map(); // computer → its last checks, so Setup draws at once when it is opened again

/** The Setup part of a computer's page (#/computer/setup): the result, what to fix, what is fine, the recipe. */
export function setupSection() {
  const key = machine.current || '~';
  const head = h('div.cp-result');
  const fixBox = h('div');
  const optionalBox = h('div');
  const fineBox = h('div');
  const checked = h('span.hint', { role: 'status' });
  const root = h('section.pcsetup.cp-part', { id: 'setup' });
  const job = setupJobCard({ onEnd: () => load() });
  let computerName = setupCache.has(key) ? setupCache.get(key).computer || null : null; // its name: a Fix's confirmation sends it
  const git = gitPanel();
  git.id = 'git'; // #/computer/setup?show=git (projects.js signInLink) lands here
  const started = () => job.start();

  // The commit name and the GitHub sign-in are not installs: their button opens the same sheet as Git and GitHub.
  const ASKED = { identity: { label: 'Set', icon: 'pencil', open: () => identitySheet({}) }, signin: { label: 'Sign in', icon: 'git', open: () => signinSheet() } };
  const askedButton = (c) => btn('small secondary', { icon: ASKED[c.id].icon, label: ASKED[c.id].label, onclick: async () => {
    if (await ASKED[c.id].open()) {
      load();
      git.refresh();
    }
  } });
  const fixRow = (c) => h('div.row.static.cp-check',
    h(`span.cp-mark.${c.status}`, { 'aria-label': c.note ? 'Note' : c.status === 'fail' ? 'Missing' : c.status === 'warn' ? 'Old' : 'Optional' }, MARK[c.status] || '·'),
    h('span.row-main.cp-wrap',
      h('span.row-title', c.label, h('span.badge.soft', GROUP_TITLES[c.group] || c.group)),
      h('span.row-sub', c.detail),
      c.fix && !c.fixKit && !c.setupKit && c.action !== 'claude-login' ? h('span.row-sub.mono', c.fix) : null), // the sign-in has its own button: no command to type
    // An optional kit (PHP + database, fvm, Docker): the Set up sheet with that kit ticked shows its commands first.
    c.setupKit ? btn('small secondary', { icon: 'download', label: 'Install…', title: `Shows what ${GROUP_TITLES[c.group] || c.setupKit} installs, then asks once`, onclick: () => setupSheet(started, c.setupKit) }) : null,
    c.group === 'kit:github' && ASKED[c.id] ? askedButton(c) : c.fixKit ? btn('small secondary', { icon: 'download', label: c.status === 'info' ? 'Install' : 'Fix', title: c.fix || `Install ${c.label}`, onclick: async (e) => {
      const b = e.currentTarget;
      const where = computerName || 'this computer';
      if (!(await confirmSheet({ title: `Fix "${c.label}" on ${where}?`, text: c.fix ? `It runs on ${where}: ${c.fix}` : `It runs the setup of that part on ${where}.`, ok: `Run it on ${where}` }))) return;
      b.disabled = true;
      if (!(await startSetup('/api/pcsetup/fix', { id: c.id, confirm: computerName }, { started }))) b.disabled = false;
    } }) : null,
    c.action === 'rules' ? btn('small secondary', { icon: 'plus', label: 'Add', title: 'Copy the working rules and import them from your CLAUDE.md', onclick: async () => {
      const r = await post('/api/pcsetup/rules', { action: 'add' });
      if (r) {
        toast(r.said.join(' · '), { ms: 8000 });
        load();
      }
    } }) : null,
    c.action === 'claude-login' ? claudeLoginButton(load) : null,
    // A coding tool Hoprig installs (OpenCode): into Hoprig's own tools folder, as a job on this page (its card shows the output).
    c.action === 'tool-install' ? btn('small secondary', { icon: 'download', label: 'Install', title: `Install ${c.label} into Hoprig's tools folder`, onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      const r = await post('/api/pcsetup/tool', { id: c.tool });
      if (r && r.started) started();
      else b.disabled = false;
    } }) : null);

  function paint(d) {
    const s = setupSummary(d.checks);
    fill(head,
      h(`span.cp-result-icon.${s.fix.length ? 'warn' : 'ok'}`, icon(s.fix.length ? 'alert' : 'check')),
      h('div.cp-result-text', h('strong', s.text), h('span.hint', s.fix.length ? 'Fix installs one thing; Set up this computer installs everything that is missing.' : `This computer has what is needed for coding.${s.offers.length ? ` ${s.offers.length} optional extra${s.offers.length === 1 ? ' is' : 's are'} below, if you want ${s.offers.length === 1 ? 'it' : 'them'}.` : ''}`)),
      // The main action only while something is missing; afterwards a quiet one (installing again is rare).
      btn(s.fix.length ? 'primary' : 'secondary', { icon: 'download', label: 'Set up this computer', onclick: () => setupSheet(started) }));
    fill(fixBox, s.fix.length ? h('div.rows', s.fix.map(fixRow)) : null);
    // Optional extras: closed until opened, each with its own button; they never make the result "to fix".
    fill(optionalBox, s.optional.length ? fold('computer-optional', s.offers.length ? `Optional · ${s.offers.length}` : 'Optional', h('div.rows', s.optional.map(fixRow))) : null);
    // What is fine, by group, folded: one line per group.
    const groups = [...new Set(s.fine.map((c) => c.group))];
    fill(fineBox, s.fine.length ? fold('computer-fine', `${s.fine.length} thing${s.fine.length === 1 ? ' is' : 's are'} fine`,
      h('div.rows', groups.map((g) => h('div.row.static.cp-check',
        h('span.cp-mark.ok', { 'aria-label': 'Fine' }, MARK.ok),
        h('span.row-main.cp-wrap', h('span.row-title', GROUP_TITLES[g] || g),
          h('span.row-sub', s.fine.filter((c) => c.group === g).map((c) => (String(c.detail).startsWith(c.label) ? c.detail : `${c.label} ${c.detail}`).trim()).join(' · '))))))) : null);
  }

  async function load() {
    fill(checked, 'Checking…');
    let d;
    try {
      d = await api('/api/pcsetup/status');
    } catch (e) {
      fill(checked);
      if (!setupCache.has(key)) {
        fill(head, h('span.cp-result-icon.warn', icon('alert')), h('div.cp-result-text', ...checkFailParts(e)));
      } else toast(e, { kind: 'error' });
      return;
    }
    setupCache.set(key, d);
    computerName = d.computer || null;
    paint(d);
    fill(checked, 'Checked just now');
  }

  const recipeActions = h('div.mrow-actions',
    btn('secondary', { icon: 'download', label: 'Save as recipe', onclick: recipeDownload }),
    btn('ghost', { icon: 'text', label: 'Set up from a recipe', onclick: () => recipeApply(started) }));

  if (setupCache.has(key)) paint(setupCache.get(key));
  else fill(head, h('span.cp-result-icon', h('div.spinner.small', { 'aria-hidden': 'true' })), h('div.cp-result-text', h('strong', 'Checking this computer…'), h('span.hint', 'What it has for coding, and what is missing.')));
  fill(root,
    h('section.card.panel.cp-resultcard', head, h('div.cp-recheck', checked, btn('small ghost', { icon: 'refresh', label: 'Check again', onclick: load }))),
    job.el,
    fixBox, optionalBox, fineBox,
    git,
    // The workspace's folders, its map and syncing live in Settings → Workspace; linking the brain to the coding tools
    // on the AI brain page (and in Get started and Skills while something is not linked).
    h('div.rows.ws-link', h('a.row', { href: link('#/settings/workspace') }, h('span.row-icon', icon('folder')),
      h('span.row-main', h('span.row-title', 'Workspace folders and the map'), h('span.row-sub', 'Settings → Workspace: the folder tree, every repository by its address, keeping it in step')),
      h('span.row-end', icon('chevronRight', { size: 18 })))),
    // Used once per new computer: closed until opened.
    fold('computer-recipe', 'Advanced: recipe for another computer',
      h('p.hint', 'Make your next computer like this one: save what is installed here, then use it there.'),
      recipeActions));
  load();
  return root;
}
