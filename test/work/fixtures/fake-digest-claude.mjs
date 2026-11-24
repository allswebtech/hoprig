// Stands in for Claude Code in print mode for "Tia writes my digest" (src/work/tellwords.mjs tiaCall): it asks no
// provider. Each call appends its arguments as one JSON line to the file named by FAKE_DIGEST_LOG, and the answer is
// the notification it was given, unchanged, with a made-up cost (FAKE_DIGEST_COST, US dollars).
import fs from 'node:fs';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (process.env.FAKE_DIGEST_LOG) fs.appendFileSync(process.env.FAKE_DIGEST_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
  const at = input.indexOf('The notification to reword:\n');
  const text = at >= 0 ? input.slice(at + 'The notification to reword:\n'.length) : '';
  const cost = Number(process.env.FAKE_DIGEST_COST || '0.03');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: text, total_cost_usd: cost, usage: { input_tokens: 10, output_tokens: 5 } }));
});
