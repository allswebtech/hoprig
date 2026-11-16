// The dashboard's part of Codex's and OpenCode's servers (./servers.mjs): a server that a list of conversations
// started, or whose last launcher could not stop it, is stopped once no session has used it for a while. The
// sessions themselves are started through POST /api/sessions (src/server/server.mjs) like Claude Code's.
import { SERVER_TOOLS, stopIfUnused } from './servers.mjs';

export const IDLE_STOP_MS = 2 * 60_000;
const LOOK_EVERY_MS = 60_000;

export function codetoolsFeature(ctx, { stop = stopIfUnused, now = Date.now } = {}) {
  let last = 0;
  const unsubscribe = ctx.onTick ? ctx.onTick(async () => {
    if (now() - last < LOOK_EVERY_MS) return;
    last = now();
    for (const tool of SERVER_TOOLS) {
      try {
        await stop(tool, { idleMs: IDLE_STOP_MS, now: now() });
      } catch {
        /* the next look tries again */
      }
    }
  }) : null;
  return { name: 'codetools', routes: [], close: () => unsubscribe?.() };
}
