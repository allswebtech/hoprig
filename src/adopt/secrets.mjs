// The search for secret-shaped values before a first push: what a first push would take, the tracked files of a
// repository and the untracked ones that are not ignored (what git add -A stages; git ls-files through the reader), each searched for the key shapes the product masks everywhere (src/assistant/secrets.mjs). Only the
// count and the files are said, never a value. A private folder (PRIVATE_DIRS) is never read and nothing in it is
// named: the list leaves it out (STATUS_EXCLUDES), and a name with a private part is dropped as a second line.
import fs from 'node:fs';
import path from 'node:path';
import { looksSecret } from '../assistant/secrets.mjs';
import { gitRead } from '../gitread.mjs';
import { STATUS_EXCLUDES } from '../pcsetup/projects.mjs';
import { isPrivate } from './proof.mjs';

const BINARY = /\.(png|jpe?g|gif|webp|pdf|zip|ico|woff2?|ttf|otf|mp[34]|mov|gz|7z|jar|so|dll|exe)$/i;

/** → { total, files: [rel] } over what a first push of `repo` would take: tracked and untracked, not ignored (each under 3 MB, text only). */
export async function secretCount(repo) {
  const r = await gitRead(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.', ...STATUS_EXCLUDES], { timeout: 60_000 });
  if (!r.ok) return { total: 0, files: [], error: 'the files could not be listed' };
  const names = [...new Set(r.stdout.split('\0').filter(Boolean))].filter((n) => !n.split('/').some(isPrivate));
  let total = 0;
  const files = [];
  for (const n of names) {
    if (BINARY.test(n)) continue;
    const p = path.join(repo, n);
    let text;
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.size > 3 << 20) continue;
      text = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const k = text.split('\n').filter((l) => looksSecret(l)).length;
    if (k) {
      total += k;
      files.push(`${n} (${k})`);
    }
  }
  return { total, files };
}
