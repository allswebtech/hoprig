// Two dashboards on one state folder share one spending record: takers in separate processes, at the same moment,
// never pass the daily cap together (spend.mjs take under its lock file).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SPEND = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'assistant', 'spend.mjs')).href;

test('takers in four processes at once never hold more than the cap', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'assistant', 'spend.jsonl');
  const go = path.join(dir, 'go');
  const taker = path.join(dir, 'taker.mjs');
  // Each taker waits for the start line, then tries as many holds as it can; it says how many it got.
  fs.writeFileSync(taker, `import fs from 'node:fs';
import { SpendLedger } from ${JSON.stringify(SPEND)};
const [file, go, cap, tries] = process.argv.slice(2);
const l = new SpendLedger({ file });
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(wait, 0, 0, 1);
let got = 0;
for (let i = 0; i < Number(tries); i++) if (l.take(Number(cap)) === null) got++;
process.stdout.write(String(got));
`);
  const CAP = 10; // twenty holds of $0.50
  const kids = Array.from({ length: 4 }, () => {
    const p = spawn(process.execPath, [taker, file, go, String(CAP), '30'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    return new Promise((resolve) => p.on('close', (code) => resolve({ code, got: Number(out), err })));
  });
  await new Promise((r) => setTimeout(r, 400)); // every taker is waiting at the line
  fs.writeFileSync(go, '');
  const done = await Promise.all(kids);
  for (const k of done) assert.equal(k.code, 0, k.err);
  const got = done.reduce((n, k) => n + k.got, 0);
  const holds = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'hold').length;
  assert.equal(holds, got, 'every hold a taker was given is in the record');
  assert.equal(holds, CAP / 0.5, `the takers held ${holds} times $0.50 against a cap of $${CAP}`);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock file was left behind');
});
