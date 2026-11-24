// Run by fork or spawn from test/fixtures/runner/reaches.mjs: a Node child (or a Node child of a Node child) that
// runs the program SEAL_CALL names. With SEAL_FRESH=1 it builds a fresh environment ({ PATH: '/usr/bin' }) for its
// own child, so that a child that throws away the test's environment is still sealed — the wrap (tools/test-seal.mjs),
// loaded through NODE_OPTIONS, carries the traps back in. It does nothing for the seal itself.
import { spawnSync } from 'node:child_process';

const argv = JSON.parse(process.env.SEAL_CALL);
const env = process.env.SEAL_FRESH ? { PATH: '/usr/bin', HOME: process.env.HOME } : process.env; // seal: the wrap seals it; this fixture proves it
const r = spawnSync(argv[0], argv.slice(1), { env, encoding: 'utf8' });
process.stdout.write(`child exit ${r.status} ${r.error ? r.error.code : ''}\n`);
