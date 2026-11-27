// Settings → Version and updates in the demo: sample versions, and an "update" that only prints a line. Nothing here looks at
// the real computer or asks a server (the demo must never show or change the owner's own installs).
import { ALL_TOOLS, TOOL_IDS } from '../codetools/index.mjs';
import { HOPRIG, TOOLS, newer } from './versions.mjs';

// Each row's versions from versions.mjs, the one place the demo keeps them (Hoprig's is the package's own).
const row = (v, method, extra = {}) => ({ installed: v.installed, latest: v.latest, method, updateAvailable: newer(v.latest, v.installed), canUpdate: true, ...extra });

const say = (id, version) => async ({ onLine = () => {} } = {}) => {
  onLine(`(demo) ${id} would be updated here; nothing is installed in the demo`);
  return { ok: true, version, output: '' };
};

const item = (id, title, whenRunning, info, o = {}) => ({
  id, title, whenRunning, installable: !!o.installable,
  info: async () => info,
  update: say(id, info.latest),
  blocked: () => o.blocked || null,
  autoOk: () => o.autoOk !== false,
});

/** The rows of the page: a coding tool's only while this version offers it (src/codetools/index.mjs). */
export function demoUpdateItems() {
  const shown = (i) => !ALL_TOOLS.some((t) => t.id === i.id) || TOOL_IDS.includes(i.id);
  return [
    item('hoprig', 'Hoprig', 'The new version is used after the dashboard restarts: sessions kept by tmux (a program that keeps terminals running) go on through the restart, sessions in the built-in terminals end then (their conversations can be continued). Hoprig never updates itself: Automatic tells you, and you choose the moment.',
      row({ installed: HOPRIG, latest: HOPRIG }, 'npm')),
    item('claude', 'Claude Code', 'Running sessions keep the version they started with and use the new one when they start again. Automatic updates wait until no Claude Code session is working.',
      row(TOOLS.claude, 'official installer')),
    item('codex', 'Codex', 'Close its sessions first: the update replaces the program\'s files. Automatic updates wait until no Codex session is open.',
      row(TOOLS.codex, "Hoprig's tools folder", { note: `Installs ${TOOLS.codex.installed} at first, the version this Hoprig is tested with.` })),
    item('opencode', 'OpenCode', 'Close its sessions first: the update replaces the program\'s files. Automatic updates wait until no OpenCode session is open.',
      row(TOOLS.opencode, "Hoprig's tools folder")),
    item('cloudflared', 'The helper for the public link (cloudflared)', 'Turn the public link off first: a Temporary link comes back with a new address. Automatic updates wait until the public link is off.',
      row(TOOLS.cloudflared, "Hoprig's add-ons folder")),
  ].filter(shown);
}
