// The models a picker offers, for the page (catalog.mjs gives them):
//   GET  /api/models?provider=<name>&tool=<id>&saved=<model>   → the provider's list: { provider, source, models:
//                                                  [{ id, label, efforts?, window1m?, images? }], why, typed, read?,
//                                                  notListed: [saved] when the check would refuse it }. Asked when a
//                                                  picker opens; the endpoint itself at most once in ten minutes.
//   POST /api/models/check { provider, tool, model }  → { ok, why }: an exact name typed into the fallback's field.
//   GET  /api/models/lead?provider=<name>&tool=<id>   → { can, line }: the one line under "Lead model" (which models
//                                                  it uses on this provider, or why it cannot lead). Shares the
//                                                  picker's ask of the endpoint: at most once in ten minutes.
//   GET  /api/models/others?provider=<name>          → { providers: [{ name, label, tools, paid, limited }] }: the
//                                                  other providers "Use other providers" can tick. Names only.
// Names only: the server asks the endpoint with the profile's own values, and nothing of a key or an address leaves.
import { readProfile, servesTools, NAME_RE } from '../profiles.mjs';
import { knownModels, modelsOf } from '../chat/engines/served.mjs';
import { MODEL_RE, modelProblem, modelsFor, notListedOf } from './catalog.mjs';
import { leadPlan } from './lead.mjs';
import { otherProviders } from './others.mjs';

const TOOL_RE = /^[a-z]{1,20}$/;

/** o: { fetchImpl, now, autoOn() } (tests). */
export function modelsFeature(ctx, o = {}) {
  const bad = (m) => new ctx.HttpError(400, m);
  const autoOn = o.autoOn || (() => false);
  /** The provider a request names, checked: it exists and serves the coding tool. */
  function providerOf(name, tool) {
    if (typeof tool !== 'string' || !TOOL_RE.test(tool)) throw bad('choose a coding tool');
    if (name === 'auto') {
      if (tool !== 'claude' || !autoOn()) throw bad('Auto mode is for Claude Code, while it is on');
      return 'auto';
    }
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw bad('choose a provider');
    const p = readProfile(name);
    if (!p) throw bad(`there is no provider "${name}"`);
    if (!servesTools(p).includes(tool)) throw bad('that provider does not serve this coding tool');
    return p;
  }
  const opts = (tool) => ({ tool, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.now ? { now: o.now } : {}), toolModels: (p) => modelsOf(p, o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), toolKnown: knownModels });
  return {
    name: 'models',
    routes: [
      ['GET', /^\/api\/models$/, async (req, m, q) => {
        const tool = q.get('tool') || 'claude';
        const view = await modelsFor(providerOf(q.get('provider'), tool), opts(tool));
        // The picker's saved value, marked only where the check would refuse it (catalog.mjs notListedOf).
        const saved = q.get('saved');
        return { ...view, notListed: saved && MODEL_RE.test(saved) ? notListedOf(view, [saved], tool) : [] };
      }],
      ['GET', /^\/api\/models\/lead$/, async (req, m, q) => {
        const tool = q.get('tool') || 'claude';
        const p = providerOf(q.get('provider'), tool);
        // The list the picker beside it asks for (one shared ask, kept ten minutes): the line is never drawn from a list
        // not known yet.
        if (tool === 'claude') await modelsFor(p, opts(tool)).catch(() => null);
        const plan = leadPlan(p, { tool, ...(o.now ? { now: o.now } : {}) });
        return { can: plan.can, line: plan.can ? plan.line : plan.why };
      }],
      ['GET', /^\/api\/models\/others$/, async (req, m, q) => {
        const own = q.get('provider');
        if (own && own !== 'auto') providerOf(own, 'claude');
        return { providers: otherProviders(own || null).map(({ ticked, ...p }) => p) };
      }],
      ['POST', /^\/api\/models\/check$/, async (req) => {
        const b = await ctx.readJson(req);
        const tool = b.tool || 'claude';
        const p = providerOf(b.provider, tool);
        await modelsFor(p, opts(tool)); // the list as it is now (kept ten minutes): a typed name is checked against it
        const why = modelProblem(p, b.model, opts(tool));
        return { ok: !why, why };
      }],
    ],
  };
}
