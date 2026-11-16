// The coding tools a chat can run, behind one contract, so the chat (src/chat/chat.mjs) and the page know nothing of
// any one of them. An engine is
//   { id, label, capabilities, file(cwd, id), exists(cwd, id), open(opts) → session, transcript({ cwd, id }),
//     sessions(cwd) }
// open(opts): { cwd, env (the provider's), sessionId, resume (the conversation exists), model, effort, ultracode,
//   mode (permission mode), grants (what "allow in this chat" covered), emit(event) } starts the coding tool. What it
//   says comes back through emit() as the events of src/chat/events.mjs, the last one { kind: "exit", code, why }.
// The session: send({ id, text, images }), answer(request, { allow, input, permissions, message }), interrupt(),
//   stopTask(taskId), setMode(mode), setModel(model), setEffort({ effort, ultracode }), rewind(messageId, { dryRun }),
//   cancel(messageId) → taken back?, contextUsage(), usage(), commands(), rename(title), close() → ended, kill(), alive.
// capabilities says what a running session changes by itself: { liveMode, liveModel, liveEffort, ultracode, queue,
//   stopTask, rewind, commands, usage, rename }. Where one is false (or the call fails), the chat starts the coding tool again
//   with the conversation resumed instead.
import { claude } from './claude.mjs';

const ENGINES = new Map([[claude.id, claude]]);

export const engineIds = () => [...ENGINES.keys()];
/** The engine `id`, or Claude Code (a chat kept from before engines had names). */
export const engineOf = (id) => ENGINES.get(id) || claude;
