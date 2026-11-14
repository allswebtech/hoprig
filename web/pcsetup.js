// A computer's Setup (#/computer/setup): the system status of the computer shown (this one, or another one through
// the hub), "Set up this computer", and recipes (the projects have their own page: projects.js). Anything that may
// need the administrator password runs in a terminal session of the dashboard, where the owner types it: no
// password ever goes through this page.
import { APP_NAME, COMMAND } from './brand.js';
import { icon } from './icons.js';
import { api, btn, fill, h, link, machine, openSheet, promptSheet, toast } from './lib.js';
import { fold } from './shell.js';
import { workspaceFolders } from './brain.js';

const MARK = { ok: '✓', fail: '✗', warn: '!', info: '·' };
const STATE = { ok: '✓', missing: '✗', old: '!' };
const GROUP_TITLES = { system: 'This computer', 'kit:basics': 'Basics', 'kit:node': 'Node.js', 'kit:python': 'Python', 'kit:github': 'GitHub', 'kit:extras': 'Terminal extras', 'kit:docker': 'Docker', claude: 'Claude Code', projects: 'Projects' };
const goSession = (name) => {
  location.hash = link(`#/s/${encodeURIComponent(name)}`);
};

async function post(path, body) {
  try {
    return await api(path, body);
  } catch (e) {
    toast(e.message, { kind: 'error', ms: 6000 });
    return null;
  }
}

/** "Set up this computer": kits with checkboxes, the exact commands, ONE confirmation, then a terminal session. */
async function setupSheet() {
  let d;
  try {
    d = await api('/api/pcsetup/kits');
  } catch (e) {
    toast(e.message, { kind: 'error' });
    return;
  }
  const chosen = new Set(d.kits.filter((k) => k.defaultOn && k.items.some((i) => i.state === 'missing')).map((k) => k.id));
  const kits = await openSheet({ title: 'Set up this computer', subtitle: 'Choose what to install. What is already there is left alone.', wide: true }, (close) => {
    const cmds = h('div');
    const paint = () => {
      const list = d.kits.filter((k) => chosen.has(k.id)).flatMap((k) => k.commands);
      const admin = d.kits.some((k) => chosen.has(k.id) && k.admin);
      fill(cmds,
        h('h3.section-title', 'Will run'),
        list.length ? h('pre', { style: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: 'var(--surface-2)', padding: '8px 10px', borderRadius: '8px' } }, list.join('\n')) : h('p.hint', 'Nothing to install for these; sign-in steps still run.'),
        // The commands are the server's own (with sudo, or as root where there is none): the page adds no wording of its own.
        admin ? h('p.hint', `It opens in a terminal session: when it asks for a password, type it there. ${APP_NAME} never sees it.`) : null);
    };
    paint();
    return [
      h('div.rows', d.kits.map((k) =>
        h('label.row.static', { style: { cursor: 'pointer', alignItems: 'flex-start' } },
          h('input', { type: 'checkbox', checked: chosen.has(k.id), style: { width: '20px', height: '20px', marginTop: '2px', accentColor: 'var(--accent)' }, onchange: (e) => { if (e.target.checked) chosen.add(k.id); else chosen.delete(k.id); paint(); } }),
          h('span.row-main',
            h('span.row-title', k.title, k.defaultOn ? null : h('span.badge.soft', 'optional')),
            h('span.row-sub', { style: { whiteSpace: 'normal' } }, k.summary),
            h('span.row-sub', { style: { whiteSpace: 'normal' } }, k.items.map((i) => `${STATE[i.state] || '·'} ${i.name}${i.version ? ` ${i.version}` : ''}`).join('   ')))))),
      cmds,
      h('div.sheet-actions',
        h('button.btn.secondary', { type: 'button', onclick: () => close(null) }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: () => close([...chosen]) }, 'Install')),
    ];
  });
  if (!kits || !kits.length) return;
  const r = await post('/api/pcsetup/setup', { kits });
  if (r) goSession(r.session);
}

async function recipeDownload() {
  const email = await openSheet({ title: 'Save as recipe', subtitle: 'Kits, the projects folder and repository addresses. No keys, no tokens.' }, (close) => [
    h('p.sheet-text', 'Put your commit e-mail in the recipe too?'),
    h('div.sheet-actions',
      h('button.btn.secondary', { type: 'button', onclick: () => close('no') }, 'Without e-mail'),
      h('button.btn.primary', { type: 'button', onclick: () => close('yes') }, 'With e-mail')),
  ]);
  if (!email) return;
  const r = await api(`/api/pcsetup/recipe${email === 'yes' ? '?email=1' : ''}`).catch((e) => toast(e.message, { kind: 'error' }));
  if (!r) return;
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(r, null, 2) + '\n'], { type: 'application/json' })), download: `${COMMAND}-recipe.json` });
  a.click();
  toast(`Saved as ${COMMAND}-recipe.json in your downloads`);
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function recipeApply() {
  const text = await promptSheet({ title: 'Set up from a recipe', text: 'Paste the recipe, or an https address of one. It is checked first: only known kits and Git addresses.', multiline: true, ok: 'Check and set up', check: (v) => (v.trim() ? '' : 'Paste a recipe or an address') });
  if (!text) return;
  const t = text.trim();
  const r = await post('/api/pcsetup/recipe', /^https:\/\//.test(t) ? { url: t } : { text: t });
  if (r) goSession(r.session);
}

export const isFine = (c) => c.status === 'ok' || (c.status === 'info' && !c.fixKit && !c.action);

/** The one sentence on top of Setup, from the checks: { fix, fine, text }. */
export function setupSummary(checks) {
  const list = checks.filter((c) => c.group !== 'projects'); // the Workspace page shows those
  const fix = list.filter((c) => !isFine(c));
  const fine = list.filter(isFine);
  const text = fix.length ? `${fix.length} thing${fix.length === 1 ? '' : 's'} to fix` : 'Everything needed is installed';
  return { fix, fine, text };
}

const setupCache = new Map(); // computer → its last checks, so Setup draws at once when it is opened again

/** The Setup part of a computer's page (#/computer/setup): the result, what to fix, what is fine, the recipe. */
export function setupSection() {
  const key = machine.current || '~';
  const head = h('div.cp-result');
  const fixBox = h('div');
  const fineBox = h('div');
  const checked = h('span.hint', { role: 'status' });
  const root = h('section.pcsetup.cp-part', { id: 'setup' });

  const fixRow = (c) => h('div.row.static.cp-check',
    h(`span.cp-mark.${c.status}`, { 'aria-label': c.status === 'fail' ? 'Missing' : c.status === 'warn' ? 'Old' : 'Suggested' }, MARK[c.status] || '·'),
    h('span.row-main.cp-wrap',
      h('span.row-title', c.label, h('span.badge.soft', GROUP_TITLES[c.group] || c.group)),
      h('span.row-sub', c.detail),
      c.fix && !c.fixKit ? h('span.row-sub.mono', c.fix) : null),
    c.fixKit && c.status !== 'info' ? btn('small secondary', { icon: 'download', label: 'Fix', title: c.fix || `Install ${c.label}`, onclick: async (e) => {
      e.currentTarget.disabled = true;
      toast(`Opening a session that installs ${c.label}…`);
      const r = await post('/api/pcsetup/fix', { id: c.id });
      if (r) goSession(r.session);
      else e.currentTarget.disabled = false;
    } }) : null,
    c.action === 'rules' ? btn('small secondary', { icon: 'plus', label: 'Add', title: 'Copy the working rules and import them from your CLAUDE.md', onclick: async () => {
      const r = await post('/api/pcsetup/rules', { action: 'add' });
      if (r) {
        toast(r.said.join(' · '), { ms: 8000 });
        load();
      }
    } }) : null);

  function paint(d) {
    const s = setupSummary(d.checks);
    fill(head,
      h(`span.cp-result-icon.${s.fix.length ? 'warn' : 'ok'}`, icon(s.fix.length ? 'alert' : 'check')),
      h('div.cp-result-text', h('strong', s.text), h('span.hint', s.fix.length ? 'Fix installs one thing; Set up this computer installs everything that is missing.' : 'This computer has what is needed for coding with Claude Code.')),
      btn('primary', { icon: 'download', label: 'Set up this computer', onclick: setupSheet }));
    fill(fixBox, s.fix.length ? h('div.rows', s.fix.map(fixRow)) : null);
    // What is fine, by group, folded: one line per group.
    const groups = [...new Set(s.fine.map((c) => c.group))];
    fill(fineBox, s.fine.length ? fold('computer-fine', `${s.fine.length} thing${s.fine.length === 1 ? ' is' : 's are'} fine`,
      h('div.rows', groups.map((g) => h('div.row.static.cp-check',
        h('span.cp-mark.ok', { 'aria-label': 'Fine' }, MARK.ok),
        h('span.row-main.cp-wrap', h('span.row-title', GROUP_TITLES[g] || g),
          h('span.row-sub', s.fine.filter((c) => c.group === g).map((c) => `${c.label} ${c.detail}`.trim()).join(' · '))))))) : null);
  }

  async function load() {
    fill(checked, 'Checking…');
    let d;
    try {
      d = await api('/api/pcsetup/status');
    } catch (e) {
      fill(checked);
      if (!setupCache.has(key)) {
        fill(head, h('span.cp-result-icon.warn', icon('alert')), h('div.cp-result-text', h('strong', 'Could not check this computer'), h('span.hint', `${e.message}. If it is another computer, see whether it answers on Overview, then check again.`)));
      } else toast(e.message, { kind: 'error' });
      return;
    }
    setupCache.set(key, d);
    paint(d);
    fill(checked, 'Checked just now');
  }

  const recipeActions = h('div.mrow-actions',
    btn('secondary', { icon: 'download', label: 'Save as recipe', onclick: recipeDownload }),
    btn('ghost', { icon: 'text', label: 'Set up from a recipe', onclick: recipeApply }));

  if (setupCache.has(key)) paint(setupCache.get(key));
  else fill(head, h('span.cp-result-icon', h('div.spinner.small', { 'aria-hidden': 'true' })), h('div.cp-result-text', h('strong', 'Checking this computer…'), h('span.hint', 'What it has for coding, and what is missing.')));
  fill(root,
    h('section.card.panel.cp-resultcard', head, h('div.cp-recheck', checked, btn('small ghost', { icon: 'refresh', label: 'Check again', onclick: load }))),
    fixBox, fineBox,
    workspaceFolders(),
    h('h2.section-title', 'Recipe'),
    h('p.hint', 'Make your next computer like this one: save what is installed here, then use it there.'),
    recipeActions);
  load();
  return root;
}
