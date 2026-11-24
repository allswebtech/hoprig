// The scan of a learned draft: the same scan as every skill (scan.mjs), plus a few lines that matter for text every
// later session follows (stop asking, push, skip checks, send away). A draft the scan marks risky cannot be installed.
import { scanSkill, scanText } from './scan.mjs';
import { sha256 } from './store.mjs';

// Lines the scan does not look for, which matter in text every later session follows. Each makes a draft risky.
// `git` with any options before its command (git -C repo push, git -c x=1 push), and the Hinglish forms of "do it".
// Linear by construction: an option's value never starts with "-" (with "(\s+\S+)?" alone each word had two readings
// and 40 options took minutes), and no word of the options ends in "git", so no match can start again inside the
// options of another (with "git -a git -a …" every "git" did, and re-read the rest of the line). "git -C my-git push"
// is still caught: from the "git" that ends "my-git".
const GIT_WORD = String.raw`(?!\S*\bgit(?!\S))\S+`;
const GIT = String.raw`\bgit(\s+-${GIT_WORD}(\s+(?!-)${GIT_WORD})?)*\s+`;
// Waiting for a person or his answer (not "wait for CI", which is about a check).
const FOR_PERSON = String.raw`(him|her|them|me|you|the\s+(owner|user|lead)|(his|her|their|my|your|the\s+owner'?s)\s+(answer|reply|yes|go-ahead|ok|okay|approval|confirmation|permission|review|sign-off)|an?\s+(answer|reply|yes|go-ahead|ok|okay)|(approval|confirmation|permission|sign-off|a\s+review))\b`;
const KARO = String.raw`(karo|kar\s*do|kardo|karna|kare|kariye|kar\s*dena|kar\s*dijiye|kar\s*dijie|kar\s*de)\b`;
const LEARN_RULES = [
  // "Never ask", "without confirmation", "he does not want to be asked", "you do not have to ask", "don't bother him".
  ['learn-no-ask', 'tells the agent to stop asking you first', new RegExp([
    String.raw`\b(never|don't|do not|no need to|stop|without)\s+(ask|asking|confirm|confirming|checking with)\b`,
    String.raw`\b(without|no)\s+(any\s+|a\s+|your\s+|his\s+|her\s+|the\s+owner'?s\s+)?(confirmation|approval|permission|asking|questions?)\b`,
    String.raw`\b(not|n't|never)\s+(want|wish|like|need)s?\s+to\s+be\s+(asked|bothered|interrupted)\b`,
    // "Never request permission", "without getting his approval".
    String.raw`\b(never|don't|do not|no need to|stop|without)\s+(request|requesting|seek|seeking|get|getting)\s+((any|his|her|your|the\s+owner'?s)\s+)?(permission|approval|confirmation|sign-off)\b`,
    String.raw`\b(do not|don't|does not|doesn't|need not|needn't|no)\s+(have|need)?\s*(to\s+)?(ask|check with|confirm)\b`,
    String.raw`\b(never|don't|do not|does not|doesn't|need not|needn't|no need to|stop|without)\s+((have|need)\s+)?(to\s+)?wait(ing)?\s+for\s+${FOR_PERSON}`,
    String.raw`\b(never|don't|do not|no need to)\s+bother\b|\bbother\b[^.\n]{0,40}\bwith\s+(questions|asking)\b`,
    String.raw`\bbina\s+(puch|pooch|puchh|pucch|bata|bataye|btaye)\w*|\bmat\s+(puch|pooch)\w*|\b(puch|pooch)\w*\s+mat\b`,
    String.raw`बिना\s*(पूछ|पुछ|बता)|मत\s*(पूछ|पुछ)|(पूछ|पुछ)\S*\s*मत`,
  ].join('|'), 'i')],
  // A push in any wording that sends work to a remote or a branch, a push as the first or the last word of a clause
  // (not "push back", which is about a request, nor "the push" as a thing), and publishing a branch.
  ['learn-push', 'pushes, or forces a change', new RegExp([
    `${GIT}push\\b`,
    String.raw`\b(always|automatically|then|and|also)\s+push\b`,
    String.raw`\bpush(es|ing)?\b[^.\n]{0,40}\b(to|into)\s+(the\s+)?(origin|remote|upstream|server|github|gitlab|main|master|branch)\b`,
    String.raw`\bpush\s+(the|this|your|my|it|each|every|all)\b[^.\n]{0,30}\b(branch|commits?|changes?|work)\b`,
    String.raw`^\s*(\d+[.)]\s+|[-*]\s+)?push\b(?!\s+back)|[.!;:]\s+push\b(?!\s+back)`,
    // The rule: a push that ends a clause ("When the tests pass, push it.") is risky unless the clause forbids it (a
    // "never", "not" or "no" right before it, "never ever", "do not you") or makes it wait ("ask the owner before you
    // push"); a "never ... before/without" or "don't forget" around a push turns that back into an order to push.
    String.raw`\b(?=push)(?<!\b(the|a|no|any|each|every|your|my|his|her|its|their|this|that|first|last)\s+)(?<!(\b(never|not|no)|n't)\s+((ever|you|we|to)\s+){0,2})(?<!\b(before|until|unless|without)\b[^.!;,\n]{0,30})push(\s+(it|them|this|that|everything|all|(it\s+)?up))?(?=\s*([.!;,]|$))`,
    String.raw`\b(never|not|n't|no)\b[^.!;\n]{0,40}\b(before|until|unless|without)\s+((you|we|it's|it\s+is|there\s+is|a|any|the|your)\s+)?(push|pushed|pushing)\b`,
    String.raw`\b(forget|fail|neglect|omit)\s+to\s+push\b`,
    String.raw`\bpublish(es|ing)?\b[^.\n]{0,40}\b(branch|commits?|changes?|origin|remote|upstream|github|gitlab)\b|\b(npm|pnpm|yarn)\s+publish\b`,
    String.raw`--force\b|\bforce[- ]push`,
    `\\bpush\\s+${KARO}`,
    'पुश',
  ].join('|'), 'i')],
  // Also a merge past the branch's protection (gh pr merge --admin).
  ['learn-skip-checks', 'skips tests, checks, hooks or a review', /\b(skip|disable|bypass|turn off|ignore)\b[^.\n]{0,30}\b(tests?|checks?|hooks?|reviews?|confirmations?|lint|ci)\b|--no-verify\b|\bgh\s+pr\s+merge\b[^\n;|&]*\s--admin\b/i],
  // Ignore rules, instructions, the rule files or the owner: no "previous" or "system" needed before them.
  ['learn-ignore-rules', 'tells the agent to ignore its rules or you', /\b(ignore|skip|override|disregard|forget|bypass|pay\s+no\s+attention\s+to|(do not|don't|never|no need to)\s+(follow|obey|respect))\b[^.\n]{0,40}(\b(rules?|instructions?|guidelines|polic(y|ies)|conventions)\b|\b(CLAUDE|AGENTS|GEMINI)\.md\b|\bthe\s+(owner|user)\b)/i],
  // Any rm with -r, -R or --recursive anywhere in its arguments (rm -f -r, rm build -r), rmdir /s, find -delete,
  // git clean, and "delete karo" / मिटा दो.
  ['learn-delete', 'deletes files recursively', new RegExp([
    // rm's own words only: its arguments end at a comma, a sentence's end, "then" or "and" ("Run rm old.log, then
    // grep -r TODO src." is two commands).
    String.raw`\b[Rr][Mm]\b(?:(?![,\n;|&]|\.\s|\.$|\s(then|and|or)\b)[^]){0,80}\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b`,
    String.raw`\b(rmdir|rd)\s+(\/\w\s+)*\/[sS]\b`,
    String.raw`\bfind\b[^\n]*\s-delete\b`,
    // The delete calls of code, also in a Markdown step (the scan counts them in code files only).
    String.raw`\bshutil\.rmtree\b|\b(rmSync|rm|rmdirSync)\([^)\n]{0,200}recursive|\bRemove-Item\b[^\n]*-Recurse`,
    `${GIT}clean\\b`,
    `\\b([Dd]elete|[Rr]emove|[Mm]ita|[Hh]ata)\\s+(${KARO}|do\\b)`,
    String.raw`\b([Mm]itao|[Hh]atao)\b|मिटा|डिलीट|हटा\s*दो`,
  ].join('|'))],
  // Changes he has not committed thrown away: git reset --hard, git checkout -- ., git restore . .
  ['learn-throw-away', 'throws away changes that are not committed', new RegExp([
    `${GIT}reset\\b[^\\n;|&]*\\s--hard\\b`,
    `${GIT}(checkout|restore)\\b[^\\n;|&]*\\s(--\\s+)?\\.(?=\\s|$|[,;)])`,
    `${GIT}checkout\\s+(-f|--force)\\b`,
    `${GIT}stash\\s+(drop|clear)\\b`,
  ].join('|'), 'i')],
  ['learn-send-away', 'sends something to another place', /\b(send|upload|post|copy|mail|forward)\b[^.\n]{0,60}\b(to|via)\b[^.\n]{0,40}(https?:\/\/|\b[a-z0-9-]+\.(com|net|io|org|dev|xyz|ru|cn|me)\b|@)|\b(send|share|upload|post|copy|paste|mail|forward|give)\b[^.\n]{0,40}\b(env\s+files?|\.env|env\s+vars?|environment\s+variables?|credentials?|secrets?|tokens?|api[ _-]?keys?|passwords?|private\s+keys?)\b/i],
];
/** The scan's rules that make a learned draft risky, whatever their level: a download, a command that runs at load,
 * credentials, a recursive delete, an instruction to ignore rules or hide something, start-up files, hidden text. */
export const RISKY = new Set(['pipe-to-shell', 'render-command', 'ignore-rules', 'hide-from-user', 'skip-permissions', 'exfiltrate', 'exfiltrate-word', 'credentials',
  'delete', 'delete-api', 'persistence', 'sudo', 'network', 'webfetch', 'encoded', 'blob', 'hidden-unicode', 'hooks', 'allowed-tools', ...LEARN_RULES.map((r) => r[0])]);

// Letters of other scripts that look like Latin ones (Cyrillic р for p, Greek ο for o, Armenian ս for u, Cherokee Ꭱ
// for R): a rule reads the line as it looks. With NFKC first, which turns full-width and other compatibility forms
// into plain letters, and accents taken off Latin letters (púsh): only off Latin ones, since a Hindi word's vowel
// signs are marks too and the Hindi rules are written with them.
const LOOK_ALIKE = Object.fromEntries([...'аaвbеeкkмmнhоoрpсcтtуyхxіiјjѕsԁdһhԛqԝwѵvАAВBЕEКKМMНHОOРPСCТTХXІIЈJЅSΑAΒBΕEΖZΗHΙIΚKΜMΝNΟOΡPΤTΥYΧXαaβbεeιiκkνvοoρpτtυuχxսuօoոnհhցgզqաwՍUՕOᎠDᎡRᎢTᎥiᎪAᎫJᎬEᎳWᎷMᎻHᏀGᏃZᏙVᏚSᏞLᏟCᏢPᏦKᏴBУyҮyԚqԜwёeїiӏlүyɡgıiȷjℓlγyηnωwςcϲcϳj']
  .reduce((pairs, c, i, all) => (i % 2 ? pairs : [...pairs, [c, all[i + 1]]]), []));
/** The look-alike table as { char: small Latin letter }: an outside improvement loop holds the same table, and a test
 * holds both to one fingerprint (test/skillhub/looks.test.mjs). */
export const LOOKS = Object.freeze(Object.fromEntries(Object.entries(LOOK_ALIKE).map(([c, l]) => [c, l.toLowerCase()])));
export const foldLooks = (text) => String(text).normalize('NFKC').replace(/[\u0131\u0237\u0250-\u02af\u0370-\u03ff\u0400-\u058f\u13a0-\u13ff\uab70-\uabbf\u2113]/g, (c) => LOOK_ALIKE[c] || LOOK_ALIKE[c.toUpperCase()] || c)
  .replace(/\p{Script=Latin}\p{M}*/gu, (c) => c.normalize('NFD').replace(/\p{M}/gu, ''));

/** Patterns of this file, for the test that times them on long hostile lines. */
export const PATTERNS = LEARN_RULES.map(([rule, , re]) => [rule, re]);

// The longest line the scan reads. A longer line is not read: the draft is refused (risky, with this as the reason),
// whatever patterns are added later, so no line can keep the dashboard busy. A line is not cut instead, since the cut
// part would be installed unread. A skill's line is never this long (a description is at most 1,024 characters).
export const LINE_MAX = 2000;

function learnFindings(text) {
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    for (const [rule, message, re] of LEARN_RULES) if (re.test(line)) out.push({ file: 'SKILL.md', line: i + 1, rule, severity: 'high', message, excerpt: line.trim().slice(0, 200) });
  });
  return out;
}

// Rules about the front matter as a whole (they point at line 1).
const FRONT_RULES = new Set(['allowed-tools', 'hooks', 'shell', 'no-front-matter']);
const frontOf = (t) => (/^---\n([\s\S]*?)\n---\n/.exec(String(t || '')) || [])[1] ?? null;

/**
 * The scan of a draft folder: { findings, counts, risky, riskyWhy }. `before`: a change's skill as it is now. A
 * finding on what the change keeps of his own (his front matter unchanged, a line he had already) is marked `own`: it
 * is shown, and it does not make the draft risky, which is decided from the lines the draft adds or changes.
 */
export function scanDraft(folder, skillMd, { before = null } = {}) {
  const long = String(skillMd).split('\n').findIndex((l) => l.length > LINE_MAX);
  if (long >= 0) {
    const message = `a line is longer than ${LINE_MAX} characters, too long to check`;
    const findings = [{ file: 'SKILL.md', line: long + 1, rule: 'long-line', severity: 'block', message, excerpt: `${String(skillMd).split('\n')[long].trim().slice(0, 80)}…` }];
    return { findings, counts: { block: 1, high: 0, medium: 0, low: 0 }, risky: true, riskyWhy: [message] };
  }
  const s = scanSkill(folder, { hash: sha256 });
  const folded = foldLooks(skillMd);
  // The scan's own rules again on the folded text, when folding changed it: what only the look-alikes hid.
  const more = folded === String(skillMd) ? [] : scanText('SKILL.md', folded).filter((f) => !s.findings.some((x) => x.rule === f.rule && x.line === f.line));
  const findings = [...s.findings, ...more, ...learnFindings(folded)];
  const order = { block: 0, high: 1, medium: 2, low: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.line - b.line);
  const counts = { block: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  if (before !== null) {
    const had = new Set(String(before).split('\n'));
    const lines = String(skillMd).split('\n');
    const sameFront = frontOf(before) !== null && frontOf(before) === frontOf(skillMd);
    for (const f of findings) {
      if (f.file !== 'SKILL.md') continue;
      if (FRONT_RULES.has(f.rule) ? sameFront : f.line > 0 && had.has(lines[f.line - 1])) f.own = true;
    }
  }
  const bad = findings.filter((f) => !f.own && (f.severity === 'block' || RISKY.has(f.rule)));
  return { findings, counts, risky: bad.length > 0, riskyWhy: [...new Set(bad.map((f) => f.message))] };
}
