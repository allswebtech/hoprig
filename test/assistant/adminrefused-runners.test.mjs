// Tia's floor (src/assistant/adminrefused.mjs) reads the wall's ONE list of programs that run their words
// (runsItsWords) and the wall's stepping of what stands in front of a command (pastWrappers). The package runners and
// environment loaders the wall now reads behind change what her floor refuses, and only where an administrator
// command stands behind or in front of one: an ordinary line behind a runner (`npx vitest run`, `uv run pytest`,
// `python3 -m pytest`) is refused by nothing here, and her own tool (run_command) still sees no administrator command
// in it. Nothing is run: the floor and the wall only answer.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { adminRefusal, sudoArgv } = await import('../../src/assistant/adminrefused.mjs');
const { wallKind } = await import('../../src/wall.mjs');

const ctx = { hoprigDirs: ['/w/.config/hoprig', '/w/.local/state/hoprig'], home: '/w', cwd: '/w/shop' };

const ORDINARY = [
  'npx vitest run', 'npx tsc --noEmit', 'npx prettier --check .', 'npx playwright test', 'npx -y create-vite@latest app',
  'bunx vitest', 'pnpx eslint .', 'uvx ruff check .', 'cross-env NODE_ENV=test jest', 'cross-env-shell A=1 npm test',
  'dotenv -e .env -- jest', 'env-cmd -f .env npm test', 'pnpm dlx create-vite app', 'yarn dlx eslint .', 'npm exec -- eslint .',
  'pnpm exec vitest run', 'uv run pytest', 'uv run -m pytest', 'pipx run black --check .', 'poetry run pytest', 'bundle exec rspec',
  'mise exec -- node --test', 'direnv exec . npm test', 'corepack enable', 'python3 -m pytest -q', 'python3 -m venv .venv',
  'python3 -m pip install -r requirements.txt', 'python3 manage.py test', 'node scripts/build.mjs',
];

test('an ordinary line behind a runner is refused by nothing on her floor, and her own tool sees no administrator command', () => {
  for (const line of ORDINARY) {
    assert.equal(adminRefusal(line, ctx), null, `session: ${line}`);
    assert.equal(adminRefusal(line, { ...ctx, argv: true }), null, `her own tool: ${line}`);
    assert.equal(wallKind(line), null, `run_command routes it as an ordinary command: ${line}`);
  }
});

// What her floor refuses now that it did not before (each was null on the base): a runner as the program sudo runs,
// and an administrator command a runner hands on.
const NEW_REFUSALS = [
  ['sudo npx some-tool', 'passer-as-admin'],
  ['sudo bunx some-tool', 'passer-as-admin'],
  ['sudo pnpx some-tool', 'passer-as-admin'],
  ['sudo uvx some-tool', 'passer-as-admin'],
  ['sudo cross-env A=1 apt-get update', 'passer-as-admin'],
  ['sudo cross-env-shell A=1 apt-get update', 'passer-as-admin'],
  ['sudo dotenv -- apt-get update', 'passer-as-admin'],
  ['sudo env-cmd -f .env apt-get update', 'passer-as-admin'],
  ['sudo concurrently "apt-get update"', 'passer-as-admin'],
  ['sudo nodemon --exec apt-get', 'passer-as-admin'],
  ['sudo watchexec apt-get update', 'passer-as-admin'],
  ['npx sudo su', 'escalator-as-admin'],
  ['uv run sudo su', 'escalator-as-admin'],
  ['poetry run sudo -i', 'login-or-shell-flag'],
  ['cross-env A=1 sudo bash', 'shell-as-admin'],
  ['python3 -m sudo su', 'escalator-as-admin'],
];

test('what her floor refuses now that it did not: a runner as sudo\'s program, an administrator command behind a runner', () => {
  for (const [line, id] of NEW_REFUSALS) {
    const r = adminRefusal(line, ctx);
    assert.ok(r, `refused: ${line}`);
    assert.equal(r.id, id, line);
  }
});

test('her own tool: an administrator command behind a runner is an administrator command, and is not run as written', () => {
  for (const line of ['npx sudo apt-get install -y nginx', 'uv run sudo apt-get update', 'cross-env A=1 sudo apt-get update']) {
    assert.equal(wallKind(line), 'admin', line);
    const r = sudoArgv(line, ctx);
    assert.ok(r.refuse, line);
    assert.equal(r.refuse.id, 'wrapper-before-sudo', line);
  }
  // A plain administrator command with a runner as an ordinary program still gets its card, as before.
  assert.deepEqual(sudoArgv('sudo uv run pytest', ctx), { argv: ['sudo', 'uv', 'run', 'pytest'] });
  assert.deepEqual(sudoArgv('sudo python3 -m pip install -r requirements.txt', ctx), { argv: ['sudo', 'python3', '-m', 'pip', 'install', '-r', 'requirements.txt'] });
});
