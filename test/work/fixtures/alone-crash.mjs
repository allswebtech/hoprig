// A dashboard that starts a run that ends by itself (DO:sleep) and then dies at once (SIGKILL, no close): what a crash
// leaves. argv: the item's id. Prints the run's id. The temporary computer comes from the environment (helpers.mjs).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-alone.mjs');
const { loadConfig } = await import('../../../src/config.mjs');
const { aloneRunner } = await import('../../../src/work/alone.mjs');
const cfg = loadConfig();
const r = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), defaultProvider: async () => 'sub' });
const s = await r.startAlone({ item: process.argv[2], minutes: 30 });
process.stdout.write(`${s.run.id}\n`);
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);
