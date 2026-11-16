// How the page follows a chat. On this computer: one look at the whole chat, then a stream of server-sent events
// (numbered events, the state, and the live deltas). For another computer, through the relay, and wherever the
// stream does not hold: the long poll (events from N, waiting up to 20 s for news). Events are numbered with an
// epoch, so a reconnect never draws one twice; a new epoch draws the conversation again.
import { api, url } from '../lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoff = (n) => Math.min(10_000, 1000 * 2 ** Math.min(n, 4));
const STREAM_TRIES = 3; // the stream failed this often before it ever opened: the long poll from then on

/**
 * o: { A (the chat's API path), remote (another computer: no stream), events(r), state(v), live(list), gone(error),
 *      connection(ok) } → stop()
 * events(r) gets { reset, events, next, epoch, first?, older? }; state(v) the chat's state (the long poll's answer
 * carries both, so it calls both).
 */
export function follow(o) {
  let alive = true;
  let epoch = 0;
  let next = 0;
  let failures = 0;
  let es = null;

  const take = (r) => {
    epoch = r.epoch;
    next = r.next;
    o.events(r);
  };
  const lost = () => {
    failures++;
    if (failures === 2) o.connection(false);
  };
  const back = () => {
    if (failures) o.connection(true);
    failures = 0;
  };

  /** One look (no wait): the whole chat, or what is new. False when the chat is gone. */
  async function look(wait = 0) {
    const r = await api(`${o.A}?from=${next}&epoch=${epoch}&wait=${wait}`);
    if (!alive) return true;
    take(r);
    o.state(r);
    return true;
  }

  async function poll() {
    let wait = 0;
    while (alive) {
      try {
        await look(wait);
        back();
        wait = 20;
      } catch (e) {
        if (!alive) return;
        if (e.status === 404) return o.gone(e);
        lost();
        await sleep(backoff(failures));
        wait = 0;
      }
    }
  }

  function stream(tries = 0) {
    if (!alive) return;
    let opened = false;
    es = new EventSource(url(`${o.A}/stream?from=${next}&epoch=${epoch}`));
    es.addEventListener('open', () => {
      opened = true;
      back();
    });
    es.addEventListener('events', (e) => take(JSON.parse(e.data)));
    es.addEventListener('state', (e) => o.state(JSON.parse(e.data)));
    es.addEventListener('live', (e) => o.live(JSON.parse(e.data)));
    es.addEventListener('error', async () => {
      // The browser would reconnect with the old position; start again from where the page is instead.
      es.close();
      es = null;
      if (!alive) return;
      lost();
      try {
        await look(); // catch up, and learn whether the chat is still there
      } catch (err) {
        if (err.status === 404) return o.gone(err);
      }
      await sleep(backoff(failures));
      if (!opened && tries + 1 >= STREAM_TRIES) return poll();
      stream(opened ? 0 : tries + 1);
    });
  }

  (async () => {
    // The first look gives the whole chat with what the state does not carry (its folder, provider, choices).
    for (;;) {
      try {
        await look();
        back();
        break;
      } catch (e) {
        if (!alive) return;
        if (e.status === 404) return o.gone(e);
        lost();
        await sleep(backoff(failures));
      }
    }
    if (o.remote || typeof EventSource === 'undefined') poll();
    else stream();
  })();

  return () => {
    alive = false;
    if (es) es.close();
  };
}
