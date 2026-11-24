// The owner's own stop of an add-on (Settings → Add-ons → Stop, or `hoprig addons stop`): when, per add-on, in
// <state>/addons-stopped.json. A start clears it (his, a session's PRERUN, a restart from the Operator). The Operator's
// gateway rule never starts again a gateway he stopped himself: that stays his.
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';

const file = () => path.join(stateDir(), 'addons-stopped.json');
const read = () => {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
};
const write = (d) => {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, file());
  } catch {
    /* never in the way of the stop or the start itself */
  }
};

/** When the owner last stopped add-on `id`, or null. */
export const stoppedAt = (id) => (Number.isFinite(read()[id]) ? read()[id] : null);
export function noteStopped(id, at = Date.now()) {
  write({ ...read(), [id]: at });
}
export function noteStarted(id) {
  const d = read();
  if (!(id in d)) return;
  delete d[id];
  write(d);
}
