// Stands in for Claude Code for a sign-in on a Console account's key: `claude auth status --json` answers as Claude
// Code 2.1.330 builds that answer (authMethod "api_key", apiKeySource "/login managed key", the account named) when
// FAKE_AUTH is "console", and as a claude.ai sign-in when it is "claudeai". Any other call (print mode) asks no
// provider: it appends its arguments to the file FAKE_CALLS names and answers its input unchanged.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  const console = process.env.FAKE_AUTH === 'console';
  const who = { email: 'someone@example.invalid', orgId: '11111111-1111-4111-8111-111111111111', orgName: 'Example Org' };
  process.stdout.write(JSON.stringify(console
    ? { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: '/login managed key', ...who }
    : { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', ...who }) + '\n');
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_CALLS) fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\n');
  const at = input.indexOf('The notification to reword:\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: at >= 0 ? input.slice(at + 28) : '', total_cost_usd: 0.02 }));
});
