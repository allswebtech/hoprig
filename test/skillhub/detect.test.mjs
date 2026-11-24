// Project signals per stack, from manifest files only, and the catalog suggestions they lead to (with reasons).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox, writeTree } from './helpers.mjs';

const box = sandbox('skills-detect');
test.after(() => box.cleanup());
const { cargoDeps, detectProject, goDeps, pubDeps, pyprojectDeps, requirementsDeps } = await import('../../src/skillhub/detect.mjs');
const { suggestFor } = await import('../../src/skillhub/catalog.mjs');

const project = (name, files) => writeTree(path.join(box.root, 'projects', name), files);
const ids = (p) => suggestFor(detectProject(p)).map((s) => s.entry.id);

test('a Next.js app: web, UI and server; Next and React skills with "because package.json has next"', () => {
  const p = project('next', { 'package.json': JSON.stringify({ dependencies: { next: '16.0.1', react: '19.0.0', 'react-dom': '19.0.0' }, devDependencies: { '@playwright/test': '1.50.0' } }) });
  const d = detectProject(p);
  for (const s of ['web', 'web-ui', 'server', 'node', 'code']) assert.ok(d.stacks[s], s);
  assert.equal(d.stacks.mobile, undefined);
  const sug = suggestFor(d);
  assert.equal(sug[0].entry.id, 'hoprig', 'the bundled skill comes first');
  const next = sug.find((s) => s.entry.id === 'next-bundle-optimizer');
  assert.deepEqual(next.why, ['package.json has next 16.0.1']);
  for (const id of ['react-best-practices', 'next-dev-loop', 'security-audit', 'webapp-testing', 'frontend-design']) assert.ok(ids(p).includes(id), id);
  for (const id of ['flutter-architecture', 'react-native-skills', 'reverse-engineer-anything', 'docker-build-strategies']) assert.ok(!ids(p).includes(id), id);
});

test('a Flutter app: pubspec with sdk: flutter → Flutter skills, mobile, and the reverse-engineering skill', () => {
  const p = project('flutter', {
    'pubspec.yaml': 'name: app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  http: ^1.2.0  # client\n  supabase_flutter: ^2.0.0\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\nflutter:\n  uses-material-design: true\n',
    'android/app/build.gradle': '',
    'ios/Podfile': '',
  });
  const d = detectProject(p);
  assert.equal(d.deps.pub.flutter.version, 'sdk: flutter');
  assert.equal(d.deps.pub.http.version, '^1.2.0');
  assert.ok(d.stacks.flutter && d.stacks.mobile && d.stacks.postgres && d.stacks.dart);
  const sug = suggestFor(d);
  assert.deepEqual(sug.find((s) => s.entry.id === 'flutter-architecture').why, ['pubspec.yaml has flutter sdk: flutter']);
  for (const id of ['flutter-widget-test', 'reverse-engineer-anything', 'postgres-best-practices', 'security-audit']) assert.ok(ids(p).includes(id), id);
  assert.ok(!ids(p).includes('react-best-practices'));
});

test('artefacts (APK, IPA, ASAR), Electron, Docker, CI, MCP and Postgres are seen; build folders are skipped', () => {
  const p = project('mixed', {
    'package.json': JSON.stringify({ dependencies: { electron: '33.0.0', '@modelcontextprotocol/sdk': '1.0.0', pg: '8.0.0' } }),
    'release/app-release.apk': 'x',
    'release/App.ipa': 'x',
    'dist/app.asar': 'x', // dist is skipped
    'Dockerfile': 'FROM node:22\n',
    'docker/compose.yaml': 'services: {}\n',
    '.github/workflows/ci.yml': 'on: push\n',
    'node_modules/next/package.json': JSON.stringify({ dependencies: { next: '1' } }),
  });
  const d = detectProject(p);
  assert.deepEqual(Object.keys(d.artifacts).sort(), ['apk', 'ipa']);
  assert.ok(d.stacks.electron && d.stacks.mcp && d.stacks.postgres && d.stacks.docker && d.stacks.ci && d.stacks.mobile);
  assert.equal(d.deps.npm.next, undefined, 'node_modules is not read');
  const sug = suggestFor(d);
  const rea = sug.find((s) => s.entry.id === 'reverse-engineer-anything');
  assert.ok(rea.why.includes('release/app-release.apk found'));
  assert.ok(rea.why.includes('package.json has electron 33.0.0'));
  for (const id of ['docker-build-strategies', 'mcp-builder', 'postgres-best-practices']) assert.ok(ids(p).includes(id), id);
});

test('a project folder with several repositories under code/ is read repository by repository', () => {
  const root = path.join(box.root, 'projects', 'multi');
  writeTree(root, {
    'code/web/package.json': JSON.stringify({ dependencies: { next: '15.2.0' } }),
    'code/app/pubspec.yaml': 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n',
    'code/api/go.mod': 'module example.com/api\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgithub.com/jackc/pgx/v5 v5.7.0 // indirect\n)\n',
  });
  for (const r of ['web', 'app', 'api']) fs.mkdirSync(path.join(root, 'code', r, '.git'));
  const d = detectProject(root);
  assert.match(d.stacks['multi-repo'], /code\/ holds 3 repositories/);
  assert.equal(d.deps.npm.next.where, 'code/web/package.json');
  assert.ok(d.stacks.flutter && d.stacks.go && d.stacks.postgres && d.stacks.server);
  const sug = suggestFor(d);
  assert.deepEqual(sug.find((s) => s.entry.id === 'react-best-practices').why, ['code/web/package.json has next 15.2.0']);
  assert.ok(ids(root).includes('flutter-architecture'));
});

test('Python, Go and Rust manifests are parsed', () => {
  assert.deepEqual(Object.keys(requirementsDeps('Django>=5\n# x\nfastapi[all]==0.110\n-r other.txt\npsycopg2_binary\n')), ['django', 'fastapi', 'psycopg2-binary']);
  assert.deepEqual(Object.keys(pyprojectDeps('[project]\ndependencies = [\n  "flask>=3",\n  "mcp",\n]\n[tool.poetry.dependencies]\npython = "^3.12"\nasyncpg = "^0.29"\n')).sort(), ['asyncpg', 'flask', 'mcp']);
  assert.deepEqual(goDeps('module m\nrequire github.com/lib/pq v1.10.9\n'), { 'github.com/lib/pq': 'v1.10.9' });
  assert.deepEqual(cargoDeps('[package]\nname="x"\n[dependencies]\naxum = "0.7"\ntokio = { version = "1", features = ["full"] }\n[dev-dependencies.sqlx]\nversion = "0.8"\n'), { axum: '0.7', tokio: '1', sqlx: '' });
  assert.deepEqual(pubDeps('dependencies:\n  provider: ^6.0.0\n'), { provider: '^6.0.0' });
  const p = project('py', { 'pyproject.toml': '[project]\ndependencies = ["fastapi", "mcp"]\n', 'requirements-dev.txt': 'pytest\n' });
  const d = detectProject(p);
  assert.ok(d.stacks.python && d.stacks.server && d.stacks.mcp);
  assert.ok(ids(p).includes('mcp-builder'));
});

test('an empty folder gets only the bundled skills', () => {
  const p = project('empty', { 'README.md': 'hi' });
  assert.deepEqual(ids(p), ['hoprig', 'adopt-projects', 'plan-work']);
});

test('a project with a brief (docs/brief.md) is offered the new-project skill too; one without is not', () => {
  const p = project('briefed', { 'docs/brief.md': 'A shop.\n' });
  assert.deepEqual(ids(p), ['hoprig', 'adopt-projects', 'new-project', 'plan-work']); // plan-work and adopt-projects are offered to every project
  assert.equal(detectProject(p).files.brief[0], 'docs/brief.md');
  assert.ok(!ids(project('nobrief', { 'docs/README.md': 'x' })).includes('new-project'));
});
