// One Activity line by "field" (the page's Activity list, <state>/automation.log): status only, never an address or
// a report's content.
import path from 'node:path';
import { createActivityLog } from '../automation/store.mjs';
import { stateDir } from '../paths.mjs';

export function recordActivity(did, outcome = 'ok') {
  try {
    return createActivityLog(path.join(stateDir(), 'automation.log')).add({ automation: 'field', did, outcome });
  } catch {
    return null;
  }
}
