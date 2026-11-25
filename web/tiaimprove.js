// Settings → Tia → "Improve Tia": the owner starts a round (src/assistant/improve.mjs) on a provider he chooses, sees
// what it costs before the press, follows it, stops it, and finds its better versions in Skills → Proposals. The
// weekly round is a switch, off until he turns it on. Mounted from tia.js tiaSettings().
import { money } from './chat/words.js';
import { api, btn, fill, h, link, toast } from './lib.js';
import { field, toggle } from './shell.js';
import { CODE_LINE, PAID_LINE, SUB_LINE, WHAT, estimateWords, phaseWords, resultWords, triedWords, weeklyWords } from './tiaimprovewords.js';

const R = '~/api/assistant/improve';

export function improveTia(slot, { isAlive }) {
  let st = null; // { provider, cap } as chosen on the page
  let timer = null;
  async function paint() {
    clearTimeout(timer);
    let v;
    try {
      v = await api(R);
    } catch (e) {
      return fill(slot, h('h3.section-title', 'Improve Tia'), h('p.form-error', e.message));
    }
    if (!isAlive()) return;
    const round = v.round;
    st ||= { provider: v.settings.provider || (v.providers.find((p) => !p.paid) || v.providers[0] || {}).name || '', cap: v.settings.cap };
    const chosen = () => v.providers.find((p) => p.name === st.provider) || null;
    const moneyBox = h('div');
    const drawMoney = () => {
      const p = chosen();
      fill(moneyBox,
        p ? h('p.hint', estimateWords(p.estimate || v.estimate, p.paid)) : null,
        p && p.paid ? h('p.hint.tia-improve-paid', PAID_LINE, v.dailyCapUsd ? ` Today's limit is ${money(v.dailyCapUsd)}.` : ' Set a daily limit for paid use above first: without one, a round on this provider does not start.') : null,
        p && !p.paid ? h('p.hint', SUB_LINE) : null);
    };
    const picker = h('select.field', { id: 'tia-improve-provider', onchange: (e) => {
      st.provider = e.target.value;
      drawMoney();
    } }, v.providers.map((p) => h('option', { value: p.name, selected: p.name === st.provider }, `${p.label} · ${p.paid ? 'billed by use' : 'subscription'}`)));
    const cap = h('input.field', { type: 'number', id: 'tia-improve-cap', min: 0.5, max: 100, step: 0.5, value: st.cap, oninput: (e) => (st.cap = Number(e.target.value)) });
    drawMoney();
    const running = round && round.running;
    const start = btn('primary', { icon: 'play', label: 'Start a round', disabled: !!(running || v.demo || !v.providers.length), onclick: async () => {
      try {
        await api(`${R}/start`, { provider: st.provider, cap: st.cap });
        paint();
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    } });
    const now = running ? h('div.tia-improve-now', { role: 'status' },
      h('p', h('strong', `Step ${Math.min(round.step, round.steps)} of at most ${round.steps}: `), phaseWords(round.phase), '…'),
      round.paid ? h('p.hint', `Used so far: ${money(round.spentUsd || 0)} of this round's limit of ${money(round.cap)}.`) : null,
      btn('secondary', { icon: 'stop', label: 'Stop', onclick: async () => {
        try {
          await api(`${R}/stop`, {});
          toast('Stopping the round');
        } catch (e) {
          toast(e.message, { kind: 'error' });
        }
        paint();
      } })) : null;
    const said = !running ? resultWords(round) : null;
    const last = said ? h('div.tia-improve-last',
      h('p', h('strong', 'Last round: '), (round.proposals || []).length && !round.failed
        ? [said.replace(/Skills → Proposals.*$/, ''), h('a', { href: link('#/skills') }, 'Skills → Proposals'), '.'] : said),
      (round.tried || []).length ? h('ul.hint.tia-improve-tried', round.tried.map((t) => h('li', triedWords(t)))) : null) : null;
    const weekly = toggle('Run a round every week', v.settings.weekly, async (on) => {
      try {
        await api(`${R}/settings`, { weekly: on, provider: st.provider, cap: st.cap });
        paint();
      } catch (e) {
        toast(e.message, { kind: 'error' });
        paint();
        return false;
      }
    }, weeklyWords(chosen(), (chosen() || {}).estimate || v.estimate, st.cap));
    fill(slot,
      h('h3.section-title', 'Improve Tia'),
      h('p.hint', WHAT),
      v.demo ? h('p.hint', v.demo) : null,
      v.providers.length ? field('Provider for the round', picker) : h('p.hint', 'Add a provider that runs Claude Code first (Providers).'),
      moneyBox,
      field('Cap for this round (US dollars)', cap, 'The round stops when it has used this much, on a provider billed by use.'),
      h('div.tia-improve-actions', start),
      now, last,
      h('p.hint', CODE_LINE),
      weekly);
    if (running) timer = setTimeout(() => isAlive() && paint(), 3000);
  }
  paint();
  return slot;
}
