// `hoprig addons …`: list the add-ons, install / update / start / stop one, and `setup` one from nothing to a
// usable profile.
import { ask, askHidden } from '../menu.mjs';
import { readProfile, validName, writeProfile } from '../profiles.mjs';
import { hasSetUp, setupShippedGateway } from '../gateway/trouteai.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { allAddons, findAddon, listAddons } from './index.mjs';
import { noteStarted, noteStopped } from './stopmark.mjs';

export const usage = () => `usage: hoprig addons                     list the add-ons and their state
       hoprig addons setup <id>          install it, start it and make a profile for it
       hoprig addons install|update|start|stop|status <id>
       hoprig addons remove <id>         take its copy out of Hoprig's folder (its data is kept)
add-ons: ${allAddons().map((a) => a.id).join(', ')}`;

const line = (text) => process.stdout.write(`  ${text}\n`);

async function show(list) {
  for (const a of list) {
    const state = !a.installed ? 'not installed' : a.running ? `running at ${a.url}` : a.foreign ? `not running: ${a.note || `another program answers at ${a.url}`}` : 'installed, not running';
    console.log(`${a.id}  ${a.title}${a.version ? ` ${a.version}` : ''} · ${state}`);
    console.log(`  ${a.summary}`);
    if (a.homepage) console.log(`  ${a.homepage}`);
  }
}

/**
 * The shipped gateway: installed when missing, started, its key made by its own command and the profile
 * written, with no question and no terminal needed (src/gateway). 0 when it is set up, else 1 and one
 * sentence with the next step.
 */
export async function setupShipped(addon, { setup = setupShippedGateway, out = line, err = (t) => console.error(t), computer = defaultHubLabel() } = {}) {
  const r = await setup({ addon, computer, onLine: out });
  if (!r.ok) {
    err(r.error);
    return 1;
  }
  console.log(r.kept ? `${addon.title} is set up: the provider ${r.name} was left as it is.` : `${addon.title} is set up: the provider ${r.name} uses the key "Hoprig sessions (${computer})".`);
  console.log(`Start a session on it: hoprig ${r.name}. Add your providers in ${addon.title}'s own page (Providers in the dashboard opens it).`);
  return 0;
}

/** Install if needed, start, then ask for the key and write the profile. Interactive. */
async function setup(addon) {
  if (hasSetUp(addon)) return setupShipped(addon);
  let s = await addon.status();
  if (!s.installed) {
    console.log(`Installing ${addon.title}…${addon.builds ? ` ${addon.builds}` : ''}`);
    const r = await addon.install({ onLine: line });
    if (!r.ok) {
      console.error(`${addon.title} could not be installed. Try: ${addon.installHint ? addon.installHint() : `npm install -g ${addon.id}`}`);
      return 1;
    }
  }
  const started = await addon.start();
  if (!started.ok) {
    console.error(started.error || `${addon.title} did not start.`);
    return 1;
  }
  console.log(`${addon.title} is running at ${started.url}`);
  const p = addon.profile();
  if (!process.stdin.isTTY) {
    console.log(`Now make its profile in a terminal: hoprig addons setup ${addon.id}`);
    return 0;
  }
  let name = p.name;
  if (readProfile(name)) {
    const other = await ask(`A profile "${name}" exists. Name for the new one (Enter replaces "${name}"): `);
    if (other === null) return 1;
    if (other) {
      if (!validName(other.toLowerCase())) {
        console.error('Use letters, digits, - or _.');
        return 1;
      }
      name = other.toLowerCase();
    }
  }
  console.log(p.tokenHint);
  const token = await askHidden('Key (it is not shown): ');
  if (!token) {
    console.log('No key given: nothing was saved. Run this again when you have one.');
    return 1;
  }
  writeProfile(name, { label: p.label, prerun: p.prerun, env: { ...p.env, [p.tokenVar]: token } });
  console.log(`Saved the profile "${name}". Start a session on it: hoprig ${name}`);
  console.log(`To let Auto mode use it when your other providers are at their limit: hoprig auto order <your provider> ${name}`);
  return 0;
}

export async function main(command, args) {
  const [action, id] = args;
  if (!action) {
    await show(await listAddons());
    return 0;
  }
  // The public link has its own words now (hoprig public); the old ones still work, as a profile's PRERUN may use them.
  if (id === 'public-link' && ['start', 'stop', 'status'].includes(action)) {
    const pub = await import('./publiccli.mjs');
    const rest = args.slice(2).filter((a) => a !== '--temporary' && a !== '--custom');
    // Written to stderr: as a PRERUN, stdout belongs to Claude Code.
    const say = (s) => process.stderr.write(`${s}\n`);
    // --yes: whoever wrote `addons start public-link` (in a PRERUN too) chose it then; it worked without a question.
    // A link that is on already stays as it is (also a Custom one): start only ever turned something on.
    const { readSwitch } = await import('./linkswitch.mjs');
    const sw = readSwitch();
    const start = ['on', `--${sw.on ? sw.kind : 'temporary'}`, '--yes', ...rest.filter((x) => x !== '--yes')];
    // A password not yet good enough for the link is said, not a failure: a PRERUN that fails stops the session.
    return pub.main(action === 'start' ? start : action === 'stop' ? ['off'] : ['status'], { out: say, err: say, prerun: action === 'start' });
  }
  const addon = findAddon(id);
  if (!addon) {
    console.error(id ? `There is no add-on "${id}".\n${usage()}` : usage());
    return 2;
  }
  switch (action) {
    case 'status':
      await show([{ id: addon.id, title: addon.title, summary: addon.summary, homepage: addon.homepage, ...(await addon.status()) }]);
      return 0;
    case 'install':
      if (addon.builds) console.log(addon.builds);
      return (await addon.install({ onLine: line })).ok ? 0 : 1;
    case 'update': {
      const r = await addon.update({ onLine: line });
      if (!r.ok && r.error) console.error(r.error);
      return r.ok ? 0 : 1;
    }
    case 'remove': {
      if (typeof addon.remove !== 'function') {
        console.error(`${addon.title} has nothing in Hoprig's own folder to remove.`);
        return 2;
      }
      const r = await addon.remove({ onLine: line });
      if (!r.ok) console.error(r.error || `${addon.title} was not removed.`);
      return r.ok ? 0 : 1;
    }
    case 'start': {
      // An add-on may explain itself and ask first (the public link), and show more once it runs.
      if (addon.beforeStart && !(await addon.beforeStart({ args: args.slice(2), ask }))) return 1;
      const r = await addon.start();
      if (r.ok) noteStarted(addon.id);
      if (r.ok && !r.already && addon.afterStart) await addon.afterStart(r);
      // Written to stderr: this command is a profile's PRERUN, and stdout there belongs to Claude Code.
      process.stderr.write(r.ok ? (r.already ? '' : `${addon.title} started: ${r.url}\n`) : `${r.error || `${addon.title} did not start`}\n`);
      return r.ok ? 0 : 1;
    }
    case 'stop': {
      const r = await addon.stop();
      if (r.ok) noteStopped(addon.id); // his own stop: the Operator's gateway rule leaves it stopped
      console.log(r.ok ? (r.already ? r.note || `${addon.title} is not running.` : `${addon.title} stopped.`) : r.error || `${addon.title} did not stop.`);
      return r.ok ? 0 : 1;
    }
    case 'setup':
      if (!addon.profile) return console.log(`${addon.title} is not a provider; start it with: hoprig addons start ${addon.id}`), 2;
      return setup(addon);
    default:
      console.error(usage());
      return 2;
  }
}
