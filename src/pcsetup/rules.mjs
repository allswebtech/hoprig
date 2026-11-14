// Working rules for Claude Code (opt-in): templates/working-rules.md is copied to
// <claude dir>/rules/hoprig-working-rules.md. The user's own CLAUDE.md is never touched.
//
// Why that folder: "Personal rules in ~/.claude/rules/ apply to every project on your machine"
// (https://code.claude.com/docs/en/memory, "User-level rules", read 14 Nov 2026), and "Rules without `paths`
// frontmatter are loaded at launch". Checked for real with Claude Code 2.1.325: a rule file in
// <CLAUDE_CONFIG_DIR>/rules/ reached a `claude -p` answer, so the folder also follows CLAUDE_CONFIG_DIR
// (which the docs do not say).
//
// An earlier version kept the rules in <claude dir>/hoprig/working-rules.md and added an import block to
// CLAUDE.md; adding or removing the rules now takes that block out again (a CLAUDE.md that is a link, because it
// lives in a git repository, is never touched: the user is told) and moves an edited old copy to the new place.
// A rules file the user edited is never overwritten or deleted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeDir } from '../paths.mjs';

export const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'working-rules.md');
export const RULES_FILE = 'hoprig-working-rules.md';
// The earlier version's import block, recognised so it can be removed.
export const OLD_IMPORT_LINE = '@hoprig/working-rules.md';
const BEGIN = '<!-- hoprig: working rules (remove with: hoprig pc setup --remove-rules) -->';
const END = '<!-- /hoprig: working rules -->';
export const OLD_BLOCK = `${BEGIN}\n${OLD_IMPORT_LINE}\n${END}\n`;

const files = (base) => ({
  rules: path.join(base, 'rules', RULES_FILE),
  oldRules: path.join(base, 'hoprig', 'working-rules.md'),
  claudeMd: path.join(base, 'CLAUDE.md'),
});
const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const isLink = (f) => {
  try {
    return fs.lstatSync(f).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * { installed, edited, linked, oldBlock, oldFile, symlinked, rules, claudeMd }. `linked` stays for callers that
 * ask "installed and in effect": a file in rules/ needs no import, so it equals `installed`.
 */
export function rulesState({ base = claudeDir(), template = TEMPLATE } = {}) {
  const f = files(base);
  const cur = read(f.rules);
  const md = read(f.claudeMd) || '';
  return {
    installed: cur !== null,
    edited: cur !== null && cur !== read(template),
    linked: cur !== null,
    oldBlock: md.includes(BEGIN),
    oldFile: read(f.oldRules) !== null,
    symlinked: isLink(f.claudeMd),
    ...f,
  };
}

/** Take the earlier version's block out of CLAUDE.md. Returns a line to say, or null. */
function dropOldBlock(st) {
  if (!st.oldBlock) return null;
  if (st.symlinked) return `your CLAUDE.md is a link: remove the Hoprig working-rules block from ${st.claudeMd} yourself (it is no longer needed)`;
  const md = read(st.claudeMd);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  fs.writeFileSync(st.claudeMd, md.replace(new RegExp(`\\n?${esc(BEGIN)}\\n[^]*?${esc(END)}\\n?`), ''));
  return `took the old import line out of ${st.claudeMd} (no longer needed)`;
}

const removeDirIfEmpty = (dir) => {
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty, or not there */
  }
};

/** Put the rules in place (unless the user's own edited copy is there). Returns what happened, in plain lines. */
export function addRules({ base = claudeDir(), template = TEMPLATE } = {}) {
  const st = rulesState({ base, template });
  const said = [];
  if (!st.installed) {
    fs.mkdirSync(path.dirname(st.rules), { recursive: true });
    const old = read(st.oldRules);
    if (old !== null && old !== read(template)) {
      // The user edited the earlier copy: their version moves to the new place.
      fs.renameSync(st.oldRules, st.rules);
      removeDirIfEmpty(path.dirname(st.oldRules));
      said.push(`moved your edited rules to ${st.rules}`);
    } else {
      fs.copyFileSync(template, st.rules, fs.constants.COPYFILE_EXCL);
      said.push(`wrote ${st.rules}`);
    }
  } else if (st.edited) said.push(`kept your edited ${st.rules} (compare: diff -u "${template}" "${st.rules}")`);
  else said.push(`${st.rules} is already there`);
  const again = rulesState({ base, template });
  if (again.oldFile && read(again.oldRules) === read(template)) {
    fs.unlinkSync(again.oldRules);
    removeDirIfEmpty(path.dirname(again.oldRules));
  }
  const dropped = dropOldBlock(again);
  if (dropped) said.push(dropped);
  return { ok: true, manual: !!(again.oldBlock && again.symlinked), said };
}

/** Remove the rules (only when the user did not edit them) and the earlier version's block. */
export function removeRules({ base = claudeDir(), template = TEMPLATE } = {}) {
  const st = rulesState({ base, template });
  const said = [];
  const dropped = dropOldBlock(st);
  if (dropped) said.push(dropped);
  for (const [file, edited] of [[st.rules, st.edited], [st.oldRules, st.oldFile && read(st.oldRules) !== read(template)]]) {
    if (read(file) === null) continue;
    if (edited) said.push(`kept ${file}: you edited it`);
    else {
      fs.unlinkSync(file);
      removeDirIfEmpty(path.dirname(file));
      said.push(`deleted ${file}`);
    }
  }
  if (!said.length) said.push('the working rules were not installed');
  return { ok: true, said };
}
