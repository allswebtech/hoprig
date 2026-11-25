// Every route of Tia's door (src/assistant/door.mjs ALLOW), read from the door itself and not kept by hand elsewhere,
// is weighed here against the PATH it takes: does it start, restart, move or carry on a coding tool's process, and if
// so, where that session is made hers (the mark and her git sign-in, through the one startAsHers). A route added to
// her door that is in neither list fails this test until someone weighs it; an entry whose route left the door fails
// too, so the lists never say more than the door does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const { ALLOW } = await import('../../src/assistant/door.mjs');
const key = (e) => `${e.method} ${e.path}`;
const CHAT = '/api/chats/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Routes that start, restart, move or carry on a coding tool's process. `file` is where the session is made hers on
// that path and `does` the line that must be there; the end-to-end proof is named in `proof`.
const STARTS = {
  'POST /api/sessions': { file: 'server/server.mjs', does: /const hers = fromHerDoor\(ctx, req\)/, proof: 'herterminal.test.mjs' },
  'POST /api/sessions/[^/]+/switch': { file: 'server/deck.mjs', does: /const hers = isMarkedHers\(/, proof: 'herterminal.test.mjs (switch)' },
  // Her call is only the typed carry-on prompt (door: onlyKeys([])); the restart in place is the page's own button,
  // and it goes through the same deck.move.
  'POST /api/sessions/[^/]+/continue': { file: 'server/deck.mjs', does: /const hers = isMarkedHers\(/, proof: 'herterminal.test.mjs (switch, the same deck.move)' },
  'POST /api/chats': { file: 'chat/feature.mjs', does: /b\.hers = fromTia\(req\)/, proof: 'chat-allow.test.mjs, hershandoff.test.mjs' },
  // A chat's process is started again for a message, a provider move and a restart: each start reads the chat's word.
  [`POST ${CHAT}/send`]: { file: 'chat/run.mjs', does: /chat\.byTia \|\| chat\.hers \|\| chat\.restoredMark\) \{\n\s*env = startAsHers\(/, proof: 'hershandoff.test.mjs' },
  [`POST ${CHAT}/provider`]: { file: 'chat/run.mjs', does: /chat\.byTia \|\| chat\.hers \|\| chat\.restoredMark\) \{\n\s*env = startAsHers\(/, proof: 'hershandoff.test.mjs' },
  // A fork starts its process at its first message, through run.mjs as every chat: the route marks it hers.
  [`POST ${CHAT}/fork`]: { file: 'chat/feature.mjs', does: /\.\.\.\(fromTia\(req\) \? \{ hers: true \} : \{\}\)/, proof: 'fork-hers.test.mjs' },
  [`POST ${CHAT}/terminal`]: { file: 'chat/handoff.mjs', does: /hers: wasHers/, proof: 'hershandoff.test.mjs' },
  'POST /api/chats/from-session': { file: 'chat/handoff.mjs', does: /isMarkedHers\(path\.join\(runsDir\(\)/, proof: 'hershandoff.test.mjs' },
  'POST /api/work/items/[^/]+/do': { file: 'work/dofeature.mjs', does: /hers: fromTia\(req\)/, proof: 'hersdoit.test.mjs' },
  'POST /api/work/missions': { file: 'mission/feature.mjs', does: /hers: fromHerDoor\(o\.sctx, req\)/, proof: 'hersdoit.test.mjs (planner)' },
  'POST /api/automation/schedules': { file: 'automation/feature.mjs', does: /hers: fromHerDoor\(sctx, req\)/, proof: 'schedule-hers.test.mjs' },
};

// Routes that start no coding tool's process, each with its reason as the path shows it.
const NOT_STARTS = {
  'POST /api/sessions/[^/]+/send': 'types into the program that runs there; starts nothing, and whose session it is stays as it was',
  'POST /api/sessions/[^/]+/key': 'one key to the program in front; starts nothing',
  'POST /api/sessions/[^/]+/rename': 'a name only',
  'POST /api/sessions/[^/]+/kill': 'ends a session; its mark goes with its record (runs.mjs removeRun)',
  [`POST ${CHAT}/answer`]: 'answers a question the running process asked; starts nothing',
  [`POST ${CHAT}/stop`]: 'stops the turn',
  [`POST ${CHAT}/title`]: 'a name only',
  [`POST ${CHAT}/close`]: 'closes the chat; its process ends',
  'POST /api/work/items': 'writes a task', 'POST /api/work/items/[^/]+': 'writes a task', 'POST /api/work/items/[^/]+/status': 'writes a status',
  'POST /api/work/items/[^/]+/remove': 'writes the list',
  'POST /api/work/fix-ids': 'writes the list: later doubles get ids of their own', 'POST /api/work/tidy': 'writes the list\'s file in its tidy form',
  'POST /api/work/missions/m-[^/]+/stop': 'stops a mission: nothing new starts',
  'POST /api/work/missions/m-[^/]+/add': 'a task joins a mission that runs; its session is started later by the mission itself, as every task of it (mission/engine.mjs)',
  'POST /api/work/missions/m-[^/]+/tasks/[^/]+/run-tests': 'the project\'s test command in the box; no coding tool starts',
  'POST /api/work/items/[^/]+/plan': 'writes a task\'s plan, milestone and what it waits for; a task of a plan starts only by a Do it of its own',
  'POST /api/work/items/[^/]+/accept': 'marks a run done and frees its worktree; no coding tool starts',
  'POST /api/work/items/[^/]+/send-back': 'writes the brief and sets the task open; the next start is a Do it of its own',
  'POST /api/automation/settings': 'switches rules; restore brings sessions back with their own mark (automation/restore.mjs), retry and the queue only type',
  'POST /api/automation/queue/[^/]+': 'a message typed when the session next waits; starts nothing',
  'POST /api/assistant/run': 'run_command: her own command, not a coding tool (its administrator rules are herrights.mjs)',
  'POST /api/pcsetup/project/new': 'folders and git', 'POST /api/pcsetup/project/clone': 'git clone', 'POST /api/pcsetup/project/add': 'git clone',
  'POST /api/pcsetup/project/sync': 'git', 'POST /api/pcsetup/install': 'a project\'s own install step, no coding tool',
  'POST /api/workspace/setup': 'folders', 'POST /api/workspace/map': 'the map file', 'POST /api/workspace/restore': 'git clones',
  'POST /api/workspace/sync': 'git', 'POST /api/workspace/settings': 'settings', 'POST /api/workspace/forget': 'the map file',
  'POST /api/workspace/drop/check': 'a dry run', 'POST /api/workspace/group': 'a dry run',
  'POST /api/pcsetup/fix': 'an install step on his card', 'POST /api/pcsetup/setup': 'install steps', 'POST /api/claude/update': 'updates a program',
  'POST /api/codetools/[a-z]+': 'turns a coding tool on or off; starts no session', 'POST /api/updates/check': 'asks for versions',
  'POST /api/updates/restart': 'restarts the dashboard; no coding tool starts by it, and a session the restore reopens keeps its own mark (restore-hers.test.mjs)',
  'POST /api/updates/run': 'updates a program', 'POST /api/pc/kill': 'ends a process',
  'POST /api/pc/power': 'reboots: the restore afterwards brings each session back with its own mark (automation/restore.mjs)',
  'POST /api/machine/label': 'a name', 'POST /api/machines/[^/]+/rename': 'a name',
  'POST /api/addons/(?!public-link/)[^/]+/(start|stop)': 'an add-on\'s service, no coding tool',
  'POST /api/addons/(?!public-link/)[^/]+/(install|update)': 'an add-on\'s install, on his card', 'POST /api/public-link': 'off only',
  'POST /api/skillhub/check': 'asks for versions', 'POST /api/skillhub/review': 'fetches files into quarantine; no coding tool',
  'POST /api/skillhub/update-review': 'fetches files into quarantine', 'POST /api/skillhub/approve': 'copies reviewed files',
  'POST /api/skillhub/remove': 'removes files', 'POST /api/skillhub/cancel': 'deletes a review\'s fetched files', 'POST /api/skillhub/undo': 'swaps a skill\'s files with the kept version',
  'POST /api/field/twice/[a-z-]+:[a-z-]+/dismiss': 'notes a line as hidden', 'POST /api/field/twice/[a-z-]+:[a-z-]+/draft': 'writes a skill draft; nothing is installed and no coding tool starts', 'POST /api/skills/learned/[0-9a-f]{24}/install': 'one git commit of a skill file in the brain; no coding tool starts', 'POST /api/skills/learned/[0-9a-f]{24}/discard': 'deletes a draft\'s folder', 'POST /api/skills/learned/[0-9a-f]{24}/undo': 'one git revert in the brain; no coding tool starts', 'POST /api/skillhub/settings': 'settings', 'POST /api/settings': 'settings',
  'POST /api/pcsetup/projects-dir': 'settings', 'POST /api/pcsetup/rules': 'a rules file',
};

test('every route of her door is weighed: it starts a process (and is made hers) or it does not', () => {
  const door = ALLOW.map(key);
  for (const k of door) {
    if (k.startsWith('GET ')) continue; // a read starts nothing: every GET of her door only reads
    assert.ok(k in STARTS || k in NOT_STARTS, `${k} is a route of her door in neither list: weigh whether it starts a coding tool's process, and if so make the session hers`);
    assert.ok(!(k in STARTS && k in NOT_STARTS), `${k} is in both lists`);
  }
  for (const k of [...Object.keys(STARTS), ...Object.keys(NOT_STARTS)]) assert.ok(door.includes(k), `${k} is no route of her door any more: take it out of this test`);
});

test('every route that starts a process of hers makes the session hers where it lands', () => {
  for (const [k, s] of Object.entries(STARTS)) assert.match(read(s.file), s.does, `${k}: ${s.file} must make the session hers (proved by ${s.proof})`);
});

test('a read of her door starts nothing: no GET route of hers reaches a start', () => {
  for (const e of ALLOW.filter((x) => x.method === 'GET')) assert.ok(!(key(e) in STARTS), `${key(e)} starts a process`);
});
