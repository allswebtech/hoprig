// Skills (#/skills, #/skills/<project folder>), the second tab of Projects: Claude Code skills on the open computer, for
// you (every project) or, from a project's page, for that one project. ONE list: a search box, Installed (a press opens
// the row's sheet: source, Update with the diff, Remove with Undo), Worth adding (what the catalog and the weekly look
// suggest and is not installed), Drafts from your work (skilllearned.js, only while some wait). Every add or update
// opens the review sheet first (files, what the scan found, the full SKILL.md, the diff of an update): Review, then
// Install. The learn settings, the tools some skills need and the update check wait under Advanced. The old addresses
// #/skills/installed, /suggested, /find and /learned open this list with that part in view.
export { projectsTabs };
import { APP_NAME, COMMAND } from './brand.js';
import { projectsTabs } from './brainlink.js';
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, link, openSheet, prefs, tildePath, toast } from './lib.js';
import { registerPage } from './registry.js';
import { learnSettings, paintLearned } from './skilllearned.js';
import { paintProposals } from './skillproposals.js';
import { errorBox, fold, groupHead, listRow, panel, skeletonRows as skeleton, toggle } from './shell.js';
import { store } from './store.js';

const SEV = { block: ['var(--danger-soft)', 'var(--danger)'], high: ['var(--danger-soft)', 'var(--danger)'], medium: ['var(--warn-soft)', 'var(--warn)'], low: ['var(--surface-3)', 'var(--text-2)'] };
const PARTS = [['installed', 'Installed'], ['suggested', 'Suggested'], ['find', 'Find'], ['learned', 'Learned']];
const enc = encodeURIComponent;

const tag = (sev, text = sev) => h('span.badge.sk-sev', { style: { background: SEV[sev][0], color: SEV[sev][1] } }, text);
const short = (s) => (!s ? '' : s.type === 'bundled' ? `bundled with ${APP_NAME} ${s.version}` : `${s.repo || s.url}${s.path ? `/${s.path}` : ''} @ ${String(s.commit).slice(0, 7)}`);
const oneLine = (t, n = 160) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Where an installed skill came from, in words. */
const origin = (s) => (s.learned ? `Learned from your work${s.learned.on ? ` on ${s.learned.on}` : ''}` : s.managed ? (s.source && s.source.type === 'bundled' ? `Comes with ${APP_NAME}` : `From ${(s.source && (s.source.repo || s.source.url)) || 'a reviewed source'}`)
  : s.viaSkillsCli ? `From ${s.viaSkillsCli.source} (added with the skills command)` : `Added by hand, not through ${APP_NAME}`);

/** The diff of an update: removed / added / changed files, the changed lines coloured. */
function diffView(d) {
  const lines = [];
  for (const f of d.removed) lines.push(h('div', { style: { color: '#ff9492' } }, `removed: ${f.path}`));
  for (const [label, list] of [['added', d.added], ['changed', d.changed]]) {
    for (const f of list) {
      lines.push(h('div', { style: { fontWeight: '650', marginTop: '6px' } }, `${label}: ${f.path}`));
      if (!f.hunks) lines.push(h('div', 'binary or too large to show line by line'));
      for (const hk of f.hunks || []) {
        lines.push(h('div', { style: { color: '#8b95a7' } }, `@@ -${hk.oldStart} +${hk.newStart} @@`));
        for (const [op, text] of hk.lines) lines.push(h('div', { style: { color: op === '+' ? '#7ee787' : op === '-' ? '#ff9492' : '#d7dae0', whiteSpace: 'pre-wrap' } }, `${op}${text}`));
      }
    }
  }
  return h('div.output', { style: { maxHeight: '320px' } }, lines.length ? lines : 'No file changed.');
}

/** The review sheet. Resolves true when the skill was installed or updated. */
async function reviewSheet(r) {
  let approved = false;
  const update = r.kind === 'update';
  await openSheet({ title: `${update ? 'Update' : 'Review'} "${r.name || '?'}"`, subtitle: r.scope.kind === 'user' ? 'For you, in every project' : `For the project ${r.scope.project}`, wide: true }, (close) => {
    const err = h('p.form-error', { role: 'alert' });
    let overwrite = false;
    const blocked = r.counts.block > 0;
    const approveBtn = h('button.btn.primary', { type: 'button', disabled: blocked, onclick: async () => {
      approveBtn.disabled = true;
      approveBtn.textContent = update ? 'Updating…' : 'Installing…';
      try {
        await api('/api/skillhub/approve', { id: r.id, overwriteLocal: overwrite });
        approved = true;
        close(true);
      } catch (e) {
        err.textContent = e.message;
        approveBtn.disabled = false;
        approveBtn.textContent = update ? 'Update' : 'Install';
      }
    } }, blocked ? 'Cannot install' : update ? 'Update' : 'Install');
    const s = r.source;
    const risky = r.counts.block + r.counts.high;
    return h('div.sk-review',
      h('p.sheet-text', oneLine(r.description, 400) || 'No description.'),
      h('div', risky ? tag('high', `${risky} thing${risky > 1 ? 's' : ''} to look at`) : tag('low', 'Nothing risky found'),
        r.catalog ? (r.pinned ? tag('low', 'In the reviewed catalog') : tag('medium', 'Newer than the catalog\'s reviewed version')) : tag('medium', 'Not from the catalog: read it all')),
      h('p.hint', 'A skill is instructions (and sometimes scripts) your coding tool follows with your permissions. Read what it says below before you install it.'),
      h('div.rows', h('div.row.static.col',
        h('span.sk-mono', `Source: ${short(s)}`),
        s.commit ? h('span.sk-mono', `Commit: ${s.commit}`) : null,
        h('span', `License: ${r.license}`),
        r.catalog && r.catalog.notes ? h('span.hint', r.catalog.notes) : null,
        hubLine(r),
        r.from ? h('span.sk-mono', `From ${String(r.from.commit || r.from.version).slice(0, 12)} to ${String(s.commit || s.version).slice(0, 12)}`) : null)),
      r.diff ? [h('h3.sk-h3', 'What changed'), diffView(r.diff)] : null,
      h('h3.sk-h3', 'What the scan found'),
      h('p.sk-tags', ...['block', 'high', 'medium', 'low'].map((k) => tag(k, `${r.counts[k]} ${k === 'block' ? 'blocking' : k}`))),
      r.findings.length ? h('div.rows', { style: { maxHeight: '300px', overflow: 'auto' } }, r.findings.map((f) =>
        h('div.row.static.col', { style: { gap: '4px' } },
          h('span', tag(f.severity), f.new ? tag('medium', 'new') : null, h('span', { style: { marginLeft: '8px', fontWeight: '600' } }, f.message)),
          h('span.hint.sk-mono', `${f.file}${f.line ? `:${f.line}` : ''}`),
          f.excerpt ? h('code.sk-mono', { style: { background: SEV[f.severity][0], padding: '4px 6px', borderRadius: '6px' } }, f.excerpt) : null)))
        : h('p.hint', 'Nothing risky found. The scan points at lines; it cannot prove a skill safe.'),
      r.localEdits && r.localEdits.length ? h('label.toggle-line', h('input', { type: 'checkbox', onchange: (e) => (overwrite = e.target.checked) }), `Replace my edits here (${r.localEdits.join(', ')}); they are kept for undo`) : null,
      h('h3.sk-h3', 'SKILL.md: what your coding tool will read'),
      h('pre.output', { style: { maxHeight: '360px' } }, r.skillMd),
      h('h3.sk-h3', `Files (${r.files.length}, ${Math.max(1, Math.round(r.total / 1024))} KB)`),
      h('div.sk-mono.sk-files', r.files.map((f) =>
        h('div', h('span.sk-size', String(f.size)), h('span', f.path), f.kind !== 'text' ? tag(f.kind === 'binary' || f.kind === 'symlink' ? 'high' : f.kind === 'script' ? 'medium' : 'low', f.kind) : null))),
      err,
      h('div.sheet-actions', h('button.btn.secondary', { type: 'button', onclick: () => close(false) }, 'Cancel'), approveBtn));
  });
  if (!approved) api('/api/skillhub/cancel', { id: r.id }).catch(() => {});
  return approved;
}

/** A list of at most `n` rows, then one Show more (never a page of fifty rows). */
const capped = (items, draw, n = 20) => {
  const box = h('div.rows', items.slice(0, n).map(draw));
  if (items.length <= n) return box;
  const more = btn('small secondary', { label: `Show ${items.length - n} more`, onclick: () => {
    fill(box, items.map(draw));
    more.parentElement.remove();
  } });
  return [box, h('div.savebar.start', more)];
};

function viewSkills({ frame, sub }) {
  store.viewing = null;
  // #/skills, #/skills/<project folder> (a project's page links here), and the four old parts: #/skills/installed,
  // /suggested, /find and /learned (also with a project folder after them) open the one list with that part in view.
  const [first = '', ...rest] = sub ? sub.split('/') : [];
  const named = PARTS.some(([id]) => id === first);
  const want = named ? first : '';
  const project = decodeURIComponent(named ? rest.join('/') : sub || '');
  let alive = true;
  let data = null; // GET /api/skillhub
  let suggest = null; // GET /api/skillhub/suggest
  let worth = null; // GET /api/skillhub/worth: the hub skills that fit your projects
  let corrected = {}; // his corrections per skill this week (GET /api/operator/corrections): shown only
  let updates = new Map(); // "user:name" | "project:name" → the check's answer
  let notice = null; // { text, undo } after a remove or an update
  let projects = []; // [{ path, name }] to name the project

  const tabs = projectsTabs('skills');
  const scopeLine = project ? h('p.hint.sk-scope', 'Skills for ', h('strong', project.split(/[\\/]/).pop()), ' · ', h('a', { href: link('#/skills') }, 'All your skills')) : null;
  const installedBox = h('div.sk-part');
  const worthBox = h('div.sk-part');
  const draftsBox = h('div'); // drafts waiting (skilllearned.js, quiet): nothing when none wait
  const proposalsBox = h('div'); // proposed changes to Tia's own texts (skillproposals.js); empty when there are none
  const foundBox = h('div.sk-found', { 'aria-live': 'polite' });
  const toolsBox = h('div', h('p.hint', 'Looking…'));
  const learnBox = h('div');
  const weeklyBox = h('div');
  const checkBox = h('div');
  const ideasBox = h('div');
  const advanced = fold('skills', 'Advanced',
    learnBox,
    panel({ icon: 'terminal', title: 'Tools these skills use', desc: 'Some skills need a program on this computer. It is installed or updated only when you press the button.' }, toolsBox),
    checkBox,
    weeklyBox,
    ideasBox,
    h('p.hint', 'Each skill is first downloaded to a place apart, kept at the exact version you saw, and shown in full before you install it.'));
  const query = h('input.field', { type: 'search', placeholder: 'Search skills', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search skills' });
  const form = h('form.inlineform.sk-search', { style: { marginBottom: '14px' } });
  frame({
    title: 'Skills',
    page: 'skills',
    body: [tabs, scopeLine, form, foundBox, installedBox, worthBox, draftsBox, project ? null : proposalsBox, advanced],
  });

  if (!project) paintProposals(proposalsBox, { diffView, tag });

  const scopeName = () => (project ? (projects.find((p) => p.path === project) || {}).name || project.split(/[\\/]/).pop() : '');
  const installedNames = () => new Set([...(data ? data.user.skills : []), ...(data && data.project ? data.project.skills : [])].map((s) => s.name));

  // ---------- Installed ----------
  async function startReview(body, button) {
    const label = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Opening…';
    }
    try {
      const r = await api(body.name ? '/api/skillhub/update-review' : '/api/skillhub/review', body);
      if (await reviewSheet(r)) {
        toast(`${r.name}: ${r.kind === 'update' ? 'updated' : 'installed'}`);
        updates.delete(`${r.scope.kind}:${r.name}`);
        if (r.kind === 'update') notice = { text: `${r.name} was updated.`, undo: { name: r.name, ...(r.scope.kind === 'project' ? { project } : {}) } };
        await load();
      }
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
    } finally {
      if (button && button.isConnected) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }

  /** A row: the name, one line, a tag when an update waits; a press opens its sheet (source, update, remove). */
  const skillRow = (s, scope) => {
    const u = updates.get(`${scope}:${s.name}`);
    const body = scope === 'project' ? { name: s.name, project } : { name: s.name };
    const sheet = () => openSheet({ title: s.name, subtitle: scope === 'project' ? `For the project ${scopeName()}` : 'For you, in every project' }, (close) => [
      h('p.sheet-text', oneLine(s.description, 400) || 'No description.'),
      h('p.hint', origin(s)),
      scope === 'user' && data.user.dir ? h('p.hint.sk-where', `Kept in ${tildePath(data.user.dir, data.home)}.`) : null,
      s.edited.length ? h('p', tag('low', 'changed here')) : null,
      corrected[s.name] ? h('p.hint.sk-corrected', `You took this back ${corrected[s.name]} time${corrected[s.name] === 1 ? '' : 's'} this week. Only shown to you; nothing changes by itself from it.`) : null,
      h('div.sheet-actions',
        btn('secondary', { icon: 'trash', label: 'Remove', onclick: async () => {
          close();
          if (!(await confirmSheet({ title: `Remove "${s.name}"?`, text: 'Your coding tools stop using it. A copy is kept, so you can bring it back.', ok: 'Remove', danger: true }))) return;
          try {
            await api('/api/skillhub/remove', body);
            notice = { text: `${s.name} was removed.`, undo: body };
            await load();
          } catch (e) {
            toast(e, { kind: 'error' });
          }
        } }),
        u && u.state === 'update' ? btn('primary', { icon: 'download', label: 'Update', onclick: (e) => {
          close();
          startReview(body, e.currentTarget);
        } }) : null)]);
    return listRow({ onclick: sheet, icon: 'sparkle',
      title: [s.name, u && u.state === 'update' ? tag('medium', 'update available') : null],
      sub: oneLine(s.description, 90) || 'No description.' });
  };

  function checkButton() {
    const said = h('span.hint.sk-said', { role: 'status' });
    const b = btn('small secondary', { icon: 'refresh', label: 'Check for updates', onclick: async () => {
      b.disabled = true;
      said.textContent = 'Checking…';
      try {
        const r = await api('/api/skillhub/check', project ? { project } : {});
        updates = new Map([...r.user.map((u) => [`user:${u.name}`, u]), ...(r.project || []).map((u) => [`project:${u.name}`, u])]);
        const n = [...updates.values()].filter((u) => u.state === 'update').length;
        said.textContent = '';
        b.disabled = false;
        paintInstalled();
        toast(n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything is up to date');
      } catch (e) {
        said.textContent = e.message;
        b.disabled = false;
      }
    } });
    return h('div.sk-bar', said, b);
  }

  function paintInstalled() {
    if (!data) return fill(installedBox, skeleton(2));
    const here = data.project ? data.project.skills : [];
    const mine = data.user.skills;
    const undo = notice && notice.undo ? btn('small secondary', { icon: 'refresh', label: 'Undo', onclick: async () => {
      try {
        await api('/api/skillhub/undo', notice.undo);
        notice = { text: 'Undone.' };
        await load();
      } catch (e) {
        toast(e, { kind: 'error' });
      }
    } }) : null;
    const banner = notice ? h('div.banner.ok-box.sk-notice', { role: 'status' }, icon('check', { size: 18 }), h('span', notice.text), undo) : null;
    fill(installedBox, banner,
      project && here.length ? [groupHead('In this project', here.length), capped(here, (s) => skillRow(s, 'project'))] : null,
      mine.length ? [groupHead(project ? 'For you, in every project' : 'Installed', mine.length), capped(mine, (s) => skillRow(s, 'user'))] : null,
      project ? fitPart(project, { review: startReview, reload: load }) : null);
  }

  // ---------- Worth adding: what the catalog suggests for you and what the weekly look found, not yet installed ----------
  function paintWorth() {
    if (!suggest) return fill(worthBox, skeleton(2));
    if (suggest.error) return fill(worthBox, errorBox(suggest.error));
    const have = installedNames();
    const picks = suggest.suggestions.filter((x) => !x.installed && !have.has(x.name));
    const finds = (worth ? worth.results : []).filter((x) => !have.has(x.name) && !picks.some((p) => p.name === x.name));
    const items = [...picks.map((x) => ({ name: x.name, tagline: oneLine(x.for, 110), why: x.why, badge: project ? (x.scope === 'user' ? 'for you' : 'this project') : null,
      go: (e) => startReview({ spec: x.id, project, scope: x.scope }, e.currentTarget) })),
    ...finds.map((x) => ({ name: x.name, tagline: oneLine(x.description, 110), why: x.why, badge: `from ${x.hubName}`, go: (e) => startReview(hubBody(x, x.project), e.currentTarget).then(loadWorth) }))];
    const row = (x) => h('div.row.static.col.mrow.sk-row',
      h('div.mrow-top', h('span.row-icon', icon('sparkle')),
        h('span.row-main',
          h('span.row-title', x.name, x.badge ? h('span.badge.soft', x.badge) : null),
          x.tagline ? h('span.row-sub.sk-wrap', x.tagline) : null,
          x.why && x.why.length ? h('span.row-sub.sk-wrap.sk-why', `Why: ${x.why.join('; ')}`) : null),
        h('span.sk-act', btn('small primary', { icon: 'download', label: 'Review', onclick: x.go }))));
    const seen = Object.keys(suggest.stacks || {}).filter((k) => k !== 'code');
    fill(worthBox,
      items.length ? [groupHead('Worth adding', items.length), project && seen.length ? h('p.hint', `Picked for ${scopeName()} from what is in it: ${seen.join(', ')}.`) : null, capped(items, row)] : null,
      worth && worth.lines.length ? h('p.hint.sk-wrap', `Not read this time: ${worth.lines.join('; ')}`) : null,
      !items.length && data && !installedNames().size ? h('p.hint', 'No skills yet. Search above to add one.') : null);
    fill(ideasBox, suggest.ideas && suggest.ideas.length ? h('p.hint', 'Also worth a search: ', suggest.ideas.map((i) => i.replace(`${COMMAND} skills find `, '')).map((w, n) => [n ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); query.value = w; form.requestSubmit(); window.scrollTo?.({ top: 0 }); } }, w)])) : null);
  }

  // ---------- Search: the reviewed catalog, the hubs and skills.sh ----------
  let found = null;
  const item = (title, sub, meta, spec) => h('div.row.static.col.mrow.sk-row',
    h('div.mrow-top', h('span.row-icon', icon('book')),
      h('span.row-main', h('span.row-title', title), sub ? h('span.row-sub.sk-wrap', sub) : null, h('span.row-sub.sk-wrap.sk-mono', meta)),
      spec ? h('span.sk-act', btn('small secondary', { icon: 'download', label: 'Review', onclick: (e) => startReview({ spec, project, scope: project ? 'project' : 'user' }, e.currentTarget) })) : null));
  function paintFound() {
    if (!found) return fill(foundBox);
    if (found.busy) return fill(foundBox, skeleton(2));
    if (found.error) return fill(foundBox, errorBox(found.error));
    const r = found.r;
    fill(foundBox,
      r.catalog.length ? [h('p.field-label', 'From the catalog (reviewed)'), capped(r.catalog, (c) => item(c.name, c.for, `${c.source} · ${c.license}`, c.add))] : null,
      hubFound(r.hubs, (body, b) => startReview({ ...body, ...(project ? { project, scope: 'project' } : { scope: 'user' }) }, b)),
      h('p.field-label', 'From skills.sh'),
      r.error ? h('p.hint', r.error) : null,
      r.online.length ? capped(r.online, (o) => item(o.name, null, `${o.source} · ${o.installs.toLocaleString()} installs${o.license ? ` · ${o.license}` : ''}`, o.add)) : h('p.hint', 'Nothing found there.'),
      h('p.hint', 'Anything from skills.sh is shown in full before it is installed.'));
  }
  fill(form, query, btn('primary', { icon: 'search', label: 'Search', type: 'submit' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = query.value.trim();
    if (!q) {
      found = null;
      return paintFound();
    }
    if (/^[\w.-]+\/[\w.-]+(\/|@|$)|^https?:\/\/|^git@/.test(q)) return startReview({ spec: q, project, scope: project ? 'project' : 'user' }, e.submitter);
    found = { busy: true };
    paintFound();
    try {
      found = { r: await api(`/api/skillhub/find?q=${enc(q)}`) };
    } catch (er) {
      found = { error: er.message };
    }
    if (alive) paintFound();
  });
  query.addEventListener('input', () => {
    if (!query.value.trim() && found) {
      found = null;
      paintFound();
    }
  });

  // Drafts waiting: the drafts group paints itself (and polls while a draft is tried); nothing shows when none wait.
  let learned = null;
  if (!project) learned = paintLearned(draftsBox, { diffView, tag, quiet: true });

  /** An old address names a part: it is put in view once, after the page has its rows. */
  let revealed = false;
  function reveal() {
    if (revealed || !want || !data || !suggest) return;
    revealed = true;
    if (want === 'find') query.focus();
    else if (want === 'suggested') worthBox.scrollIntoView?.({ block: 'start' });
    else if (want === 'learned') {
      advanced.open = true;
      advanced.addEventListener('toggle', () => prefs.set('fold.skills', false), { once: true }); // opened by the address, not remembered
      (draftsBox.firstChild ? draftsBox : advanced).scrollIntoView?.({ block: 'start' });
    }
  }

  // ---------- data ----------
  async function load() {
    try {
      data = await api(`/api/skillhub${project ? `?project=${enc(project)}` : ''}`);
    } catch (e) {
      if (alive) fill(installedBox, errorBox(e), btn('secondary', { icon: 'refresh', label: 'Try again', onclick: load }));
      return;
    }
    if (!alive) return;
    try {
      corrected = (await api('/api/operator/corrections')).week.skill || {};
    } catch {
      corrected = {}; // another computer, or an older one: nothing to show
    }
    fill(weeklyBox, toggle('Look for updates and new skills once a week', data.settings.weekly, (v) => api('/api/skillhub/settings', { weekly: v }).catch((er) => {
      toast(er.message, { kind: 'error' });
      throw er;
    }), `Once a week, look for updates of your skills and for new skills from the reviewed hubs that fit your projects. It only tells you; nothing is added without you.${data.settings.lastCheck ? ` Last check: ${new Date(data.settings.lastCheck).toLocaleDateString()}.` : ''}`));
    fill(checkBox, checkButton());
    paintInstalled();
    paintWorth();
    try {
      suggest = await api(`/api/skillhub/suggest${project ? `?project=${enc(project)}` : ''}`);
    } catch (e) {
      suggest = { error: e.message, suggestions: [] };
    }
    if (!alive) return;
    paintWorth();
    if (!project) await loadWorth();
    reveal();
  }

  async function loadWorth() {
    try {
      worth = await api('/api/skillhub/worth');
    } catch {
      worth = null; // another computer, or an older one: nothing to show
    }
    if (!alive) return;
    if (suggest) paintWorth();
    reveal();
  }

  /** The project's name, from the projects of this computer. */
  async function loadProjects() {
    const pj = await api('/api/pcsetup/projects').catch(() => null);
    if (!alive || !pj) return;
    projects = [...pj.workspaces.map((w) => ({ path: w.dir, name: w.name })), ...pj.repos.map((r) => ({ path: r.dir, name: r.rel }))];
    if (scopeLine) fill(scopeLine, 'Skills for ', h('strong', scopeName()), ' · ', h('a', { href: link('#/skills') }, 'All your skills'));
    if (data) paintInstalled();
  }

  advanced.addEventListener('toggle', function once() {
    if (!advanced.open) return;
    advanced.removeEventListener('toggle', once);
    paintTools();
    if (!project) fill(learnBox, learnSettings(() => learned && learned.refresh()));
  });
  async function paintTools() {
    try {
      const { tools } = await api('/api/skillhub/tools');
      if (!alive) return;
      fill(toolsBox, tools.length ? h('div.rows', tools.map((t) =>
        h('div.row.static.col.mrow.sk-row',
          h('div.mrow-top', h('span.row-icon', icon('terminal')),
            h('span.row-main', h('span.row-title', t.bin, t.updateAvailable ? tag('medium', 'update available') : null),
              h('span.row-sub.sk-wrap', `${t.installed ? `Installed${t.version ? ` (${t.version})` : ''}` : 'Not installed'} · needed by ${t.for}${t.latest ? ` · newest ${t.latest}` : ''}`)),
            !t.installed || t.updateAvailable ? h('span.sk-act', btn('small secondary', { icon: 'download', label: t.installed ? 'Update' : 'Install', onclick: async (e) => {
              if (!(await confirmSheet({ title: `${t.installed ? 'Update' : 'Install'} ${t.bin}?`, text: `This runs: ${t.commandText}`, ok: 'Run it' }))) return;
              const b = e.currentTarget;
              b.disabled = true;
              b.textContent = 'Running…';
              try {
                const r = await api(`/api/skillhub/tools/${t.id}/update`, {});
                toast(r.ok ? `${t.bin}: done` : `${t.bin}: that did not work`, { kind: r.ok ? 'info' : 'error' });
              } catch (er) {
                toast(er.message, { kind: 'error' });
              }
              paintTools();
            } })) : null)))) : h('p.hint', 'None of the skills here needs a tool.'));
    } catch (e) {
      fill(toolsBox, errorBox(e));
    }
  }
  if (advanced.open) {
    paintTools();
    if (!project) fill(learnBox, learnSettings(() => learned && learned.refresh()));
  }

  paintInstalled();
  load();
  loadProjects();
  return () => {
    alive = false;
    if (learned) learned.stop();
  };
}

registerPage({ id: 'skills', title: 'Skills', icon: 'book', navAs: 'workspace', order: 20, perComputer: true, render: viewSkills });

// ---------- Worth adding: skills from the reviewed hubs that fit your projects (src/skillhub/hubs.mjs) ----------

/** The review request of a hub skill: the hub, its folder and the commit the weekly look read. */
const hubBody = (x, project) => ({ hub: x.hub, path: x.path, commit: x.commit, ...(project ? { project, scope: 'project' } : { scope: 'user' }) });

/** The hub skills a search found among the ones the last weekly look read, each with Review. */
function hubFound(list, review) {
  if (!list || !list.length) return null;
  return [h('p.field-label', 'From the reviewed hubs'), h('div.rows', list.map((x) => h('div.row.static.col.mrow.sk-row',
    h('div.mrow-top', h('span.row-icon', icon('book')),
      h('span.row-main', h('span.row-title', x.name), x.description ? h('span.row-sub.sk-wrap', x.description) : null,
        h('span.row-sub.sk-wrap.sk-mono', `${x.hubName} · ${x.path} · the hub's licence: ${x.license}`)),
      h('span.sk-act', btn('small secondary', { icon: 'download', label: 'Review', onclick: (e) => review(hubBody(x, null), e.currentTarget) }))))))];
}

/** In the review sheet of a hub skill: the hub, its licence, and the skill's own licence or the NOTICE it gets. */
function hubLine(r) {
  if (!r.hub) return null;
  return h('span', `From the hub ${r.hub.name}, whose licence is ${r.hub.license}. ${r.hub.own ? `The skill's own licence: ${r.hub.own}.` : 'The skill has no licence of its own, so a NOTICE file with the hub\'s licence is added to it.'}`);
}

/**
 * A project's "Fits its technology" (src/skillhub/fit.mjs): the switch "Add skills that fit this project's technology"
 * (his choice for the project, kept in Hoprig's state) and the last fit's three lists: already yours (nothing copied),
 * added by itself (Undo takes it out, kept for undo; Put back brings it again), waiting for you (Review shows every
 * file, then Install). review(body, button): the page's review sheet; reload(): the page again. → the element.
 */
export function fitPart(project, { review, reload, call = api } = {}) {
  const el = h('section.card.panel.sk-fit', h('h2.panel-title', 'Fits its technology'), h('p.hint', 'Looking…'));
  const row = (x, sub, act) => h('div.row.static.col.mrow.sk-row',
    h('div.mrow-top', h('span.row-icon', icon(x.here ? 'check' : 'sparkle')),
      h('span.row-main', h('span.row-title', x.name), sub ? h('span.row-sub.sk-wrap', sub) : null,
        x.why && x.why.length ? h('span.row-sub.sk-wrap.sk-why', `Why: ${x.why.join('; ')}`) : null),
      act ? h('span.sk-act', act) : null));
  const press = (label, ic, path, x, kind = 'secondary') => btn(`small ${kind}`, { icon: ic, label, onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      await call(path, { name: x.name, project });
      await reload();
    } catch (er) {
      toast(er, { kind: 'error' });
      paint();
    }
  } });
  const list = (title, items, draw) => [h('p.field-label', `${title} (${items.length})`), items.length ? h('div.rows', items.map(draw)) : h('p.hint', 'None.')];
  let d = null;
  function paint(err = null) {
    if (err) return fill(el, h('h2.panel-title', 'Fits its technology'), errorBox(err));
    const sw = toggle('Add skills that fit this project\'s technology', d.fit, async (v) => {
      d = await call('/api/skillhub/fit/choice', { project, fit: v });
      paint();
    }, 'Text-only skills from your own and from the reviewed catalog go in by themselves, with Undo; anything else waits for you. Hoprig looks when the project is made and once more when it first has code.');
    const seen = d.at || d.mine.length || d.added.length || d.waiting.length;
    fill(el, h('h2.panel-title', 'Fits its technology'), sw,
      !seen ? h('p.hint', d.fit ? 'Nothing looked for yet: Hoprig looks once the project has code.' : 'Nothing looked for: the switch is off.') : [
        ...list('Already yours', d.mine, (x) => row(x, 'One of your own skills, used in every project: nothing was copied.')),
        ...list('Added by itself', d.added, (x) => row(x, x.here ? x.for : `${x.for} Taken out.`, x.here ? press('Undo', 'refresh', '/api/skillhub/remove', x) : press('Put back', 'refresh', '/api/skillhub/undo', x))),
        ...list('Waiting for you', d.waiting, (x) => row(x, [x.for, x.reasons && x.reasons.length ? ` Not added by itself: ${x.reasons.join('; ')}.` : ''].join(''), x.here ? h('span.badge.sk-done', 'Installed')
          : btn('small primary', { icon: 'download', label: 'Review', onclick: (e) => review({ spec: x.id, project, scope: 'project' }, e.currentTarget) }))),
      ]);
  }
  call(`/api/skillhub/fit?project=${enc(project)}`).then((r) => {
    d = r;
    paint();
  }, (e) => paint(e));
  return el;
}
