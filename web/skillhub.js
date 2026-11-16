// Skills (#/skills, #/skills/<project folder>): Claude Code skills on the open computer, for you (every project) or
// for one project, picked on top ("Skills for:"). Three parts: Installed (Update with the diff, Remove with Undo),
// Suggested (the catalog's picks with the reason), Find (the catalog and skills.sh). Every add or update opens the
// review sheet first (files, what the scan found, the full SKILL.md, the diff of an update): Review, then Install.
// The tools some skills need and the weekly update check wait under Advanced.
import { APP_NAME, COMMAND } from './brand.js';
import { linkBrainNote } from './brainlink.js';
import { icon } from './icons.js';
import { api, btn, confirmSheet, fill, h, link, openSheet, prefs, promptSheet, tildePath, toast } from './lib.js';
import { registerPage } from './registry.js';
import { emptyState, errorBox, fold, panel, skeletonRows as skeleton, tabBar, toggle } from './shell.js';
import { store } from './store.js';

const SEV = { block: ['var(--danger-soft)', 'var(--danger)'], high: ['var(--danger-soft)', 'var(--danger)'], medium: ['var(--warn-soft)', 'var(--warn)'], low: ['var(--surface-3)', 'var(--text-2)'] };
const PARTS = [['installed', 'Installed'], ['suggested', 'Suggested'], ['find', 'Find']];
const enc = encodeURIComponent;

const tag = (sev, text = sev) => h('span.badge.sk-sev', { style: { background: SEV[sev][0], color: SEV[sev][1] } }, text);
const short = (s) => (!s ? '' : s.type === 'bundled' ? `bundled with ${APP_NAME} ${s.version}` : `${s.repo || s.url}${s.path ? `/${s.path}` : ''} @ ${String(s.commit).slice(0, 7)}`);
const oneLine = (t, n = 160) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Where an installed skill came from, in words. */
const origin = (s) => (s.managed ? (s.source && s.source.type === 'bundled' ? `Comes with ${APP_NAME}` : `From ${(s.source && (s.source.repo || s.source.url)) || 'a reviewed source'}`)
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
      h('p.hint', 'A skill is instructions (and sometimes scripts) Claude Code follows with your permissions. Read what it says below before you install it.'),
      h('div.rows', h('div.row.static.col',
        h('span.sk-mono', `Source: ${short(s)}`),
        s.commit ? h('span.sk-mono', `Commit: ${s.commit}`) : null,
        h('span', `License: ${r.license}`),
        r.catalog && r.catalog.notes ? h('span.hint', r.catalog.notes) : null,
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
      h('h3.sk-h3', 'SKILL.md: what Claude will read'),
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

function viewSkills({ frame, sub }) {
  store.viewing = null;
  // #/skills, #/skills/<part>, #/skills/<part>/<project folder>, #/skills/<project folder> (a project's page links here)
  const [first = '', ...rest] = sub ? sub.split('/') : [];
  const named = PARTS.some(([id]) => id === first);
  const project = decodeURIComponent(named ? rest.join('/') : sub || '');
  let part = named ? first : prefs.get('skills.part', '');
  let alive = true;
  let data = null; // GET /api/skillhub
  let suggest = null; // GET /api/skillhub/suggest
  let updates = new Map(); // "user:name" | "project:name" → the check's answer
  let notice = null; // { text, undo } after a remove or an update
  let projects = []; // [{ path, name }] for the selector

  const picker = h('select.field.sk-picker', { id: 'sk-for' }, h('option', { value: '' }, 'Just for me'), project ? h('option', { value: project, selected: true }, project) : null);
  const addr = (id) => link(`#/skills/${id}${project ? `/${enc(project)}` : ''}`);
  const tabs = tabBar('Parts of Skills', [], part, (id) => show(id));
  const partBox = h('div.sk-part', { role: 'tabpanel' });
  const toolsBox = h('div', h('p.hint', 'Looking…'));
  const weeklyBox = h('div');
  const advanced = fold('skills', 'Advanced',
    panel({ icon: 'terminal', title: 'Tools these skills use', desc: 'Some skills need a program on this computer. It is installed or updated only when you press the button.' }, toolsBox),
    weeklyBox,
    h('p.hint', 'Each skill is fetched into quarantine, pinned to one exact version and shown in full before you install it.'));
  frame({
    title: 'Skills',
    page: 'skills',
    intro: 'A skill teaches Claude Code one kind of work, like testing a web app or writing Flutter code. Add the ones that fit you and your projects.',
    body: [h('div.sk-for', h('label.sk-for-label', { for: 'sk-for' }, 'Skills for:'), picker),
      // The brain's skills, not read by Claude Code until its skills folder is linked: the same button as the AI brain page.
      project ? null : linkBrainNote({ only: ['skills'], text: () => 'The skills in your AI brain are not used by Claude Code yet.', after: () => load() }),
      tabs, partBox, advanced],
  });

  const scopeName = () => (project ? (projects.find((p) => p.path === project) || {}).name || project.split(/[\\/]/).pop() : '');
  const installedCount = () => (data ? data.user.skills.length + (data.project ? data.project.skills.length : 0) : 0);
  const openCount = () => (suggest ? suggest.suggestions.filter((x) => !x.installed).length : 0);

  function paintTabs() {
    const n = { installed: data ? installedCount() : null, suggested: suggest ? openCount() : null, find: null };
    tabs.update(PARTS.map(([id, label]) => ({ id, label, href: addr(id), count: n[id] ?? undefined })), part);
  }
  function show(id) {
    part = id;
    prefs.set('skills.part', id);
    if (location.hash !== addr(id)) history.replaceState(null, '', addr(id));
    paintTabs();
    paintPart();
  }

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
      toast(e.message, { kind: 'error', ms: 8000 });
    } finally {
      if (button && button.isConnected) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }

  const skillRow = (s, scope) => {
    const u = updates.get(`${scope}:${s.name}`);
    const body = scope === 'project' ? { name: s.name, project } : { name: s.name };
    const remove = btn('small ghost', { icon: 'trash', label: 'Remove', onclick: async () => {
      if (!(await confirmSheet({ title: `Remove "${s.name}"?`, text: 'Claude Code stops using it. A copy is kept, so you can bring it back.', ok: 'Remove', danger: true }))) return;
      remove.disabled = true;
      try {
        await api('/api/skillhub/remove', body);
        notice = { text: `${s.name} was removed.`, undo: body };
        await load();
      } catch (e) {
        remove.disabled = false;
        toast(e.message, { kind: 'error' });
      }
    } });
    return h('div.row.static.col.mrow.sk-row',
      h('div.mrow-top', h('span.row-icon', icon('sparkle')),
        h('span.row-main',
          h('span.row-title', s.name, u && u.state === 'update' ? tag('medium', 'update available') : null, s.edited.length ? tag('low', 'changed here') : null),
          h('span.row-sub.sk-wrap', oneLine(s.description) || 'No description.'),
          h('span.row-sub.sk-wrap', origin(s))),
        h('span.sk-act',
          u && u.state === 'update' ? btn('small primary', { icon: 'download', label: 'Update', onclick: (e) => startReview(body, e.currentTarget) }) : null,
          remove)));
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
        paintPart();
        toast(n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything is up to date');
      } catch (e) {
        said.textContent = e.message;
        b.disabled = false;
      }
    } });
    return h('div.sk-bar', said, b);
  }

  function paintInstalled() {
    const here = data.project ? data.project.skills : [];
    const mine = data.user.skills;
    const undo = notice && notice.undo ? btn('small secondary', { icon: 'refresh', label: 'Undo', onclick: async () => {
      try {
        await api('/api/skillhub/undo', notice.undo);
        notice = { text: 'Undone.' };
        await load();
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    } }) : null;
    const banner = notice ? h('div.banner.ok-box.sk-notice', { role: 'status' }, icon('check', { size: 18 }), h('span', notice.text), undo) : null;
    if (!here.length && !mine.length) {
      return fill(partBox, banner, emptyState('book', project ? `No skills for ${scopeName()} yet. Suggested shows the ones that fit it.` : 'No skills yet. Suggested shows the ones that fit you.',
        btn('primary', { icon: 'sparkle', label: 'See suggested', onclick: () => show('suggested') })));
    }
    fill(partBox, banner,
      h('div.sk-head', h('p.hint', project ? `Claude uses these in ${scopeName()}.` : 'Claude uses these in every project.'), checkButton()),
      project ? [h('p.field-label', `In this project (${here.length})`), here.length ? h('div.rows', here.map((s) => skillRow(s, 'project'))) : h('p.hint', 'None yet: Suggested shows the ones that fit it.')] : null,
      project ? h('p.field-label', `For you, in every project (${mine.length})`) : null,
      mine.length ? h('div.rows', mine.map((s) => skillRow(s, 'user'))) : project ? h('p.hint', 'None.') : null,
      project ? null : h('p.hint.sk-where', `Kept in ${tildePath(data.user.dir, data.home)}.`));
  }

  // ---------- Suggested ----------
  function paintSuggested() {
    if (!suggest) return fill(partBox, skeleton(2));
    if (suggest.error) return fill(partBox, errorBox(suggest.error));
    const seen = Object.keys(suggest.stacks || {}).filter((k) => k !== 'code');
    const reviewBtn = (x) => btn('small primary', { icon: 'download', label: 'Review', onclick: (e) => startReview({ spec: x.id, project, scope: x.scope }, e.currentTarget) });
    fill(partBox,
      h('p.hint', project ? `Picked for ${scopeName()} from what is in it${seen.length ? `: ${seen.join(', ')}` : ''}.` : 'Useful for you in every project. Pick a project above for the skills that fit it.'),
      suggest.suggestions.length
        ? h('div.rows', suggest.suggestions.map((x) => h('div.row.static.col.mrow.sk-row',
          h('div.mrow-top', h('span.row-icon', icon(x.installed ? 'check' : 'sparkle')),
            h('span.row-main',
              h('span.row-title', x.name, h('span.badge.soft', x.scope === 'user' ? 'for you' : 'this project')),
              h('span.row-sub.sk-wrap', x.for),
              h('span.row-sub.sk-wrap.sk-why', `Why: ${x.why.join('; ')}`)),
            h('span.sk-act', x.installed ? h('span.badge.sk-done', 'Installed') : reviewBtn(x))))))
        : emptyState('sparkle', project ? 'Nothing in the catalog fits this project yet. Find searches all skills.' : 'Nothing to suggest for you right now.', btn('secondary', { icon: 'search', label: 'Find a skill', onclick: () => show('find') })),
      suggest.ideas && suggest.ideas.length ? h('p.hint', 'Also worth a search: ', suggest.ideas.map((i) => i.replace(`${COMMAND} skills find `, '')).map((w, n) => [n ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); findWords = w; show('find'); } }, w)])) : null);
  }

  // ---------- Find ----------
  let findWords = '';
  let found = null;
  function paintFind() {
    const out = h('div.sk-found', { 'aria-live': 'polite' });
    const query = h('input.field', { type: 'search', value: findWords, placeholder: 'e.g. nextjs, flutter, postgres, owner/repo', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Find a skill' });
    const item = (title, sub, meta, spec) => h('div.row.static.col.mrow.sk-row',
      h('div.mrow-top', h('span.row-icon', icon('book')),
        h('span.row-main', h('span.row-title', title), sub ? h('span.row-sub.sk-wrap', sub) : null, h('span.row-sub.sk-wrap.sk-mono', meta)),
        spec ? h('span.sk-act', btn('small secondary', { icon: 'download', label: 'Review', onclick: (e) => startReview({ spec, project, scope: project ? 'project' : 'user' }, e.currentTarget) })) : null));
    const paintFound = () => {
      if (!found) return fill(out);
      if (found.busy) return fill(out, skeleton(2));
      if (found.error) return fill(out, errorBox(found.error));
      const r = found.r;
      fill(out,
        r.catalog.length ? [h('p.field-label', 'From the catalog (reviewed)'), h('div.rows', r.catalog.map((c) => item(c.name, c.for, `${c.source} · ${c.license}`, c.add)))] : null,
        h('p.field-label', 'From skills.sh'),
        r.error ? h('p.hint', r.error) : null,
        r.online.length ? h('div.rows', r.online.map((o) => item(o.name, null, `${o.source} · ${o.installs.toLocaleString()} installs${o.license ? ` · ${o.license}` : ''}`, o.add))) : h('p.hint', 'Nothing found there.'),
        h('p.hint', 'Anything from skills.sh is shown in full before it is installed.'));
    };
    const form = h('form.inlineform', { onsubmit: async (e) => {
      e.preventDefault();
      const q = query.value.trim();
      findWords = q;
      if (!q) return;
      if (/^[\w.-]+\/[\w.-]+(\/|@|$)|^https?:\/\/|^git@/.test(q)) return startReview({ spec: q, project, scope: project ? 'project' : 'user' }, e.submitter);
      found = { busy: true };
      paintFound();
      try {
        found = { r: await api(`/api/skillhub/find?q=${enc(q)}`) };
      } catch (er) {
        found = { error: er.message };
      }
      if (alive && part === 'find') paintFound();
    } }, query, btn('primary', { icon: 'search', label: 'Find', type: 'submit' }));
    fill(partBox, h('p.hint', 'Search the reviewed catalog and skills.sh by a word, or give a skill\'s address (owner/repo).'), form, out);
    paintFound();
    if (findWords && !found) form.requestSubmit();
  }

  function paintPart() {
    if (!data) return fill(partBox, skeleton(2));
    if (part === 'suggested') paintSuggested();
    else if (part === 'find') paintFind();
    else paintInstalled();
  }

  // ---------- data ----------
  async function load() {
    try {
      data = await api(`/api/skillhub${project ? `?project=${enc(project)}` : ''}`);
    } catch (e) {
      if (alive) fill(partBox, errorBox(e.message), btn('secondary', { icon: 'refresh', label: 'Try again', onclick: load }));
      return;
    }
    if (!alive) return;
    if (!part) part = installedCount() ? 'installed' : 'suggested';
    fill(weeklyBox, toggle('Check for updates once a week', data.settings.weekly, (v) => api('/api/skillhub/settings', { weekly: v }).catch((er) => {
      toast(er.message, { kind: 'error' });
      throw er;
    }), `It only tells you (a notification and a mark here); it never installs.${data.settings.lastCheck ? ` Last check: ${new Date(data.settings.lastCheck).toLocaleDateString()}.` : ''}`));
    paintTabs();
    paintPart();
    try {
      suggest = await api(`/api/skillhub/suggest${project ? `?project=${enc(project)}` : ''}`);
    } catch (e) {
      suggest = { error: e.message, suggestions: [] };
    }
    if (!alive) return;
    paintTabs();
    if (part === 'suggested') paintSuggested();
  }

  /** The selector: the projects of this computer first, then other folders Claude worked in. */
  async function loadProjects() {
    const [pj, hub] = await Promise.all([api('/api/pcsetup/projects').catch(() => null), api('/api/skillhub').catch(() => null)]);
    if (!alive) return;
    projects = pj ? [...pj.workspaces.map((w) => ({ path: w.dir, name: w.name })), ...pj.repos.map((r) => ({ path: r.dir, name: r.rel }))].sort((a, b) => a.name.localeCompare(b.name)) : [];
    const others = ((hub && hub.projects) || []).filter((f) => !projects.some((p) => p.path === f.path || f.path.startsWith(`${p.path}/`)));
    if (project && !projects.some((p) => p.path === project) && !others.some((f) => f.path === project)) others.unshift({ path: project, short: project });
    fill(picker,
      h('option', { value: '' }, 'Just for me'),
      projects.length ? h('optgroup', { label: 'Projects' }, projects.map((p) => h('option', { value: p.path, selected: p.path === project }, p.name))) : null,
      others.length ? h('optgroup', { label: 'Other folders' }, others.map((f) => h('option', { value: f.path, selected: f.path === project }, f.short))) : null,
      h('option', { value: '__other' }, 'Another folder…'));
    picker.value = project;
    if (data) {
      paintTabs();
      paintPart(); // the project's name is known now
    }
  }

  picker.addEventListener('change', async () => {
    let v = picker.value;
    if (v === '__other') {
      v = await promptSheet({ title: 'Another folder', text: 'The full path of a project folder on this computer.', placeholder: '/path/to/project', check: (x) => (x.startsWith('/') || /^[A-Za-z]:\\/.test(x) ? '' : 'A full path') });
      if (v === null) {
        picker.value = project;
        return;
      }
    }
    // The address names the choice, so Back and a reload keep it; replace() keeps Back for the page before.
    location.replace(link(`#/skills/${part || 'installed'}${v ? `/${enc(v)}` : ''}`));
  });

  advanced.addEventListener('toggle', function once() {
    if (!advanced.open) return;
    advanced.removeEventListener('toggle', once);
    paintTools();
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
      fill(toolsBox, errorBox(e.message));
    }
  }
  if (advanced.open) paintTools();

  paintTabs();
  paintPart();
  load();
  loadProjects();
  return () => {
    alive = false;
  };
}

registerPage({ id: 'skills', title: 'Skills', icon: 'book', group: 'more', order: 20, perComputer: true, render: viewSkills });
