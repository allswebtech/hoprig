// `hoprig skills …`: the skills manager on the command line. Every command that changes a skills folder shows
// what it will do and asks first (a real terminal is needed for the question; elsewhere the review is printed with
// the command that approves it).
import { oneLine } from './frontmatter.mjs';
import * as hub from './hub.mjs';
import { catalogTools, checkTool, updateTool } from './tools.mjs';

const HELP = `hoprig skills — Claude Code skills: see, find, suggest, review, add, update

  hoprig skills list [--project <dir>] [--offline]   installed skills, their source and whether a newer one exists
  hoprig skills find <words>                      search the built-in catalog and skills.sh
  hoprig skills suggest [dir]                     skills that fit a project (read from its manifests, no AI), with why
  hoprig skills add <id | owner/repo[/path] | owner/repo@skill | git url> [--project <dir> | --user] [--yes]
                                                     fetch into quarantine, show the review, install on a yes
                                                     (--yes only for catalog entries at their reviewed commit)
  hoprig skills approve <review id>               install a review printed earlier (when no terminal could ask)
  hoprig skills update [name] [--check] [--project <dir>] [--overwrite-local]
                                                     newer versions: the diff and the scan, then a yes per skill
  hoprig skills undo <name> [--project <dir>]     go back to the version before the last update or removal
  hoprig skills rm <name> [--project <dir>] [--yes]   remove a skill (kept for undo)
  hoprig skills tools [--update <id>]             command-line tools catalog skills need: installed, latest, update

  Skills are folders with a SKILL.md that Claude Code loads: yours from ~/.claude/skills, a project's from
  <project>/.claude/skills. Hoprig records what it installs in .hoprig-skills.json next to them.
`;

function parseArgs(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project' || a === '--commit' || a === '--update') flags[a.slice(2)] = args[++i];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else if (a === '-y') flags.yes = true;
    else pos.push(a);
  }
  return { flags, pos };
}

const ago = (iso) => (iso ? iso.slice(0, 10) : '');
const sourceText = (s) => (!s ? '' : s.type === 'bundled' ? `bundled with Hoprig ${s.version}` : `${s.repo || s.url}${s.path ? `/${s.path}` : ''} @ ${String(s.commit).slice(0, 7)}`);

async function list(flags, out) {
  const scopes = [hub.installed({}), ...(flags.project ? [hub.installed({ project: flags.project })] : [])];
  for (const sc of scopes) {
    let checks = [];
    if (!flags.offline) checks = await hub.checkUpdates(sc.kind === 'user' ? {} : { project: sc.root }).catch(() => []);
    const byName = new Map(checks.map((c) => [c.name, c]));
    out(`${sc.kind === 'user' ? 'Your skills' : `Skills of ${sc.root}`} (${sc.dir}):`);
    if (!sc.skills.length) out('  (none)');
    for (const s of sc.skills) {
      const c = byName.get(s.name);
      const state = !s.managed ? (s.viaSkillsCli ? `from ${s.viaSkillsCli.source}${s.viaSkillsCli.commit ? ` @ ${s.viaSkillsCli.commit.slice(0, 7)}` : ''} (skills CLI)` : 'source unknown (not installed by Hoprig)')
        : `${sourceText(s.source)}${c ? (c.state === 'update' ? '  — UPDATE AVAILABLE' : c.state === 'current' ? '  — up to date' : `  — ${c.error || 'could not check'}`) : ''}`;
      out(`  ${s.name}${s.link ? ' (link)' : ''}`);
      out(`      ${oneLine(s.description, 110) || '(no description)'}`);
      out(`      ${state}${s.edited.length ? `  — EDITED HERE: ${s.edited.join(', ')}` : ''}`);
    }
  }
  return 0;
}

async function find(words, flags, out) {
  const r = await hub.find(words);
  if (flags.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  out(`Catalog (reviewed, pinned):${r.catalog.length ? '' : ' nothing for that'}`);
  for (const c of r.catalog) out(`  ${c.id}  ${c.source}  [${c.license}]\n      ${c.for}\n      hoprig skills add ${c.id}`);
  out('', `skills.sh${r.error ? `: ${r.error}` : ':'}`);
  for (const o of r.online) out(`  ${o.source}@${o.name}  ${o.installs.toLocaleString('en')} installs${o.license ? `  [${o.license}]` : ''}${o.add ? `\n      hoprig skills add ${o.add}` : '  (not on GitHub: not supported)'}`);
  out('', 'Anything found online is reviewed in full before it is installed.');
  return 0;
}

function suggest(dir, flags, out) {
  const r = hub.suggest(dir || process.cwd());
  if (flags.json) {
    out(JSON.stringify(r, null, 2));
    return 0;
  }
  out(`Project: ${r.project}`);
  const stacks = Object.keys(r.stacks).filter((s) => s !== 'code');
  out(`Seen:    ${stacks.length ? stacks.join(', ') : 'nothing this tool knows'}${r.repos.length > 1 ? `  (repositories: ${r.repos.join(', ')})` : ''}`);
  out('');
  if (!r.suggestions.length) out('No catalog skill fits this project.');
  for (const s of r.suggestions) {
    out(`${s.installed ? '✓' : '•'} ${s.id}${s.installed ? '  (installed)' : ''}  [${s.license}]`);
    out(`    ${s.for}`);
    out(`    why: ${s.why.join('; ')}`);
    out(`    from: ${s.source}`);
    if (!s.installed) out(`    ${s.command}`);
  }
  if (r.ideas.length) out('', 'More to look for:', ...r.ideas.map((i) => `  ${i}`));
  return 0;
}

async function add(spec, flags, ui) {
  if (!spec) {
    ui.say('usage: hoprig skills add <catalog id | owner/repo[/path] | owner/repo@skill | git url> [--project <dir> | --user]');
    return 2;
  }
  const review = await hub.prepare(spec, { project: flags.user ? null : flags.project || null, forceProject: Boolean(flags.project), commit: flags.commit || null });
  for (const l of hub.reviewText(review)) ui.say(l);
  return decide(review, flags, ui);
}

async function decide(review, flags, ui) {
  if (review.counts.block) {
    hub.cancel(review.id);
    ui.say('\nNot installed: the review found a blocking problem (above).');
    return 1;
  }
  let go = false;
  if (flags.yes) {
    if (!review.pinned) {
      ui.say('\n--yes is only for catalog entries at their reviewed commit. This one needs your look: run it again in a terminal, or approve it with:');
      ui.say(`  hoprig skills approve ${review.id}`);
      return 1;
    }
    go = true;
  } else go = await ui.confirm(`\n${review.kind === 'update' ? 'Update' : 'Install'} "${review.name}" ${review.scope.kind === 'user' ? 'for you' : `into ${review.scope.dir}`}?`);
  if (!go) {
    if (!process.stdin.isTTY && !flags.yes) {
      ui.say(`\nNo terminal to ask in. After reading the review above, approve it with:\n  hoprig skills approve ${review.id}${review.localEdits && review.localEdits.length ? ' --overwrite-local' : ''}\n(the review is kept for a day)`);
      return 0;
    }
    hub.cancel(review.id);
    ui.say('Nothing changed.');
    return 0;
  }
  const r = hub.approve(review.id, { overwriteLocal: Boolean(flags['overwrite-local']) });
  ui.say(`${review.kind === 'update' ? 'Updated' : 'Installed'} "${r.name}" in ${r.dir}. Claude Code picks it up in its next turn (a new skills folder needs /reload-skills or a new session).`);
  return 0;
}

async function update(name, flags, ui) {
  const scope = flags.project ? { project: flags.project } : {};
  const checks = await hub.checkUpdates(scope, { only: name || null });
  if (!checks.length) ui.say('No skill here was installed by Hoprig, so there is nothing to check.');
  for (const c of checks) {
    const state = c.state === 'update' ? `update available (${String(c.latest).slice(0, 12)})` : c.state === 'current' ? `up to date${c.moved ? ' (the repository moved; this skill did not change)' : ''}` : c.error || c.note || 'could not check';
    ui.say(`  ${c.name}: ${state}${c.edited.length ? `; EDITED HERE: ${c.edited.join(', ')}` : ''}`);
  }
  if (!name || flags.check) await toolsReport(ui, { installedOnly: true });
  if (flags.check) return 0;
  let code = 0;
  for (const c of checks.filter((x) => x.state === 'update')) {
    ui.say('');
    const review = await hub.prepareUpdate(c.name, scope);
    for (const l of hub.reviewText(review)) ui.say(l);
    const rc = await decide(review, { ...flags, yes: false }, ui);
    code = code || rc;
  }
  return code;
}

async function toolsReport(ui, { installedOnly = false } = {}) {
  const tools = catalogTools();
  const checked = await Promise.all(tools.map((t) => checkTool(t)));
  const show = checked.filter((t) => !installedOnly || t.installed);
  if (!show.length) return checked;
  ui.say('', 'Tools:');
  for (const t of show) {
    ui.say(`  ${t.bin} (npm ${t.npm}, for ${t.for}): ${t.installed ? `installed ${t.version || '(version unknown)'}` : 'not installed'}, latest ${t.latest || 'unknown'}${t.updateAvailable ? '  — UPDATE AVAILABLE' : ''}`);
    if (!t.installed || t.updateAvailable) ui.say(`      ${t.installed ? 'update' : 'install'}: ${t.commandText}   (or: hoprig skills tools --update ${t.id})`);
  }
  return checked;
}

async function tools(flags, ui) {
  const checked = await toolsReport(ui);
  if (!flags.update) return 0;
  const t = checked.find((x) => x.id === flags.update);
  if (!t) {
    ui.say(`There is no tool "${flags.update}" in the catalog.`);
    return 1;
  }
  if (t.installed && !t.updateAvailable) {
    ui.say(`${t.bin} is up to date.`);
    return 0;
  }
  if (!(await ui.confirm(`Run "${t.commandText}"?`))) {
    ui.say('Nothing changed.');
    return 0;
  }
  const r = await updateTool(t, { onLine: (l) => ui.say(`  ${l}`) });
  ui.say(r.ok ? 'Done.' : 'That did not work (see above).');
  return r.ok ? 0 : 1;
}

/** Entry point for bin/hoprig.mjs: `hoprig skills <sub> …`. Resolves to an exit code. */
export async function main(command, args = [], { ui = hub.consoleUi() } = {}) {
  const [sub, ...rest] = args;
  const { flags, pos } = parseArgs(rest);
  const out = (...l) => l.forEach((x) => ui.say(x));
  try {
    switch (sub) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        ui.say(HELP);
        return 0;
      case 'list':
      case 'ls':
        return await list(flags, out);
      case 'find':
      case 'search':
        if (!pos.length) {
          ui.say('usage: hoprig skills find <words>');
          return 2;
        }
        return await find(pos.join(' '), flags, out);
      case 'suggest':
        return suggest(pos[0], flags, out);
      case 'add':
        return await add(pos[0], flags, ui);
      case 'approve': {
        const r = hub.approve(pos[0], { overwriteLocal: Boolean(flags['overwrite-local']) });
        ui.say(`Installed "${r.name}" in ${r.dir}.`);
        return 0;
      }
      case 'update':
      case 'upgrade':
        return await update(pos[0], flags, ui);
      case 'undo': {
        if (!pos[0]) {
          ui.say('usage: hoprig skills undo <name> [--project <dir>]');
          return 2;
        }
        hub.undo(pos[0], flags.project ? { project: flags.project } : {});
        ui.say(`"${pos[0]}" is back to its previous version.`);
        return 0;
      }
      case 'rm':
      case 'remove': {
        if (!pos[0]) {
          ui.say('usage: hoprig skills rm <name> [--project <dir>]');
          return 2;
        }
        const scope = flags.project ? { project: flags.project } : {};
        if (!flags.yes && !(await ui.confirm(`Remove the skill "${pos[0]}" (${flags.project ? `project ${flags.project}` : 'yours'})? It is kept for "skills undo".`))) {
          ui.say('Nothing changed.');
          return 0;
        }
        hub.remove(pos[0], scope);
        ui.say(`Removed "${pos[0]}". Undo: hoprig skills undo ${pos[0]}${flags.project ? ` --project ${flags.project}` : ''}`);
        return 0;
      }
      case 'tools':
        return await tools(flags, ui);
      default:
        ui.say(`hoprig skills: unknown command "${sub}"\n`);
        ui.say(HELP);
        return 2;
    }
  } catch (e) {
    if (Number.isInteger(e.status)) {
      ui.say(`hoprig skills: ${e.message}`);
      return 1;
    }
    throw e;
  }
}
