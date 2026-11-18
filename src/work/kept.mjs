// The owner's list, kept IN the repository while a merge of the Work list runs. Between "the file is put back to its
// last commit" and "the merged list is written", his list is in no file: the journal (journal.mjs) has it, but the
// journal lives in Hoprig's state folder, and that folder can be gone, or be another one (a dashboard and a terminal
// with two state folders). So before the file is put back, his list is also stored in the repository as a git object
// (a blob) under a ref of Hoprig's own, refs/hoprig/work-save/<12 hex digits of the file's path>: git never prunes
// what a ref points at, and the owner finds it with one command (git show <ref>). The ref is deleted when the save is
// done or dropped. A look at the Work list that finds it without a journal of that save says so and shows how to put
// that list back (resume.mjs); it is never applied by itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture } from '../setup/system.mjs';
import { gitWrite } from './git.mjs';

/** The ref that keeps the list of the Work file at `rel` (its path in the repository, with "/"). */
export const keptRef = (rel) => `refs/hoprig/work-save/${crypto.createHash('sha256').update(rel).digest('hex').slice(0, 12)}`;

/** The command that prints that list, for a message. */
export const keptShow = (rel) => `git show ${keptRef(rel)}`;

/** The id the ref points at in the repository at `top`, or null when there is none (or git could not say). */
export async function keptId(top, rel, run = capture) {
  const r = await gitRead(top, ['rev-parse', '--verify', '--quiet', keptRef(rel)], { run });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Store the Work file's bytes (`file`, read by the caller as `id`) as a blob and point the ref at it. → { ok, detail? }:
 * not ok when git refused, or when the bytes git stored are not the ones read (the file changed meanwhile).
 */
export async function keepList(top, rel, file, id, run = capture) {
  const h = await gitWrite(top, ['hash-object', '-w', '--no-filters', '--', file], { run });
  if (!h.ok || h.stdout.trim() !== id) return { ok: false, detail: h.ok ? 'the Work file changed while it was kept' : (h.stderr || '').trim() };
  const u = await gitWrite(top, ['update-ref', '-m', 'Work save: your list, kept until the save is done', keptRef(rel), id], { run });
  return u.ok ? { ok: true } : { ok: false, detail: (u.stderr || '').trim() };
}

/** Delete the ref (the save is done, or the owner dropped it). Only while it still points at `id`, when one is given. */
export function dropKept(top, rel, run = capture, id = null) {
  return gitWrite(top, ['update-ref', '-d', keptRef(rel), ...(id ? [id] : [])], { run });
}

/**
 * The kept list of a place's Work file, found from its folder: { top, name, rel, ref, id }, or null when there is none.
 * Two reads of git, so every look at the Work list can ask.
 */
export async function keptOf(place, run = capture) {
  if (!fs.existsSync(place.folder)) return null;
  const t = await gitRead(place.folder, ['rev-parse', '--show-toplevel'], { run });
  if (!t.ok) return null;
  const top = t.stdout.trim();
  let rel;
  try {
    rel = path.relative(fs.realpathSync(top), place.file).split(path.sep).join('/');
  } catch {
    return null;
  }
  const id = await keptId(top, rel, run);
  return id ? { top, name: path.basename(top), rel, ref: keptRef(rel), id } : null;
}
