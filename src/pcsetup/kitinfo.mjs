// What a kit that installs into the workspace's development/ folder says before the one yes, in one shape for
// `pc setup`, /api/pcsetup/kits and the page: what it downloads (in words, with the vendor's host), about how big
// (download and on disk, from the kit's data), what it changes (the folder, a link, the shell lines), what was found
// (its path with ~) and the owner's own steps (a command to type, never run by Hoprig).
import { askingInstall, kitById, stepLine } from './kits.mjs';
import { sdkManagerAt } from './devplaces.mjs';
import { blockLine, shellValue } from '../setup/localbin.mjs';
import { showCommand } from '../setup/system.mjs';

const about = (n) => (n >= 1e9 ? `about ${Math.round(n / 1e8) / 10} GB` : `about ${Math.round(n / 1e6)} MB`);

// The programs Flutter's Linux page names (https://docs.flutter.dev/install/manual, read 24 Nov 2026), by the command
// that shows each is here, and Debian's package for it. libglu1-mesa has no command: its library file is looked for.
const FLUTTER_NEEDS = [['curl', 'curl'], ['git', 'git'], ['unzip', 'unzip'], ['xz', 'xz-utils'], ['zip', 'zip']];
const GLU = ['/usr/lib/x86_64-linux-gnu/libGLU.so.1', '/usr/lib/aarch64-linux-gnu/libGLU.so.1', '/usr/lib64/libGLU.so.1', '/usr/lib/libGLU.so.1'];

/**
 * The owner's own steps of the chosen kits: [{ kit (its title), text, command? }]. Shown, never run: a kit never asks
 * for administrator rights by itself.
 */
export function yourSteps(chosen, found, sys) {
  const out = [];
  if (chosen.includes('flutter') && sys.platform === 'linux') {
    const r = (found.flutter || []).find((x) => x.id === 'flutter') || {};
    const lack = FLUTTER_NEEDS.filter(([bin]) => !sys.has(bin)).map(([, pkg]) => pkg);
    if (!GLU.some((f) => sys.exists(f))) lack.push('libglu1-mesa');
    if (lack.length && r.state !== 'na') {
      const cmd = sys.pm === 'apt' ? askingInstall(sys, lack) : null;
      out.push({
        kit: kitById('flutter').title,
        text: `Flutter needs ${lack.join(', ')} (Flutter's own list for Linux)${cmd ? ': install them yourself; this asks before it changes anything' : `: install them with your package manager (these are Debian's names)`}`,
        ...(cmd ? { command: showCommand(cmd) } : {}),
      });
    }
  }
  if (chosen.includes('android') && sys.platform !== 'win32') {
    const r = (found.android || []).find((x) => x.id === 'android-sdk') || {};
    // The SDK folder the commands work on: the one found, or the place the kit puts it.
    if (r.sdk && r.state !== 'na' && (r.state === 'ok' || !r.hold)) {
      // A path as the owner pastes it: "$HOME/…" in double quotes (a home with a space stays one word; a ~ after "="
      // is not expanded), else in single quotes.
      const q = (p) => {
        const v = shellValue(p, sys.home);
        return v !== null ? `"${v}"` : `'${p.replace(/'/g, `'\\''`)}'`;
      };
      const sdk = r.sdk;
      const title = kitById('android').title;
      // The sdkmanager the commands name: the one the kit puts there, or the one an SDK found here has (the older
      // tools/bin layout too). An SDK found without any is said so, with no command that names a missing program.
      const at = r.state === 'ok' ? [sdkManagerAt(sdk), `${sdk}/tools/bin/sdkmanager`].find((f) => sys.exists(f)) : sdkManagerAt(sdk);
      if (!at) {
        out.push({ kit: title, text: 'This Android SDK has no sdkmanager, so its licence and packages cannot be handled from a terminal: add the command-line tools to it with Android Studio\'s SDK Manager' });
        return out;
      }
      const mgr = q(at);
      const root = `--sdk_root=${q(sdk)}`;
      // Google's licence is the owner's to read and accept: Hoprig never answers it for him.
      if (!sys.exists(`${sdk}/licenses/android-sdk-license`)) {
        out.push({ kit: title, text: 'Google\'s licence for the Android SDK is yours to read and accept: Hoprig never accepts it for you. Type this in a new terminal, read each licence, and answer it (sdkmanager needs Java: Android Studio\'s own, or a JDK)', command: `${mgr} ${root} --licenses` });
      }
      if (!sys.exists(`${sdk}/platform-tools/adb`)) {
        out.push({ kit: title, text: 'The SDK\'s packages are yours to choose: platform-tools first, then the platform and build tools your app names (sdkmanager --list shows them)', command: `${mgr} ${root} --install platform-tools` });
      }
    }
  }
  return out;
}

/**
 * One kit's development/ facts for the page and the API: { downloads, size, changes, found, yours } — empty lists for a
 * kit that has none. `plan` is buildPlan([kit.id], …) on this computer.
 */
export function kitInfo(kit, found, sys, plan) {
  const t = (p) => (sys.home && (p === sys.home || p.startsWith(`${sys.home}/`)) ? `~${p.slice(sys.home.length)}` : p);
  const steps = plan.steps.filter((s) => s.kit === kit.id && !s.argv);
  const downloads = steps.filter((s) => s.download).map((s) => ({ what: s.download.what, host: s.download.host, list: s.download.list, checksum: s.download.checksum, text: `${s.download.what}, from ${s.download.host} over https (checked against its ${s.download.checksum})` }));
  const sized = steps.filter((s) => s.download);
  const size = sized.length
    ? { download: sized.reduce((n, s) => n + s.download.download, 0), disk: sized.reduce((n, s) => n + s.download.disk, 0) }
    : null;
  if (size) size.text = `${about(size.download)} to download, ${about(size.disk)} on disk`;
  const changes = [];
  for (const s of steps) {
    if (s.do === 'flutter' || s.do === 'android-sdk') changes.push(`a new folder ${t(s.place)}`);
    else if (s.do === 'link') changes.push(`${t(s.place)} becomes a link to ${t(s.from)} (nothing of it is moved, copied or changed)`);
    else if (s.do === 'shell') changes.push(`these lines in the hoprig kits block of your shell start files: ${s.lines.map((l) => blockLine(l)).join('; ')}`);
  }
  const foundAt = (found[kit.id] || []).filter((r) => r.found).map((r) => ({ name: r.name, where: r.found, version: r.version || null, text: r.detail }));
  const yours = yourSteps([kit.id], found, sys);
  return { downloads, size, changes, found: foundAt, yours, steps: steps.map((s) => stepLine(s, showCommand)) };
}

