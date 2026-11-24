// A dashboard that takes the last go-live back and is ended by its own back (test/ship/backcut.test.mjs), as Hoprig's
// back restarts the dashboard: argv = the project's real path. DASH in the environment is this process's pid.
const [real] = process.argv.slice(2);
process.env.DASH = String(process.pid);
const { takeBack } = await import('../../../src/ship/live.mjs');
await takeBack(real);
