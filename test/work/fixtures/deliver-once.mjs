// One webhook delivery in a process of its own (test/work/hooks.test.mjs): proxy variables only count when they are
// set as a process starts. argv: <url>. Prints the result as JSON.
import { deliverOnce } from '../../../src/work/hooks.mjs';

const r = await deliverOnce({ url: process.argv[2], ownNetwork: true, secret: 'c'.repeat(64) }, '{}', { timeoutMs: 3000 });
process.stdout.write(JSON.stringify(r));
