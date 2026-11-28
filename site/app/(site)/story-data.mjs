// The landing page's story: four steps, each a heading, one sentence and three screens of the built-in demo (the
// middle one in front; the moving form shows them in turn, on a phone in `phoneOrder` where a step has one). Plain data, read by the page (story.ts) and by the script that takes the pictures
// (scripts/story-shots.mjs). The words are frame words (no content file has them yet): each was checked against the
// docs and the demo, and they may move into site/content later.

/** Every screen the story shows, in the order they are taken (the first run before Home closes it). */
export const SHOTS = [
  { name: 'first-run', label: 'First run', hash: '&firstrun=1#/', alt: 'Home on a new install: one card, Welcome to Hoprig, with Signed in to Claude and Start your first chat, New project or My own folder' },
  { name: 'computer-overview', label: 'Overview', hash: '#/computer', alt: 'A computer\'s Overview: its system, its disk and memory, and its sessions' },
  { name: 'computer-setup', label: 'Setup', hash: '#/computer/setup', wait: 4000, alt: 'A computer\'s Setup page: what it has for coding, what is missing, and one button to install it' },
  { name: 'home', label: 'Home', hash: '#/', alt: 'Home: the sessions of every computer on one page, the ones that need you first' },
  { name: 'computers', label: 'Computers', hash: '#/computers', alt: 'Computers: the Workstation and the Laptop, each with its state and its sessions' },
  { name: 'projects', label: 'Workspace', hash: '#/workspace', wait: 4000, alt: 'Workspace: every project, each with its sessions under it' },
  { name: 'limit-reached', label: 'At the limit', hash: '#/s/docs-site', wait: 3500, alt: 'A session at its usage limit: one button to go on with the same conversation on another plan, the other ways folded under it' },
  { name: 'providers', label: 'Providers', hash: '#/providers', alt: 'Providers: the Claude accounts, API keys and the gateway this computer can use, who can work now and who is at a limit, and the choice of what happens at a limit' },
  { name: 'auto-mode', label: 'Auto mode', hash: '#/providers', alt: 'Providers, When an account reaches its limit: the choice to carry on with the next provider, which is called Auto mode' },
  { name: 'session-phone', label: 'A session', hash: '#/s/api-server', phone: true, alt: 'A session on a phone: its messages and the box to answer it' },
  { name: 'chat-phone', label: 'An OK to give', hash: '#/chat/{chat}', wait: 3500, phone: true, alt: 'A chat on a phone, waiting for an OK to run the tests' },
  { name: 'new-session-phone', label: 'A new session', hash: '#/new', phone: true, alt: 'Starting a new session on a phone: one tap on a project' },
];

export const STEPS = [
  {
    id: 'ready',
    tag: 'One computer made ready',
    title: 'It looks, lists what is missing, and installs it',
    text: 'Hoprig looks at what the computer has for coding, shows what is missing, and installs it with one button. It asks a few questions, each once.',
    panes: ['first-run', 'computer-setup', 'computer-overview'],
  },
  {
    id: 'together',
    tag: 'Every computer in one place',
    title: 'Desktop, laptop and server on one page',
    text: 'Every computer shows up with its sessions (your conversations with the AI) and its projects. Open one to see how it is doing, set it up or change it.',
    panes: ['projects', 'computers', 'home'],
    // On a phone: Computers has two rows and its lower 60 % is empty at 390 px, so it comes last, and the moving form
    // shows one computer's Overview in its place ("Open one to see how it is doing"), which fills a phone.
    phoneOrder: ['home', 'projects', 'computers'],
    phoneSwap: { computers: 'computer-overview' },
  },
  {
    id: 'limit',
    tag: 'Going on at a usage limit',
    title: 'At a limit, the same session goes on',
    text: 'At a usage limit, one tap continues the same conversation on another plan or account of yours: your own plans and keys, while Hoprig itself stays free. A way that costs money per use says so. Auto mode, a choice on the Providers page, can also do it by itself.',
    panes: ['providers', 'limit-reached', 'auto-mode'],
    // On a phone the session at its limit, with the limit's buttons on top, tells the step best: it comes first.
    phoneOrder: ['limit-reached', 'providers', 'auto-mode'],
  },
  {
    id: 'phone',
    tag: 'The same on your phone',
    title: 'Every conversation with the AI in your pocket',
    text: 'Open the dashboard on your phone: answer a question, give an OK, or start a session, in the browser. There is no app to install.',
    panes: ['session-phone', 'chat-phone', 'new-session-phone'],
    // On a wide window the row of phones runs to the window's edges: past the step's three it shows these screens of
    // the demo at phone width, dimmed and soft (three at the left, three at the right), so no screen is seen twice and
    // no phone is a blank card.
    rowFill: ['providers', 'home', 'projects', 'limit-reached', 'computer-overview', 'auto-mode'],
  },
];
