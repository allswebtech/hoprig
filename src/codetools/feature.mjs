// The dashboard's part of the coding tools.
//
//   GET  /api/codetools          [{ id, name, on, managed, installed, about, providers: [name], command }]: which
//                                tools are on, which are installed, and the providers that serve each
//   POST /api/codetools/<id>     { on: bool }: turn a tool on or off (never all off); which tools the page offers
//   GET  /api/codetools/codex/signin   { installed, signedIn: true | false | null }: Codex's own sign-in
//   POST /api/codetools/codex/signin   {}: a terminal with Codex's device sign-in (Hoprig's copy) → { name }
//                                both answer 404 while Codex is not offered (src/codetools/offered.mjs)
//
// And Codex's and OpenCode's servers (./servers.mjs): a server that a list of conversations started, or whose last
// launcher could not stop it, is stopped once no session has used it for a while. The sessions themselves are
// started through POST /api/sessions (src/server/server.mjs) like Claude Code's.
import os from 'node:os';
import { listProfiles, servesTools } from '../profiles.mjs';
import { codexSignedIn, forgetSignin } from './codexsignin.mjs';
import { TOOLS, anyTool, enabledToolIds, findTool, notOffered, withTool } from './index.mjs';
import { SERVER_TOOLS, stopIfUnused } from './servers.mjs';

export const IDLE_STOP_MS = 2 * 60_000;
const LOOK_EVERY_MS = 60_000;

// `find`: the offered tool by id (tests of the kept Codex routes pass one that knows every built tool).
export function codetoolsFeature(ctx, { stop = stopIfUnused, now = Date.now, profiles = listProfiles, signedIn = codexSignedIn, find = findTool } = {}) {
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

  const fail = (status, message) => new ctx.HttpError(status, message);
  const offeredCodex = () => {
    if (!find('codex')) throw fail(404, notOffered('codex'));
    return find('codex');
  };
  const view = () => {
    const on = enabledToolIds(ctx.config());
    const all = profiles();
    return {
      tools: TOOLS.map((t) => ({
        id: t.id, name: t.name, on: on.includes(t.id), managed: !!t.managed, installed: t.installedVersion(),
        about: t.about || null,
        // A Codex sign-in last: the Start form picks the first, and a key provider works without a sign-in step.
        providers: all.filter((p) => servesTools(p).includes(t.id)).sort((a, b) => (a.kind === 'chatgpt') - (b.kind === 'chatgpt')).map((p) => p.name),
        command: t.id === 'claude' ? 'hoprig <provider>' : `hoprig ${t.id} <provider>`,
      })),
    };
  };

  const routes = [
    ['GET', /^\/api\/codetools$/, async () => view()],
    ['GET', /^\/api\/codetools\/codex\/signin$/, async () => {
      const codex = offeredCodex();
      return { installed: !!codex.installedVersion(), signedIn: await signedIn({ fresh: true }) };
    }],
    ['POST', /^\/api\/codetools\/codex\/signin$/, async (req) => {
      const codex = offeredCodex();
      const b = await ctx.readJson(req);
      if (b && Object.keys(b).length) throw fail(400, 'send {}');
      if (!codex.installedVersion()) throw fail(409, 'Codex is not installed: Settings → Coding tools installs it');
      forgetSignin();
      // The launcher's own words (src/codetools/terminal.mjs): Hoprig's copy, never one on PATH.
      return { name: await ctx.deck.runLauncher('codex-signin', os.homedir(), ['codex', 'login', '--device-auth']) };
    }],
    ['POST', /^\/api\/codetools\/([a-z]+)$/, async (req, m) => {
      const b = await ctx.readJson(req);
      const t = find(m[1]);
      if (!t) throw fail(404, anyTool(m[1]) ? notOffered(m[1]) : 'there is no such coding tool');
      if (!b || typeof b.on !== 'boolean' || Object.keys(b).some((k) => k !== 'on')) throw fail(400, 'send { on: true } or { on: false }');
      let next;
      try {
        next = withTool(ctx.config(), t.id, b.on);
      } catch (e) {
        throw fail(400, e.message);
      }
      ctx.saveConfig({ codingTools: next });
      return view();
    }],
  ];
  return { name: 'codetools', routes, close: () => unsubscribe?.() };
}
