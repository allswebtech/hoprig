#!/usr/bin/env node
// Stands in for the launcher in its first moment: it takes its launch file, as the real one does first, then waits
// before it would write its run record, with Node's own Ctrl+C handling (the real launcher sets its own only later).
// A Ctrl+C now ends it, and the shell then drops the rest of the start line (the removal of the start's mark).
import { applyLaunch } from '../../../src/launchfile.mjs';

applyLaunch();
setTimeout(() => {}, 60_000);
