// `hoprig demo` (dispatched by bin/hoprig.mjs): the dashboard with sample data, see ./index.mjs.
// Returns an exit code, or null while the demo runs (Ctrl+C stops it and removes everything).
import { main as demo } from './index.mjs';

export async function main(command, args = []) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('usage: hoprig demo [--port N] [--no-open]\n  Starts the dashboard with sample data on 127.0.0.1 (no Claude Code, no provider, nothing real)\n  and opens it in the browser. Ctrl+C stops it and removes everything.\n');
    return 0;
  }
  return demo(args);
}
