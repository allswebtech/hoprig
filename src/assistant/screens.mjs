// open_screen: a button to one of the dashboard's pages. It is how Tia hands the owner what only he may do (sign-ins,
// keys, the password, her own settings): she never does those by chat (tools.mjs, level L3).
import { obj, str } from './schema.mjs';
import { LOCAL } from './shown.mjs';
import { ASSISTANT_NAME } from './tia.mjs';
import { comp, computer, tool } from './toolkit.mjs';

// The page addresses she can open (web/app.js PAGE_ADDRESSES; a test keeps the two lists in step). Pages that
// belong to one computer open for that computer ("#/m/<computer>/…") when a computer is given.
export const SCREENS = [
  'new', 'code', 'workspace', 'new-project', 'get-project', 'providers', 'computers', 'computers/add', 'computer', 'computer/setup', 'computer/advanced',
  'automations', 'automations/queue', 'automations/rules', 'automations/activity', 'skills', 'skills/installed', 'skills/suggested',
  'skills/find', 'brain', 'tia', 'tia/jobs', 'tia/activity', 'settings', 'settings/new-sessions', 'settings/workspace', 'settings/notifications',
  'settings/appearance', 'settings/security', 'settings/public-link', 'settings/tia', 'settings/editor', 'settings/addons', 'settings/codingtools', 'settings/updates', 'settings/about',
  'desktop', 'desktop/sessions', 'desktop/terminal', 'desktop/files', 'desktop/editor', 'desktop/tasks', 'desktop/services', 'desktop/logs',
];
const PER_COMPUTER = /^(computer|workspace|code|new-project|get-project|automations|skills|providers|desktop)(\/|$)/;
export const open_screen = tool({
  name: 'open_screen',
  level: 'L1',
  description: `Show the owner a button to a dashboard page. Use it for what only he may do: add a provider, sign it in or out, sign in with another Claude account at a usage limit, or change its key (providers), remove a computer or add one by pairing code (computers, computer/advanced), the password, the network and sign-in devices (settings/security), notifications (settings/notifications), how new sessions are allowed to act (settings/new-sessions), whether updates run by themselves (settings/updates), another coding tool's sign-in (settings/codingtools), ${ASSISTANT_NAME}'s own settings (settings/tia) — and to show him any page: a new session (new), the editor (code), the desktop and its apps (desktop/…).`,
  input: obj({ screen: str({ enum: SCREENS }), computer }, { required: ['screen'] }),
  async run(ops, a) {
    const link = a.computer && a.computer !== LOCAL && PER_COMPUTER.test(a.screen) ? `#/m/${a.computer}/${a.screen}` : `#/${a.screen}`;
    return { summary: `A button to ${a.screen.replace(/[/-]/g, ' ')} is shown to the owner.`, data: { screen: a.screen, link, computer: comp(a) }, ui: { open: link } };
  },
});
