// THE switch: the coding tools this version offers. Everything that lists, validates, turns on, installs or starts a
// coding tool, and every view of a provider that leaves the process (profiles.mjs publicProfile), goes through this
// list, so a tool missing here is offered nowhere: not in the pages, the command line, Setup, Updates, the provider
// kinds or the AI brain's links.
//
// Codex is left out on purpose: its descriptor, its server, the terminal attach, its own sign-in and the key filter
// are built and tested (codex.mjs, attach.mjs, terminal.mjs, codexsignin.mjs, providers.mjs), but it has no chat
// engine yet, and this version offers only the coding tools that work in a chat as well as in a terminal. To offer
// it: add 'codex' here and add its chat engine next to OpenCode's (src/chat/).
//
// This file imports nothing, so the launcher's start (menu.mjs, profiles.mjs) reads it without loading the tools'
// descriptors (index.mjs). Tests that run the kept code of a tool that is not offered swap this file for one with
// every tool (test/fixtures/every-tool.mjs).
export const OFFERED = Object.freeze(['claude', 'opencode']);

/** Is coding tool `id` offered by this version? */
export const isOffered = (id) => OFFERED.includes(id);
/** The ids of `ids` that this version offers, in their order (e.g. the tools a provider serves, for a page). */
export const offeredOnly = (ids) => (Array.isArray(ids) ? ids.filter(isOffered) : []);
