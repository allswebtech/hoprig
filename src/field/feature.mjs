// Field reports in the dashboard (docs/FIELD-REPORTS.md): Settings → Field reports and the Home lines.
//
//   GET  /api/field                                  settings, this computer's reports (each whole), the Home lines
//   POST /api/field/settings { sendTo?, choice?, ownNetwork?, copyDir? }
//   POST /api/field/report/<id>/send | dont-send     "ask each time": the owner's answer for one report
//   POST /api/field/twice/<kind>:<class>/dismiss | draft   the "went wrong twice" line: hide it, or make a skill draft
//
// The owner's own page only: Tia's token, the server's own requests on her behalf and another computer's token are
// refused (a send, a setting and a draft are his presses alone). Nothing here runs by itself but one thing: with
// "always", a report made after his choice is sent at the next tick (and what failed before goes with it). With any
// other choice, or no address, the tick reads nothing.
import { readFieldSettings, readFieldState, changeFieldState, madeAfterChoice, sendChoice, writeFieldSettings } from './settings.mjs';
import { listReports } from './report.mjs';
import { KIND_WORDS, keyOf, knownFor, twiceLines } from './learn.mjs';
import { dontSend, sendReports, waitingReports } from './send.mjs';
import { makeWayRound } from './wayround.mjs';
import { CLASSES, KINDS } from './shape.mjs';
import './copy.mjs'; // "also write each report into this folder"

const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });

/** opts: { lookup, ca } (tests: the receiver's name lookup and authority), brain() (the AI brain's folder). */
export function fieldFeature(sctx, opts = {}) {
  const ownerOnly = (req) => {
    if (/^Bearer\s/i.test(String((req.headers && req.headers.authorization) || ''))) throw fail(403, 'field reports are the owner\'s own page only');
    if (sctx.caller && sctx.caller(req) !== 'page') throw fail(403, 'field reports are changed and sent by the owner\'s own press only');
  };
  const net = { ...(opts.lookup ? { lookup: opts.lookup } : {}), ...(opts.ca ? { ca: opts.ca } : {}) };

  // One send at a time: two presses (two tabs) or a press and a tick never send the same report twice.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  };

  function view() {
    const settings = readFieldSettings();
    const state = readFieldState();
    const { reports, notRead } = listReports();
    const waiting = waitingReports({ settings, state });
    return {
      settings,
      choice: sendChoice(settings),
      // Asked once: an address is set and he has not chosen. Not answering is the same as "never".
      question: !!settings.sendTo && !settings.choice,
      reports: reports.map((x) => ({ ...x.report, text: x.text, answer: state.answered[x.report.id] || (Object.hasOwn(state.kept, x.report.id) ? 'kept' : null) })),
      notRead,
      waiting: waiting.map((x) => ({ id: x.report.id, kind: x.report.kind, kindWords: KIND_WORDS[x.report.kind], time: x.report.time, text: x.text })),
      twice: twiceLines({ reports, state }),
    };
  }

  /**
   * "always": the reports made after his choice that were never tried go now (with what was kept). Which ones is read
   * inside the one-at-a-time chain, after the send before it has noted its tries: a tick never queues a report another
   * send has taken. A try that could not be noted posts nothing (send.mjs), so the report is simply fresh again at the
   * next tick and goes as soon as the state folder can be written.
   */
  async function tick() {
    if (sendChoice(readFieldSettings()) !== 'always') return [];
    return serial(() => {
      const settings = readFieldSettings();
      if (sendChoice(settings) !== 'always') return [];
      const state = readFieldState();
      if (state.broken) return [];
      const fresh = listReports().reports.map((x) => x.report).filter((r) => madeAfterChoice(r.time, settings) && !state.answered[r.id] && !Object.hasOwn(state.kept, r.id));
      return fresh.length ? sendReports(fresh.map((r) => r.id), net) : [];
    });
  }

  const parseKey = (k) => {
    const [kind, cls] = String(k).split(':');
    if (!KINDS.includes(kind) || !CLASSES.includes(cls) || cls === 'none') throw fail(400, 'that is not a trouble of this list');
    return { kind, cls };
  };

  const routes = [
    ['GET', /^\/api\/field$/, async (req) => {
      ownerOnly(req);
      return view();
    }],
    ['POST', /^\/api\/field\/settings$/, async (req) => {
      ownerOnly(req);
      const b = await sctx.readJson(req);
      writeFieldSettings(b);
      return view();
    }],
    ['POST', /^\/api\/field\/report\/([0-9a-f]{16})\/(send|dont-send)$/, async (req, m) => {
      ownerOnly(req);
      await sctx.readJson(req);
      const id = m[1];
      const settings = readFieldSettings();
      if (sendChoice(settings) !== 'ask') throw fail(409, 'reports wait for your answer only with "ask each time"', 'not-asking');
      if (!waitingReports({ settings }).some((x) => x.report.id === id)) throw fail(409, 'that report does not wait for your answer (answered already?)', 'answered');
      if (m[2] === 'dont-send') {
        await serial(async () => dontSend(id));
        return { ...view(), sent: null };
      }
      const r = await serial(() => (readFieldState().answered[id] ? [] : sendReports([id], net)));
      const mine = r.find((x) => x.id === id);
      return { ...view(), sent: mine ? { ok: mine.ok, status: mine.status } : null };
    }],
    ['POST', /^\/api\/field\/twice\/([a-z-]+:[a-z-]+)\/(dismiss|draft)$/, async (req, m) => {
      ownerOnly(req);
      await sctx.readJson(req);
      const { kind, cls } = parseKey(m[1]);
      const line = twiceLines().find((x) => x.key === keyOf(kind, cls));
      if (!line) throw fail(409, 'that line is not shown now', 'not-shown');
      if (m[2] === 'dismiss') {
        changeFieldState((s) => ({ ...s, dismissed: { ...s.dismissed, [line.key]: line.last } }));
        return view();
      }
      if (!line.draft) throw fail(409, 'there is nothing to learn from this one yet: a draft would only say to run hoprig doctor', 'no-draft');
      // The product's own words for that class, never a report's or a session's.
      const k = knownFor(kind, cls);
      const d = makeWayRound(`${KIND_WORDS[kind]} went wrong twice: ${k.words}.`, k.help, { trigger: 'field', ...(opts.brain ? { brain: opts.brain() } : {}) });
      return { ...view(), draft: d.id };
    }],
  ];

  let unsubscribe = null;
  return {
    name: 'field',
    routes,
    tick,
    start() {
      if (sctx.onTick) unsubscribe = sctx.onTick(() => tick().catch(() => {}));
    },
    close() {
      if (unsubscribe) unsubscribe();
    },
  };
}
