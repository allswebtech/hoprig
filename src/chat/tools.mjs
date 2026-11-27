// Which coding tool a chat runs, and what it may choose there: the providers that serve the tool, its permission
// modes, efforts and models. A conversation stays in the coding tool it was started with; a chat of a tool starts,
// moves and resumes only on a provider that serves it (a Claude subscription never reaches another tool), checked
// here on the server wherever that happens. Which tools are offered is the tools' registry's choice
// (src/codetools/index.mjs: the enabled ones), so a tool that is off is refused here too.
import { getAutoSwitch } from '../autoswitch.mjs';
import { EFFORTS, OWNER_MODES, PERMISSION_MODES } from '../config.mjs';
import { assertServes, readProfile, servesTools } from '../profiles.mjs';
import { anyTool, enabledToolIds, findTool, notOffered } from '../codetools/index.mjs';
import { isOffered } from '../codetools/offered.mjs';
import { assertToolReady } from '../codetools/start.mjs';
import { isToolSessionId } from '../codetools/stores.mjs';
import { isSessionId } from '../sessions.mjs';
import { engineIds } from './engines/index.mjs';
import { EFFORTS as OC_EFFORTS, MODES as OC_MODES, MODE_WORDS as OC_MODE_WORDS, knownModels, modelsOf } from './engines/served.mjs';
import { askDue, idsWith, knownModelsFor, modelProblem, modelsFor, notListedOf } from '../models/catalog.mjs';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+\-[\]]{0,119}$/;
const bad = (message) => Object.assign(new Error(message), { status: 400 });
const autoOn = () => getAutoSwitch().enabled === true;

/** The coding tool a request names (absent: Claude Code): on, installed and with a chat engine. Throws a 400/409. */
export function chatTool(v, cfg) {
  if (v === undefined || v === null || v === '' || v === 'claude') return 'claude';
  // Not part of this version (Codex): the switch's own sentence (src/codetools/offered.mjs).
  if (!isOffered(v) && anyTool(v)) throw bad(notOffered(v));
  const offered = chatTools(cfg);
  if (!offered.includes(v)) throw bad(`a chat runs one of these coding tools: ${offered.map((id) => findTool(id).name).join(', ')}`);
  assertToolReady(v, cfg);
  return v;
}

/** The coding tools a chat can run on this computer: the ones that are on and have a chat engine. */
export const chatTools = (cfg) => enabledToolIds(cfg).filter((id) => engineIds().includes(id));

/**
 * Why a chat of `tool` runs nothing now (the tool was turned off since it was opened), as the page says it; null while
 * it is on. Claude Code is never off.
 */
export const toolOffWords = (tool, cfg) => (tool === 'claude' || chatTools(cfg).includes(tool) ? null
  : `${findTool(tool).name} is off on this computer: turn it on under Settings → New sessions → Coding tools to go on with this chat`);

/**
 * The same for the page's choice: [{ id, name, modes?, modeWords?, efforts? }] of the ones installed too (Claude Code
 * is always one; another tool brings its own choices, Claude Code's are the page's own words).
 */
export function chatToolList(cfg) {
  return chatTools(cfg).filter((id) => {
    try {
      assertToolReady(id, cfg);
      return true;
    } catch {
      return id === 'claude';
    }
  }).map((id) => (id === 'claude' ? { id, name: findTool(id).name } : { id, name: findTool(id).name, modes: OC_MODES, modeWords: OC_MODE_WORDS, efforts: OC_EFFORTS }));
}

/** May a chat of `tool` run on provider `name`? Says why not as a 400; false when there is no such provider. */
export function providerOk(name, tool) {
  if (name === 'auto') return tool === 'claude' && autoOn();
  const p = readProfile(name);
  if (p && !servesTools(p).includes(tool)) assertServes(p, tool);
  return !!p;
}

/** The same, without the sentence: may a chat fall back on this provider (the folder's last one)? */
export const serves = (name, tool) => (name === 'auto' ? tool === 'claude' && autoOn() : servesTools(readProfile(name)).includes(tool));

/** A conversation id of `tool`, as its store spells it. */
export const conversationIdOk = (tool, id) => (tool === 'claude' ? isSessionId(id) : isToolSessionId(tool, id));

/**
 * The chips' choices of a chat of `tool` on provider `profile`: { models, efforts, modes, modeWords?, check }. Claude
 * Code: the provider's own models as far as they are known now (src/models/catalog.mjs; a picker that opens asks for
 * them), then the saved values `claudeModels()` names (a default set in Settings) that the list leaves out. Another
 * tool: its own modes and efforts, and the models the provider lists (from a cache: `onModels` is called once a list
 * that was not known yet arrives). `check(m)`: null when model `m` may start, else why not.
 */
export function choicesOf(tool, profile, claudeModels, onModels) {
  if (tool === 'claude') {
    const saved = (claudeModels ? claudeModels() : []).filter((m) => typeof m === 'string' && m);
    const view = knownModelsFor(profile || '');
    // An open chat page (onModels) is an open picker: its provider is asked at most once in ten minutes, whatever the
    // last ask gave (askDue): a model the endpoint adds later reaches the menu, and a refused key is not asked again at
    // every state the page is sent.
    if (onModels && profile && askDue(profile)) modelsFor(profile).then((v) => v.source === 'endpoint' && onModels(), () => {});
    // notListed: the saved values the provider's own list leaves out, shown marked (never replaced).
    return { models: idsWith(view, saved), notListed: notListedOf(view, saved), efforts: EFFORTS, modes: PERMISSION_MODES, check: (m) => modelProblem(profile || '', m, { saved }) };
  }
  const known = knownModels(profile);
  if (!known.length && onModels) {
    const p = readProfile(profile);
    if (p) modelsOf(p).then((list) => list.length && onModels(), () => {});
  }
  return { models: known.map((m) => m.id), efforts: OC_EFFORTS, modes: OC_MODES, modeWords: OC_MODE_WORDS };
}

/**
 * A model chosen for a chat of `tool`: Claude Code, one of the provider's list, a family name, a saved value or (no
 * list known) a checked exact name; another tool, one of the choices (also a model id while the list is not known).
 */
export function modelOk(tool, m, choices) {
  if (choices.models.includes(m)) return true;
  if (choices.check) return choices.check(m) === null;
  return tool !== 'claude' && !choices.models.length && typeof m === 'string' && MODEL_RE.test(m);
}

/** Why `m` is refused, in plain words, for a 400 (see modelOk). */
export const modelRefusal = (m, choices) => (choices.check && choices.check(m)) || (choices.models.length ? `the model must be one of: ${choices.models.slice(0, 20).join(', ')}${choices.models.length > 20 ? ', …' : ''}` : 'that is no model id');

/** A permission mode kept for a chat of `tool`: Claude Code's modes are all its own; another tool's or null. */
// Claude Code's App chat may hold Allow everything too (bypassgate.mjs ALL): who may choose it is checked where it is chosen.
export const modeFor = (tool, mode) => (tool === 'claude' ? (OWNER_MODES.includes(mode) ? mode : null) : OC_MODES.includes(mode) ? mode : null);
