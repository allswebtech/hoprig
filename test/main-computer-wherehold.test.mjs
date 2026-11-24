// "New work elsewhere" refuses a name that is not a computer with words a person reads: "main computer", never "hub".
// The name is refused before anything is written, so no state folder is touched.
import assert from 'node:assert/strict';
import test from 'node:test';

const { setElsewhere } = await import('../src/operator/where-hold.mjs');

test('a computer name that is not one is refused as "not a computer of the main computer"', () => {
  for (const bad of ['', 'no such/name', 42]) {
    assert.throws(() => setElsewhere(bad, 'x'), (e) => {
      assert.equal(e.message, 'not a computer of the main computer');
      return true;
    });
  }
});
