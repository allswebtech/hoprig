// The owner's check of the git sign-in (src/assistant/hersignin.mjs checkHerSignin / checkWords, and the route in
// src/server/hersignin.mjs): with the token it asks the git server what the token may do and says it in plain words —
// whether it can delete a repository, and per repository of the map whether a forced push or a delete of the default
// branch is blocked. "Not known" is said as not known. No real git server is asked: the test opens its own stand-in.
// Nothing the check returns holds the token.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { branchRuleWords, checkHerSignin, checkWords, ghRepoOf, tokenCanDelete } from '../../src/assistant/hersignin.mjs';
import { herSigninFeature } from '../../src/server/hersignin.mjs';

// A stand-in git server. It reads the token from the Authorization header and answers as the real server's API would:
// the token's scopes on the root, each repository's default branch, and its protection rule.
function standInServer() {
  const server = http.createServer((req, res) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (token === 'bad-token') return json(401, { message: 'Bad credentials' });
    const url = req.url.split('?')[0];
    if (url === '/') {
      const scopes = token === 'can-delete' ? { 'x-oauth-scopes': 'repo, delete_repo, workflow' }
        : token === 'no-delete' ? { 'x-oauth-scopes': 'repo, workflow' }
          : {}; // a fine-grained token: no x-oauth-scopes header at all
      return json(200, { message: 'ok' }, scopes);
    }
    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url);
    if (m) {
      if (m[2] === 'gone') return json(404, { message: 'Not Found' });
      if (m[2] === 'forbidden') return json(403, { message: 'Resource not accessible by personal access token' });
      return json(200, { default_branch: 'main' });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/branches\/([^/]+)\/protection$/.exec(url);
    if (m) {
      if (m[2] === 'guarded') return json(200, { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } });
      if (m[2] === 'loose') return json(200, { allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } });
      if (m[2] === 'open') return json(404, { message: 'Branch not protected' });
      return json(403, { message: 'Must have admin rights' }); // cannot read the rule
    }
    return json(404, { message: 'Not Found' });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('ghRepoOf reads github.com owner/name, null for another server', () => {
  assert.deepEqual(ghRepoOf('https://github.com/alex/shop.git'), { owner: 'alex', name: 'shop' });
  assert.deepEqual(ghRepoOf('https://github.com/alex/shop'), { owner: 'alex', name: 'shop' });
  assert.deepEqual(ghRepoOf('git@github.com:alex/shop.git'), { owner: 'alex', name: 'shop' });
  assert.equal(ghRepoOf('https://gitlab.com/alex/shop.git'), null);
  assert.equal(ghRepoOf('https://example.com/alex/shop'), null);
});

test('tokenCanDelete and branchRuleWords read the git server\'s own answers', () => {
  assert.equal(tokenCanDelete('repo, delete_repo'), true);
  assert.equal(tokenCanDelete('repo, workflow'), false);
  assert.equal(tokenCanDelete(''), false);
  assert.equal(tokenCanDelete(null), null); // a fine-grained token: not known
  assert.deepEqual(branchRuleWords(200, { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } }), { forcePush: 'blocked', branchDelete: 'blocked' });
  assert.deepEqual(branchRuleWords(200, { allow_force_pushes: { enabled: true }, allow_deletions: { enabled: true } }), { forcePush: 'not blocked', branchDelete: 'not blocked' });
  assert.deepEqual(branchRuleWords(404, null), { forcePush: 'not blocked', branchDelete: 'not blocked' });
  assert.deepEqual(branchRuleWords(403, null), { forcePush: 'not known', branchDelete: 'not known' });
});

test('the check says, for a token that can delete, one that cannot, and one that is not known', async () => {
  const server = standInServer();
  const apiBase = await listen(server);
  try {
    const repos = [{ ref: 'shop/code/guarded', url: 'https://github.com/alex/guarded.git' }];
    const canDel = await checkHerSignin({ token: 'can-delete', apiBase, repos });
    assert.equal(canDel.accepted, true);
    assert.equal(canDel.canDelete, true);
    assert.ok(checkWords(canDel).some((l) => /^This token can delete a repository\.$/.test(l)));

    const noDel = await checkHerSignin({ token: 'no-delete', apiBase, repos });
    assert.equal(noDel.canDelete, false);
    assert.ok(checkWords(noDel).some((l) => /^This token cannot delete a repository\.$/.test(l)));

    const fine = await checkHerSignin({ token: 'fine-grained', apiBase, repos });
    assert.equal(fine.canDelete, null);
    assert.ok(checkWords(fine).some((l) => /can delete a repository is not known/.test(l)));

    const bad = await checkHerSignin({ token: 'bad-token', apiBase, repos });
    assert.equal(bad.accepted, false);
    assert.deepEqual(checkWords(bad), ['the git server did not accept this token']);
  } finally {
    server.close();
  }
});

test('the check says per repository whether a forced push or a branch delete is blocked, and not known when it cannot tell', async () => {
  const server = standInServer();
  const apiBase = await listen(server);
  try {
    const repos = [
      { ref: 'shop/guarded', url: 'https://github.com/alex/guarded.git' },
      { ref: 'shop/open', url: 'https://github.com/alex/open.git' },
      { ref: 'shop/loose', url: 'https://github.com/alex/loose.git' },
      { ref: 'shop/admin-only', url: 'https://github.com/alex/admin-only.git' },
      { ref: 'shop/gone', url: 'https://github.com/alex/gone.git' },
      { ref: 'shop/forbidden', url: 'https://github.com/alex/forbidden.git' },
      { ref: 'shop/elsewhere', url: 'https://gitlab.com/alex/x.git' },
    ];
    const r = await checkHerSignin({ token: 'no-delete', apiBase, repos });
    const by = Object.fromEntries(r.repos.map((x) => [x.ref, x]));
    assert.deepEqual([by['shop/guarded'].forcePush, by['shop/guarded'].branchDelete], ['blocked', 'blocked']);
    assert.deepEqual([by['shop/open'].forcePush, by['shop/open'].branchDelete], ['not blocked', 'not blocked']);
    assert.deepEqual([by['shop/loose'].forcePush, by['shop/loose'].branchDelete], ['not blocked', 'not blocked']);
    assert.deepEqual([by['shop/admin-only'].forcePush, by['shop/admin-only'].branchDelete], ['not known', 'not known']);
    assert.equal(by['shop/gone'].known, false);
    assert.equal(by['shop/elsewhere'].known, false);
    // A repo the check cannot read (a 403 for this token) carries a real reason, never a bare "not known".
    assert.equal(by['shop/forbidden'].known, false);
    assert.equal(by['shop/forbidden'].why, 'this token may not read it');
    const words = checkWords(r).join('\n');
    // The safe state reads as "blocked"; the dangerous state is stated in the affirmative, so a non-programmer reads
    // the risk at a glance instead of "not blocked" next to "can delete a repository".
    assert.match(words, /shop\/guarded — default branch "main": a rule blocks a forced push; a rule blocks deleting the branch\./);
    assert.match(words, /shop\/loose — default branch "main": a forced push is allowed \(no rule blocks it\); deleting the branch is allowed \(no rule blocks it\)\./);
    assert.match(words, /shop\/gone: not known \(the git server does not find it with this token\)\./);
    assert.match(words, /shop\/forbidden: not known \(this token may not read it\)\./);
    assert.doesNotMatch(words, /\(not known\)/); // never the repeated parenthetical "not known (not known)"
  } finally {
    server.close();
  }
});

// A fake ctx that keeps config in memory, as src/config.mjs saveConfig does.
function fakeCtx(initial = {}) {
  let cfg = { ...initial, server: { ...(initial.server || {}) } };
  class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  return { config: () => cfg, saveConfig(patch) { cfg = { ...cfg, ...patch, server: { ...(cfg.server || {}), ...(patch.server || {}) } }; return cfg; }, readJson: async (req) => req, HttpError };
}

test('the check route reads the token from the chosen file and returns words, never the token itself', async () => {
  const server = standInServer();
  const apiBase = await listen(server);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hersignin-route-')));
  const creds = path.join(root, 'credentials');
  fs.mkdirSync(path.join(creds, 'shop'), { recursive: true });
  const TOKEN = 'can-delete';
  fs.writeFileSync(path.join(creds, 'shop', 'token'), `${TOKEN}\n`);
  try {
    const ctx = fakeCtx({ server: { herGitSignin: { file: 'shop/token' } } });
    const f = herSigninFeature(ctx, { apiBase, credsDir: () => creds, repos: () => [{ ref: 'shop/open', url: 'https://github.com/alex/open.git' }] });
    const check = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/hersignin/check'))[2];
    const out = await check();
    assert.equal(out.file, 'shop/token');
    assert.equal(out.canDelete, true);
    assert.ok(out.lines.some((l) => /can delete a repository/.test(l)));
    // The token is in nothing the route returns.
    assert.ok(!JSON.stringify(out).includes(TOKEN), 'the token leaked into the check\'s answer');
    // With no file chosen, the route asks the owner to choose one (it never calls the git server).
    const empty = herSigninFeature(fakeCtx(), { apiBase, credsDir: () => creds, repos: () => [] });
    const check2 = empty.routes.find(([m, re]) => m === 'POST' && re.test('/api/hersignin/check'))[2];
    await assert.rejects(() => check2(), (e) => e.status === 400 && /choose a credentials file/.test(e.message));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
