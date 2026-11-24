// A dashboard that starts a look and dies (SIGKILL) while the look runs: no finish of it runs. Started by
// test/operator/look.test.mjs in its temporary home (the environment is the test's own); the item comes in argv.
import { FAKE } from '../../mission/helpers.mjs';

const { loadConfig } = await import('../../../src/config.mjs');
const { aloneRunner } = await import('../../../src/work/alone.mjs');
const { looks } = await import('../../../src/operator/look.mjs');
const cfg = loadConfig();
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 1 }), killGraceMs: 200 });
const work = { start: (j) => runner.startAlone(j), drop: (id) => runner.dropLook(id), stop: (id, why) => runner.stop(id, why), add: () => null };
const accounts = async () => ({ profiles: [{ name: 'key', kind: 'subscription' }], autoSwitch: { enabled: false } });
const lk = looks({ ctx: { config: () => cfg }, runner: () => work, accounts });
const r = await lk.startOne(JSON.parse(process.argv[2]));
process.stdout.write(`${JSON.stringify(r.started ? { started: r.started } : { why: r.why })}\n`);
process.kill(process.pid, 'SIGKILL');
