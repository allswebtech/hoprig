// hoprig tasks tokens: the Work tokens for other programs (access.mjs), listed and revoked from a terminal. They are
// made only on the dashboard's page (Work → Tasks → Work settings (at the foot)), where the token is shown once.
import { listWebhooks, listWorkTokens, revokeWorkToken } from './access.mjs';

const when = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : 'never');

/** `tasks tokens` and `tasks tokens revoke <id or name>`. → exit code. */
export function tokensCommand(word, name, { show, dryRun = false }) {
  if (word === undefined) {
    const tokens = listWorkTokens();
    const hooks = listWebhooks();
    const lines = tokens.length
      ? tokens.flatMap((t) => [
        `${t.id}  ${t.name}  made ${when(t.created)}  last used ${when(t.lastUsed)}`,
        ...hooks.filter((h) => h.token === t.id).map((h) => `    webhook ${h.id}: ${h.url} (${h.events.join(', ')})`),
      ])
      : ['No Work tokens. Make one in the dashboard: Work → Tasks → Work settings (at the foot) → More → Another program.'];
    show({ tokens, webhooks: hooks }, lines.join('\n'));
    return 0;
  }
  if (word !== 'revoke') throw Object.assign(new Error(`tokens takes "revoke <id or name>", not "${String(word).slice(0, 40)}"`), { status: 400, usage: true });
  if (!name) throw Object.assign(new Error('revoke needs the id or the name of a Work token (hoprig tasks tokens shows them)'), { status: 400, usage: true });
  const t = listWorkTokens().find((x) => x.id === name || x.name === name);
  if (!t) throw Object.assign(new Error(`there is no Work token "${String(name).slice(0, 60)}"`), { status: 404, details: { code: 'not-found' } });
  if (dryRun) {
    show({ dryRun: true, would: { revoke: { id: t.id, name: t.name } } }, `Would revoke the Work token ${t.name} (${t.id}) and its webhooks (dry run: nothing written)`);
    return 0;
  }
  const gone = revokeWorkToken(t.id);
  show({ revoked: gone }, `Revoked the Work token ${t.name} (${t.id}): it is refused from now on, and its webhooks are gone. Its tasks stay, with its name.`);
  return 0;
}
