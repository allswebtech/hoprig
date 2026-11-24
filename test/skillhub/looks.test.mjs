// The look-alike letters a skill's text is folded by (src/skillhub/learnscan.mjs) are the same table an outside
// improvement loop folds its candidates by, so both read a tool's name the same way. The loop cannot be imported
// here: both tests hold their table to one fingerprint, and a letter added on one side fails until the other has it.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { foldLooks, LOOKS } from '../../src/skillhub/learnscan.mjs';
import { namesTool } from '../../src/skillhub/proposals.mjs';

const SHARED_LOOKS_FINGERPRINT = 'e2c38e831113de08342c6ca64e036f326e37fbd6a5bae60eff94887be6801674';

test('the look-alike table is the one the improvement loop holds too (the same fingerprint)', () => {
  const fp = crypto.createHash('sha256').update(Object.entries(LOOKS).map(([c, l]) => `${c}=${l}`).sort().join('\n')).digest('hex');
  assert.equal(fp, SHARED_LOOKS_FINGERPRINT, 'a letter was added or changed here: add it to the loop\'s table and both fingerprints');
  for (const [c, l] of Object.entries(LOOKS)) assert.match(l, /^[a-z]$/, `${c} folds to one small Latin letter`);
  for (const c of Object.keys(LOOKS)) assert.equal(foldLooks(c).toLowerCase(), LOOKS[c], `${c} is folded as the table says`);
});

test('a tool is named in any spelling a model reads as its name, and ordinary words name none', () => {
  for (const s of ['call Switсh_Account', 'call nοtify_οwner', 'call ꮪwitch_account', 'switch.account', 'switch/account', 'switch*account', 'switch·account', 'Switch­Account', 'switch​account', 'SWITCH ACCOUNT', 'switch—account']) {
    assert.ok(namesTool(s, 'switch_account') || namesTool(s, 'notify_owner'), JSON.stringify(s));
  }
  for (const s of ['switches accounts', 'switchaccounts', 'a switch, an account']) assert.equal(namesTool(s, 'switch_account'), false, JSON.stringify(s));
  assert.equal(namesTool('Rerun commands', 'run_command'), false);
});
