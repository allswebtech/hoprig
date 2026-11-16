// Add-ons: optional companions that hoprig can install, start and stop for you and turn into a profile.
//
// The first one is a gateway: a program that speaks Claude Code's API on one side and any AI provider on the
// other. With it, "add a provider" is something you do in the gateway, and Claude Code (and Auto mode) just gets
// one more account to use.
//
// An add-on is a plain object:
//   id, title, summary, homepage
//   status()            → { installed, version, running, url }   (never throws)
//   install({ onLine }) → { ok }      update({ onLine }) → { ok }
//   start()             → { ok, url, already }     stop() → { ok }
//   profile             → what `addons setup` writes: { name, label, env, prerun, tokenVar, tokenHint }
//   gateway (optional)  { port() }: an AI gateway with Claude's API on 127.0.0.1:<port> (src/gateway)
import { publicLink } from './linkaddon.mjs';
import { trouteai } from './trouteai.mjs';

export const ADDONS = [trouteai, publicLink];

export const findAddon = (id) => ADDONS.find((a) => a.id === id) || null;

/** Every add-on with its state, for the command line and the dashboard. */
export async function listAddons() {
  return Promise.all(ADDONS.map(async (a) => ({ id: a.id, title: a.title, summary: a.summary, homepage: a.homepage, ...(await a.status()) })));
}
