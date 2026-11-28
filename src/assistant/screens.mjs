// open_screen: a button to one of the dashboard's pages. It is how Tia hands the owner what only he may do (sign-ins,
// keys, the password, her own settings): she never does those by chat (tools.mjs, level L3).
import { loadActs } from './acts.mjs';
import { obj, str } from './schema.mjs';
import { LOCAL } from './shown.mjs';
import { ASSISTANT_NAME } from './tia.mjs';
import { comp, computer, tool } from './toolkit.mjs';

// The page addresses she can open: the screens of the acts file (acts.json "screens": every row names one of them, and
// web/app.js PAGE_ADDRESSES is held to the same list by a test). Pages that belong to one computer open for that computer
// ("#/m/<computer>/…") when a computer is given.
export const SCREENS = [...loadActs().screens];
const PER_COMPUTER = /^(computer|workspace|code|new-project|get-project|skills|providers|desktop)(\/|$)/;
const linkOf = (screen, computer) => (computer && computer !== LOCAL && PER_COMPUTER.test(screen) ? `#/m/${computer}/${screen}` : `#/${screen}`);

// What she says when an act is the owner's own (design 2.10): one sentence per class of NEVER, with the page, the item and
// the one press filled in by code. The model repeats it; it never says "I cannot".
const SAY = {
  'sign-in': 'Signing in and keys are yours alone. I opened {screen} at {item}: press {press}.',
  credentials: 'The credentials folder is yours alone. I opened {screen}: press {press}.',
  'open-out': 'Opening this computer to the internet is yours alone. I opened {screen}: press {press}.',
  pair: 'Adding or pairing a computer is yours alone. I opened {screen}: press {press}.',
  'delete-work': 'Deleting is yours alone. I opened {screen} at {item}: press {press}.',
  'her-rights': 'My own rights are yours to set. I opened {screen} at {item}: press {press}.',
};

/** The item a row stands for on its page: its id without the area, "gatewayhost.combos.make" is "combos-make". */
export const focusOf = (row) => row.id.split('.').slice(1).join('-');

/**
 * The answer for an act that is the owner's own: the page, the item on it, the one press, and the sentence, all from the
 * row (a test asks for it for every open row). `computer`: another computer's page.
 */
export function openAnswer(row, { computer } = {}) {
  const say = SAY[row.facts.never].replace('{screen}', row.screen).replace('{item}', focusOf(row)).replace('{press}', row.press);
  return { outcome: 'open', act: row.id, screen: row.screen, focus: focusOf(row), press: row.press, link: linkOf(row.screen, computer), say };
}

export const open_screen = tool({
  name: 'open_screen',
  level: 'L1',
  description: `A button that opens a dashboard page for the owner. Use it for what only he does: add a provider, sign it in or out, sign in with another Claude account at a usage limit, or change its key (providers), remove or pair a computer (computers), the password and sign-in devices (settings/security), notifications, how new sessions are allowed to act (settings/new-sessions), updates by themselves, the public link on (settings/public-link), another coding tool's sign-in, ${ASSISTANT_NAME}'s own settings (settings/tia); and to show him any page: a new session (new), the editor (code), the desktop (desktop/…).`,
  input: obj({ screen: str({ enum: SCREENS }), computer }, { required: ['screen'] }),
  async run(ops, a) {
    const link = linkOf(a.screen, a.computer);
    return { summary: `A button to ${a.screen.replace(/[/-]/g, ' ')} is shown to the owner.`, data: { screen: a.screen, link, computer: comp(a) }, ui: { open: link } };
  },
});
