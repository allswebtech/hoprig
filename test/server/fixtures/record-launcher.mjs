#!/usr/bin/env node
// Stands in for the launcher where only what it was started with matters: it takes its launch file as the real one
// does (src/launchfile.mjs), writes the arguments, the folder and $PWD it ended up with to
// <state>/recorded/<time>-<pid>.json, prints "RECORDED" and ends. No Claude Code, no run record.
import fs from 'node:fs';
import path from 'node:path';
import { applyLaunch } from '../../../src/launchfile.mjs';

applyLaunch();
const dir = path.join(process.env.HOPRIG_STATE_DIR, 'recorded');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${Date.now()}-${process.pid}.json`);
fs.writeFileSync(`${file}.part`, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pwd: process.env.PWD }));
fs.renameSync(`${file}.part`, file); // whoever waits for it never reads it half written
process.stdout.write('RECORDED\n');
