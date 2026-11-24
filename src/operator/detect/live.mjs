// The dashboard's own doors: the local login page and the public link. One that does not answer 200 is an item,
// with the status it gave and since when it has been like that.
//
// Reads board.live: { local: { status, since, checkedAt }, link: { on, status, since, checkedAt } }. `status`
// is the HTTP status, 0 when nothing answered; the address itself is never on the board (it can hold a token).

import { act, makeItem } from '../item.mjs';
import { clock, ms, span } from './util.mjs';

const said = (status) => (status ? `answers ${status}` : 'does not answer');

export function detectLive(board, { now = Date.now() } = {}) {
  const live = board.live;
  if (!live) return [];
  const out = [];
  const l = live.local;
  if (l && Number.isInteger(l.status) && l.status !== 200) {
    const since = ms(l.since);
    out.push(makeItem({
      kind: 'live',
      cls: 'stopped',
      subject: 'the login page',
      since,
      facts: [`the login page ${said(l.status)}`, since != null ? `like this for ${span(now - since)}` : null, l.checkedAt ? `checked at ${clock(l.checkedAt, now)}` : null],
      acts: [act('open', { href: '#/settings/about', label: 'Open About' })],
      why: 'Phones and other computers cannot sign in while it fails.',
    }));
  }
  const p = live.link;
  if (p?.on && Number.isInteger(p.status) && p.status !== 200) {
    const since = ms(p.since);
    out.push(makeItem({
      kind: 'live',
      cls: 'stopped',
      subject: 'the public link',
      since,
      facts: [`the public link ${said(p.status)}`, since != null ? `like this for ${span(now - since)}` : null, p.checkedAt ? `checked at ${clock(p.checkedAt, now)}` : null],
      acts: ['restart-link', act('open', { href: '#/settings/public-link' })],
      why: 'A restart makes a new tunnel when the old one went away.',
    }));
  }
  return out;
}
