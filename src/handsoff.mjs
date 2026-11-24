// Hands-off: the owner's switch (per project, per session) under which Hoprig answers by itself what a coding tool
// asks, with no model. What it answers (decide):
//   a question with options   the one option the TOOL marked as recommended (askcard.mjs markedOption)
//   a question with no mark   the owner's note for the project, as the free-text answer where the tool takes one
//   a plan to approve         approved, and the session keeps the permission mode it had (never a wider one)
//   a tool permission         nothing: the mode's own rules, as without Hands-off
//   a notice of the tool      only those on NOTICES_SEEN (none so far)
// and what it never answers, in any mode: anything whose words are about money, a sign-in, a push or a merge, a
// release, sending something out, a delete outside the folder, admin rights, switching a safety rule off or widening
// the mode (SIGNS: a closed list). Off is the default; a switch turned on under another version of Hoprig is off.
// Only node: imports: the hook loads this, and Claude Code waits for the hook.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Is Hands-off offered at all on this computer? Offered is the shipped default: the switch is shown and may
 * be turned on. Only `handsOff.offered: false` — the owner's own choice to hide the feature — reads as not offered,
 * and only that exact boolean does it; an absent flag, or any other value, reads as offered. While it is hidden the
 * product is as if Hands-off did not exist: no switch is shown and no answer is ever given, whatever a run record or
 * the config's other keys (`projects`, `sessions`) say. The exact cards do not depend on it. Offering it turns nothing
 * on: every project and session switch is still off until the owner presses one (switchState).
 * Not offered on Windows: the wall's PreToolUse hold is a shell `[ -e … ]` test that only a POSIX shell runs, so
 * launch.mjs and chatHooks install it only where `process.platform !== 'win32'`. Without that hold Hands-off could
 * answer a question but never hold an owner-only act, so on Windows the switch is never shown and nothing is answered
 * or held — the feature is simply not offered there. (`platform` is a seam for the test; callers use the default.)
 */
export const handsOffOffered = (cfg, platform = process.platform) => platform !== 'win32' && !(cfg && typeof cfg === 'object' && cfg.handsOff && cfg.handsOff.offered === false);

// The matcher of the wall's own PreToolUse entry (launch.mjs hookSettings and chatHooks build it with exactly this).
// A session's handed settings carry the wall's hold only when a PreToolUse entry has this matcher. Another PreToolUse
// entry — the Lead model's Agent|Task entry (launch.mjs leadHook) — is not the wall: a session with only that answers
// the tool's questions but holds none of its acts, so Hands-off must treat it as uncovered.
export const WALL_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit';
export function settingsHoldWall(settings) {
  const pre = settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  return pre.some((e) => e && e.matcher === WALL_MATCHER);
}

/** This Hoprig's version (package.json): a switch turned on under another one reads as off. */
export function hoprigVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

// Three answers in a row with no work between them: a loop. The session is his until he turns it on again.
export const LOOP_MAX = 3;
// Work is a call that changes something: an edit, a write, a command. A read or a search between two asks is no work,
// or a model that reads one file between its questions would be answered for ever.
export const WORK_TOOLS = Object.freeze(new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'Patch']));
// And whatever comes between: at most this many answers in an hour, then the session is his ('hour'). The owner's
// press that turns it on again starts the hour again (`since`: switchState), so "turn it on again" means it.
export const HOUR_MAX = 10;
const HOUR = 3_600_000;
/** Have the answers given at `times` (ms), and not before `since`, reached HOUR_MAX within the hour before `now`? */
export const hourFull = (times, now = Date.now(), since = 0) => (Array.isArray(times) ? times : []).filter((t) => Number.isFinite(t) && t >= since && now - t < HOUR).length >= HOUR_MAX;

// Notices whose one answer is "seen" and that change nothing else. Empty: of the notices captured from Claude Code
// 2.1.327 (trust this folder, the usage-limit menu, a sign-in that ran out) none is such; its one-time notice about
// auto mode needs no answer at all.
export const NOTICES_SEEN = Object.freeze([]);

// The signs of what is the owner's alone, in English, Hindi and Hinglish. A text is read through signText first. Devanagari has no
// word boundary in JavaScript's \b, so those signs are plain parts of words.
export const SIGNS = Object.freeze([
  ['money', /\b(?:pay|paid|payment|purchase|buy|billing|invoice|subscri?pti?ons?|subscribe|credit card|card details|pricing|price plan|charge[sd]?|refund|paid plan|extra usage|overage|top up|usd|eur|inr|paisa|paise|kharid|khareed|rupaye|premium)\b|\bupgrade\b.{0,30}\b(?:plan|pro|max|team|tier|paid|premium|subscription|account)\b|\b(?:pro|max|team|premium|paid|business|enterprise) (?:plan|tier|subscription)\b|\b(?:api|account|usage|prepaid|more|extra|add(?: a)?|buy) credits?\b|\bcredits? (?:to|on|for) (?:the|your|my|an?) account\b|\bspend\w*\b.{0,30}\b(?:money|dollars?|euros?|rupees?|credits?|budget)\b|\d ?(?:dollars?|bucks|euros?|rupees?)\b|\brupees? ?\d|\bplan le\b|\brenew\w*\b.{0,30}\b(?:plan|licen[cs]e|membership)\b|[$€£₹]\s?\d/],
  ['money', /पैस|भुगतान|पेमेंट|खरीद|सब्सक्रिप्शन|शुल्क|रुपय|रुपए|बिल भर|अपग्रेड|प्रो प्लान|पेड प्लान|प्रीमियम|प्लान ले/],
  // Signing in is an act ("log in again"); a login page, form or component is code.
  ['sign-in', /\b(?:log|sign)[- ]?(?:in|on|up|out)\b(?![- ](?:page|form|component|screen|button|route|flow|handler|view|tests?|modal|box|field|link|endpoint|api|logic|state|styles?|template))|\bre-?auth\w*|\bauthenticat\w*|\boauth\b|\bapi keys?\b|\b(?:access|auth|api|bearer|refresh|github|gitlab|npm|personal|secret|session|oauth|bot|deploy) tokens?\b|\bpassword\b|\bpasscode\b|\bcredentials?\b|\b2fa\b|\botp\b|\bssh keys?\b|\b(?:secret|private|signing|deploy) keys?\b|\bsecrets?\b|\b(?:claude|gh|npm|gcloud|aws|az|firebase|vercel|heroku|docker|git) (?:auth|login)\b|\bauth (?:login|logout)\b|\b(?:with|into|from|to) (?:the |my |your |a |an |this |that )?(?:new |other |another |bot |second |different |work |personal |admin |team )?account\b/],
  ['sign-in', /लॉगिन|लॉग[- ]?इन|साइन[- ]?इन|साइन[- ]?अप|पासवर्ड|टोकन|प्रमाणीकरण|खाते|खाता/],
  // A push of commits, a merge of a branch or a pull request, anything that names the default branch or a remote. Any
  // merge is git's ("merge it", "squash and merge"), except the code senses written out: merging objects, lists,
  // configs and the like, a merge sort, a deep merge, resolving merge conflicts. Landing a change on a branch too.
  ['push or merge', /(?<!\b(?:deep|shallow|object|array|dict|config|recursive)[- ])\bmerg(?:e|es|ed|ing)\b(?![- ](?:sort|conflicts?|markers?|function|helper|utils?|logic|step|fields?)\b)(?! (?:the |these |those |two |both |all |its |their |each |every |them |with |in )?(?:[\w']+ )?(?:objects?|arrays?|configs?|configurations?|dicts?|dictionaries|maps?|lists?|options|settings|props|styles?|cells?|columns?|rows?|tables?|data ?frames?|results?|intervals?|ranges?|json|yaml|fields?|keys?|values?|records?|entries|types?|schemas?|defaults?|hash(?:es)?|sets?|arguments|args|params|parameters|headers|translations|locales?|css|classes|class ?names?|duplicates?|sorted|overlapping|adjacent|cells?)\b(?!\s+(?:fix|fixes|change[sd]?|rework|reworks|migration|migrations?|patch|patches|update|updates|pr|prs|branch|branches|feature|features|commit|commits|hotfix|bugfix)\b))|\bland(?:s|ed|ing)?\b(?![- ](?:pages?|zone|gear|strip|screen|view|section|site))[^?]{0,40}\b(?:on|onto|in|into|to) (?:the )?["'\x60]?(?:main|master|trunk|default|base|develop|release)\b["'\x60]?(?![\w-]|\.\w)|\bgit push\b|\bforce[- ]?push|\bpush(?:ed|ing|es)?\b(?![- ](?:down|notifications?|button|back|pop|state|ups?|api|events?|service|messages?))|\bmerg(?:e|es|ed|ing)\b.{0,40}\b(?:branch(?:es)?|pr|prs|pull requests?|mr|merge requests?|main|master|default branch|trunk|develop|release|production|prod)\b|\b(?:main|master|default branch|trunk|pr|pull requests?|merge requests?|branch)\b.{0,40}\bmerg(?:e|es|ed|ing)\b|\bmerge kar|\bfast[- ]?forward\w*\b.{0,30}\b(?:main|master|trunk|branch|origin|remote)\b|\b(?:origin|upstream)[/ ](?:main|master|trunk|head)\b|\b(?:main|master|default|base|trunk) branch\b|\b(?:on|to|from|of) the remote\b|\bremote (?:branch(?:es)?|repo|repository)\b|\bgit remote\b|\bforce[- ]?(?:update|overwrite|reset)\b|\bforce the update\b/],
  ['push or merge', /पुश|मर्ज|(?:मेन|मास्टर|मुख्य) ब्रांच|ब्रांच.*(?:मिला|मर्ज|पुश|डाल)/],
  // A release of a version; releasing a file handle or a lock is code. "production-like" data is not production.
  ['release', /\breleas(?:e[sd]?|ing)\b(?! (?:the |a |an |its |this |that |each |every )?(?:file|handles?|locks?|memory|resources?|buffers?|connections?|mutex|semaphore|keys?|button|events?|pointers?|references?|objects?|notes))|\bpublish\w*|\bdeploy\w*|\bship it\b|\bgo(?:es)? live\b|\blive (?:servers?|site|environment|system|users?|database|db)\b|\broll(?:ing)?[- ]?out\b|\b(?:on|to|pe|par) npm\b|\bnpm (?:pe|par)\b|\bnpm (?:registry|publish)\b|\bapp store\b|\bplay store\b|\bproduction\b(?![- ](?:like|ready|grade|style|quality|build))|\bprod\b|\btag v?\d|\bcut\b.{0,20}\b(?:release|version)\b|\b(?:repo|repository|project|bucket|site|gist|package)\b.{0,20}\bpublic\b|\bpublic (?:repo|repository|bucket|gist)\b/],
  ['release', /रिलीज|प्रकाशित|पब्लिश|डिप्लॉय|लाइव कर/],
  // Sending to a person or a channel; a form that sends its data is code.
  ['send out', /\b(?:send|sends|sending)\b.{0,40}\b(?:to (?:the |a |an |my |your |our |all |every )?(?:clients?|customers?|users?|team|boss|manager|people|everyone|list|channel|group|owner|maintainers?)|by (?:e-?mail|mail|sms|post)|e-?mails?|mail|messages?|reports?|invoices?|invites?|newsletters?|out)\b|\be-?mail\b(?! (?:field|address(?:es)?|input|format|validation|regex|column|template|parser|helper|type))|\bby (?:e-?)?mail\b|\bmail (?:it|this|to|kar)\b|\btweet|\bpost (?:it|this|to|on|a)\b|\bmessage (?:the|a|to|our)\b|\bslack\b|\bsms\b|\bwhatsapp\b|\bwebhook\b|\binvite\b|\bpull request\b|\b(?:open|opens|opened|opening|create[sd]?|creating|raise[sd]?|raising|submit\w*|file|make|makes|making|draft[sd]?|drafting|put up|puts up|putting up|send|sends|sending|push up|pushes up|pushing up)\b[^?.]{0,20}\b(?:pr|prs|mr|merge requests?)\b|\bgh pr (?:create|new|open|submit)\b|\bglab mr (?:create|new|open|submit)\b|\bpr (?:this|it|that)\b|\bbhej\w*|\bnotif(?:y|ies|ying)\b.{0,30}\b(?:customers?|clients?|users?|team|people|everyone|subscribers?|owner|maintainers?)\b|\bshar(?:e|es|ing)\b.{0,40}\b(?:links?|channel|drive|team|publicly|online|everyone|clients?|customers?)\b|\b(?:team|slack|discord|telegram|public|shared|company) channel\b|\b(?:open|file|create|raise)\w*\b.{0,15}\bissues?\b.{0,40}\b(?:upstream|github|gitlab|repo|repository|project|tracker)\b|\bupstream (?:project|repo|repository|maintainers?)\b|\bupload\w*\b(?! (?:button|form|field|component|handler|page|size|limit|progress|widget|tests?))/],
  ['send out', /भेज|ईमेल|मेल कर|संदेश|पोस्ट कर/],
  ['delete outside', /(?:\brm -\w+|\b(?:delete|remove|wipe|erase|truncate|purge|destroy|clean(?:\s?up)?|clear out|saaf|hata\w*|mita\w*|uda do))\b.*(?:\boutside\b|\bhome\b|~\/|(?<![.\w])\/tmp\b|\/etc|\/usr|\/var|\/(?:srv|opt|root|mnt|media|users?|library)\b|\bsystem\b|\bwhole\b|\bentire\b|\ball (?:files|data)\b|\bdatabase\b|\bparent folder\b|\.\.\/|\bdisk\b|\beverything\b|\bother (?:projects?|repos?)\b|\bdownloads\b|\bremote\b|\bghar\b|\bbahar\b|\bsab kuch\b|\bpoora\b|\bpura\b)|(?:\boutside\b|\bhome folder\b|\bghar\b|\bbahar\b|\bsab kuch\b|\bpoora\b|\bpura\b|\bother (?:projects?|repos?)\b).*\b(?:delete|remove|wipe|erase|saaf|hata\w*|mita\w*|uda do)\b|\bdrop (?:table|database|schema|db)\b|\brm -rf \/|\bformat the disk/],
  ['delete outside', /(?:हटा|मिटा|डिलीट).*(?:बाहर|होम|सिस्टम|सब कुछ|पूरा|पूरी|डेटाबेस)|(?:बाहर|होम|सिस्टम|सब कुछ|पूरा|पूरी|डेटाबेस).*(?:हटा|मिटा|डिलीट)/],
  ['admin rights', /\b(?:sudo|as root|with root|root (?:access|user|rights|privileges|shell)|superuser|administrator|admin (?:rights|access|privileges)|run as admin|chmod 777|chown|setuid|elevat\w*|docker group|system[- ]wide|apt(?:-get)? install|visudo)\b|\b(?:add|put)\b.{0,30}\bto the \w+ group\b/],
  ['admin rights', /एडमिन|सुडो|रूट/],
  ['safety off', /\b(?:disable|turn off|switch off|skip|bypass|ignore|silence|band|bandh|hata)\w*\b.{0,40}\b(?:safety|security|checks?|hooks?|lint\w*|tests?|ci|verification|sandbox|firewall|protection|guard|rules?|warnings?)\b|\b(?:safety|security|checks?|hooks?|lint|tests?)\b.{0,30}\b(?:band|bandh|hata|skip)\w*\b|--no-verify|\bno[- ]verify\b|--dangerously|\b(?:turn|switch|shut)\w*\b[^?.]{0,40}\b(?:checker|checks?|lint\w*|tests?|types?|typecheck\w*|safety|security|hooks?|ci|validation|sandbox|firewall|guard|rules?|warnings?|strict\w*)\b[^?.]{0,15}\boff\b|\bcomment(?:ing)? out\b.{0,30}\b(?:tests?|checks?|asserts?|assertions?|validation|lint\w*)\b|\b(?:delete|remove)\b.{0,20}\b(?:failing|broken|flaky) tests?\b/],
  ['safety off', /(?:बंद|हटा|छोड़|स्किप).*(?:सुरक्षा|जांच|जाँच|चेक|टेस्ट|हुक)|(?:सुरक्षा|जांच|जाँच|चेक|टेस्ट|हुक).*(?:बंद|हटा|छोड़|स्किप)/],
  ['wider mode', /\b(?:bypass ?permissions?|auto mode|accept edits|auto-accept|don'?t ask again|do not ask again|always allow|allow all|skip permissions|dangerously-skip|full access|yolo|bina puche|bina pooche|bina permission|hamesha allow|sab allow|stop asking|no more (?:asking|prompts|questions))\b|\ballow (?:every|any)\w*\b|\bwithout (?:asking|permission|prompts?|confirm\w*)\b/],
  ['wider mode', /बिना पूछे|ऑटो मोड|बायपास|हमेशा अनुमति/],
]);

// Latin letters that a Cyrillic or Greek one looks like ("lоg in" with a Cyrillic о): read as the Latin one, so a word
// copied from a page with such a letter is still the word. Only letters that look the same in lower case; also the
// dotless ı, which Latin itself has.
const LOOKS_LATIN = Object.freeze({
  ı: 'i',
  а: 'a', в: 'b', е: 'e', ё: 'e', з: '3', і: 'i', ї: 'i', ј: 'j', к: 'k', м: 'm', н: 'h', о: 'o', п: 'n', р: 'p', с: 'c', т: 't',
  у: 'y', х: 'x', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', ɡ: 'g', α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't',
  υ: 'u', χ: 'x', ω: 'w',
  // Armenian letters that look like Latin ones ("pսsh", "deplօy").
  ս: 'u', օ: 'o', գ: 'q', ո: 'n', շ: 'z',
  // Small-capital Latin letters (Phonetic Extensions: no compatibility form, so NFKD leaves them) — "ᴘush".
  ᴀ: 'a', ʙ: 'b', ᴄ: 'c', ᴅ: 'd', ᴇ: 'e', ɢ: 'g', ʜ: 'h', ɪ: 'i', ᴊ: 'j', ᴋ: 'k', ʟ: 'l', ᴍ: 'm', ɴ: 'n', ᴏ: 'o', ᴘ: 'p', ʀ: 'r', ꜱ: 's', ᴛ: 't', ᴜ: 'u', ᴠ: 'v', ᴡ: 'w', ʏ: 'y', ᴢ: 'z',
});
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKS_LATIN).join('')}]`, 'g');

/**
 * A text as the signs read it: compatibility forms folded and accents split off (NFKD: fullwidth "ｐｕｓｈ" is "push",
 * "púsh" becomes "push"), the characters that draw nothing removed (zero-width spaces, a soft hyphen, direction marks,
 * the combining grapheme joiner, variation selectors, Hangul fillers: Unicode's default-ignorable characters, \p{DI}),
 * lowercased, the Cyrillic, Greek, Armenian and small-capital letters that look like Latin ones read as Latin, and the
 * combining marks on a Latin letter (an accent, a strike-through, an overlay) removed. NFKD decomposes an accented
 * Latin letter into its base and the mark, so the mark is there to strip, which NFKC did not do. Devanagari keeps its
 * own letters and its vowel signs (the mark-strip is only after a Latin letter), and NFC at the end puts it back as the
 * Hindi signs are written.
 */
export function signText(t) {
  return String(t).normalize('NFKD').replace(/\p{DI}/gu, '').toLowerCase().replace(LOOKALIKE, (c) => LOOKS_LATIN[c]).replace(/(?<=\p{sc=Latin})\p{M}+/gu, '').normalize('NFC');
}

/** The first sign of what is the owner's alone in any of `texts`, as its name, or null. */
export function ownersAlone(...texts) {
  const all = signText(texts.flat(Infinity).filter((t) => typeof t === 'string' && t).join('\n'));
  if (!all) return null;
  const hit = SIGNS.find(([, re]) => re.test(all));
  return hit ? hit[0] : null;
}

// The words of a card, everything the tool said in it: what the signs read.
function wordsOf(card) {
  if (card.kind === 'question') return card.questions.map((q) => [q.question, q.header, q.options.map((o) => [o.label, o.description])]);
  if (card.kind === 'plan') return [card.plan];
  if (card.kind === 'notice') return [card.notice && card.notice.text];
  return [];
}

// The mode a plan's approval goes on in: the one the session had before its plan, never a wider one. A session that
// had no other (it started planning, or in the tool's default) goes on asking for each edit.
export function keptMode(had) {
  return !had || had === 'plan' || had === 'default' ? 'manual' : had;
}

/**
 * What Hands-off answers for `card` (askcard.mjs cardOf): { answer, because } or { wait } (why it waits for him).
 *   answer   { answers: { question: label | note } } for a question, { mode } for a plan
 *   because  'recommended' | 'note' | 'plan'
 * `note`: the owner's note for the project ('' for none); `mode`: the session's mode before the plan (keptMode).
 * The marks and the note decide; no other text on the card does (a sentence that says an option is recommended,
 * or to answer, is only words of the tool's and reaches the signs).
 */
export function decide(card, { note = '', mode = null } = {}) {
  if (!card || typeof card !== 'object') return { wait: 'unknown' };
  if (card.kind === 'permission') return { wait: 'permission' }; // the mode's own rules, as without Hands-off
  // A notice on the list is "seen" by itself; the list is empty, so every notice waits (NOTICES_SEEN).
  if (card.kind === 'notice') return NOTICES_SEEN.includes(card.notice && card.notice.type) ? { answer: { seen: true }, because: 'notice' } : { wait: 'notice' };
  // A secret in the tool's words (askcard.mjs masked it on the card): whatever is asked about it is his.
  if (card.masked) return { wait: 'secret' };
  // A text longer than the card shows: the tool and its model read all of it, the signs only the part shown. And the
  // answer must be keyed by the tool's own question, which the card no longer holds whole.
  if (card.cut) return { wait: 'too-long' };
  const sign = ownersAlone(wordsOf(card));
  if (sign) return { wait: `owner:${sign}` };
  if (card.kind === 'plan') return { answer: { mode: keptMode(mode) }, because: 'plan' };
  if (card.kind !== 'question' || !card.questions.length) return { wait: 'unknown' };
  const own = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
  const answers = {};
  let because = 'recommended';
  for (const q of card.questions) {
    if (q.recommended !== null && q.options[q.recommended]) answers[q.question] = q.options[q.recommended].label;
    else if (own && q.freeText) {
      answers[q.question] = own;
      because = 'note';
    } else return { wait: own ? 'no-free-text' : 'no-mark' };
  }
  return { answer: { answers }, because };
}

/**
 * Is Hands-off on for a session? `session`: its own switch ({ on, version, at }, or null: it follows the project's);
 * `project`: the project's ({ on, version, note, at }); `version`: this Hoprig's. A switch stored under another version
 * is off (`stale`: "turned off by the update"). `stopped`: the session's loop stop. → { on, stale, note, since }
 * The session's own switch is over the project's, except that the project turned off after it stops the session too:
 * one press on either stops it (`at`: when each was last pressed). `since`: when the switch that is on was pressed,
 * the start of the hour's count (hourFull).
 */
export function switchState({ session = null, project = null, version = '', stopped = null } = {}) {
  const fresh = (s) => !!s && s.on === true && typeof s.version === 'string' && s.version === version;
  const own = session && typeof session === 'object' && typeof session.on === 'boolean' ? session : null;
  const proj = project && typeof project === 'object' ? project : null;
  const offLater = !!own && !!proj && proj.on === false && (Number(proj.at) || 0) > (Number(own.at) || 0);
  const chosen = own && !offLater ? own : proj;
  const note = project && typeof project.note === 'string' ? project.note : '';
  const stale = !!chosen && chosen.on === true && !fresh(chosen);
  return { on: fresh(chosen) && !stopped, stale, note, loop: stopped === 'loop' || stopped === 'hour', stopped: stopped || null, since: fresh(chosen) ? Number(chosen.at) || 0 : 0 };
}

/**
 * A terminal session's own switch ({ on, version, at }), or null: it is kept in Hoprig's config under the session's
 * run id, written by the dashboard's route (server/handsoff.mjs), never in the run record, which the session's own
 * commands find through $HOPRIG_RUN_FILE. (The config is the same user's file too: see server/handsoff.mjs.)
 */
export function sessionEntry(cfg, runId) {
  const all = cfg && cfg.handsOff && typeof cfg.handsOff.sessions === 'object' && cfg.handsOff.sessions ? cfg.handsOff.sessions : {};
  const e = typeof runId === 'string' && runId && Object.hasOwn(all, runId) ? all[runId] : null;
  return e && typeof e === 'object' && typeof e.on === 'boolean' ? e : null;
}

/**
 * Is run `runId` being moved by the dashboard right now (server/deck.mjs: its stops and its count were read for the
 * new run)? Then Hands-off answers nothing more for it: an answer now would not be counted on the run it moves to. The
 * wall goes on holding: this is no switch, and the old run's own switch stays as it was until the move is done.
 */
export function movingAway(cfg, runId) {
  const all = cfg && cfg.handsOff && typeof cfg.handsOff.moving === 'object' && cfg.handsOff.moving ? cfg.handsOff.moving : {};
  return typeof runId === 'string' && !!runId && Object.hasOwn(all, runId);
}

/** The project entry of `cfg.handsOff` that holds folder `dir` (the deepest one), or null. */
export function projectEntry(cfg, dir) {
  const all = cfg && cfg.handsOff && typeof cfg.handsOff.projects === 'object' && cfg.handsOff.projects ? cfg.handsOff.projects : {};
  if (typeof dir !== 'string' || !dir) return null;
  const keys = Object.keys(all).filter((k) => k && (dir === k || dir.startsWith(k.endsWith('/') ? k : `${k}/`)));
  if (!keys.length) return null;
  const k = keys.sort((a, b) => b.length - a.length)[0];
  return all[k] && typeof all[k] === 'object' ? { ...all[k], dir: k } : null;
}

// The permission modes in the words the page's mode chip uses (web/chat/words.js MODE), never the tool's ids.
export const MODE_WORDS = Object.freeze({ manual: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: 'Don\'t ask', bypassPermissions: 'Bypass permissions' });
export const modeWords = (m) => MODE_WORDS[m] || 'Manual';

/** The answer as one line for the owner: "node:test (Recommended)", "approved the plan; it goes on in Accept edits, the mode it had". */
export function answerText(card, d) {
  if (!d || !d.answer) return '';
  if (d.answer.mode) return `approved the plan; it goes on in ${modeWords(d.answer.mode)}, the mode it had`;
  return Object.values(d.answer.answers).join('; ').slice(0, 300);
}

/** Why, in the owner's words: "because the tool recommended it", "from your note for this project". */
export const BECAUSE = Object.freeze({
  recommended: 'because the tool recommended it',
  note: 'from your note for this project',
  plan: '', // the plan's line says the mode itself (answerText)
});
