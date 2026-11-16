#!/usr/bin/env node
// What Claude Code starts for a hook event (launch.mjs: hookSettings). The same as `hoprig hook`, without loading
// the rest of hoprig: Claude waits for every one of these.
import { hookMain } from '../src/hook.mjs';

await hookMain();
