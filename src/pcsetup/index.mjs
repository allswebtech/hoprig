// The two entry points other parts of hoprig call (a first-run flow, the dashboard's "Get started"):
//   runPcSetup({ ui, yes, dryRun, kits, recipe, projects, rules }) → { ok, changed, missing, code }
//   pcStatus({ offline, projects }) → [{ id, label, status, detail, fix, group, fixKit? }]
import { sysFacts } from './detect.mjs';
import { projectsDir } from './projects.mjs';
import { pcStatus as statusOf } from './status.mjs';

export { runPcSetup } from './setup.mjs';

export async function pcStatus({ offline = false, projects = projectsDir() } = {}) {
  return statusOf({ sys: await sysFacts(), offline, projects });
}
