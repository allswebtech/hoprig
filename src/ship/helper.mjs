#!/usr/bin/env node
// The helper of a go-live whose update restarts the dashboard that runs it (docs/GO-LIVE.md). Started,
// detached, just before the update; argv: the repository's git folder (where the step's journal lies).
//
// It waits. The dashboard that comes back after the restart finishes the step (live.mjs finishCut) and claims it
// first: then the helper has nothing to do and ends. When no dashboard has claimed the step within the update's time
// limits plus the project's "waitSeconds" after the update began, the helper claims it itself (exclusively: never
// both), checks the confirmed "back" against the settings again (a changed journal or settings file runs nothing), runs
// it and writes the outcome. It reads only the journal, Hoprig's settings and this computer's key. Only a claim shown to
// be a living process's ends its wait early: one that cannot be told (alive, and its start not readable: on Windows a
// pid handed to a process that is ending just then) is looked at again, and decided by the claim at the end of the
// wait. When it ends without taking the step back it says why, in one line of the state folder's ship/helper.log.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { alive } from '../procid.mjs';
import { claimLook, helperBack, readJournal } from './live.mjs';

const gitDir = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One line of why the helper of step `id` ended without taking it back. */
function said(id, why) {
  try {
    const file = path.join(stateDir(), 'ship', 'helper.log');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${new Date().toISOString()} ${id}: ${why}\n`, { mode: 0o600 });
  } catch {
    /* nowhere to say it */
  }
}
const lookWords = (l) => `the claim ${l.state} (pid ${l.pid}, alive ${l.alive}, its identity ${l.proc}, the system's now ${l.now})`;

async function main() {
  if (!gitDir || !path.isAbsolute(gitDir) || !fs.existsSync(gitDir)) return;
  const first = readJournal(gitDir);
  if (!first || first.unreadable || !first.restarts) return;
  const updateMinutes = (first.live?.update || []).reduce((n, c) => n + (Number(c.minutes) || 0), 0);
  const wait = Math.min(1800, Math.max(5, Number(first.live?.waitSeconds) || 120)) * 1000;
  const startedAt = Date.parse(first.updateAt || first.at) || Date.now();
  // The time limit runs from the moment the dashboard that started the step is gone (the restart ended it), and at
  // the latest from the end of the update's own time limits.
  let until = startedAt + updateMinutes * 60_000 + wait;
  let goneAt = null;
  let unknown = null; // the last look that could not tell the claim
  for (;;) {
    const j = readJournal(gitDir);
    if (!j || j.unreadable || j.id !== first.id) return said(first.id, j && !j.unreadable ? 'another step is in the journal' : 'the step has ended (no journal)');
    const look = claimLook(gitDir, j.id);
    if (look.state === 'held') return said(j.id, `a living process finishes it: ${lookWords(look)}`);
    if (look.state === 'unknown') unknown = look;
    if (goneAt === null && !(Number.isInteger(first.owner) && alive(first.owner))) {
      goneAt = Date.now();
      until = Math.min(until, goneAt + wait);
    }
    if (Date.now() >= until) break;
    await sleep(Math.min(500, Math.max(50, until - Date.now())));
  }
  try {
    const r = await helperBack(gitDir);
    if (!r) said(first.id, `it was not taken: ${lookWords(claimLook(gitDir, first.id))}${unknown ? `; during the wait ${lookWords(unknown)}` : ''}`);
  } catch (e) {
    said(first.id, `taking it back failed: ${String(e && e.message).slice(0, 300)}`);
  }
}

await main();
