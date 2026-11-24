// Words the frame needs that no content file has yet: plain, each checked against the docs and the demo, and listed
// so that they can move into site/content later. Everything else a page says comes from the content files.
export const WORDS = {
  // The three facts above the headline. "Free" and "open source (Apache-2.0)" are the content's kicker
  // (site/content/index.md); "Runs on your own computer" is its second line (no server of Hoprig's own: docs/INSTALL.md).
  pills: ['Free', 'Open source', 'Runs on your own computer'],
  // The window's title bar over the first picture: the demo's page is called Home.
  heroWindow: 'Hoprig · Home',
  // The first picture: the demo's Home (site/story/home-*.webp), described from what it shows.
  heroAlt: 'Hoprig\'s Home page in the built-in demo: the sessions of every computer on one page, the ones that need you first',
  // Over the install line: where it goes, for someone who has never used a terminal, and the page that walks them
  // through it (site/content/use-cases/not-a-developer.md: "open the Terminal app ... and paste one line").
  paste: 'Paste this line into the Terminal app and press Enter.',
  newHere: { text: 'New to this? Start here', href: '/use-cases/not-a-developer/' },
  // Under the install line: Hoprig costs nothing, the AI it runs may (the FAQ "Is Hoprig free?": "What can cost money
  // is the provider you choose"; not-a-developer.md: "Hoprig is free; the AI is not").
  cost: 'Hoprig is free; the AI is not: it uses your own Claude plan or API key.',
  // Under the install line on a phone only (a phone has no Terminal app): what to do there. The install ends with a
  // QR code that the phone's camera opens as the dashboard (not-a-developer.md step 5, docs/INSTALL.md "2. Scan").
  phone: 'On a phone? Run this line on your computer, then scan the QR code it shows: the dashboard opens here.',
  copied: 'The line is copied',
} as const;
