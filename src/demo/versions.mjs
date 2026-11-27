// Every made-up version the demo shows, in one place: the coding tools' installed and newest versions, Hoprig's own,
// the other computer's, the gateway's, the public link's helper and the set-up checks' programs. Settings → Version and updates,
// the Overview, Health, Setup, Coding tools, the Computers page, the chat and the sign-in all read them from here,
// so no page says "the newest version" while another offers a newer one (test/server/demo-versions.test.mjs).
import fs from 'node:fs';

/** Hoprig's own version (package.json): the demo never shows a Hoprig version this is not. */
export const HOPRIG = String(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || '');

/** The coding tools and the public link's helper: what is "installed" and the newest one "out". */
export const TOOLS = Object.freeze({
  claude: Object.freeze({ installed: '2.1.330', latest: '2.1.332' }),
  codex: Object.freeze({ installed: '0.169.0', latest: '0.170.1' }),
  opencode: Object.freeze({ installed: '2.3.0', latest: '2.3.0' }),
  cloudflared: Object.freeze({ installed: '2026.10.1', latest: '2026.10.1' }),
});

/** The pretend gateway add-on, once "installed". */
export const GATEWAY = '1.0.8';

/** The programs the set-up checks name (Computer → Setup and Health). */
export const KITS = Object.freeze({
  git: '2.47.1',
  ripgrep: '14.1.1',
  node: '22.12.0',
  python: '3.13.1',
  uv: Object.freeze({ installed: '0.4.2', latest: '0.6.1' }),
  gh: '2.63.0',
});

/** Whether `latest` is newer than `installed` (plain x.y.z). */
export function newer(latest, installed) {
  const a = String(latest || '').split('.').map(Number);
  const b = String(installed || '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}
