#!/usr/bin/env node
// The helper of a go-live whose update restarts the dashboard that runs it (docs/GO-LIVE.md). Started,
// detached, just before the update; argv: the repository's git folder (where the step's journal lies).
//
// It waits. The dashboard that comes back after the restart finishes the step (live.mjs finishCut) and claims it
// first: then the helper has nothing to do and ends. When no dashboard has claimed the step within the update's time
// limits plus the project's "waitSeconds" after the update began, the helper claims it itself (exclusively: never
// both), checks the confirmed "back" against the settings again (a changed journal or settings file runs nothing), runs
// it and writes the outcome. It reads only the journal, Hoprig's settings and this computer's key.
import fs from 'node:fs';
import path from 'node:path';
import { alive } from '../procid.mjs';
import { claimHeld, helperBack, readJournal } from './live.mjs';

const gitDir = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (;;) {
    const j = readJournal(gitDir);
    if (!j || j.unreadable || j.id !== first.id) return; // ended (or another step): not the helper's
    if (claimHeld(gitDir, j.id)) return; // a living dashboard is finishing it
    if (goneAt === null && !(Number.isInteger(first.owner) && alive(first.owner))) {
      goneAt = Date.now();
      until = Math.min(until, goneAt + wait);
    }
    if (Date.now() >= until) break;
    await sleep(Math.min(500, Math.max(50, until - Date.now())));
  }
  await helperBack(gitDir).catch(() => {});
}

await main();
