// A preload for a child run (node --import <this> …): every file module the child loads is written, one URL per line,
// into the file $LOADLIST_FILE. A test reads it to see which product modules a run loaded. The hook runs in the
// child's own thread (registerHooks, which every supported Node has).
import fs from 'node:fs';
import module from 'node:module';

module.registerHooks({
  load(url, context, next) {
    if (url.startsWith('file:') && process.env.LOADLIST_FILE) fs.appendFileSync(process.env.LOADLIST_FILE, `${url}\n`);
    return next(url, context);
  },
});
