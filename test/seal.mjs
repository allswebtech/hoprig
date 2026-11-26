// Keeps the test runner's seal (tools/test.mjs, tools/test-traps.mjs) on a PATH or an environment a test makes for a
// child of its own. The runner puts its traps first on PATH and names their folder in HOPRIG_TEST_TRAPS; the variables
// in SEAL_VARS point the product's own ways to such a program (the npm of the Node it runs on) at the traps too. A
// child given a fresh environment without them could reach the real sudo, systemctl or npm. test/seal.test.mjs checks
// that every PATH a test writes goes through here or is marked as a value no program is started with.
//
// The runner also wraps node:child_process in every test file's process (tools/test-seal.mjs),
// so a child is sealed even when a test forgets this helper. The two share one copy of the logic (tools/seal-core.mjs);
// this file keeps its exports so the tests that call sealed()/sealedPath() by hand do not change.
export { SEAL_VARS, sealed, sealedPath } from '../tools/seal-core.mjs';

import { shippedGateways } from '../tools/seal-net.mjs';
import { windowsSh } from '../tools/test-seal.mjs';

/**
 * The skip of a test whose stand-ins are `#!/bin/sh` scripts. On Windows the wrap starts such a stand-in of the test's
 * own through Git for Windows' sh (tools/test-seal.cjs windowsStandIn), found on the PATH of this test process outside
 * the test's area and the traps; only where no sh is found is the test skipped. False on every other system.
 */
const processPath = () => String(Object.entries(process.env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] || '');
export const SHELL_STANDINS = { skip: process.platform === 'win32' && !windowsSh(processPath()) && 'the stand-ins are shell scripts and no sh is here' };
/** A port no test's gateway answers on (port 1: nothing an ordinary user runs listens there, so it is refused at once). */
export const CLOSED_PORT = 1;
/**
 * The settings' `addons` that put every shipped gateway on CLOSED_PORT, never its default port, where the computer's
 * own gateway may listen: a dashboard or the Operator's look asks the gateway's port on every tick, and the runner
 * refuses the default (tools/seal-net.mjs).
 */
export const closedGateways = () => Object.fromEntries(shippedGateways().map((g) => [g.id, { port: CLOSED_PORT }]));
