// The plain walk of find in files and quick open, for a folder without ripgrep and outside a repository. It runs in a
// worker thread: a regular expression typed in the page can take exponential time on one line (a typo is enough), and
// a large folder takes long to read; on the server's own thread either would stop every terminal and page. The
// worker is ended at the time limit, wherever it is (also inside a regular expression).
import fs from 'node:fs';
import path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { isBinary } from './files.mjs';

/** A glob as a RegExp over a relative path; a pattern without "/" matches the name at any depth (as in VS Code). */
export function globRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      s += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${s}(/.*)?$` : `(^|/)${s}(/.*)?$`);
}

/**
 * Walk `root` in a worker. o: { mode: 'search' | 'files', skip (names never entered), fold, re: { source, flags },
 * inc, exc, perFile, fileBytes, ms }. `onItems(items)` gets each file's hits ([path, line, col, text]) or a batch of
 * file paths; returning false ends the walk. Resolves { timedOut, stopped }.
 */
export function walk(root, o, onItems) {
  return new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { root, ...o } });
    let done = false;
    const end = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      w.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => end({ timedOut: true }), o.ms);
    w.on('message', (m) => {
      if (done) return;
      if (m.items && onItems(m.items) === false) end({ stopped: true });
      if (m.end) end({ timedOut: Boolean(m.timedOut) });
    });
    w.on('error', () => end({}));
    w.on('exit', () => end({}));
  });
}

function run({ root, mode, skip, fold, re, inc, exc, perFile, fileBytes }) {
  const name = (n) => (fold ? n.toLowerCase() : n);
  const rx = mode === 'search' ? new RegExp(re.source, re.flags) : null;
  const incRe = inc.map(globRe);
  const excRe = exc.map(globRe);
  const stack = [''];
  let batch = [];
  while (stack.length) {
    const rel = stack.pop();
    let list;
    try {
      list = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    list.sort((a, b) => b.name.localeCompare(a.name));
    for (const d of list) {
      if (skip.includes(name(d.name))) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (excRe.some((x) => x.test(p))) continue;
      if (d.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!d.isFile()) continue;
      if (mode === 'files') {
        batch.push(p);
        if (batch.length >= 500) {
          parentPort.postMessage({ items: batch });
          batch = [];
        }
        continue;
      }
      if (incRe.length && !incRe.some((x) => x.test(p))) continue;
      let buf;
      try {
        const full = path.join(root, p);
        if (fs.statSync(full).size > fileBytes) continue;
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      const hits = [];
      for (let i = 0; i < lines.length && hits.length < perFile; i++) {
        const m = rx.exec(lines[i]);
        if (m) hits.push([p, i + 1, m.index + 1, lines[i]]);
      }
      if (hits.length) parentPort.postMessage({ items: hits });
    }
  }
  if (batch.length) parentPort.postMessage({ items: batch });
  parentPort.postMessage({ end: true });
}

if (!isMainThread && workerData && workerData.mode) run(workerData);
