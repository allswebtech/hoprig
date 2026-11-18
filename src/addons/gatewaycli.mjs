// `hoprig gateways …`: the gateways Hoprig knows, and the owner's own ones (src/addons/gateways.mjs).
//
// A gateway the owner adds is a program Hoprig will run, so `add`, `confirm` (his program changed: keep it as it is now)
// and `remove` are his steps: they need a terminal (a question is asked there; there is no --yes), they refuse in a
// shell Hoprig or a coding tool started, and `add` and `confirm` ask for the dashboard's password when there is one (a
// session does not have it). That guards against a mistake, the
// assistant and a coding tool that tries it in passing; it is no wall against a program of the owner's user that sets
// out to do it: such a one can edit config.json itself. Once added, a gateway is an add-on like the shipped one:
// `hoprig addons setup|start|stop <id>`, and Providers → Add provider.
import { loadConfig } from '../config.mjs';
import { ask as askLine, askHidden } from '../menu.mjs';
import { verifyPassword } from '../server/auth.mjs';
import { SHIPPED, addDefinition, checkNew, confirmProgram, definedGateways, gatewayAddons, notLoadedReason, portOf, providersOf, removeDefinition, repinned } from './gateways.mjs';

export const USAGE = `usage: hoprig gateways                  the gateways Hoprig knows, and yours
       hoprig gateways add <id> --title <title> --port <port> (--bin <program> | --npm <package> [--bin <name>])
                          [--args "<words, PORT where the port goes>"] [--dashboard <path of its page>]
                                       a gateway of your own: a program Hoprig will run (asks you first)
       hoprig gateways confirm <id> [--program <path>]
                                       after you changed the program of a gateway of yours (an update): Hoprig
                                       starts the program as it is now (asks you first; its sharing and keys stay);
                                       --program names it, when it is somewhere else now
       hoprig gateways remove <id>      forget a gateway of yours`;

// A shell a coding tool or Hoprig started says so in its environment: Claude Code sets CLAUDECODE, OpenCode OPENCODE,
// Codex CODEX_SANDBOX or CODEX_SANDBOX_NETWORK_DISABLED in its sandbox, and Hoprig sets HOPRIG_RUN_FILE for every
// coding tool it starts and HOPRIG_TERM_ID in each of its terminals.
const CODING_TOOL_VARS = ['CLAUDECODE', 'OPENCODE', 'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID'];
const FLAGS = { '--title': 'title', '--port': 'port', '--bin': 'bin', '--npm': 'npm', '--args': 'args', '--dashboard': 'dashboard' };

// Why a program of the owner's own is not started until he confirms it (status needsConfirm), as `hoprig gateways` says.
const NEEDS_CONFIRM = {
  changed: 'its program changed since you confirmed it',
  'no-fingerprint': 'config.json keeps no fingerprint of its program',
  gone: 'its program is not where you confirmed it any more (an update may have moved it), and what you named when you added it leads to another file now',
  'gone-old': 'its program is not where you confirmed it any more, and config.json does not keep the program as you named it (a definition from before Hoprig kept it)',
};

/**
 * The first sentence of the question before the owner confirms the program of `r.def` again (repinned's answer): what
 * changed, with the file he confirmed and the one it is now when they differ. `id`: said after the title (the terminal).
 */
export function confirmQuestion(r, id = null) {
  const name = id ? `${r.def.title} (${id})` : r.def.title;
  if (r.was === 'no-fingerprint') return `config.json keeps no fingerprint of the program of ${name}. Confirm it only if it is yours.`;
  if (r.from) return `The program of ${name} changed since you confirmed it: you confirmed ${r.from}, and ${r.def.typed} leads to ${r.def.bin} now. Confirm it only if you changed it yourself (an update, a new build).`;
  return `The program of ${name} changed since you confirmed it. Confirm it only if you changed it yourself (an update, a new build).`;
}

/** The definition the words of `add` describe: { raw } or { error }. */
export function parseAdd(args) {
  const [id, ...rest] = args;
  if (!id || id.startsWith('-')) return { error: 'say the id of the gateway first' };
  const raw = { id };
  for (let i = 0; i < rest.length; i += 2) {
    const key = FLAGS[rest[i]];
    const v = rest[i + 1];
    if (!key) return { error: `"${String(rest[i]).slice(0, 40)}" is not an option of gateways add` };
    if (v === undefined) return { error: `${rest[i]} needs a value` };
    if (key in raw) return { error: `${rest[i]} is given twice` };
    raw[key] = key === 'port' ? (/^\d{1,5}$/.test(v) ? Number(v) : NaN) : key === 'args' ? v.trim().split(/\s+/) : v;
  }
  return { raw };
}

/**
 * The lines that say exactly what Hoprig will run for `def`, on the port it will really use (portOf). `typed`: the
 * program as the owner wrote it, when it is a name or a link that stands for the file shown.
 */
export function runsLines(def, { typed = null, cfg = undefined, fingerprint = false } = {}) {
  const words = [def.bin, ...def.args.map((a) => a.replaceAll('PORT', String(portOf(def, cfg))))].join(' ');
  return [
    ...(def.npm ? [`Hoprig installs and updates it with: npm install -g ${def.npm}`] : []),
    'When it starts (by you, on the page, or for a session on a provider that uses it), Hoprig runs:',
    `  ${words}`,
    ...(typed && typed !== def.bin ? [`(${typed} is that file on this computer now.)`] : []),
    ...(fingerprint && def.sha256 ? [`Its fingerprint (sha256) now: ${def.sha256}`] : []),
    ...(def.npm ? [] : [`Hoprig keeps a fingerprint of that file: once it changes, Hoprig does not start it until you confirm it again (hoprig gateways confirm ${def.id}).`]),
    'It runs as your user, with everything your user may do. Nothing of it goes through a shell.',
  ];
}

/** io: { out, err, ask(question) → answer | null, askSecret(question), tty, env } — the terminal; tests pass their own. */
export async function main(args, io = {}) {
  const out = io.out || ((s) => console.log(s));
  const err = io.err || ((s) => console.error(s));
  const ask = io.ask || askLine;
  const askSecret = io.askSecret || askHidden;
  const tty = io.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const env = io.env || process.env;
  const [action, ...rest] = args;

  if (!action || action === 'list') {
    const { skipped } = definedGateways();
    for (const g of gatewayAddons()) {
      const st = await g.status();
      out(`${g.id}  ${g.title}${g.defined ? ' (yours)' : ''} · ${!st.installed ? (st.needsConfirm ? 'its program is not where you confirmed it' : 'not installed') : st.running ? `running at ${st.url}` : st.foreign ? `not running: another program answers on port ${g.gateway.port()}` : 'installed, not running'}`);
      out(`  runs: ${g.command().join(' ')}`);
      if (st.needsConfirm) out(`  ${NEEDS_CONFIRM[st.needsConfirm]}, so Hoprig does not start it: ${st.needsConfirm === 'gone-old' ? `name the program it is now with hoprig gateways confirm ${g.id} --program <path>` : `if that is yours, hoprig gateways confirm ${g.id}`}`);
    }
    for (const s of skipped) out(`skipped${s.id ? ` ${s.id}` : ''} (gateway number ${s.at + 1} in config.json): ${s.error}`);
    return 0;
  }
  if (action !== 'add' && action !== 'remove' && action !== 'confirm') {
    err(USAGE);
    return 2;
  }
  // The owner's own steps: never from a coding tool, never without a terminal to ask in.
  const tool = CODING_TOOL_VARS.find((k) => env[k]);
  if (tool) {
    err(`hoprig gateways ${action} is yours alone: run it in your own terminal, not in a session or a terminal of the dashboard (${tool} is set here).`);
    return 1;
  }
  if (!tty) {
    err(`hoprig gateways ${action} asks you to confirm: run it in a terminal.`);
    return 1;
  }

  if (action === 'remove') {
    const id = rest[0];
    if (!id || rest.length > 1) {
      err(USAGE);
      return 2;
    }
    if (SHIPPED.some((g) => g.id === id)) {
      err(`The gateway ${id} is one Hoprig ships: it cannot be removed.`);
      return 1;
    }
    const g = gatewayAddons().find((a) => a.id === id && a.defined);
    // A definition that was not loaded has no add-on: it is only taken out of config.json.
    const notLoaded = g ? null : notLoadedReason(id);
    if (!g && !notLoaded) {
      err(`There is no gateway "${id}" of yours (hoprig gateways lists them).`);
      return 1;
    }
    const name = g ? g.title : id;
    const users = providersOf(id);
    if (users.length) out(`The ${users.length === 1 ? 'provider' : 'providers'} ${users.join(', ')} start${users.length === 1 ? 's' : ''} ${name}: ${users.length === 1 ? 'its' : 'their'} sessions will not start until you change or remove ${users.length === 1 ? 'it' : 'them'}.`);
    const a = await ask(g ? `Remove the gateway ${g.title} (${id})? It is stopped first if it runs. (y/N) ` : `Remove the gateway ${id} from config.json? It was not loaded (${notLoaded}), so Hoprig does not stop it. (y/N) `);
    if (!a || !/^y/i.test(a)) return 1;
    const stopped = g ? await g.stop() : { ok: true };
    if (!stopped.ok) {
      err(stopped.error || `${g.title} did not stop.`);
      return 1;
    }
    const r = removeDefinition(id);
    if (!r.ok) {
      err(r.error);
      return 1;
    }
    out(`Removed ${name}.`);
    return 0;
  }

  if (action === 'confirm') {
    const [id, flag, program, ...more] = rest;
    if (!id || id.startsWith('-') || (flag !== undefined && (flag !== '--program' || program === undefined)) || more.length) {
      err(USAGE);
      return 2;
    }
    const r = repinned(id, undefined, { program: program ?? null });
    if (r.error) {
      err(`Not confirmed: ${r.error}.`);
      return 1;
    }
    if (!r.was) {
      out(`The program of ${r.def.title} is the one you confirmed: there is nothing to confirm.`);
      return 0;
    }
    out(confirmQuestion(r, id));
    for (const l of runsLines(r.def, { typed: r.def.typed, fingerprint: true })) out(l);
    if (!(await ownersYes({ ask, askSecret, out, err }, 'confirm', 'Nothing was changed.'))) return 1;
    const c = confirmProgram(id, { expect: { bin: r.def.bin, sha256: r.def.sha256 }, program: program ?? null });
    if (!c.ok) {
      err(`Not confirmed: ${c.error}.`);
      return 1;
    }
    out(`Confirmed: Hoprig starts ${r.def.title} with this program now. Its sharing and the keys of other computers are as they were.`);
    return 0;
  }

  const parsed = parseAdd(rest);
  if (parsed.error) {
    err(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { list } = definedGateways();
  const checked = await checkNew(parsed.raw, { others: list });
  if (checked.error) {
    err(`Not added: ${checked.error}.`);
    return 2;
  }
  const def = checked.def;
  out(`A gateway of your own: ${def.title} (${def.id}) on port ${portOf(def)}.`);
  for (const l of runsLines(def, { typed: parsed.raw.bin })) out(l);
  if (!(await ownersYes({ ask, askSecret, out, err }, 'add', 'Nothing was added.'))) return 1;
  const r = await addDefinition(parsed.raw, { expect: { bin: def.bin, sha256: def.sha256 } });
  if (!r.ok) {
    err(`Not added: ${r.error}.`);
    return 1;
  }
  out(`Added ${def.title}.`);
  out(def.npm ? `Install it, start it and make its provider: hoprig addons setup ${def.id}` : `Start it and make its provider: hoprig addons setup ${def.id}`);
  out('Or on the page: Providers → Add provider → Other providers.');
  return 0;
}

/**
 * The owner's yes to `verb` (add, confirm) in his terminal: with a dashboard password, that password (what a session or
 * a script in it does not have); while there is none, y/N. → true or false (`nothing` said).
 */
async function ownersYes({ ask, askSecret, out, err }, verb, nothing) {
  const hash = (() => {
    try {
      return loadConfig().server?.passwordHash || null;
    } catch {
      return null;
    }
  })();
  if (hash) {
    const pw = await askSecret(`To ${verb} it, type the dashboard's password (Enter alone: no): `);
    if (!pw) {
      out(nothing);
      return false;
    }
    if (!(await verifyPassword(pw, hash))) {
      err(`That is not the dashboard's password. ${nothing}`);
      return false;
    }
    return true;
  }
  const a = await ask(`${verb[0].toUpperCase()}${verb.slice(1)} it? (y/N) `);
  if (!a || !/^y/i.test(a)) {
    out(nothing);
    return false;
  }
  return true;
}
