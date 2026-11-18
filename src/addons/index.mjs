// Add-ons: optional companions that hoprig can install, start and stop for you and turn into a profile.
//
// Most are gateways: a program that speaks Claude Code's API on one side and any AI provider on the other. With one,
// "add a provider" is something you do in the gateway, and Claude Code (and Auto mode) just gets one more account to
// use. Gateways are data (gateways.mjs: the shipped ones and the owner's own), made into add-ons by localgateway.mjs.
//
// An add-on is a plain object:
//   id, title, summary, homepage
//   status()            → { installed, version, running, url }   (never throws)
//   install({ onLine }) → { ok }      update({ onLine }) → { ok }
//   start()             → { ok, url, already }     stop() → { ok }
//   profile             → what `addons setup` writes: { name, label, env, prerun, tokenVar, tokenHint }
//   gateway (optional)  { port() }: an AI gateway with Claude's API on 127.0.0.1:<port> (src/gateway); a gateway also
//                       has words (the page's sentences), page() (its own page), command() (what it runs), defined
//                       (the owner's own) and, for a program that is not a package, installable: false
import { gatewayAddons } from './gateways.mjs';
import { publicLink } from './linkaddon.mjs';

/** Every add-on, as the configuration says now: the gateways (shipped, then the owner's), then the public link. */
export const allAddons = () => [...gatewayAddons(), publicLink];

export const findAddon = (id) => allAddons().find((a) => a.id === id) || null;

/** Every add-on with its state, for the command line and the dashboard. */
export async function listAddons() {
  return Promise.all(allAddons().map(async (a) => ({ id: a.id, title: a.title, summary: a.summary, homepage: a.homepage, ...(a.installable === false ? { installable: false } : {}), ...(await a.status()) })));
}
