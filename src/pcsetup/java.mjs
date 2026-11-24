// Java: Hoprig has no kit for it and never installs one. It looks for a Java that is here already and says where it
// is and which version it is. Android Studio carries its own (its `jbr` folder), which is often the only one on a
// computer used for Android or Flutter work. Nothing here changes PATH, JAVA_HOME or a shell start file: where a tool
// wants JAVA_HOME, the line to add is shown.
//
// The order (the first one that RUNS counts; one that is found but does not run is named, and the search goes on):
//   1. JAVA_HOME
//   2. java on PATH
//   3. Android Studio's jbr. Linux: ~/android-studio, /opt/android-studio, /usr/local/android-studio, the snap
//      (/snap/android-studio/current/jbr), JetBrains Toolbox (~/.local/share/JetBrains/Toolbox/apps/android-studio*, and the older
//      apps/AndroidStudio/ch-<n>/<build>),
//      and an android-studio folder beside the Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT or ~/Android/Sdk).
//      macOS: /Applications/Android Studio.app/Contents/jbr/Contents/Home and the same under ~/Applications.
//   4. a system JDK: /usr/lib/jvm/* (Linux), /Library/Java/JavaVirtualMachines/*/Contents/Home (macOS).
// Windows is not covered, and says so.
import path from 'node:path';

const listOf = (sys, dir) => (typeof sys.list === 'function' ? sys.list(dir) : []);

/** "openjdk version \"25.0.4\" 2026-07-15" (java -version prints on stderr) → "25.0.4"; "1.8.0_402" → "1.8.0_402". */
export function javaVersion(text) {
  const t = String(text || '');
  const m = /version "([^"]+)"/.exec(t) || /\b(?:openjdk|java)\s+(\d+(?:\.\d+)*(?:_\d+)?)/i.exec(t);
  return m ? m[1] : null;
}

/** A path for people: the home folder as "~". */
const tilde = (p, home) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);

/** A path in a shell line: the home folder as $HOME (the same line everywhere, with no user name in it). */
const homeVar = (p, home) => (home && p.startsWith(`${home}/`) ? `$HOME${p.slice(home.length)}` : p);

/** When and where the JAVA_HOME line goes, in words: the file is named (a Mac's shell is zsh, Linux's is bash). */
const fileFor = (sys) => (sys.platform === 'darwin' ? '~/.zshrc' : '~/.bashrc (or ~/.zshrc if you use zsh)');
const hintFor = (sys, replace = false) => (replace
  ? `Your JAVA_HOME points at a Java that does not work: replace your JAVA_HOME line in ${fileFor(sys)} with this one, then open a new terminal:`
  : `Only if a build says JAVA_HOME is not set: add this line to ${fileFor(sys)}, then open a new terminal:`);
/** A stale JAVA_HOME beside a Java on PATH whose home cannot be told: the line is to go, not to be replaced. */
const removeHint = (sys) => `Your JAVA_HOME points at a Java that does not work: remove your JAVA_HOME line from ${fileFor(sys)}, then open a new terminal (the Java on your PATH is then used).`;

/** The JAVA_HOME advice as one line of text (pc setup, pc status): "" when there is none. */
export const javaHomeText = (j) => (j && j.javaHome ? `${j.javaHomeHint} ${j.javaHome}` : (j && j.javaHomeHint) || '');

/**
 * The home folder of the java on PATH, so that the line shown names the Java that was found: its link followed to the
 * end, without /bin/java (/usr/bin/java → /usr/lib/jvm/<jdk>/bin/java → /usr/lib/jvm/<jdk>; Homebrew's
 * /opt/homebrew/bin/java → …/openjdk.jdk/Contents/Home/bin/java). Only Apple's own /usr/bin/java on a Mac, which is no
 * link but a stand-in that runs the JDK /usr/libexec/java_home names, is asked about through java_home. null when it
 * cannot be told: no link to follow, or a folder that is no Java home (every JDK and JRE image has a `release` file at
 * its top; /usr or a ~/bin with a wrapper script in it has none).
 */
async function pathHome(sys, bin) {
  const real = typeof sys.realpath === 'function' && bin.startsWith('/') ? sys.realpath(bin) : null;
  if (real && real.endsWith('/bin/java')) {
    const home = path.dirname(path.dirname(real));
    if (sys.exists(path.join(home, 'release'))) return home;
  }
  if (sys.platform === 'darwin' && (real || bin) === '/usr/bin/java') {
    const r = await sys.run(['/usr/libexec/java_home']);
    const h = r.ok ? String(r.stdout || '').trim() : '';
    if (h.startsWith('/')) return h;
  }
  return null;
}

/** The places to look, in order: [{ home (a Java home folder, or null for PATH), from (words) }]. */
export function javaPlaces(sys) {
  const env = sys.env || {};
  const home = sys.home;
  const out = [];
  if (env.JAVA_HOME) out.push({ home: env.JAVA_HOME, from: 'JAVA_HOME' });
  out.push({ home: null, from: 'your PATH' });
  const studio = (dir) => out.push({ home: path.join(dir, 'jbr'), from: 'Android Studio' });
  if (sys.platform === 'darwin') {
    for (const apps of ['/Applications', path.join(home, 'Applications')]) out.push({ home: path.join(apps, 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'), from: 'Android Studio' });
    const jvms = '/Library/Java/JavaVirtualMachines';
    for (const n of listOf(sys, jvms).sort().reverse()) out.push({ home: path.join(jvms, n, 'Contents', 'Home'), from: 'a JDK of the system' });
    return out;
  }
  for (const d of [path.join(home, 'android-studio'), '/opt/android-studio', '/usr/local/android-studio', '/snap/android-studio/current']) studio(d);
  const toolbox = path.join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'apps');
  for (const n of listOf(sys, toolbox).filter((x) => /^android-studio/i.test(x)).sort()) studio(path.join(toolbox, n));
  // Toolbox 1.x: apps/AndroidStudio/ch-<n>/<build>/, the newest build first.
  const byNumbers = (a, b) => b.localeCompare(a, 'en', { numeric: true });
  for (const n of listOf(sys, toolbox).filter((x) => /^AndroidStudio/i.test(x))) {
    for (const ch of listOf(sys, path.join(toolbox, n)).filter((x) => /^ch-\d+$/.test(x)).sort(byNumbers)) {
      for (const b of listOf(sys, path.join(toolbox, n, ch)).filter((x) => /^\d/.test(x)).sort(byNumbers)) studio(path.join(toolbox, n, ch, b));
    }
  }
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(home, 'Android', 'Sdk')].filter(Boolean);
  for (const sdk of [...new Set(sdks)]) studio(path.join(path.dirname(sdk), 'android-studio'));
  const jvm = '/usr/lib/jvm';
  for (const n of listOf(sys, jvm).filter((x) => !x.startsWith('.') && !/^default/.test(x)).sort().reverse()) out.push({ home: path.join(jvm, n), from: 'a JDK of the system' });
  // The same folder reached twice (ANDROID_HOME beside ~/android-studio) is looked at once.
  const seen = new Set();
  return out.filter((p) => (p.home === null ? true : !seen.has(p.home) && seen.add(p.home)));
}

/**
 * Look for a Java. → { state: 'ok' | 'missing' | 'na', version, place, from, broken: [{ place, why }], text, javaHome }
 * `text` is the one line Setup and `pc status` show; `javaHome` the line to add where a tool wants JAVA_HOME (null when
 * the Java found is the one JAVA_HOME names, or nothing was found), and `javaHomeHint` the sentence before it;
 * `staleJavaHome` when JAVA_HOME is set but names no Java that works (a tool that reads it keeps failing).
 */
export async function findJava(sys) {
  if (sys.platform === 'win32') return { state: 'na', version: null, place: null, from: null, broken: [], javaHome: null, text: 'Java is not looked for on Windows: Hoprig does not cover it there.' };
  const broken = [];
  const said = []; // the broken ones in words, for when nothing works
  for (const p of javaPlaces(sys)) {
    const bin = p.home ? path.join(p.home, 'bin', 'java') : sys.has('java') ? (typeof sys.which === 'function' && sys.which('java')) || 'java' : null;
    if (!bin) continue;
    // macOS: /usr/bin/java is Apple's stand-in, there on every Mac; without a JDK it only says "Unable to locate a Java
    // Runtime" (and may open Apple's install window). It is run only when java_home names a JDK, and never named as broken.
    if (sys.platform === 'darwin' && !p.home && bin === '/usr/bin/java' && !(await sys.run(['/usr/libexec/java_home'])).ok) continue;
    if (p.home && !sys.exists(bin)) {
      if (p.from === 'JAVA_HOME') {
        broken.push({ place: tilde(p.home, sys.home), why: sys.exists(p.home) ? 'it has no bin/java' : 'that folder is not there' });
        said.push(`Your JAVA_HOME (${tilde(p.home, sys.home)}) ${sys.exists(p.home) ? 'has no bin/java' : 'names a folder that is not there'}.`);
      }
      continue;
    }
    const r = await sys.run([bin, '-version']);
    const version = r.ok ? javaVersion(`${r.stderr || ''}\n${r.stdout || ''}`) : null;
    if (!version) {
      const place = tilde(p.home || bin, sys.home);
      broken.push({ place, why: r.ok ? 'it did not say its version' : 'it did not run' });
      const did = r.ok ? 'did not say its version' : 'did not run';
      said.push(p.from === 'Android Studio' ? `The Java in Android Studio (${place}) ${did}: open Android Studio once, or reinstall it.` : p.from === 'JAVA_HOME' ? `The Java your JAVA_HOME names (${place}) ${did}.` : `The Java at ${place} ${did}.`);
      continue;
    }
    const where = tilde(p.home || bin, sys.home);
    // The line is shown whenever the Java found is not the one JAVA_HOME names: also when JAVA_HOME is set but points at
    // nothing that runs (a tool that reads it, Gradle or Flutter's Android build, keeps failing until it is replaced).
    const set = (sys.env || {}).JAVA_HOME;
    // Found on PATH while JAVA_HOME is set and broken: its home is told from where the java link leads; where it
    // cannot be, the JAVA_HOME line is to be removed (Gradle then uses the java on PATH).
    const home = p.home || (set && p.from === 'your PATH' ? await pathHome(sys, bin) : null);
    const javaHome = home && p.from !== 'JAVA_HOME' ? `export JAVA_HOME="${homeVar(home, sys.home)}"` : null;
    const javaHomeHint = javaHome ? hintFor(sys, Boolean(set)) : set && p.from === 'your PATH' ? removeHint(sys) : null;
    // JAVA_HOME is looked at first: set, and a Java found elsewhere, means the one it names does not work.
    const staleJavaHome = Boolean(set) && p.from !== 'JAVA_HOME';
    return { state: 'ok', version, place: where, from: p.from, broken, javaHome, javaHomeHint, staleJavaHome, text: `Java ${version}, found ${p.from === 'your PATH' ? 'on your PATH' : p.from === 'JAVA_HOME' ? 'through JAVA_HOME' : `in ${p.from}`} (${where})` };
  }
  // Found but not working: said as such, never as "no Java found" (that is for when nothing was there at all).
  const text = said.length ? `No working Java. ${said.join(' ')}` : 'No Java found. Android Studio brings its own; Hoprig does not install Java.';
  return { state: 'missing', version: null, place: null, from: null, broken, javaHome: null, javaHomeHint: null, text };
}

/** What a broken find says beside a Java that works, in one sentence ("" when nothing was broken, or nothing works:
 * then `text` says it). */
export const brokenText = (j) => (j.state === 'ok' && j.broken.length ? `Found but not working: ${j.broken.map((b) => `${b.place} (${b.why})`).join('; ')}.` : '');
