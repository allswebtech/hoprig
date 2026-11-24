// A preload for a child run (node --import <this> …): every file module the child loads is written, one URL per line,
// into the file $LOADLIST_FILE. A test reads it to see which product modules a run loaded. Node 22.15+ takes the
// hook in the child's own thread (registerHooks); an older Node through register, whose hook runs in a thread of its
// own and writes the same file.
import module from 'node:module';

const hook = `
import fs from 'node:fs';
export async function load(url, context, next) {
  if (url.startsWith('file:') && process.env.LOADLIST_FILE) fs.appendFileSync(process.env.LOADLIST_FILE, url + '\\n');
  return next(url, context);
}`;

if (module.registerHooks) {
  const fs = await import('node:fs');
  module.registerHooks({
    load(url, context, next) {
      if (url.startsWith('file:') && process.env.LOADLIST_FILE) fs.appendFileSync(process.env.LOADLIST_FILE, `${url}\n`);
      return next(url, context);
    },
  });
} else {
  module.register(`data:text/javascript,${encodeURIComponent(hook)}`);
}
