#!/usr/bin/env node
// What Claude Code starts for a hook event (launch.mjs: hookSettings). The same as `hoprig hook`, without loading
// the rest of hoprig: Claude waits for every one of these. A status event loads only the record's part
// (hookrecord.mjs); the wall and the answers are loaded only for an event that can be answered.
import { hookMain } from '../src/hookrecord.mjs';

await hookMain();
