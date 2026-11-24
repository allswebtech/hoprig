// A Hoprig that runs a check and is then killed (test/ship/checkcut.test.mjs): argv = the project's real path and the
// folder to check. The environment (HOPRIG_* folders, PATH with the traps) is the test's.
const [real, dir] = process.argv.slice(2);
const { runCheck } = await import('../../../src/ship/check.mjs');
await runCheck(real, dir, { busy: () => ({ over: false, why: null }) });
