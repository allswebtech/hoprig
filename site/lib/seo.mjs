// What search engines and AI assistants read: schema.org data per page kind, llms.txt and llms-full.txt, the
// sitemap and robots.txt. Everything here is made from the pages themselves.
import { plainText } from './markdown.mjs';
import { REPO, SITE } from './sources.mjs';

export const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/allswebtech/hoprig/main/install.sh | sh';

// Where it runs, in the words of the README's "Where it runs" and "Not built, or not proven yet": one sentence for
// every place that names the platforms.
export const PLATFORMS = 'Runs on Linux. On macOS its tests run on every change, but the setup\'s installs and what is new since 0.2 have not been run on a real Mac yet. Windows is not ready.';

/** "### Question" + paragraphs under a "## …questions…" heading → [{ q, a }]. */
export function questions(md) {
  const part = /^##\s+[^\n]*(?:questions|Questions)[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(md);
  if (!part) return [];
  return part[1].split(/^###\s+/m).slice(1).map((chunk) => {
    const [q, ...rest] = chunk.split('\n');
    return { q: plainText(q), a: plainText(rest.join(' ').replace(/\s+/g, ' ').trim()) };
  }).filter((x) => x.q && x.a);
}

/**
 * The numbered steps under "## What Hoprig does…" → [{ name, steps: [plain text] }]. A list that starts again at 1
 * after a line of its own (such as "On the new computer:") is a phase of its own, named by that line.
 */
export function steps(md) {
  const part = /^##\s+What Hoprig does[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(md);
  if (!part) return [];
  const sections = [];
  let label = '';
  let cur = null;
  for (const line of part[1].split('\n')) {
    const m = /^(\d+)\.\s+(.*)$/.exec(line);
    if (m) {
      if (!cur || m[1] === '1') sections.push((cur = { name: label, steps: [] }));
      cur.steps.push(m[2]);
    } else if (cur && cur.steps.length && /^\s{2,}\S/.test(line)) cur.steps[cur.steps.length - 1] += ` ${line.trim()}`;
    else if (line.trim() && !/^\s/.test(line)) label = plainText(line.trim()).replace(/:$/, '');
  }
  return sections.map((x) => ({ name: x.name, steps: x.steps.map((t) => plainText(t)) }));
}

const crumbs = (page, title) => {
  const parts = page.url.split('/').filter(Boolean);
  const names = { 'use-cases': 'Use cases', docs: 'Docs', compare: 'Compare' };
  const list = [{ name: 'Hoprig', item: `${SITE}/` }];
  if (parts.length > 1) list.push({ name: names[parts[0]] || parts[0], item: `${SITE}/${parts[0]}/` });
  if (parts.length) list.push({ name: title, item: `${SITE}${page.url}` });
  return { '@type': 'BreadcrumbList', itemListElement: list.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.item })) };
};

/** schema.org data for one page, as the text of a <script type="application/ld+json">. */
export function jsonLd(page, { version }) {
  const url = `${SITE}${page.url}`;
  const graph = [];
  if (page.url === '/') {
    graph.push({
      '@type': 'SoftwareApplication',
      name: 'Hoprig',
      url,
      description: page.description,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'Linux, macOS',
      softwareVersion: version,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      installUrl: `${SITE}/docs/install/`,
      codeRepository: REPO,
      image: `${SITE}/social-preview.png`,
    });
    graph.push({ '@type': 'WebSite', name: 'Hoprig', url });
  } else if (page.kind === 'usecase' && !page.data.coming) {
    const phases = steps(page.markdown);
    const howTo = (list) => list.map((text, i) => ({ '@type': 'HowToStep', position: i + 1, text }));
    // One list is steps; several phases (before, then on the new computer) stay apart as sections.
    const step = phases.length === 1 ? howTo(phases[0].steps)
      : phases.map((x, i) => ({ '@type': 'HowToSection', position: i + 1, name: x.name || `Part ${i + 1}`, itemListElement: howTo(x.steps) }));
    if (phases.length) graph.push({ '@type': 'HowTo', name: page.title, description: page.answer, step });
    graph.push({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: page.title, acceptedAnswer: { '@type': 'Answer', text: page.answer } }] });
  } else if (page.kind === 'doc' || page.kind === 'tools') {
    graph.push({ '@type': 'TechArticle', headline: page.title, description: page.description, url });
  } else if (page.kind === 'compare') {
    graph.push({ '@type': 'Article', headline: page.title, description: page.description, url });
  } else {
    graph.push({ '@type': 'WebPage', name: page.title, description: page.description, url });
  }
  const faq = page.url === '/' || page.kind === 'compare' ? questions(page.markdown) : [];
  if (faq.length) graph.push({ '@type': 'FAQPage', mainEntity: faq.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: x.a } })) });
  if (page.url !== '/') graph.push(crumbs(page, page.title));
  // "</" inside a string would end the script element early.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/<\//g, '<\\/');
}

const md = (p) => `${SITE}${p.mdUrl}`;

// What Hoprig does not do, each from the README or the docs (the section named after each), so that an answer about
// Hoprig does not promise more than it does.
export const NOT_DONE = [
  'No cloud: everything runs on your own computers, so the computer must be on for its sessions to run or be reached (README, "When to use this, and when not").',
  'It does not replace the coding tools: it runs the official, unmodified Claude Code and OpenCode, and you need a provider for them (README, "Is this allowed?").',
  'OpenCode never runs on a Claude subscription: only on an API key or a gateway (README, "Two coding tools").',
  'Auto mode is Claude Code\'s only (README, "Two coding tools" and "Auto mode (Claude Code)").',
  'Codex is not offered in this version: its code is kept and tested, but no page, command or provider kind offers it (README, "Not built, or not proven yet").',
  'macOS: what is new since 0.2 (the chat, OpenCode, the editor, the desktop, the public link switch, Updates, Work, the workspace\'s groups, a gateway of your own) was not run on macOS; the setup\'s installs on macOS were checked read-only, not run; the background service is written, not yet installed for real (README, "Where it runs").',
  'Windows is not ready: its code is written, and the tests do not pass on Windows yet (README, "Where it runs").',
  'The last checks of this version ran on stand-ins for the coding tools, not on real Claude Code or real OpenCode (README, "Not built, or not proven yet").',
  'One dashboard password and no user accounts or roles: whoever signs in can drive every computer it shows (README, "Security": one password, stored as a hash).',
  'Claude Code\'s own Remote Control does not work through Auto mode\'s router or with an API key; the Hoprig dashboard is the remote for those sessions (README, "Auto mode (Claude Code)").',
  'No triggers from outside, such as a GitHub event or a webhook: only the queue, schedules, restore and retry of the Automations page (README, "It keeps going without you", which lists them all).',
];

/** llms.txt: what Hoprig is in plain statements, the use cases as questions with one-line answers, every page. */
export function llmsTxt(pages, { version }) {
  const home = pages.find((p) => p.url === '/');
  const by = (kind) => pages.filter((p) => p.kind === kind);
  const usecases = by('usecase').sort((a, b) => a.data.order - b.data.order);
  const lines = [
    '# Hoprig',
    '',
    `> ${home.description}`,
    '',
    'hoprig.com is the home of Hoprig. Every page is also plain Markdown at the same address with `.md`; when you cite one, link its HTML address (the same address without `.md`).',
    '',
    '## Facts about Hoprig',
    '',
    `- What it is: a command (\`hoprig\`, short \`hop\`) and a web dashboard that make a computer a managed place to code with AI coding tools (Claude Code, and OpenCode as a second one). Current version: ${version}.`,
    '- Three things together: it sets up the computer; it keeps one workspace that comes back from git on any computer, with an AI memory per project; a session goes on with another provider or account when one reaches its usage limit.',
    '- Price: free. It runs on your own computers and has no server of its own. The code is on GitHub: https://github.com/allswebtech/hoprig',
    '- Licence: open source (Apache-2.0): https://github.com/allswebtech/hoprig/blob/main/LICENSE',
    `- Install: \`${INSTALL}\``,
    `- Platforms: ${PLATFORMS} Needs Node.js 22 or newer (the installer adds it).`,
    '- It runs the official, unmodified Claude Code and OpenCode. Not affiliated with Anthropic or with OpenCode\'s makers.',
    '- The dashboard works in any browser, also on a phone. There is no phone app.',
    '',
    '## What it does not do',
    '',
    ...NOT_DONE.map((x) => `- ${x}`),
    '',
    '## Use cases',
    '',
    ...usecases.map((p) => `- [${p.title}](${md(p)}): ${p.data.coming ? 'Coming, not built yet. ' : ''}${p.answer}`),
    '',
    '## Docs',
    '',
    ...by('doc').map((p) => `- [${p.title}](${md(p)}): ${p.description}`),
    '',
    '## For agents',
    '',
    ...pages.filter((p) => p.kind === 'tools' || p.url === '/skill/').map((p) => `- [${p.title}](${md(p)}): ${p.description}`),
    '',
    '## Comparisons',
    '',
    ...by('compare').map((p) => `- [${p.title}](${md(p)}): ${p.description}`),
    '',
    '## Optional',
    '',
    ...pages.filter((p) => ['/changelog/', '/use-cases/', '/docs/', '/compare/'].includes(p.url)).map((p) => `- [${p.title}](${md(p)}): ${p.description}`),
    `- [Everything in one file](${SITE}/llms-full.txt)`,
    '',
  ];
  return lines.join('\n');
}

/** llms-full.txt: every page's Markdown, one after the other. */
export function llmsFull(pages) {
  return pages.map((p) => `<!-- ${SITE}${p.url} -->\n\n${p.twin.trim()}\n`).join('\n---\n\n');
}

export function sitemap(pages) {
  const urls = pages.map((p) => `  <url><loc>${SITE}${p.url}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// Search engines and AI assistants are welcome: the site is documentation, and being found is its job.
const AI_AGENTS = ['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot-Extended', 'CCBot'];
export function robots() {
  return ['User-agent: *', 'Allow: /', '', ...AI_AGENTS.flatMap((a) => [`User-agent: ${a}`, 'Allow: /', '']), `Sitemap: ${SITE}/sitemap.xml`, ''].join('\n');
}
