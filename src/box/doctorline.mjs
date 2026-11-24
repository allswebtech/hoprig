// The doctor's one line about the box (docs/BOX.md): an information line, never a cross and never a warning, whether
// this computer has a box or not. Only `hoprig doctor` as a person runs it passes this to the checks (src/setup/cli.mjs),
// so the self-test runs there and nowhere else: a dashboard or the upkeep that asks for the doctor's checks gets no
// box line and starts no self-test.
import { boxCheck } from './box.mjs';

/** The line for the doctor: { id, label, status: 'info', detail, fix }. `check` is the box's own; a test passes another. */
export async function boxLine(check = boxCheck) {
  let r;
  try {
    r = await check();
  } catch (e) {
    r = { ok: false, why: `the self-test could not run: ${e.message}`, step: '' };
  }
  const detail = r.ok
    ? `this computer has one (${r.kind}): commands can run with no network, without your home, seeing only the folders named`
    : `this computer has none: ${r.why}${r.step ? `; what would give it one: ${r.step}` : ''}`;
  return { id: 'box', label: 'A box for commands', status: 'info', detail, fix: '' };
}
