// Skills → Learned (#/skills/learned) and Settings → Learn skills (#/settings/learn): drafts of skills made from
// the owner's own work in Work (src/skillhub/learnfeature.mjs). A draft says where it came from, what would change,
// what the scan found and how a cheap model answered its test requests without it and with it; nothing is installed
// until he presses Install, and a risky draft cannot be installed at all. Installed, it is one commit in his AI
// brain; Undo takes it back.
import { api, btn, confirmSheet, fill, h, link, toast } from './lib.js';
import { registerSettingsPage } from './registry.js';
import { emptyState, errorBox, field, panel, savedMark, skeletonRows as skeleton, toggle } from './shell.js';
import { icon } from './icons.js';
import { money } from './chat/words.js';

const shortDay = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const quote = (s, n = 220) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return `“${t.length > n ? `${t.slice(0, n - 1)}…` : t}”`;
};
/** A SKILL.md without its front matter. */
const bodyOf = (md) => String(md || '').replace(/^---\n[\s\S]*?\n---\n+/, '');
const RESULT_WORDS = { 'refused: waiting': 'the same skill as a draft that waits for you, so no second draft was made', 'refused: declined': 'an idea you discarded before',
  'refused: exists': 'a skill of that name is there already', nothing: 'nothing worth keeping', draft: 'a draft', refused: 'an answer that was not a proper draft, so none was made',
  failed: 'the model could not be reached', declined: 'an idea you discarded before', looking: 'looking now' };
/** The words of a look's result. `looking`: a look runs now; a "looking" left without one was stopped by a restart. */
const resultWords = (result, looking) => (result === 'looking' && !looking ? 'stopped before it finished (the dashboard stopped)'
  : RESULT_WORDS[result] || RESULT_WORDS[String(result).split(':')[0]] || result);
// Dollars only for a provider billed by use (`billed`, from the server), as the chat says them (chat/words.js billed):
// on a subscription a look costs nothing per look, it counts toward the plan's usage limit.
const cost = (c) => (!c || !(c.usd || c.tokens) ? ''
  : c.billed ? `about ${money(Number(c.usd) || 0)} (${Number(c.tokens).toLocaleString()} tokens)`
    : `${Number(c.tokens).toLocaleString()} tokens, which count toward your plan's usage limit`);

/**
 * Paint the Learned part into `box`. `kit`: { diffView, tag, onCount(n) } from the Skills page (onCount: the drafts
 * waiting, for the tab). → { refresh(), stop() }: the
 * Skills page calls stop() before it paints another part into the same box, or leaves.
 */
export function paintLearned(box, kit) {
  let data = null;
  let notice = null; // { text, undoId } after an install or an undo
  let timer = null;
  let dead = false;
  let seen = ''; // the last answer painted: a refresh with the same answer paints nothing
  const alive = () => !dead && box.isConnected;
  // What he chose stays over a refresh: the folds he opened or closed (by draft and fold), and where his focus was.
  const folds = new Map();
  const fold = (d, which, dflt, ...children) => {
    const key = `${d.id}:${which}`;
    const el = h('details.lr-more', { open: folds.has(key) ? folds.get(key) : dflt, ontoggle: (e) => folds.set(key, e.currentTarget.open) }, ...children);
    return el;
  };
  const keyed = (el, key) => {
    el.setAttribute('data-key', key);
    return el;
  };

  async function load() {
    clearTimeout(timer);
    if (dead) return; // a refresh that was due when the part was stopped
    try {
      data = await api('/api/skills/learned');
    } catch (e) {
      if (alive()) fill(box, errorBox(e));
      return;
    }
    if (!alive()) return;
    const now = JSON.stringify(data);
    if (now !== seen || notice) paint();
    seen = now;
    // While a look runs or a draft's test requests are tried, look again soon.
    if (data.looking || data.drafts.some((d) => d.state === 'trying' || d.state === 'installing')) timer = setTimeout(load, 3000);
  }

  // Are the brain's skills read by the coding tools (linked)? Until they are, an installed skill is saved in the brain
  // but not used, and the words after Install and in Undo say so. Not known (an older computer): said as linked.
  const linked = () => api('/api/workspace/link').then((plan) => !plan.brain
    || !plan.entries.some((e) => String(e.id).split(':').pop() === 'skills' && e.action !== 'already'), () => true);

  async function press(d, what, button) {
    const isLinked = what === 'discard' ? true : await linked();
    if (what === 'discard' && !(await confirmSheet({ title: `Discard "${d.name}"?`, text: 'The draft goes, and the same idea is not offered again.', ok: 'Discard' }))) return;
    if (what === 'undo' && !(await confirmSheet({ title: `Undo "${d.name}"?`, text: d.kind === 'new'
      ? `${isLinked ? 'Your coding tools stop using it.' : 'Your coding tools do not use it yet: the skills of your AI brain are not linked.'} A commit in your AI brain takes it back; its text stays in the history.`
      : 'Your skill gets its text from before. A commit in your AI brain takes the change back.', ok: 'Undo' }))) return;
    const label = button.textContent;
    button.disabled = true;
    button.textContent = what === 'install' ? 'Installing…' : what === 'undo' ? 'Undoing…' : 'Discarding…';
    try {
      const r = await api(`/api/skills/learned/${d.id}/${what}`, {});
      const commit = String(r.commit).slice(0, 7);
      notice = what === 'install' ? { text: isLinked ? `"${d.name}" is installed and saved in your AI brain (commit ${commit}).`
        : `"${d.name}" is saved in your AI brain (commit ${commit}). Your coding tools use it once you press Switch on, above.`, undoId: d.id }
        : what === 'undo' ? { text: `"${d.name}" is taken back (commit ${commit}).` } : { text: `The draft "${d.name}" is discarded.` };
      await load();
    } catch (e) {
      toast(e, { kind: 'error', ms: 8000 });
      button.disabled = false;
      button.textContent = label;
    }
  }

  function scanBlock(d) {
    if (d.risky) {
      return h('div.lr-risky', { role: 'note' }, icon('alert', { size: 18 }),
        h('div', h('strong', 'This draft cannot be installed.'), h('p', 'The scan found: ', h('span.lr-why-risky', `${d.riskyWhy.join('; ')}.`), ' Text like that is not taken from a session, even when it asks. Discard it.')));
    }
    const n = d.counts.high + d.counts.medium;
    return h('p.lr-scan', n ? kit.tag('medium', `The scan points at ${n} line${n > 1 ? 's' : ''}: read them below`) : kit.tag('low', 'The scan found nothing risky'));
  }

  // With more than a few drafts waiting, only the newest card opens its folds: the others are a short list to open.
  const FEW = 3;
  let roomy = true;
  function card(d, i = 0) {
    const open = (dflt) => dflt && (roomy || i === 0);
    const src = d.source || {};
    const from = src.trigger === 'sent-back'
      ? ['You sent back ', h('strong', quote(src.title, 80)), ' with: ', h('q.lr-words', String(src.words || '').slice(0, 300))]
      : src.trigger === 'session' ? ['A coding session wrote down what failed and what worked when it used Hoprig.']
        : src.trigger === 'field' ? ['The same trouble came up twice on this computer: these are Hoprig\'s own words for it.']
          : ['You asked to learn from ', h('strong', quote(src.title, 80)), ', a task you accepted.'];
    // A risky draft's button stays in the Tab walk (aria-disabled, not disabled), so a screen reader reaches it and
    // hears why; every button names its skill, since each card has the same buttons.
    const install = btn('primary', { icon: 'download', label: d.risky ? 'Cannot be installed' : d.state === 'trying' ? 'Trying the test requests…' : 'Install',
      'aria-label': d.risky ? `${d.name} cannot be installed` : `Install ${d.name}`, 'aria-disabled': d.risky ? 'true' : null, disabled: !d.risky && d.state !== 'ready',
      onclick: (e) => (d.risky ? null : press(d, 'install', e.currentTarget)) });
    const findings = d.findings.filter((f) => f.severity !== 'low');
    return h('article.lr-card', { 'aria-labelledby': `lr-${d.id}` },
      h('div.lr-head', h('span.row-icon', icon('sparkle')),
        h('div.lr-title', h('h3', { id: `lr-${d.id}` }, d.name),
          h('span.badge.soft', d.kind === 'new' ? 'New skill' : 'A change to your skill'), h('span.hint', shortDay(d.createdAt)))),
      h('p.lr-from', ...from),
      d.why ? h('p.lr-why', h('span.lr-label', 'Why: '), d.why) : null,
      scanBlock(d),
      // A new skill: its text as the coding tools will read it (the front matter is ours: its name, description and
      // where it came from). A change: the lines that change.
      d.kind === 'new'
        ? fold(d, 'text', open(!d.risky), h('summary', 'The new skill: what your coding tools would read'), h('pre.output.lr-text', bodyOf(d.skillMd)))
        : fold(d, 'text', open(!d.risky), h('summary', 'What would change in your skill'), kit.diffView(d.diff)),
      findings.length ? fold(d, 'scan', false, h('summary', `What the scan found (${findings.length})`),
        h('ul.lr-findings', findings.map((f) => h('li', kit.tag(f.severity), ' ', f.message, f.line ? h('span.hint', ` · line ${f.line}`) : null, f.excerpt ? h('code.sk-mono.lr-excerpt', f.excerpt) : null)))) : null,
      !d.tests.length ? h('p.hint', 'No test requests: no model made this draft, so there is nothing to try side by side. Read its text above.') :
      fold(d, 'tests', open(d.state === 'ready'), h('summary', 'Test requests: answers without it and with it'),
        h('p.hint', 'Each request was sent to the cheapest model twice: once without this skill, once with it.'),
        d.tests.map((t) => h('div.lr-test', h('p.lr-prompt', icon('send', { size: 14 }), h('span', t.prompt)),
          h('div.lr-sides',
            h('div.lr-side', h('span.lr-label', 'Without it'), h('p', t.without === null ? 'Trying…' : t.without)),
            h('div.lr-side.lr-with', h('span.lr-label', 'With it'), h('p', t.with === null ? 'Trying…' : t.with)))))),
      d.cost && (d.cost.usd || d.cost.tokens) ? h('p.hint', d.cost.billed ? `This look cost ${cost(d.cost)}.` : `This look used ${cost(d.cost)}.`) : null,
      h('div.lr-actions', keyed(btn('secondary', { icon: 'trash', label: 'Discard', 'aria-label': `Discard ${d.name}`, onclick: (e) => press(d, 'discard', e.currentTarget) }), `${d.id}:discard`), keyed(install, `${d.id}:install`)));
  }

  function installedRow(d) {
    return h('div.row.static.col.mrow.sk-row',
      h('div.mrow-top', h('span.row-icon', icon('check')),
        h('span.row-main', h('span.row-title', d.name, h('span.badge.soft', 'learned')),
          h('span.row-sub.sk-wrap', `${d.kind === 'new' ? 'New skill' : 'A change to your skill'} from ${quote(d.source && d.source.title, 60)} · installed ${shortDay(d.installed.at)} · commit ${String(d.installed.commit).slice(0, 7)}`)),
        h('span.sk-act', keyed(btn('small secondary', { icon: 'refresh', label: 'Undo', 'aria-label': `Undo ${d.name}`, onclick: (e) => press(d, 'undo', e.currentTarget) }), `${d.id}:undo`))));
  }

  function paint() {
    const waiting = data.drafts.filter((d) => ['trying', 'ready', 'installing'].includes(d.state));
    roomy = waiting.length <= FEW;
    if (kit.onCount) kit.onCount(waiting.length);
    const installed = data.drafts.filter((d) => d.state === 'installed');
    // The id is taken now: `notice` is cleared at the end of this paint, before the button can be pressed.
    const undoId = notice && notice.undoId;
    const undoBtn = undoId ? btn('small secondary', { icon: 'refresh', label: 'Undo', onclick: (e) => {
      const d = data.drafts.find((x) => x.id === undoId);
      if (d) press(d, 'undo', e.currentTarget);
    } }) : null;
    const banner = notice ? h('div.banner.ok-box.sk-notice', { role: 'status', tabindex: '-1' }, icon('check', { size: 18 }), h('span', notice.text), undoBtn) : null;
    const last = data.recent && data.recent[0];
    const focused = document.activeElement && box.contains(document.activeElement) && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-key') : null;
    fill(box,
      banner,
      data.on ? null : h('div.banner.lr-off', icon('info', { size: 18 }), h('span', 'Learning from Work is off, so no drafts come from your work (a session\'s way round still comes). '), h('a', { href: link('#/settings/learn') }, 'Turn it on in Settings')),
      h('p.hint', 'A draft comes from your own work in Work (a result you sent back with your words, or a task you accepted and marked “Learn from this”) or from a coding session that wrote down a way round after a Hoprig command failed. Nothing is installed until you press Install.'),
      data.looking ? h('p.lr-looking', { role: 'status' }, icon('refresh', { size: 16 }), 'Looking at a run of your work…') : null,
      waiting.length ? [h('p.field-label', `Waiting for you (${waiting.length})`), h('div.lr-list', waiting.map((d, i) => card(d, i)))]
        : emptyState('sparkle', data.on ? 'No drafts waiting. When a run of your work shows something worth keeping, its draft comes here.' : 'No drafts waiting.'),
      last && !data.looking ? h('p.hint', `Last look (${shortDay(last.at)}): ${resultWords(last.result, data.looking)}.`) : null,
      installed.length ? [h('p.field-label', `Installed from your work (${installed.length})`), h('div.rows', installed.map(installedRow))] : null);
    if (banner) banner.focus();
    else if (focused) {
      const again = box.querySelector(`[data-key="${focused}"]`);
      if (again) again.focus();
    }
    notice = null;
  }

  fill(box, skeleton(2));
  load();
  return {
    refresh: load,
    stop() {
      dead = true;
      clearTimeout(timer);
    },
  };
}

// ---------- Settings → Learn skills ----------

function learnPanel() {
  const slot = h('div', skeleton(2));
  const paintIt = (v) => {
    const s = v.settings;
    const mark = savedMark();
    const save = async (patch) => {
      try {
        const next = await api('/api/skills/learn/settings', patch);
        mark.show();
        Object.assign(v.settings, next);
        return next;
      } catch (e) {
        toast(e, { kind: 'error' });
        throw e;
      }
    };
    const providers = v.providers;
    const provider = h('select.field', { onchange: (e) => save({ provider: e.target.value }) },
      s.provider ? null : h('option', { value: '', disabled: true, selected: true }, 'Choose a provider'),
      providers.map((p) => h('option', { value: p.name, selected: p.name === s.provider }, p.label)));
    const model = h('select.field', { onchange: (e) => save({ model: e.target.value }) },
      v.models.map((m) => h('option', { value: m, selected: m === s.model }, m === 'haiku' ? 'haiku (the cheapest)' : m)));
    const perWeek = h('input.field', { type: 'number', min: 1, max: 20, value: String(s.perWeek), onchange: (e) => save({ perWeek: Number(e.target.value) }).catch(() => (e.target.value = String(v.settings.perWeek))) });
    const sw = () => slot.querySelector('input.switch');
    // The last look's time and result come apart from its cost: a look that did not reach the model cost nothing.
    const ll = v.lastLook;
    const spent = s.last ? ` One look and its test requests ${s.last.billed ? 'cost' : 'used'} ${cost(s.last)} the last time one reached the model.` : '';
    const last = !ll ? 'No look has been made yet.'
      : ll.result === 'failed' ? `The last look (${shortDay(ll.at)}) did not reach the model.${spent}`
        : `The last look (${shortDay(ll.at)}): ${resultWords(ll.result, v.looking)}.${spent}`;
    fill(slot,
      toggle('Learn skills from my work', s.on, async (on) => {
        // A look costs usage on the provider it runs on: he chooses it, it is never guessed.
        if (on && !v.settings.provider) {
          sw().checked = false;
          toast(providers.length ? 'Choose the provider that does the looking first.' : 'Add a provider first (Providers).', { kind: 'error' });
          provider.focus();
          return false;
        }
        return save({ on });
      }, 'Off until you turn it on. Only a result you send back in Work, or one you accept and mark “Learn from this”, is looked at, never every session.'),
      field('Provider that does the looking', provider, 'Each look uses this provider: its usage limit, or paid tokens.'),
      field('Model for the look', model, 'The test requests always use the cheapest model.'),
      field('Looks per week, at most', perWeek, `At most ${v.draftsPerWeek} drafts are made a week, whatever this says.`),
      h('p.hint', `${last} This week: ${v.looksThisWeek} of ${s.perWeek} looks, ${v.draftsThisWeek} of ${v.draftsPerWeek} drafts.`),
      h('p.hint', mark, ' A draft waits in ', h('a', { href: link('#/skills/learned') }, 'Skills → Learned'), ' until you press Install or Discard.'));
  };
  api('/api/skills/learn').then(paintIt, (e) => fill(slot, errorBox(e)));
  return panel({ icon: 'sparkle', title: 'Skills from your own work', desc: 'Drafts of skills from what you corrected or kept in Work. You read each one; nothing is installed by itself.' }, slot);
}

registerSettingsPage({
  id: 'learn', title: 'Learn skills', icon: 'sparkle', order: 58,
  desc: 'Drafts of skills from your own work in Work. Off until you turn it on.',
  summary: async () => ((await api('/api/skills/learn')).settings.on ? 'On' : 'Off'),
  render: () => [learnPanel()],
});

/** The number of drafts waiting, for the Skills page's tab; null when it cannot be read. Never throws. */
export const waitingCount = () => api('/api/skills/learned').then((v) => v.drafts.filter((d) => ['trying', 'ready', 'installing'].includes(d.state)).length, () => null);

/** For Work: is learning on (on the computer the page shows)? Never throws. */
export const learningOn = () => api('/api/skills/learn').then((v) => v.settings.on === true, () => false);
