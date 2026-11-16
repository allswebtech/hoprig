// The one line another computer pastes to link itself to the main one: made and read back, the older command form,
// and what is not such a line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { joinLine, parseJoinLine } from '../../src/machines/joinline.mjs';

test('the line: address#join=CODE, with the fingerprint only for a hub with its own certificate', () => {
  assert.equal(joinLine('https://pc.example.com/', 'K7QM-4XP2'), 'https://pc.example.com#join=K7QM-4XP2');
  assert.equal(joinLine('https://10.0.0.5:7433', 'K7QM-4XP2', 'sha256:AbC'), 'https://10.0.0.5:7433#join=K7QM-4XP2&fingerprint=sha256:AbC');
  assert.deepEqual(parseJoinLine(' https://pc.example.com#join=K7QM-4XP2 \n'), { url: 'https://pc.example.com', code: 'K7QM-4XP2', fingerprint: null });
  assert.deepEqual(parseJoinLine(joinLine('https://10.0.0.5:7433', 'K7QM-4XP2', 'sha256:AbC')), { url: 'https://10.0.0.5:7433', code: 'K7QM-4XP2', fingerprint: 'sha256:AbC' });
  // A hub behind a proxy under a path keeps the path.
  assert.equal(parseJoinLine('https://hub.example.net/deck#join=AB12-CD34').url, 'https://hub.example.net/deck');
});

test('the older whole command is read too; anything else is not a line', () => {
  assert.deepEqual(parseJoinLine('hoprig join https://pc.example.com K7QM-4XP2'), { url: 'https://pc.example.com', code: 'K7QM-4XP2', fingerprint: null });
  assert.deepEqual(parseJoinLine('hoprig join https://10.0.0.5:7433 K7QM-4XP2 --fingerprint sha256:AbC'), { url: 'https://10.0.0.5:7433', code: 'K7QM-4XP2', fingerprint: 'sha256:AbC' });
  for (const bad of ['', null, 'K7QM-4XP2', 'https://pc.example.com', 'https://pc.example.com#other=1', 'ftp://x#join=A', 'javascript:alert(1)#join=A',
    'hoprig leave https://pc.example.com K7QM', 'hoprig join user@host', `https://a.example#join=${'A'.repeat(3000)}`]) {
    assert.equal(parseJoinLine(bad), null, String(bad).slice(0, 40));
  }
});
