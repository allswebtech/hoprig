// "Today": the one screen for what needs the owner, worked out from the items (views of model.mjs). Pure.
//   needsYou   items not closed that are overdue or due this week (today and the six days after: inWeek), and items waiting for him
//              (`waiting`); overdue first, then waiting, then high priority, then the date. (The sessions that need an
//              OK are added by the page, which knows them.)
//   toReview   items a session has done (`review`), for his look: Accept or Send back ("Do it", doit.mjs)
//   week       the next seven days, today first: per day the items dated that day that are not dropped
//   doneLately items done in the last seven days, newest first
import { CLOSED, WEEK_DAYS, addDays, inWeek } from './model.mjs';

export { WEEK_DAYS, inWeek };

const rank = (it) => (typeof it.days === 'number' && it.days < 0 ? 0 : ['waiting', 'review'].includes(it.status) ? 1 : 2);
const pr = (it) => (it.priority === 'high' ? 0 : it.priority === 'low' ? 2 : 1);

/** The one order of a list of items: overdue, then waiting and review, then high priority, then the date (none last). */
export function rankItems(items) {
  return [...items].sort((a, b) => rank(a) - rank(b)
    || pr(a) - pr(b)
    || (a.date ? 0 : 1) - (b.date ? 0 : 1)
    || String(a.date || '').localeCompare(String(b.date || ''))
    || a.title.localeCompare(b.title));
}

/** Why an item needs the owner, in plain words: "3 days overdue", "due today", "waiting for you", … */
export function whyNeeded(it) {
  if (typeof it.days === 'number' && it.days < 0) return `${-it.days} day${it.days === -1 ? '' : 's'} overdue`;
  if (it.status === 'waiting') return 'waiting for you';
  if (it.status === 'review') return 'ready for your review';
  if (it.days === 0) return 'due today';
  if (it.days === 1) return 'due tomorrow';
  return `due in ${it.days} days`;
}

/** { today, needsYou: [item + why], toReview: [item], week: [{ date, items }], doneLately: [item], counts } */
export function todayView(items, today) {
  const live = items.filter((it) => !CLOSED.has(it.status));
  const needs = live.filter((it) => it.status !== 'review' && ((typeof it.days === 'number' && it.days < 0) || inWeek(it.days) || it.status === 'waiting'));
  const week = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    const date = addDays(today, i);
    week.push({ date, items: rankItems(items.filter((it) => it.date === date && it.status !== 'dropped')) });
  }
  const since = addDays(today, -WEEK_DAYS);
  const doneLately = items.filter((it) => it.status === 'done' && it.doneAt && it.doneAt > since)
    .sort((a, b) => b.doneAt.localeCompare(a.doneAt) || a.title.localeCompare(b.title));
  return {
    today,
    needsYou: rankItems(needs).map((it) => ({ ...it, why: whyNeeded(it) })),
    toReview: rankItems(live.filter((it) => it.status === 'review')),
    week,
    doneLately,
    counts: { all: items.length, open: live.length, done: items.length - live.length },
  };
}
