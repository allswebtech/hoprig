// `hoprig doctor`: what is there and what is missing, for the whole product, nothing changed. Grouped (This
// computer · Claude Code and providers · Dashboard · Coding tools · Projects · Skills), one line per check with
// ✓ / ✗ / !, and under each problem the one command that fixes it. Exit code 0 only when everything needed works.
// --json gives the same for the page; --offline skips every network lookup.
import { loadConfig } from '../config.mjs';
import { exitCodeFor, sysInfo } from './checks.mjs';
import { grouped, overview } from './overview.mjs';
import { bold, dim, mark } from './ui.mjs';
import { reportDoctor } from '../field/wire.mjs';

export function formatResults(results) {
  const w = Math.max(...results.map((r) => r.label.length));
  const lines = [];
  for (const r of results) {
    lines.push(`  ${mark(r.status)} ${r.label.padEnd(w)}  ${r.detail}`);
    if (r.fix && r.status !== 'ok') lines.push(`    ${' '.repeat(w)}  ${dim('fix:')} ${r.fix}`);
    // The dashboard signs in to Claude itself: named too, so a person who never typed in a terminal has a way.
    if (r.action === 'claude-login' && r.status !== 'ok') lines.push(`    ${' '.repeat(w)}  ${dim('or:')} on the dashboard, Home → Get started → Sign in to Claude`);
  }
  return lines.join('\n');
}

const isHub = (sys) => {
  try {
    return loadConfig().hubOnly === true || sys.env.HOPRIG_HUB === '1';
  } catch {
    return false;
  }
};

// `box`: the box's line (src/box/doctorline.mjs), given only by `hoprig doctor` as a person runs it (cli.mjs): its
// self-test runs there and never when something else asks for the checks.
export async function doctor(args = [], { write = (s) => process.stdout.write(s), sys = sysInfo(), parts, box } = {}) {
  const json = args.includes('--json');
  const offline = args.includes('--offline');
  const unknown = args.filter((a) => a !== '--json' && a !== '--offline');
  if (unknown.length) {
    write('usage: hoprig doctor [--offline] [--json]\n');
    return 2;
  }
  const startedAt = Date.now();
  const results = await overview({ sys, offline, hub: isHub(sys), parts });
  if (box) results.push({ ...(await box()), group: 'This computer' });
  // What the upkeep's two looks kept (off unless the owner turned them on): a suggestion, never a failure.
  try {
    const { readLooks, onlyHereLine, serversLine } = await import('../workspace/onlyherelook.mjs');
    const kept = readLooks();
    const only = onlyHereLine(kept.onlyHere);
    if (only) results.push({ id: 'only-here', group: 'This computer', label: 'Only on this computer', status: 'warn', detail: `${only}, as looked ${String(kept.onlyHere.at).slice(0, 10)}`, fix: 'hoprig pc leave --check' });
    const servers = serversLine(kept.servers);
    if (servers) results.push({ id: 'git-servers', group: 'This computer', label: 'Git servers', status: 'warn', detail: `${servers}, as looked ${String(kept.servers.at).slice(0, 10)}` });
  } catch {
    /* nothing kept, or not readable: nothing to say */
  }
  reportDoctor(results, startedAt); // a field report, only when a check failed (src/field)
  const code = exitCodeFor(results);
  const groups = grouped(results);
  if (json) {
    write(JSON.stringify({ ok: code === 0, groups: groups.map((g) => ({ title: g.title, checks: g.checks.map(({ group, ...c }) => c) })) }, null, 2) + '\n');
    return code;
  }
  write(`\n${bold('hoprig doctor')}\n`);
  for (const g of groups) write(`\n${bold(g.title)}\n${formatResults(g.checks)}\n`);
  write('\n');
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  if (fails) write(`${fails} problem${fails > 1 ? 's' : ''} to fix (✗). Run the "fix" command under each one, or: hoprig setup\n`);
  else write(`Everything needed works.${warns ? ` ${warns} suggestion${warns > 1 ? 's' : ''} (!) above.` : ''}\n`);
  return code;
}
