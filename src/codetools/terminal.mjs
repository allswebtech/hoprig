// A terminal session of Codex or OpenCode, started by the launcher (`hoprig codex|opencode <provider> [args]`, the
// command the dashboard types for these tools: src/server/deck.mjs launchArgv). Claude Code's launch stays in
// src/launch.mjs, unchanged.
//
// The launcher's own words, the same for both tools (and the same as Claude Code's where they mean the same):
//   --resume <id>              continue that conversation of the folder
//   -c                         continue the folder's newest conversation (a new one when there is none)
//   --permission-mode <m>      the tool's permission modes (options.permissionModes of its descriptor)
//   --effort <e>, --model <m>  how it should think, and which model
//   -- <prompt>                a first message (last; may start with "-")
// Anything else goes to the tool as it is. These flags are what moves along when the session moves to another
// provider (the run record's carryArgs).
//
// The session attaches to the tool's server (./servers.mjs), and this launcher follows the server's events to keep
// the run record's status true, as Claude Code's hooks do for Claude: working, needs your OK, waiting. When the
// server cannot be used, the tool runs on its own and the record says statusSource "basic": the card then reads the
// screen's activity only, and says so.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { listProfiles, notServedLines, readProfile, servesTools, validName } from '../profiles.mjs';
import { rememberFolderProvider } from '../defaultprovider.mjs';
import { refuseIfHeld } from '../held.mjs';
import { createRun, updateRun } from '../runs.mjs';
import { endRun } from '../typinglock.mjs';
import { codexPlan, opencodePlan, standalonePlan } from './attach.mjs';
import { anyTool, findTool, notOffered } from './index.mjs';
import { providerModels } from './providers.mjs';
import { cleanEnv, ensureServer, serverProviders, stopIfUnused } from './servers.mjs';
import { isToolSessionId } from './stores.mjs';

export { codexItem, codexStatus, codexTuiArgs, opencodeStatus, opencodeTuiArgs } from './attach.mjs';

const VALUE_FLAGS = new Set(['--permission-mode', '--effort', '--model', '--resume']);

/** The launcher's arguments for Codex or OpenCode, read into { resume, cont, permissionMode, effort, model, prompt, extra }. */
export function parseToolArgs(args) {
  const o = { resume: null, cont: false, permissionMode: null, effort: null, model: null, prompt: null, extra: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      o.prompt = args.slice(i + 1).join(' ') || null;
      break;
    }
    const [name, eq] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (name === '-c' || name === '--continue') o.cont = true;
    else if (VALUE_FLAGS.has(name)) {
      const v = eq !== null ? eq : args[++i];
      if (v === undefined) throw new Error(`${name} needs a value`);
      if (name === '--resume') o.resume = v;
      else if (name === '--permission-mode') o.permissionMode = v;
      else if (name === '--effort') o.effort = v;
      else o.model = v;
    } else o.extra.push(a);
  }
  return o;
}

/** The flags that move with the session to another provider. */
export const carryOf = (o) => [
  ...(o.permissionMode ? ['--permission-mode', o.permissionMode] : []),
  ...(o.effort ? ['--effort', o.effort] : []),
  ...(o.model ? ['--model', o.model] : []),
];

/** The run patch for a new status (stopAt when a reply ended, failure when it ended in an error). */
export function statusPatch(prev, next, now = Date.now()) {
  const patch = { status: next.status, note: next.note || '' };
  if (next.status === 'waiting' && prev !== 'waiting') patch.stopAt = now;
  patch.failure = next.failed ? { at: now, error: 'error', text: String((next.error && (next.error.message || next.error.type)) || 'the reply ended in an error').slice(0, 300) } : null;
  return patch;
}


/** The model to start with: chosen, else the provider's pinned one, else the first the provider lists. */
async function modelFor(o, profile) {
  if (o.model) return o.model;
  const prov = serverProviders('codex', [profile])[0] || serverProviders('opencode', [profile])[0];
  if (prov && prov.model) return prov.model;
  return (await providerModels(profile).catch(() => []))[0] || null;
}

/**
 * Start Codex or OpenCode under `profileName` in this terminal and follow its status. Resolves to the exit code.
 */
export async function launchTool(toolId, profileName, args, { cwd = process.cwd(), base = process.env } = {}) {
  const tool = anyTool(toolId); // toolCommand and the dashboard let only an offered tool through
  let o;
  try {
    o = parseToolArgs(args);
  } catch (e) {
    console.error(`hoprig: ${e.message}`);
    return 2;
  }
  // A resume names its conversation in the run record, written before any check that can refuse the start (one
  // conversation, one process); a refusal removes it again: a terminal that runs nothing holds nothing.
  const conversation = o.resume && isToolSessionId(toolId, o.resume) ? o.resume : null;
  const { file, run } = createRun({ profile: profileName, cwd, carryArgs: carryOf(o), tool: toolId, conversation });
  // The record goes under the typing lock, then the terminal's input is settled (src/typinglock.mjs): nothing typed for
  // the coding tool in the meantime is left for the shell.
  const refuse = async (code, lines) => {
    for (const line of lines) console.error(line);
    await endRun(file);
    return code;
  };
  // A chat or another terminal that runs this conversation already keeps it (held.mjs).
  if (refuseIfHeld(run, conversation, toolId, tool.name)) return refuse(2, []);
  const profile = readProfile(profileName);
  if (!profile) return refuse(2, [`hoprig: no provider "${profileName}". Add one on the Providers page, or with: hoprig add`]);
  if (!servesTools(profile).includes(toolId)) return refuse(2, notServedLines(profile, toolId));
  if (!fs.existsSync(tool.binPath())) return refuse(127, [`hoprig: ${tool.name} is not installed in Hoprig's tools folder. Install it: hoprig tools install ${toolId}`]);
  try {
    tool.flagsFor(o); // refuses an unknown permission mode or effort
  } catch (e) {
    return refuse(2, [`hoprig: ${e.message}`]);
  }
  if (o.resume && !conversation) return refuse(2, [`hoprig: "${o.resume}" is not a ${tool.name} conversation id.`]);
  // A new conversation started here makes this the folder's provider for this coding tool, as Claude Code's launcher
  // does for its own (defaultprovider.mjs). A resume or a continue (a move too: it resumes) carries a conversation on
  // and says nothing about where the next one should start.
  if (!o.resume && !o.cont) rememberFolderProvider(cwd, profile.name, toolId);
  updateRun(file, { server: true, statusSource: 'server' }); // counted as a user before the server is looked at
  const report = makeReporter(file);
  let follow = null;
  let plan;
  try {
    const r = await ensureServer(toolId, { need: profile.name, except: run.runId, base });
    const model = await modelFor(o, profile);
    if (r.ok) {
      plan = toolId === 'codex' ? await codexPlan(r.server, { profile, model, cwd, o, base, report }) : await opencodePlan(r.server, { profile, model, cwd, o, base, report });
      follow = plan.follow;
    } else {
      console.error(`hoprig: ${r.why}. ${tool.name} runs on its own; its live status is basic.`);
      plan = await standalonePlan(toolId, { profile, model, cwd, o, base });
      updateRun(file, { server: false, statusSource: 'basic' });
    }
  } catch (e) {
    await endRun(file);
    await stopIfUnused(toolId, { except: run.runId }).catch(() => {});
    console.error(`hoprig: ${e.message}`);
    return 1;
  }
  if (plan.sessionId) updateRun(file, { sessionId: plan.sessionId });
  console.error(`hoprig: ${tool.name} · provider ${profile.name} · ${profile.label}`);
  const { code, signalled } = await runChild(tool.argv(plan.args), { ...plan.env, HOPRIG_RUN_FILE: file }, follow, { report });
  await endRun(file);
  if (plan.cleanup) plan.cleanup();
  // The last session of the tool stops its server. Not when the terminal itself is closing or being restarted
  // (a move to another provider): the next launcher may be on its way, and this process may not live long enough
  // to finish. The dashboard stops a server that nobody uses after a while (./feature.mjs).
  if (!signalled) await stopIfUnused(toolId, { except: run.runId }).catch(() => {});
  return code;
}

const clip = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

/** What the watchers tell, written into the run record (the dashboard reads it from there). */
function makeReporter(file) {
  let last = 'starting';
  const report = (next) => {
    if (!next) return;
    updateRun(file, statusPatch(last, next));
    last = next.status;
  };
  report.claim = (id) => updateRun(file, { sessionId: id });
  report.title = (t) => updateRun(file, { title: clip(t, 120) });
  report.message = (t) => updateRun(file, { lastMessage: clip(t, 300) });
  report.basic = (on) => updateRun(file, { statusSource: on ? 'basic' : 'server' });
  return report;
}

/** Start the program in this terminal; `follow(child)` watches the server meanwhile and returns a stop function. */
function runChild([bin, ...args], env, follow, { report }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', env });
    const onInt = () => {}; // Ctrl+C belongs to the program (it shares our terminal)
    let signalled = false;
    const forward = (sig) => () => { signalled = true; try { child.kill(sig); } catch { /* gone */ } };
    const onTerm = forward('SIGTERM');
    const onHup = forward('SIGHUP');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);
    const stop = follow ? follow() : (report({ status: 'waiting' }), null);
    const done = (code) => {
      if (stop) stop();
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      resolve({ code, signalled });
    };
    child.on('error', (e) => {
      console.error(`hoprig: could not start ${bin}: ${e.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/** `hoprig codex login|logout [args]`: Hoprig's copy of Codex signs in or out (its own sign-in, in its own folder). */
function codexAccount(word, rest, { base = process.env } = {}) {
  const tool = anyTool('codex');
  if (!tool.installedVersion()) {
    console.error('hoprig: Codex is not installed in Hoprig\'s tools folder. Install it: hoprig tools install codex');
    return Promise.resolve(127);
  }
  const [bin, ...args] = tool.argv([...tool.noSelfUpdate.args, word, ...rest]);
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', env: cleanEnv(base) });
    child.on('error', (e) => { console.error(`hoprig: could not start Codex: ${e.message}`); resolve(127); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

export async function toolCommand(toolId, args) {
  const tool = findTool(toolId);
  if (!tool) {
    // The leading word of a tool this version does not offer (src/codetools/index.mjs): one plain sentence.
    console.error(`hoprig: ${notOffered(toolId, { cli: true })}`);
    return 2;
  }
  const [first, ...rest] = args;
  if (toolId === 'codex' && (first === 'login' || first === 'logout')) return codexAccount(first, rest);
  if (first === '--help' || first === '-h' || first === 'help') {
    console.log(`hoprig ${toolId} [provider] [-c | --resume <id>] [--permission-mode ${tool.options.permissionModes.join('|')}]
                 [--effort ${tool.options.efforts.join('|')}] [--model <id>] [-- <first message>]

  Starts ${tool.name} in this terminal on a provider that serves it. Hoprig keeps the session's status for the
  dashboard and stops its own ${tool.name} server when the last session ends.${toolId === 'codex' ? `

hoprig codex login [--device-auth] | login status | logout
  Codex's own sign-in (for a "Codex sign-in" provider), with Hoprig's copy of Codex.` : ''}`);
    return 0;
  }
  if (first && !first.startsWith('-') && validName(first) && readProfile(first)) return launchTool(toolId, first, rest);
  const fit = listProfiles().filter((p) => servesTools(p).includes(toolId));
  if (first && !first.startsWith('-')) {
    console.error(`hoprig: no provider "${first}". Providers for ${tool.name}: ${fit.map((p) => p.name).join(', ') || 'none yet'}.`);
    return 2;
  }
  if (fit.length === 1) return launchTool(toolId, fit[0].name, args);
  console.error(fit.length
    ? `hoprig: name the provider for ${tool.name}: ${fit.map((p) => p.name).join(', ')} (hoprig ${toolId} <provider>)`
    : `hoprig: no provider serves ${tool.name} yet. Add an OpenAI key or a gateway${toolId === 'codex' ? ', or a Codex sign-in,' : ''} on the Providers page, then Test it.`);
  return 2;
}
