// Two addresses that only name a part by their query: where that part lives in the pages (used by app.js).
const QUERY_ALIASES = [['/computer/advanced', 'service', '/computer/health'], ['/work/tasks', 'golive', '/work/golive']];

/** "#/computer/advanced?show=service" lands on Health, "#/work/tasks?show=golive" on Go live; any other address: null. */
export const queryAlias = (path, query) => {
  for (const [from, show, to] of QUERY_ALIASES) if (path === from && query.get('show') === show) return to;
  return null;
};
