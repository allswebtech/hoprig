// The seal's core as ES-module exports; its one copy is tools/seal-core.cjs (CommonJS, so that the wrap can be
// preloaded into a Node child by --require without changing how that child's main file is loaded).
import { createRequire } from 'node:module';

const core = createRequire(import.meta.url)('./seal-core.cjs');
export const { STAND_INS, realAsked, realByFullPath, ownTree, SEAL_VARS, TRAPPED, extraTraps, TRAP_EXIT, UNKNOWN_FILE, inTmp, sealedPath, sealed } = core;
