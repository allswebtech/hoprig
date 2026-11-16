// Source Control: the repository's branch, what is staged and what is not (with counts), a press shows a file's
// changes in the diff editor; stage, unstage, discard (confirmed, naming the files), the commit box, and the newest
// commits. A folder that is not in a repository says so, and repositories inside it can be opened on their own.
import { ago, btn, confirmSheet, fill, h, link, toast } from '../lib.js';
import { icon } from '../icons.js';
import { fold } from '../shell.js';

const base = (p) => p.split('/').pop();
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
// What git's letters mean, in words, for a row's title. The page shows U for a new file and ! for a conflict.
const WORDS = { M: 'Changed', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'New, not in git yet', '!': 'In conflict' };
/** The colour class of a letter, for the lists and the Explorer. */
export const markClass = (l) => ({ A: 'new', U: 'new', D: 'del', '!': 'conflict' })[l] || 'mod';
/** path → the letter the Explorer shows, from a status (conflicts first, then what is not staged, then staged). */
export function marksOf(st) {
  const m = new Map();
  if (!st || !st.repo) return m;
  for (const x of st.staged) m.set(x.path, x.x);
  for (const x of st.changes) m.set(x.path, x.y);
  for (const x of st.untracked) m.set(x.path, 'U');
  for (const x of st.conflicts) m.set(x.path, '!');
  return m;
}

/** wb: { get, post, root, tabs, onStatus(status) }. */
export function createScm(wb) {
  let st = null;
  const message = h('textarea.field.ed-commit-msg', { rows: 3, placeholder: 'Message (Ctrl+Enter commits)', 'aria-label': 'Commit message' });
  const commitBtn = btn('primary small', { icon: 'check', label: 'Commit', onclick: () => commit() });
  const branch = h('div.ed-branch');
  const groups = h('div.ed-groups');
  const log = h('div.ed-log');
  const logFold = fold('editor-log', 'Commits', log);
  const repos = h('div.ed-repos');
  const box = h('div.ed-commit', message, h('div.ed-commit-row', commitBtn));
  const el = h('div.ed-panel.ed-scm',
    h('div.ed-panelhead', h('h2.ed-paneltitle', 'Source Control'),
      h('div.ed-paneltools', btn('icon ghost small', { icon: 'refresh', title: 'Look again', onclick: () => refresh() }))),
    branch, box, groups, logFold, repos);
  message.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  });
  logFold.addEventListener('toggle', () => logFold.open && loadLog());

  async function refresh() {
    try {
      st = await wb.get('git/status', {});
    } catch (e) {
      st = null;
      fill(groups, h('p.ed-panelnote', e.message));
      wb.onStatus(null);
      return;
    }
    paint();
    wb.onStatus(st);
    if (logFold.open) loadLog();
  }

  function paint() {
    fill(repos, st.repos && st.repos.length ? [
      h('p.ed-group-title', 'Repositories inside this folder'),
      st.repos.map((r) => h('a.ed-reporow', { href: link(`#/code?dir=${encodeURIComponent(`${wb.root}/${r}`)}&view=changes`) }, icon('git', { size: 14 }), h('span', r), icon('chevronRight', { size: 14 }))),
    ] : null);
    if (!st.repo) {
      fill(branch);
      box.classList.add('hidden');
      logFold.classList.add('hidden');
      fill(groups, h('p.ed-panelnote', 'This folder is not in a git repository.'));
      return;
    }
    box.classList.remove('hidden');
    logFold.classList.remove('hidden');
    fill(branch, icon('git', { size: 14 }),
      h('span.ed-branch-name', st.detached ? 'Detached' : st.branch || '(no branch)'),
      st.upstream ? h('span.ed-branch-sync', { title: `Compared with ${st.upstream}` }, `↑${st.ahead || 0} ↓${st.behind || 0}`) : h('span.ed-branch-sync', 'not published'));
    const changes = [...st.changes, ...st.untracked];
    fill(groups,
      st.conflicts.length ? group('Merge conflicts', st.conflicts, 'conflict') : null,
      group('Staged changes', st.staged, 'staged'),
      group('Changes', changes, 'changes'),
      !st.conflicts.length && !st.staged.length && !changes.length ? h('p.ed-panelnote', 'No changes: everything is committed.') : null);
  }

  function group(title, items, kind) {
    if (!items.length && kind !== 'changes' && kind !== 'staged') return null;
    const all = items.map((x) => x.path);
    const tools = kind === 'staged'
      ? [btn('icon ghost small', { icon: 'minus', title: 'Unstage all', disabled: !items.length, onclick: () => act('unstage', all) })]
      : kind === 'changes'
        ? [btn('icon ghost small', { icon: 'undo', title: 'Discard all changes', disabled: !items.length, onclick: () => discard(items) }),
          btn('icon ghost small', { icon: 'plus', title: 'Stage all', disabled: !items.length, onclick: () => act('stage', all) })]
        : [];
    return h('div.ed-group',
      h('div.ed-group-head', h('span.ed-group-title', title), h('span.ed-count', String(items.length)), h('span.ed-group-tools', tools)),
      items.map((x) => row(x, kind)));
  }

  function row(x, kind) {
    const letter = kind === 'conflict' ? '!' : x.x === '?' ? 'U' : kind === 'staged' ? x.x : x.y;
    const word = WORDS[letter] || letter;
    const deleted = letter === 'D';
    return h(`div.ed-change.git-${markClass(letter)}`, {
      tabindex: '0', title: `${x.from ? `${x.from} → ` : ''}${x.path} · ${word}`,
      onclick: () => (kind === 'conflict' ? wb.tabs.open(x.path, { preview: false }) : wb.tabs.openDiff(x.path, { staged: kind === 'staged' })),
      onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click(),
    },
    h('span.ed-change-name', base(x.path)), h('span.ed-hitfile-dir', dirOf(x.path)),
    h('span.ed-change-tools',
      deleted ? null : btn('icon ghost small', { icon: 'text', title: 'Open the file', onclick: (e) => {
        e.stopPropagation();
        wb.tabs.open(x.path, { preview: false });
      } }),
      kind === 'changes' ? btn('icon ghost small', { icon: 'undo', title: 'Discard changes', onclick: (e) => {
        e.stopPropagation();
        discard([x]);
      } }) : null,
      kind === 'staged'
        ? btn('icon ghost small', { icon: 'minus', title: 'Unstage', onclick: (e) => {
          e.stopPropagation();
          act('unstage', [x.path]);
        } })
        : btn('icon ghost small', { icon: 'plus', title: kind === 'conflict' ? 'Mark as resolved (stage)' : 'Stage', onclick: (e) => {
          e.stopPropagation();
          act('stage', [x.path]);
        } })),
    h('span.ed-row-mark', { 'aria-label': word }, letter));
  }

  async function act(what, paths) {
    try {
      await wb.post(`git/${what}`, { paths });
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    await refresh();
    wb.tabs.refreshDiffs();
  }

  async function discard(items) {
    const fresh = items.filter((x) => x.x === '?');
    const names = items.slice(0, 6).map((x) => x.path).join(', ') + (items.length > 6 ? ` and ${items.length - 6} more` : '');
    const ok = await confirmSheet({
      title: items.length === 1 ? `Discard the changes to ${base(items[0].path)}?` : `Discard ${items.length} changes?`,
      text: `${names}. ${fresh.length ? `${fresh.length === items.length ? (items.length === 1 ? 'This new file is' : 'These new files are') : `${fresh.length} new file${fresh.length === 1 ? ' is' : 's are'}`} deleted. ` : ''}This cannot be undone.`,
      ok: 'Discard', danger: true,
    });
    if (!ok) return;
    try {
      await wb.post('git/discard', { paths: items.map((x) => x.path), confirm: true });
      toast(items.length === 1 ? 'Changes discarded' : `${items.length} changes discarded`);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
    await refresh();
    wb.onDiscarded(items.map((x) => x.path));
  }

  async function commit() {
    const text = message.value.trim();
    if (!text) {
      toast('Write a message for the commit first.', { kind: 'error' });
      return message.focus();
    }
    commitBtn.disabled = true;
    try {
      const r = await wb.post('git/commit', { message: text });
      message.value = '';
      toast(`Committed ${r.commit}: ${r.subject}`);
    } catch (e) {
      if (e.code === 'nothing-staged') {
        const all = st ? [...st.changes, ...st.untracked].map((x) => x.path) : [];
        if (all.length && await confirmSheet({ title: 'Nothing is staged', text: `Stage all ${all.length} change${all.length === 1 ? '' : 's'} and commit them?`, ok: 'Stage all and commit' })) {
          try {
            await wb.post('git/stage', { paths: all });
            commitBtn.disabled = false;
            return commit();
          } catch (e2) {
            toast(e2.message, { kind: 'error' });
          }
        } else if (!all.length) toast('There is nothing to commit.', { kind: 'error' });
      } else toast(e.message, { kind: 'error', ms: 9000 });
    } finally {
      commitBtn.disabled = false;
    }
    await refresh();
    wb.tabs.refreshDiffs();
  }

  async function loadLog() {
    let r;
    try {
      r = await wb.get('git/log', { n: '30' });
    } catch (e) {
      fill(log, h('p.ed-panelnote', e.message));
      return;
    }
    fill(log, r.commits.length
      ? r.commits.map((c) => h('div.ed-commitrow', { title: `${c.hash}\n${c.author}` },
        h('span.ed-commit-subject', c.subject), h('span.ed-commit-meta', `${c.short} · ${c.author} · ${ago(c.at)}`)))
      : h('p.ed-panelnote', 'No commits yet.'));
  }

  return { el, refresh, get status() {
    return st;
  }, focus: () => message.focus() };
}
