// A dashboard that starts a go-live and is then killed (test/ship/live.test.mjs): argv = the project's real path and
// the put-together's id. The environment (HOPRIG_* folders, PATH with the traps) is the test's.
const [real, id] = process.argv.slice(2);
const { readTogether } = await import('../../../src/ship/together.mjs');
const { goLive } = await import('../../../src/ship/live.mjs');
const step = await goLive(real, readTogether(id));
await step.done;
