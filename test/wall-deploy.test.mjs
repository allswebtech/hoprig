// A deploy, release or publish script the project names is held — whether or not anything was
// accepted, because a project's own file is someone else's words — and the session's own edit of project.json is
// held. An ordinary script, and a read of project.json, go through.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { wallKind, wallHeld } = await import('../src/wall.mjs');

const places = { hoprig: ['/x/.config/hoprig', '/x/.local/state/hoprig'], home: '/x', own: '/x/shop' };
const bash = (command) => wallHeld({ tool: 'Bash', input: { command }, cwd: '/x/shop', places });
const file = (tool, fp) => wallHeld({ tool, input: { file_path: fp }, cwd: '/x/shop', places });

test('a deploy/release/publish script the project names is held', () => {
  // All are held; the exact kind is 'deploy', except a publish-named one that also matches the publish release-kind.
  for (const c of [
    'npm run deploy', 'pnpm run release', 'yarn run publish', 'npm run deploy:prod',
    'pnpm deploy', 'yarn release', 'make deploy', 'make release-staging',
    './deploy.sh', 'bash scripts/release.sh', 'sh deploy.bash', './publish.py', 'scripts/deploy --now',
  ]) assert.ok(bash(c), c);
  assert.equal(bash('npm run deploy').kind, 'deploy');
  assert.equal(bash('make deploy').kind, 'deploy');
  assert.equal(bash('./deploy.sh').kind, 'deploy');
});

test('an ordinary script or build goes through', () => {
  for (const c of ['npm run build', 'npm test', 'pnpm install', 'yarn lint', 'make', 'make build', './run.sh', 'release-notes --check', 'git status']) {
    assert.equal(bash(c), null, c);
  }
});

test('the session editing project.json is held, by a file tool or a shell write; a read goes through', () => {
  assert.equal(file('Write', '/x/shop/project.json')?.kind, 'project');
  assert.equal(file('Edit', '/x/shop/sub/project.json')?.kind, 'project');
  assert.equal(bash('sed -i s/a/b/ project.json')?.kind, 'project');
  assert.equal(bash('mv new.json project.json')?.kind, 'project');
  assert.equal(bash('echo {} > project.json')?.kind, 'project');
  // Reads and other files go through.
  assert.equal(bash('cat project.json'), null);
  assert.equal(bash('grep name project.json'), null);
  assert.equal(file('Write', '/x/shop/package.json'), null);
});
