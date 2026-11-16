// A chat's task table: the subagents, background shells and workflows its coding tool runs, by task id, from the
// engine's `task` and `tasks-running` events (src/chat/events.mjs), and whether background work still runs.
//
// A result is not the end: a background task that ended is followed by a turn of the coding tool's own (it reads
// the task's result), also when it ended while a turn ran; that turn starts right after the result. Until it does,
// the chat still works (`owed`), for OWED_MS at most.
const TASKS_MAX = 200;
export const OWED_MS = 10_000;

export class TaskTable {
  constructor() {
    this.map = new Map(); // task id → { taskId, toolId, type, title, now, status, background, usage, phases, agents, … }
    this.bg = new Set(); // the background tasks the coding tool says run
    this.owed = 0; // background tasks that ended, whose turn has not started yet
    this.timer = null;
  }

  values() {
    return this.map.values();
  }
  get size() {
    return this.map.size;
  }
  has(id) {
    return this.map.has(id);
  }
  get(id) {
    return this.map.get(id);
  }

  /** Tasks read back from the transcript (they ran before): kept where the table does not know them. */
  load(list) {
    for (const t of list) if (!this.map.has(t.taskId)) this.map.set(t.taskId, (({ kind, ...x }) => x)(t));
  }

  #task(id) {
    const t = this.map.get(id) || { taskId: id, status: 'running', startedAt: Date.now() };
    this.map.set(id, t);
    if (this.map.size > TASKS_MAX) {
      const old = [...this.map.values()].find((x) => x.status !== 'running');
      if (old) this.map.delete(old.taskId);
    }
    return t;
  }

  /** A `task` event: what it says is merged into the task. */
  apply(ev) {
    const { kind, at, ...fields } = ev;
    const t = this.#task(ev.taskId);
    const was = t.status;
    Object.assign(t, fields, { updatedAt: Date.now() });
    if (t.background && was === 'running' && (t.status === 'completed' || t.status === 'failed')) this.owed++;
    if (t.status !== 'running') this.bg.delete(t.taskId);
  }

  /** The background tasks that run now (this line comes before a task's own start, and marks a workflow as background). */
  running(ids) {
    this.bg = new Set(ids);
    for (const id of ids) this.#task(id).background = true;
  }

  /** Background work runs: the coding tool says so, or a task started in the background has not ended. */
  bgBusy() {
    if (this.bg.size) return true;
    for (const t of this.map.values()) if (t.background && t.status === 'running') return true;
    return false;
  }
  busy() {
    return this.bgBusy() || this.owed > 0;
  }

  /** A turn started: what was owed came. */
  turnStarted() {
    this.owed = 0;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** No turn runs: wait for the owed one, at most `ms`, then `gaveUp()`. */
  waitOwed(ms, gaveUp) {
    if (!this.owed || this.bgBusy() || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.owed = 0;
      gaveUp();
    }, ms);
    this.timer.unref?.();
  }

  /** The process is gone, and what ran in it with it. */
  lost() {
    for (const t of this.map.values()) if (t.status === 'running') t.status = 'stopped';
    this.bg.clear();
    this.turnStarted();
  }
}
