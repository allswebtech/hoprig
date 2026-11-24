// The top help names `-- "first message"` for OpenCode "as above": the lines above it say what it does (the session
// starts and that text is sent as its first message), in the program's help and in the skill's copy of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, SKILL_DIRS } from '../../tools/build-skill.mjs';

const said = /-- "[^"]+"\s+start, and send this as the\s+session's first message/;

test('the help says what the first message after -- does, before OpenCode\'s line points to it', () => {
  const bin = fs.readFileSync(path.join(ROOT, 'bin/hoprig.mjs'), 'utf8');
  const help = bin.slice(bin.indexOf('const HELP = `'));
  assert.match(help, said);
  assert.ok(help.search(said) < help.indexOf('hoprig opencode [provider] [args]'), 'it stands above "as above"');
  for (const dir of SKILL_DIRS) {
    const ref = fs.readFileSync(path.join(ROOT, dir, 'references/commands.md'), 'utf8');
    assert.match(ref, said, `${dir}: the skill's copy of the help`);
  }
});
