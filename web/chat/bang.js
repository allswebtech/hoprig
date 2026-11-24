// "!" before a line in the App's box runs it as a shell command in the session's folder (src/chat/bang.mjs), as
// Claude Code's shell mode does. Its output shows above the box and goes with the owner's next message, as text he
// sends himself (shellText); a run he does not want to send he removes. Every line is set as text.
import { icon } from '../icons.js';
import { api as apiCall, fill, h, toast } from '../lib.js';
import { failText } from './words.js';

const SENT_MAX = 12 * 1024; // what of one run's output goes into the message: its end (the message has a size limit)

/** A line typed into the box is a shell command: it starts with "!" (the command is the rest). → the command or null */
export function bangOf(text) {
  const m = /^!\s*([\s\S]+)$/.exec(String(text || '').replace(/\s+$/, ''));
  return m ? m[1] : null;
}

/**
 * The runs as the text in front of the next message: each its command, its output (its end when long) and how it
 * ended. runs: [{ command, code, output, cut, timedOut }]
 */
export function shellText(runs) {
  return runs.map((r) => {
    let out = String(r.output || '').replace(/\s+$/, '');
    const cut = r.cut || out.length > SENT_MAX;
    if (out.length > SENT_MAX) out = out.slice(-SENT_MAX);
    const end = r.timedOut ? 'It was stopped after 5 minutes.' : r.stopped ? 'I stopped it.' : r.code === 0 ? 'Exit code 0.' : r.code == null ? 'It did not finish.' : `Exit code ${r.code}.`;
    return `I ran this command in the session's folder:\n$ ${r.command}\n\`\`\`\n${cut ? '[… the start of the output is left out]\n' : ''}${out || '(no output)'}\n\`\`\`\n${end}`;
  }).join('\n\n');
}

const POLL_MS = 500; // how often the running command's output is looked at
const endWord = (r) => (r.timedOut ? 'stopped after 5 minutes' : r.stopped ? 'stopped' : r.code === 0 ? 'done' : r.code == null ? 'did not finish' : `exit ${r.code}`);

/**
 * o: { A (the chat's API path), changed() (the runs changed: the composer's buttons) }
 * → { el, run(cmd), adopt(), stop(), text(), count(), clear(), running() }
 * While a command runs its output shows as it comes (the end of it, open), with Stop; done, it folds away.
 */
export function createShellRuns(o) {
  const runs = []; // done, not sent yet
  let busy = null; // the command that runs now
  let live = ''; // its output so far
  let mine = false; // this page started it: its result comes back here (else it was started before a reload, elsewhere)
  let poll = null;
  const el = h('div.chat-shell-runs.hidden', { role: 'region', 'aria-label': 'Shell commands for your next message' });
  // Said once to a screen reader when a command ends (the region itself is not read again on every change).
  const said = h('p.chat-sr', { role: 'status', 'aria-live': 'polite' });
  function paint() {
    el.classList.toggle('hidden', !runs.length && !busy);
    fill(el,
      runs.map((r) => h(`details.chat-shell-run${r.code === 0 ? '' : '.failed'}`,
        h('summary', icon('terminal', { size: 14 }), h('code.chat-shell-cmd', `$ ${r.command}`),
          h('span.chat-shell-end', endWord(r)),
          h('button.btn.icon.ghost.chat-shell-x', { type: 'button', 'aria-label': `Do not send the output of ${r.command}`, title: 'Do not send this', onclick: (e) => {
            e.preventDefault();
            runs.splice(runs.indexOf(r), 1);
            paint();
            o.changed?.();
          } }, icon('x', { size: 14 }))),
        h('pre.chat-shell-out', (r.cut ? '… ' : '') + (String(r.output || '').slice(-4000) || '(no output)')))),
      busy ? h('div.chat-shell-run.chat-shell-busy',
        h('div.chat-shell-head', h('span.spinner', { 'aria-hidden': 'true' }), h('code.chat-shell-cmd', `$ ${busy}`), h('span.chat-shell-end', 'running…'),
          h('button.btn.small.secondary.chat-shell-stop', { type: 'button', title: 'Stop this command (Esc)', onclick: () => api.stop() }, 'Stop')),
        live ? h('pre.chat-shell-out.chat-shell-live', live.slice(-2000)) : null) : null,
      runs.length ? h('p.chat-shell-note', `${runs.length === 1 ? 'Its output goes' : 'Their output goes'} with your next message.`) : null,
      said);
    const out = el.querySelector('.chat-shell-live');
    if (out) out.scrollTop = out.scrollHeight;
  }
  async function look() {
    try {
      const r = await apiCall(`${o.A}/shell`);
      if (!busy) return;
      if (!mine && !el.isConnected) return settle(); // the page was left: its page no longer asks
      if (r && r.running && typeof r.output === 'string' && r.output !== live) {
        live = r.output;
        paint();
      } else if (!mine && r && !r.running) {
        // One this page did not start has ended: its result went to the page that started it, so it is not sent.
        said.textContent = `${busy}: ended`;
        settle();
      }
    } catch {
      /* the next look, or the end */
    }
  }
  function settle() {
    clearInterval(poll);
    busy = null;
    live = '';
    paint();
    o.changed?.();
  }
  const api = {
    el,
    async run(command) {
      if (busy) return toast('A command runs already; wait for its output', { kind: 'error' });
      busy = command;
      mine = true;
      live = '';
      said.textContent = '';
      paint();
      poll = setInterval(look, POLL_MS);
      let other = false;
      try {
        const r = await apiCall(`${o.A}/shell`, { command });
        runs.push({ command, ...r });
        said.textContent = `${command}: ${endWord(r)}`;
      } catch (e) {
        other = e.status === 409; // one started before a reload or in another window runs: it is shown, with Stop
        toast(other ? 'A command started earlier runs in this session: wait for it, or stop it (Esc)' : failText(e), { kind: 'error' });
      } finally {
        settle();
      }
      if (other) await api.adopt();
    },
    /** A command that runs in this session but was not started by this page (the page was reloaded, or it was
     * started in another window): it shows as running, with its output so far and Stop, until it ends. */
    async adopt() {
      if (busy) return;
      let r;
      try {
        r = await apiCall(`${o.A}/shell`);
      } catch {
        return;
      }
      if (busy || !r || !r.running || typeof r.command !== 'string') return;
      busy = r.command;
      mine = false;
      live = typeof r.output === 'string' ? r.output : '';
      said.textContent = '';
      paint();
      poll = setInterval(look, POLL_MS);
      o.changed?.();
    },
    /** Stop the command that runs (Stop, or Esc while it runs). → whether one ran */
    stop() {
      if (!busy) return false;
      apiCall(`${o.A}/shell/stop`, {}).catch((e) => toast(failText(e), { from: e, kind: 'error' }));
      return true;
    },
    text: () => shellText(runs),
    count: () => runs.length,
    running: () => !!busy,
    clear() {
      runs.length = 0;
      paint();
    },
  };
  return api;
}
