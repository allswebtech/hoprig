// What `npm publish` would send, for both packages (npm pack --dry-run): only files that are in git (nothing a build
// or a test made), no test, no private file, and the generated skill in both.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean));

function packed(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: path.join(ROOT, dir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const [info] = JSON.parse(out);
  return { info, files: info.files.map((f) => f.path).sort() };
}

const NEVER = /(^|\/)(test|tests|__tests__|fixtures|node_modules|dist|_site|coverage|\.github|\.git)\/|\.test\.mjs$|(^|\/)\.env|\.(pem|key|p12|tgz|log)$|(^|\/)(credentials|secrets?)(\.(json|txt|ya?ml)|\/)/i;

// Tia's eval ships with the package: "Improve Tia" runs it from an installed Hoprig, which has no git checkout.
// Exactly these files under test/ (the runner, its cases, its fake dashboard), never a test file.
const EVAL = [
  'test/assistant/eval/baseline.json', 'test/assistant/eval/candidate.mjs', 'test/assistant/eval/cases.mjs', 'test/assistant/eval/gate.mjs', 'test/assistant/eval/lines.mjs',
  'test/assistant/eval/mcp-candidate.mjs', 'test/assistant/eval/run.mjs', 'test/assistant/fake-dashboard.mjs', 'test/assistant/fake-work.mjs',
];

test('the hoprig package: tracked files only, no tests, no site, no second package, the skill and the eval inside', () => {
  const { info, files } = packed('.');
  assert.equal(info.name, 'hoprig');
  for (const f of files) {
    assert.ok(tracked.has(f), `${f} is not in git (made by a build or a test?)`);
    if (EVAL.includes(f)) continue;
    assert.doesNotMatch(f, NEVER, f);
    assert.doesNotMatch(f, /^(site|packages|tools|test)\//, f);
  }
  for (const want of ['bin/hoprig.mjs', 'templates/skills/hoprig/SKILL.md', 'templates/skills/hoprig/references/commands.md', 'LICENSE', 'NOTICE', ...EVAL]) assert.ok(files.includes(want), want);
});

test('the hoprig-skill package: exactly its program, the generated skill, README and LICENSE', () => {
  const { info, files } = packed('packages/hoprig-skill');
  assert.equal(info.name, 'hoprig-skill');
  assert.deepEqual(files, ['LICENSE', 'README.md', 'bin/hoprig-skill.mjs', 'package.json', 'skill/SKILL.md', 'skill/references/commands.md']);
  for (const f of files) assert.ok(tracked.has(`packages/hoprig-skill/${f}`), `${f} is not in git`);
});
