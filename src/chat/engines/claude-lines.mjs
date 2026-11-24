// Claude Code in a coding chat: the arguments of its headless run and the lines written to it (stream-json), and
// what "allow in this chat" and the permission mode mean in its terms. What it says back is claude-parse.mjs.
//
// Checked on Claude Code 2.1.325 against a stand-in Messages API (no model, no quota) and once against a real model:
//   --permission-prompt-tool stdio   a tool use that needs the owner's OK arrives on stdout as
//       {"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name","input",
//        "tool_use_id","description","permission_suggestions", …}}
//     and is answered on stdin with
//       {"type":"control_response","response":{"subtype":"success","request_id":R,
//        "response":{"behavior":"allow","updatedInput":{…},"updatedPermissions":[…]}}}  or {"behavior":"deny","message":"…"}
//     This is the channel the Agent SDK's canUseTool callback uses; "stdio" is the value the SDK itself passes.
//     An answer of another shape is not asked again: the tool call fails ("invalid permission result").
//   What still asks in bypassPermissions (everything else runs unasked there, .git/ and .claude/ included):
//       AskUserQuestion and ExitPlanMode                     "requires_user_interaction": true (the card is the answer)
//       an ask rule of the settings (permissions.ask)        "decision_reason_type": "rule" (or "matched_ask_rule")
//       a hook that answers "ask"                            "decision_reason_type": "hook"
//       a delete that could empty the disk (rm -rf $DIR/*)   "decision_reason_type": "safetyCheck", "classifier_approvable": false
//       any change after Claude itself entered plan mode     "decision_reason_type": "mode" (EnterPlanMode does not ask;
//                                                            system/status then reports permissionMode "plan")
//     A deny rule never asks: Claude Code refuses the call itself, in every mode. Where the settings turn the mode off
//     (disableBypassPermissionsMode), init reports permissionMode "default" and everything asks as usual.
//   permission_suggestions are what the terminal's "don't ask again" would add. For an edit they are for the session
//     ({"type":"setMode","mode":"acceptEdits","destination":"session"}); for a command, an MCP tool or a web page
//     they name a settings file ({"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm view *"}],
//     "behavior":"allow","destination":"localSettings"}). Sent back with "destination":"session" they hold for the
//     running process only and nothing is written; a resumed process has forgotten them. Given at the start instead
//     (--settings '{"permissions":{"allow":["Bash(node -e 1)"]}}', which writes nothing either) they hold from the
//     first tool call on, with Claude Code's own judgement: a command that chains an allowed one (cd sub && node -e 1)
//     runs unasked, while a chain with a part no rule covers asks for that part only. An "ask" or "deny" rule of the
//     owner's settings still wins over them.
//   A chained command asks with "decision_reason_type": "subcommandResults"; its suggestions name the parts that
//     still need a rule. A sensitive file (.git/, .claude/, a shell profile) asks with "decision_reason_type":
//     "safetyCheck" in every mode but bypassPermissions, also after "acceptEdits" was set.
//   Control requests ({"type":"control_request","request_id":X,"request":{"subtype":…}}) are answered with a
//     control_response of the same id: "initialize" (first; with "perTaskStopAffordance" an interrupt ends the turn
//     and spares background agents, and its answer lists the session's commands and skills), "interrupt",
//     "set_permission_mode" (bypassPermissions only when the process was started with
//     --allow-dangerously-skip-permissions), "set_model", "apply_flag_settings" ({effortLevel, ultracode}: an effort
//     sent without "ultracode" turns it off, so both go together), "stop_task", "rewind_files" (needs the checkpoint
//     variable below), "cancel_async_message" (a message written while a turn runs is queued by Claude Code itself
//     and can be taken back until it starts), "get_context_usage", "get_usage", "file_suggestions".
//   A resumed conversation (--resume <id>) keeps writing the same transcript, <claudeDir>/projects/<slug>/<id>.jsonl,
//     so a chat opens in the terminal (claude --resume <id>) and the other way round.

import { askType } from '../../asking.mjs';

/** The environment a chat's process gets on top of the provider's: file checkpoints, so a turn's edits can be undone. */
export const CHAT_ENV = { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' };

/**
 * Claude Code's arguments for one coding chat. Its normal tools, CLAUDE.md, settings, MCP servers and skills stay.
 * Text streams as it is written (partial messages), each message of the owner is echoed with its id when Claude Code
 * takes it (replay), and the switch into bypassPermissions stays possible while it runs, but only where the owner
 * allowed bypass (`allowBypass`, bypassgate.mjs): without it neither the flag nor a bypass start mode is given.
 */
export function chatArgs({ sessionId, resume = false, fork = null, permissionMode = null, effort = null, model = null, settings = null, allowBypass = true, lead = [] }) {
  if (!sessionId) throw new Error('chatArgs needs a session id');
  // A conversation rewound to an earlier message, or forked (a copy of all of it: `at` is its newest line): a copy of
  // `fork.from` up to the line `fork.at`, under the new id
  // (Claude Code 2.1.325: --resume <old> --fork-session --session-id <new> --resume-session-at <uuid>).
  const where = fork ? ['--resume', fork.from, '--fork-session', '--session-id', sessionId, '--resume-session-at', fork.at]
    : [resume ? '--resume' : '--session-id', sessionId];
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages',
    '--permission-prompt-tool', 'stdio', ...(allowBypass ? ['--allow-dangerously-skip-permissions'] : []),
    ...(permissionMode && (allowBypass || permissionMode !== 'bypassPermissions') ? ['--permission-mode', permissionMode] : []),
    ...(settings ? ['--settings', settings] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(model ? ['--model', model] : []),
    ...lead, // "Lead model" (src/models/lead.mjs leadArgs): its helpers and the lead's instruction; [] when off
    ...where,
  ];
}

const line = (o) => JSON.stringify(o) + '\n';

/**
 * One message of the owner as a stream-json input line. `images`: [{ mime, data (base64) }] go in as image blocks;
 * files are named in the text (@path), which Claude Code reads itself.
 */
export function userLine(text, { id = null, images = [] } = {}) {
  const content = [{ type: 'text', text: String(text) }];
  for (const im of images) content.push({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } });
  return line({ type: 'user', ...(id ? { uuid: id } : {}), message: { role: 'user', content }, parent_tool_use_id: null });
}
/** A tool use is allowed. `permissions`: rule or mode changes for this session only. */
export const allowLine = (requestId, input, permissions = null) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input, ...(permissions && permissions.length ? { updatedPermissions: permissions } : {}) } } });
export const denyLine = (requestId, message) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } });
export const controlLine = (requestId, request) => line({ type: 'control_request', request_id: requestId, request });
export const interruptLine = (requestId) => controlLine(requestId, { subtype: 'interrupt' });

/** Hoprig's word for a permission mode → Claude Code's (the flag says "manual" for what it reports as "default"). */
export const sdkMode = (mode) => (mode === 'manual' || !mode ? 'default' : mode);

// ---------- "allow in this chat" ----------

const GRANT_MAX = 20; // rules or folders in one answer

/**
 * What "allow in this chat" adds for one ask: Claude Code's own suggestions, for this session only, whatever settings
 * file they name. Only what makes Claude ask less about the same thing is taken: allow rules, more folders, and
 * "edits without asking"; never another mode, a deny or ask rule, or a removal. Returns
 * { updates (for allowLine), atoms (one word per rule, folder and mode, to remember the grant by), edits, text,
 * project, projectText, projectAtoms } or null when there is nothing to offer. `project`: "Always allow in this
 * project", only where Claude Code itself offers a lasting rule (its suggestion names a project's settings file:
 * localSettings or projectSettings), sent with the destination of the project's own local settings (localSettings:
 * Claude Code itself writes them into the project's .claude/settings.local.json; Hoprig writes no settings file);
 * "all edits" goes with it for this session (a mode, which Claude Code keeps per session: projectAtoms remembers it).
 * null where nothing lasting was offered (a rule or folder for the session only, "all edits" alone, a rule for the
 * owner's user settings, which is not "this project"). projectText names only the rules and folders it keeps.
 */
export function sessionGrant(suggestions) {
  const updates = [];
  const atoms = [];
  const words = [];
  const kept = []; // what Claude Code itself offers to keep in a project's settings file
  const keptWords = [];
  let edits = null; // the "all edits" update, when offered
  const lasting = (s) => s.destination === 'localSettings' || s.destination === 'projectSettings';
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'setMode' && s.mode === 'acceptEdits') {
      edits = { type: 'setMode', mode: 'acceptEdits', destination: 'session' };
      updates.push(edits);
      atoms.push('mode:acceptEdits');
      words.push('all edits');
    } else if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
      const rules = s.rules.filter((r) => r && typeof r.toolName === 'string' && r.toolName && (r.ruleContent === undefined || typeof r.ruleContent === 'string'))
        .map((r) => (r.ruleContent === undefined ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }));
      if (!rules.length || rules.length !== s.rules.length) continue;
      updates.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
      const said = rules.map((r) => (r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`));
      for (const r of rules) atoms.push(`rule:${r.toolName}:${r.ruleContent ?? ''}`);
      words.push(...said);
      if (lasting(s)) {
        kept.push({ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' });
        keptWords.push(...said);
      }
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length && s.directories.every((d) => typeof d === 'string' && d)) {
      updates.push({ type: 'addDirectories', directories: [...s.directories], destination: 'session' });
      const said = s.directories.map((d) => `the folder ${d}`);
      for (const d of s.directories) atoms.push(`dir:${d}`);
      words.push(...said);
      if (lasting(s)) {
        kept.push({ type: 'addDirectories', directories: [...s.directories], destination: 'localSettings' });
        keptWords.push(...said);
      }
    }
  }
  if (!updates.length || atoms.length > GRANT_MAX) return null;
  const cut = (t) => (t.length > 300 ? `${t.slice(0, 300)}…` : t);
  const project = kept.length ? [...kept, ...(edits ? [edits] : [])] : null;
  return {
    updates, atoms, edits: atoms.every((a) => a === 'mode:acceptEdits'), text: cut(words.join(', ')),
    project, projectText: project ? cut(keptWords.join(', ')) : '',
    projectAtoms: project && edits ? ['mode:acceptEdits'] : [],
  };
}

// Characters of the rules and folders in --settings. Windows starts claude.cmd through cmd.exe, whose whole command
// line may be 8191 characters, quoting included.
const SETTINGS_MAX = 3000;

/**
 * What the chat remembers from "allow in this chat" (sessionGrant atoms, oldest first) and its ultracode switch as
 * Claude Code's --settings for a new process: the allow rules and folders, so it starts as the process where they
 * were added left off. The newest are kept when they do not all fit. "All edits" is not a rule: an edit's ask is
 * answered from the atom (chat.mjs). Returns a JSON string, or null when there is nothing to give.
 */
export function grantSettings(atoms, { ultracode = false } = {}) {
  const allow = [];
  const dirs = [];
  let size = 0;
  for (const a of [...(atoms || [])].reverse()) {
    let m;
    if ((m = /^rule:([^:]+):([\s\S]*)$/.exec(a))) {
      const rule = m[2] ? `${m[1]}(${m[2]})` : m[1];
      if ((size += JSON.stringify(rule).length + 1) > SETTINGS_MAX) break;
      allow.unshift(rule);
    } else if ((m = /^dir:([\s\S]+)$/.exec(a))) {
      if ((size += JSON.stringify(m[1]).length + 1) > SETTINGS_MAX) break;
      dirs.unshift(m[1]);
    }
  }
  const out = {};
  if (allow.length || dirs.length) out.permissions = { ...(allow.length ? { allow } : {}), ...(dirs.length ? { additionalDirectories: dirs } : {}) };
  if (ultracode) out.ultracode = true;
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

// Claude Code marks these two itself (requires_user_interaction); their names hold where a version does not.
const isQuestion = (ask) => ask.interactive || askType(ask.tool) !== 'permission';

/**
 * Why an ask is the owner's to answer even where the chat answers by itself (bypassPermissions), or null:
 *   "question"  the card is the answer (a question to the owner, a plan to approve): never a permission
 *   "rule"      the owner's own settings say "ask" for this
 *   "hook"      a hook of the owner's setup says a person must look
 *   "safety"    Claude Code's stop before a delete it cannot judge: never "allow in this chat"; in bypass mode the
 *               one rule decides it as in a terminal (src/chat/asks.mjs: the chat's hook answers a delete plainly
 *               inside the folder the shell is in)
 */
export function ownerOnly(ask) {
  if (isQuestion(ask)) return 'question';
  if (ask.ruleForced) return 'rule';
  if (ask.reasonType === 'hook') return 'hook';
  if (ask.manualOnly) return 'safety';
  return null;
}

/** One line for the card: why Claude Code asks, where that is not plain from the request itself. */
export function askWhy(ask) {
  if (isQuestion(ask)) return '';
  if (ask.ruleForced) return 'Your permission settings say to ask for this.';
  if (ask.reasonType === 'hook') return `A hook asks for your OK${ask.reason ? `: ${ask.reason}` : '.'}`;
  if (ask.reasonType === 'mode') return 'Claude is in plan mode, where it asks before it changes anything.';
  if (ask.reasonType === 'safetyCheck' || ask.reasonType === 'workingDir' || ask.manualOnly) return ask.reason;
  return '';
}

// The reasons (decision_reason_type) of an ask that a rule of the session settles for good, as seen on Claude Code:
// none (an edit, a web page, an MCP tool), "other" (a command), "workingDir" (a path outside the project). An ask
// with any other reason is never answered from what the chat remembers: its card is shown.
const SETTLED_BY_RULE = new Set([null, 'other', 'workingDir']);
export const settledByRule = (ask) => SETTLED_BY_RULE.has(ask.reasonType);
