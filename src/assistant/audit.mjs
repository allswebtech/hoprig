// The assistant's audit log: one JSON line per tool call that writes (L1, L2 staging, a card's confirm, decline or
// failure), in <stateDir>/assistant-audit.jsonl. Reads (L0) are not logged. Inputs are masked (secrets.mjs) before
// they reach the disk. The dashboard shows the newest entries as "Activity".
//
//   { at, actor: "assistant" | "owner", conversation, tool, level, input, outcome, card?, error? }
//   outcome: "done" | "staged" | "confirmed" | "declined" | "refused" | "failed" | "stale" | "expired"
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { maskForAudit } from './secrets.mjs';

const MAX_BYTES = 5 * 1024 * 1024; // then the file is rotated once to .1

export const auditFile = () => path.join(stateDir(), 'assistant-audit.jsonl');

export class AuditLog {
  /** file: a path, or null to keep entries in memory only (tests). */
  constructor({ file = auditFile(), now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.memory = [];
  }

  append({ actor, conversation = 'direct', tool, level, input, outcome, card = null, error = null }) {
    const entry = { at: this.now(), actor, conversation, tool, level, input: maskForAudit(input ?? {}), outcome };
    if (card) entry.card = card;
    if (error) entry.error = maskForAudit(String(error)).slice(0, 300);
    this.memory.push(entry);
    if (this.memory.length > 500) this.memory.shift();
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        try {
          if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, `${this.file}.1`);
        } catch {
          /* no file yet */
        }
        fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      } catch (e) {
        // The action itself already happened or was refused; a full disk must not turn that into a crash.
        console.error(`assistant audit: ${e.message}`);
      }
    }
    return entry;
  }

  /** The newest `n` entries (from the file when there is one, so they survive a restart). */
  recent(n = 100) {
    if (!this.file) return this.memory.slice(-n);
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-n);
      return lines.flatMap((l) => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }
}
