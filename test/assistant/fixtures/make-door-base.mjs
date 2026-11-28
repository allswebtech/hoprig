// Makes test/assistant/fixtures/door-base.json: what Tia's door let through, route by route, taken ONCE from the door
// as it was before it was derived from the acts file (src/assistant/acts.json). Run it on a checkout of that commit:
//
//   node test/assistant/fixtures/make-door-base.mjs
//
// It builds the server in a sandbox of its own (test/server/helpers.mjs) and writes nothing else. The file is not made
// again when the door is changed on purpose: the person who opens a route says so in the test's list of what is new.
// Since the catalog (src/assistant/catalog.mjs) it also asks each catalog route that changes something with the do_act card the owner
// could confirm for it: those passes are the routes that open ONLY as the act of such a card (their card is named a-<act id>).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../../server/helpers.mjs';
import { catalogCards, probe } from './door-probe.mjs';

const box = sandbox('doorbase');
const A = await import('../../../src/assistant/acts.mjs');
const D = await import('../../../src/assistant/door.mjs');
const { createServer } = await import('../../../src/server/server.mjs');
const samples = (r) => {
  try {
    return A.samplesOf(r.re);
  } catch {
    return [r.key.replace(/^[A-Z]+ /, '')];
  }
};
const app = createServer({ watch: false });
try {
  const routes = [...A.changingRoutes(app), ...A.readRoutes(app)].map((r) => ({ method: r.method, paths: samples(r) }));
  const out = probe({ checkRoute: D.checkRoute, neverClassOf: D.neverClassOf, ALLOW: D.ALLOW }, routes, await catalogCards());
  const file = fileURLToPath(new URL('./door-base.json', import.meta.url));
  const lines = (list) => list.map((x) => `  ${JSON.stringify(x)}`).join(',\n');
  fs.writeFileSync(file, `{\n "passes": [\n${lines(out.passes)}\n ],\n "classes": [\n${lines(out.classes)}\n ]\n}\n`);
  console.log(`${out.passes.length} passes, ${out.classes.length} classes written`);
} finally {
  await app.close();
  box.cleanup();
}
