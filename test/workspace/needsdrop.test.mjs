// `hoprig drop shop` when another project on this computer (blog) names shop in its "needs" (workspace/drop.mjs, the
// drop's own flow): it says which, and asks that first, before any fetch or other question; a no removes nothing;
// without a terminal it is refused with the list; --check and --json name `neededBy`. A project that is only in the map
// does not count. Local bare repositories only (dropfix.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropOn, dropWorld, getOn, owner } from './dropfix.mjs';

test('drop of an entry another project here needs: it says which and asks first; a no keeps it; no terminal refuses', async () => {
  const w = await dropWorld('needed');
  try {
    const A = w.computers[0];
    // blog names shop as a need, in its own project.json on the git server.
    const seed = w.clone(w.u.blog, path.join(w.root, 'seed-blog'));
    w.commit(seed, 'project.json', JSON.stringify({ name: 'blog', repos: [], memories: {}, needs: ['shop'] }, null, 2) + '\n');
    w.sh(seed, 'push', '-q');
    assert.equal((await getOn(A, ['shop'])).code, 0);
    assert.equal((await getOn(A, ['blog'])).code, 0);

    // No terminal: refused with the list, nothing removed.
    let r = await dropOn(A, ['shop']);
    assert.notEqual(r.code, 0);
    assert.match(r.text, /blog needs it \(named in "needs"\): drop it all the same\?/);
    assert.ok(fs.existsSync(A.shop));

    // --check and --json name who needs it, and change nothing.
    r = await dropOn(A, ['shop', '--check', '--json']);
    assert.deepEqual(r.json.projects[0].neededBy, ['blog']);
    assert.ok(r.json.projects[0].asks.some((a) => a.ask === 'needed'));
    // Nothing of shop exists only here: --check says so, and exits 0; the need is its own line.
    assert.equal(r.json.projects[0].result, 'nothing only here');
    assert.equal(r.code, 0);
    r = await dropOn(A, ['shop', '--check']);
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /blog needs it \(named in "needs"\): a drop asks about that first/);
    assert.match(r.text, /nothing of it exists only here: it can be dropped/);
    assert.doesNotMatch(r.text, /exists only here \(above\)|all the same/);
    assert.ok(fs.existsSync(A.shop));

    // A terminal: the first question is this one; a no stops before anything is done.
    r = await dropOn(A, ['shop'], { answers: ['n'] });
    assert.match(r.asked[0], /Drop shop all the same\?/);
    assert.equal(r.asked.length, 1, 'nothing else asked after a no');
    assert.match(r.text, /blog needs shop/);
    assert.match(r.text, /stopped at the question about the projects that need it/);
    assert.ok(fs.existsSync(A.shop), 'a no removes nothing');

    // A yes goes on to the drop's own questions and the drop.
    const say = owner();
    r = await dropOn(A, ['shop'], { answers: (q) => (/all the same/.test(q) ? 'y' : say(q)) });
    assert.equal(r.code, 0, r.text);
    assert.ok(!fs.existsSync(A.shop), 'dropped after the yes');

    // blog itself is needed by nobody: no such question.
    r = await dropOn(A, ['blog', '--check', '--json']);
    assert.equal(r.json.projects[0].neededBy, undefined);
  } finally {
    w.cleanup();
  }
});
