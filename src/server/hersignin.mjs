// The git sign-in Tia's sessions use (src/assistant/hersignin.mjs): chosen here from the owner's signed-in page and
// nowhere else. Like every feature route it sits behind the dashboard's login; it is no route of Tia's door (door.mjs
// refuses /api/hersignin), so a session, a token or another computer can never point her sessions at a different
// sign-in than the one the owner chose.
//   GET  /api/hersignin            → { file }          the chosen credentials-file name, or null when he chose none
//   POST /api/hersignin   { file }  → { file }          choose a file (a name inside the credentials folder) or clear it
//   POST /api/hersignin/check       → { file, lines, … } ask the git server what the token may do (the owner's press)
// The file's content (the token) is never returned by any of these: GET/POST only name the file, and the check reads
// it, sends it in an Authorization header, and returns only plain words. `opts` lets a test point the check at a
// stand-in git server and a temporary credentials folder (so the real git server is never asked anything).
import { checkHerSignin, checkWords, cleanHerGitSigninFile, herGitSigninFile, readHerToken } from '../assistant/hersignin.mjs';
import { credsDir as realCredsDir } from '../workspace/credlinks.mjs';
import { readMap } from '../workspace/map.mjs';

/** Every repository the workspace map names, with its address: [{ ref, url }] (the brain, groups, projects' repos, others). */
function reposFromMap() {
  const { map } = readMap();
  if (!map) return [];
  const out = [];
  if (map.brain && map.brain.url) out.push({ ref: 'the brain', url: map.brain.url });
  for (const g of map.groups || []) if (g.url) out.push({ ref: g.dir, url: g.url });
  for (const p of map.projects || []) {
    const ref = p.name || p.dir;
    if (p.url) out.push({ ref, url: p.url });
    for (const r of p.repos || []) if (r.url) out.push({ ref: `${ref}/${r.dir}`, url: r.url });
  }
  for (const o of map.others || []) if (o.url) out.push({ ref: o.dir, url: o.url });
  return out;
}

export function herSigninFeature(ctx, opts = {}) {
  const credsDir = () => (opts.credsDir ? opts.credsDir() : realCredsDir());
  const repos = () => (opts.repos ? opts.repos() : reposFromMap());
  return {
    name: 'hersignin',
    routes: [
      ['GET', /^\/api\/hersignin$/, async () => ({ file: herGitSigninFile(ctx.config()) })],
      ['POST', /^\/api\/hersignin$/, async (req) => {
        // Chosen only from the owner's own signed-in page: never through Tia's door, a token or another
        // computer. The machines gate (TOKEN_FORBIDDEN) already refuses those; this is the same owner-page guard.
        if (ctx.caller && ctx.caller(req) !== 'page') throw new ctx.HttpError(403, 'the git sign-in for her sessions is chosen only by you, on this computer\'s own dashboard page: not by Tia, a token or another computer');
        const b = await ctx.readJson(req);
        let file;
        try {
          file = cleanHerGitSigninFile(b && b.file);
        } catch (e) {
          throw new ctx.HttpError(400, e.message);
        }
        ctx.saveConfig({ server: { herGitSignin: { file, at: Date.now() } } });
        return { file };
      }],
      ['POST', /^\/api\/hersignin\/check$/, async (req) => {
        // The check asks the git server what the token may do, on the owner's press only: never through
        // Tia's door, a token or another computer.
        if (ctx.caller && ctx.caller(req) !== 'page') throw new ctx.HttpError(403, 'the git sign-in check runs only on your press, on this computer\'s own dashboard page: not by Tia, a token or another computer');
        const file = herGitSigninFile(ctx.config());
        if (!file) throw new ctx.HttpError(400, 'choose a credentials file first');
        let token;
        try {
          token = readHerToken(credsDir(), file);
        } catch (e) {
          throw new ctx.HttpError(400, e.message);
        }
        const result = await checkHerSignin({ token, repos: repos(), apiBase: opts.apiBase, fetchImpl: opts.fetchImpl });
        token = null;
        return { file, accepted: result.accepted, canDelete: result.canDelete, error: result.error, repos: result.repos, lines: checkWords(result) };
      }],
    ],
  };
}
