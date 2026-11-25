// Tests of the kept code of a coding tool that this version does not offer (Codex: src/codetools/offered.mjs): call
// offerEveryTool() before the first import of src/, and the switch reads as if every built tool were offered. The
// product has no such setting; only a test swaps the file, through a module resolve hook of its own process.
import module from 'node:module';

export const EVERY_TOOL = Object.freeze(['claude', 'codex', 'opencode']);

const SWITCH = /\/src\/codetools\/offered\.mjs$/;
const STAND_IN = `data:text/javascript,${encodeURIComponent(`
export const OFFERED = Object.freeze(${JSON.stringify(EVERY_TOOL)});
export const isOffered = (id) => OFFERED.includes(id);
export const offeredOnly = (ids) => (Array.isArray(ids) ? ids.filter(isOffered) : []);
`)}`;

function resolve(specifier, context, next) {
  const r = next(specifier, context);
  return SWITCH.test(new URL(r.url).pathname) ? { url: STAND_IN, shortCircuit: true } : r;
}

/** Swap the switch for every later import of src/ in this process (in-thread hooks, which every supported Node has). */
export function offerEveryTool() {
  module.registerHooks({ resolve });
}
