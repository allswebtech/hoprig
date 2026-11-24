// The code editor's files from node_modules: the files the page loads exist in the installed package (the AMD build
// is deprecated upstream, so a version that drops it must fail here, not in a browser), they are served under a URL
// with the version in it and cached for good, and nothing else of the package is reachable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { immutable, monaco, monacoManifest, mounts, resolveStatic } from '../../src/server/static.mjs';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

test('monaco-editor is pinned to an exact version and that version is installed', () => {
  const want = pkg.dependencies['monaco-editor'];
  assert.match(want, /^\d+\.\d+\.\d+$/, 'an exact version, no range');
  const m = monaco();
  assert.ok(m, 'installed');
  assert.equal(m.version, want);
  assert.equal(m.base, `/vendor/monaco/${want}/vs/`);
  const dir = path.resolve(path.dirname(require.resolve('monaco-editor')), '..', '..');
  for (const f of ['LICENSE', 'ThirdPartyNotices.txt']) assert.ok(fs.existsSync(path.join(dir, f)), `${f} ships`);
});

test('the files the page loads exist: the loader, the editor, its styles and the five workers', () => {
  const m = monaco();
  for (const f of ['loader.js', 'editor/editor.main.js', 'editor/editor.main.css']) {
    const file = resolveStatic(`${m.base}${f}`);
    assert.ok(file && fs.statSync(file).size > 0, f);
  }
  assert.deepEqual(Object.keys(m.workers).sort(), ['css', 'editor', 'html', 'json', 'ts']);
  for (const [label, url] of Object.entries(m.workers)) {
    assert.ok(url.startsWith(`${m.base}assets/${label}.worker-`), url);
    const file = resolveStatic(url);
    assert.ok(file && fs.statSync(file).size > 1000, `${label} worker is served`);
  }
  assert.deepEqual(monacoManifest(), { version: m.version, base: m.base, workers: m.workers }, 'no folder on disk in what the page gets');
});

test('only the min build is reachable; the translations, the AMD worker copies and the package files are not', () => {
  const m = monaco();
  assert.ok(mounts().some(([p]) => p === m.base));
  const nls = fs.readdirSync(path.join(m.dir, 'nls')).find((n) => n.endsWith('.js'));
  const lang = fs.readdirSync(path.join(m.dir, 'language'), { recursive: true }).find((n) => String(n).endsWith('.js'));
  for (const bad of [
    `${m.base}nls/${nls}`, `${m.base}language/${lang}`, `${m.base}../package.json`, `${m.base}../../package.json`,
    `${m.base}%2e%2e/%2e%2e/package.json`, `/vendor/monaco/0.0.1/vs/loader.js`, `${m.base.replace('/vs/', '/')}package.json`,
  ]) {
    assert.equal(resolveStatic(bad), null, bad);
  }
});

test('the editor files are cached for good; the page itself is checked every time', () => {
  const m = monaco();
  assert.equal(immutable(resolveStatic(`${m.base}loader.js`)), true);
  assert.equal(immutable(resolveStatic('/index.html')), false);
  assert.equal(immutable(resolveStatic('/vendor/xterm/lib/xterm.mjs')), false);
});

test('monaco-editor\'s copyright and permission notice goes with every copy Hoprig hands out', () => {
  const root = new URL('../../', import.meta.url);
  const dir = path.resolve(path.dirname(require.resolve('monaco-editor')), '..', '..');
  const licence = fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8').trim();
  assert.match(licence, /^The MIT License \(MIT\)\n\nCopyright \(c\) .* Microsoft Corporation\n\nPermission is hereby granted/);
  // Hoprig's own NOTICE (in the npm package and in the image) holds it word for word.
  const notice = fs.readFileSync(new URL('NOTICE', root), 'utf8');
  assert.ok(notice.includes(licence), 'NOTICE holds monaco-editor\'s licence as the package ships it');
  assert.ok(pkg.files.includes('NOTICE'), 'NOTICE is in the npm package');
  // The image installs it with npm, as a plain dependency (not dev, not optional), so its own LICENSE comes too.
  assert.ok(pkg.dependencies['monaco-editor'] && !(pkg.optionalDependencies || {})['monaco-editor'] && !(pkg.devDependencies || {})['monaco-editor']);
  const docker = fs.readFileSync(new URL('Dockerfile', root), 'utf8');
  assert.match(docker, /npm ci --omit=dev --omit=optional/);
  assert.match(docker, /^COPY .*\bNOTICE\b/m, 'the image copies NOTICE');
});

