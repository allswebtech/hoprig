// The review's automatic scan: reads every file of a skill (never runs any) and points at what deserves a human
// look before an AI agent follows it with the user's permissions. It cannot prove a skill safe; it makes the risky
// lines easy to see. Severity: "block" (install refused), "high", "medium", "low".
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontMatter } from './frontmatter.mjs';

export const LIMITS = { files: 2000, bytes: 50 * 1024 * 1024, textBytes: 2 * 1024 * 1024 };

const SCRIPT_EXT = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.rb', '.pl', '.php', '.ps1', '.psm1', '.bat', '.cmd', '.vbs', '.lua', '.go', '.rs', '.swift', '.java', '.kt', '.applescript', '.scpt', '.jar', '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm']);
const QUIET_BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.zip']);

// Line rules: [id, severity, message, regex, which files ('any' | 'md' | 'skill' | 'code')].
const RULES = [
  ['pipe-to-shell', 'high', 'downloads something and runs it at once', /\b(curl|wget|fetch|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\|\s*iex\b|\bbash\s*<\s*\(\s*curl|\beval\s*"?\$\(\s*(curl|wget)/i, 'any'],
  ['render-command', 'high', 'Claude Code runs this command when the skill loads, before the AI reads it (!`…`)', /(^|[^\\`])!`[^`\n]+`/, 'skill'],
  ['ignore-rules', 'high', 'tells the agent to ignore its rules or the user', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|safety|all)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines|polic(y|ies))\b/i, 'any'],
  ['hide-from-user', 'high', 'tells the agent to act without the user knowing', /\b(do not|don't|never)\s+(tell|inform|show|mention|notify|ask)\b[^.\n]{0,30}\b(the\s+)?(user|human|owner)\b|\bwithout\s+(asking|telling|informing|notifying)\s+(the\s+)?(user|human)\b|\bsilently\b[^.\n]{0,40}\b(send|upload|post|delete|install|run)\b/i, 'any'],
  ['skip-permissions', 'high', 'turns off permission prompts or sandboxing', /--dangerously-skip-permissions|bypassPermissions|--no-sandbox\b|\bbypass(ing)?\s+(the\s+)?(permission|sandbox|safety|security)/i, 'any'],
  ['exfiltrate', 'high', 'sends secrets somewhere', /\bupload\b[^.\n]{0,40}\b(secrets?|credentials?|keys?|tokens?|\.env)\b|\b(send|post)\b[^.\n]{0,40}\b(secrets?|credentials?|tokens?|api[ _-]?keys?|\.env)\b[^.\n]{0,40}\b(to|via)\b/i, 'any'],
  ['credentials', 'high', 'reads credentials, keys or .env files', /(^|[\s"'`(/~])\.env(\.[A-Za-z]+)?\b(?!\.example|\.sample)|\.ssh\/|\bid_(rsa|ed25519|ecdsa)\b|\.aws\/credentials|\.npmrc\b|\.netrc\b|\.pypirc\b|\.git-credentials|\.docker\/config\.json|\.kube\/config|\.claude\/\.credentials|\bsecurity\s+find-(generic|internet)-password|\bgh\s+auth\s+token\b|printenv\b|\benv\s*\|\s*(curl|nc)|process\.env\b(?!\.(NODE_ENV|HOME|PATH|CI)\b)|os\.environ\b/i, 'any'],
  ['exfiltrate-word', 'medium', 'talks about exfiltration (check whether it describes or asks for it)', /\bexfiltrat/i, 'any'],
  ['delete', 'high', 'deletes files recursively', /\brm\s+-[a-zA-Z]*([rR][a-zA-Z]*f|f[a-zA-Z]*[rR])\b|\brm\s+--recursive|\bRemove-Item\b[^\n]*-Recurse|\brd\s+\/s\b|\bdel\s+\/[sq]/i, 'any'],
  ['delete-api', 'medium', 'deletes folders recursively from code', /\bshutil\.rmtree\b|\brmSync\([^)]*recursive|\brm\([^)]*recursive:\s*true/, 'code'],
  ['persistence', 'high', 'changes start-up files, cron or services', /\bcrontab\b|\blaunchctl\s+(load|bootstrap|submit)|\bsystemctl\s+(--user\s+)?enable|>>?\s*~?\/?[^\s]*\.(bashrc|zshrc|profile|bash_profile|zprofile)\b|\bschtasks\b|\bRun\\(?:Once)?\b|LaunchAgents/i, 'any'],
  ['sudo', 'medium', 'asks for administrator rights', /(^|[\s;&|`(])sudo\s+\S/, 'any'],
  ['network', 'medium', 'reaches the network', /\b(curl|wget|nc|ncat|netcat|scp|rsync|ftp)\s+\S|\bfetch\s*\(|\brequests\.(get|post|put|delete|patch)\b|\burllib(\.request)?\b|\bhttpx?\.\w+\(|\baxios\b|\bhttps?\.(get|request)\s*\(|\bInvoke-(WebRequest|RestMethod)\b|\bnew\s+WebSocket\b|\bsocket\.(socket|connect)\b/i, 'any'],
  ['webfetch', 'medium', 'tells the agent to fetch instructions or content from the internet', /\bWebFetch\b|\b(fetch|download|retrieve|curl|get)\b[^.\n]{0,30}\b(rules|instructions|guidelines|prompts?|commands?)\b[^\n]{0,40}https?:\/\/|https?:\/\/\S+[^.\n]{0,30}\b(and follow|follow (it|them|these)|and run|and execute)\b/i, 'md'],
  ['exec', 'medium', 'runs other programs or code built at run time', /\beval\s*\(|\bexec\s*\(|\bnew\s+Function\s*\(|\bchild_process\b|\bspawn(Sync)?\s*\(|\bexecSync\s*\(|\bsubprocess\.|\bos\.(system|popen|exec\w*)\s*\(|\bpexpect\b|\bRuntime\.getRuntime\(\)\.exec/, 'code'],
  ['encoded', 'medium', 'decodes hidden (base64/hex) content', /\bbase64\s+(-d|--decode|-D)\b|\batob\s*\(|\bb64decode\b|Buffer\.from\([^)]*['"]base64['"]|\bfromCharCode\(\s*(\d+\s*,\s*){8,}|\bxxd\s+-r/i, 'any'],
  ['chmod', 'low', 'makes a file executable or changes permissions', /\bchmod\s+(\+x|[0-7]{3,4}|-R)\b/i, 'any'],
  ['install', 'low', 'installs packages', /\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bnpx\s+-y\b|\bpip3?\s+install\b|\buv\s+(pip|tool)\s+install\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bgo\s+install\b|\bcargo\s+install\b/i, 'any'],
];
// In Markdown prose (outside code) words about credentials, deleting or the network usually describe rather than
// do, so they count one level lower. Rules about what the agent is told to do keep their level everywhere.
const PROSE_LOWER = new Set(['credentials', 'delete', 'persistence', 'sudo', 'network', 'encoded', 'install', 'chmod']);
const LOWER = { high: 'medium', medium: 'low', low: 'low' };
const BLOB = /[A-Za-z0-9+/]{240,}={0,2}/;
// Characters a reader cannot see: zero-width, bidirectional controls, Unicode "tag" characters, other format chars.
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩­᠎﻿\u{E0000}-\u{E007F}]/u;
const HIDDEN_G = new RegExp(HIDDEN.source, 'gu');

const fileKind = (rel, buf, mode) => {
  const ext = path.extname(rel).toLowerCase();
  const binary = buf.subarray(0, 8192).includes(0);
  if (binary) return QUIET_BINARY_EXT.has(ext) ? 'asset' : 'binary';
  if (SCRIPT_EXT.has(ext) || /^#!/.test(buf.subarray(0, 64).toString('utf8')) || (mode & 0o111) !== 0) return 'script';
  return 'text';
};

/** A path from inside a skill that is safe to write below a folder: relative, no "..", no odd characters. */
export function safeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400) return false;
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\')) return false;
  const parts = rel.split(/[\\/]/);
  return parts.every((p) => p && p !== '.' && p !== '..' && !/[\x00-\x1f\x7f]/.test(p) && !HIDDEN.test(p));
}

/**
 * Every file below `root` (a skill folder), without following symlinks out of it. Returns
 * { files: [{ path, size, mode, kind, sha256? }], problems: [finding] }; symlinks are listed with their target.
 */
export function walkSkill(root, { hash } = {}) {
  const files = [];
  const problems = [];
  let total = 0;
  const realRoot = fs.realpathSync(root);
  const visit = (dir, relDir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (relDir === '' && e.name === '.git') continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      if (!safeRel(rel)) {
        problems.push({ file: rel, line: 0, rule: 'bad-name', severity: 'block', message: 'a file name that could escape the skill folder or hide characters' });
        continue;
      }
      if (e.isSymbolicLink()) {
        let target = null;
        try {
          target = fs.realpathSync(full);
        } catch {
          /* broken link */
        }
        const inside = target && (target === realRoot || target.startsWith(realRoot + path.sep));
        files.push({ path: rel, size: 0, mode: 0, kind: 'symlink', link: fs.readlinkSync(full), inside: Boolean(inside) });
        problems.push(inside
          ? { file: rel, line: 0, rule: 'symlink', severity: 'medium', message: `a link to ${fs.readlinkSync(full)} inside the skill; it is copied as a file` }
          : { file: rel, line: 0, rule: 'symlink-out', severity: 'block', message: `a link that points outside the skill (${fs.readlinkSync(full)})` });
        continue;
      }
      if (e.isDirectory()) {
        visit(full, rel);
        continue;
      }
      if (!e.isFile()) {
        problems.push({ file: rel, line: 0, rule: 'special-file', severity: 'block', message: 'not a regular file (device, socket or pipe)' });
        continue;
      }
      const st = fs.statSync(full);
      total += st.size;
      const f = { path: rel, size: st.size, mode: st.mode & 0o7777 };
      if (hash) f.sha256 = hash(fs.readFileSync(full));
      files.push(f);
      if (files.length > LIMITS.files) throw Object.assign(new Error(`more than ${LIMITS.files} files: not a skill this tool takes`), { status: 400 });
    }
  };
  visit(realRoot, '');
  if (total > LIMITS.bytes) problems.push({ file: '', line: 0, rule: 'too-big', severity: 'block', message: `the skill is ${Math.round(total / 1048576)} MB; more than ${LIMITS.bytes / 1048576} MB is refused` });
  return { files, problems, total };
}

const excerpt = (line) => {
  const t = line.trim().replace(HIDDEN_G, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
};

/** Findings for one text file's content. `rel` decides which rules apply. */
export function scanText(rel, text) {
  const out = [];
  const isMd = /\.(md|markdown|mdx|txt)$/i.test(rel);
  const isSkill = /(^|\/)SKILL\.md$/.test(rel);
  const perRule = new Map();
  const push = (f) => {
    const n = (perRule.get(f.rule) || 0) + 1;
    perRule.set(f.rule, n);
    if (n <= 8) out.push(f);
    else if (n === 9) out.push({ ...f, line: 0, message: `${f.message} (more lines like this not listed)`, excerpt: '' });
  };
  const lines = String(text).split('\n');
  let fenced = false;
  lines.forEach((line, i) => {
    if (isMd && /^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const prose = isMd && !fenced && !line.includes('`');
    if (HIDDEN.test(line)) {
      const cps = [...new Set(line.match(HIDDEN_G).map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`))];
      push({ file: rel, line: i + 1, rule: 'hidden-unicode', severity: 'high', message: `characters you cannot see (${cps.join(', ')})`, excerpt: excerpt(line) });
    }
    if (BLOB.test(line)) push({ file: rel, line: i + 1, rule: 'blob', severity: 'medium', message: 'a long encoded blob (base64 or similar)', excerpt: `${line.trim().slice(0, 80)}…` });
    for (const [rule, severity, message, re, where] of RULES) {
      if (where === 'skill' && !isSkill) continue;
      if (where === 'md' && !isMd) continue;
      if (where === 'code' && isMd) continue;
      if (re.test(line)) push({ file: rel, line: i + 1, rule, severity: prose && PROSE_LOWER.has(rule) ? LOWER[severity] : severity, message, excerpt: excerpt(line) });
    }
  });
  if (isSkill) {
    const fm = parseFrontMatter(text);
    if (!fm.ok) push({ file: rel, line: 1, rule: 'no-front-matter', severity: 'medium', message: 'SKILL.md has no front matter (name, description)', excerpt: '' });
    const d = fm.data;
    if (d['allowed-tools']) push({ file: rel, line: 1, rule: 'allowed-tools', severity: 'medium', message: `pre-approves tools while it runs: ${String(typeof d['allowed-tools'] === 'object' ? JSON.stringify(d['allowed-tools']) : d['allowed-tools'])}`, excerpt: '' });
    if (d.hooks) push({ file: rel, line: 1, rule: 'hooks', severity: 'high', message: 'registers hooks (commands Claude Code runs on events)', excerpt: '' });
    if (d.shell === 'powershell') push({ file: rel, line: 1, rule: 'shell', severity: 'low', message: 'its injected commands run in PowerShell', excerpt: '' });
  }
  return out;
}

const ORDER = { block: 0, high: 1, medium: 2, low: 3 };

/**
 * Scan a skill folder: { files, findings, counts, total }. Files get a `kind` (text, script, binary, asset, symlink);
 * scripts and binaries are findings too, so the review lists them.
 */
export function scanSkill(root, { hash } = {}) {
  const { files, problems, total } = walkSkill(root, { hash });
  const findings = [...problems];
  const realRoot = fs.realpathSync(root);
  for (const f of files) {
    if (f.kind === 'symlink') continue;
    const buf = fs.readFileSync(path.join(realRoot, f.path));
    f.kind = fileKind(f.path, buf, f.mode);
    if (f.kind === 'binary') findings.push({ file: f.path, line: 0, rule: 'binary', severity: 'high', message: 'a binary file: its content cannot be reviewed here', excerpt: '' });
    if (f.kind === 'script') findings.push({ file: f.path, line: 0, rule: 'script', severity: 'medium', message: 'a script the agent may run', excerpt: '' });
    if ((f.mode & 0o6000) !== 0) findings.push({ file: f.path, line: 0, rule: 'setuid', severity: 'block', message: 'setuid/setgid bit', excerpt: '' });
    if (f.kind === 'binary' || f.kind === 'asset' || buf.length > LIMITS.textBytes) continue;
    findings.push(...scanText(f.path, buf.toString('utf8')));
  }
  if (!files.some((f) => f.path === 'SKILL.md')) findings.push({ file: 'SKILL.md', line: 0, rule: 'no-skill-md', severity: 'block', message: 'there is no SKILL.md at the top of the folder', excerpt: '' });
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const counts = { block: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return { files, findings, counts, total };
}
