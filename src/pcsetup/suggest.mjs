// Which optional kits the projects on this computer would use, and why. A suggestion never ticks a kit: `pc setup`
// takes an optional kit only through --kits, and the Setup tab shows it unticked with its reason.
//   php     composer.json or artisan at a project's root or in one of its code repositories (code/<repo>), or the word
//           PHP, MariaDB or MySQL (a whole word, any case) in its own AGENTS.md or project.json
//   fvm     .fvmrc or .fvm/fvm_config.json (a project that pins a Flutter version)
//   docker  Dockerfile, docker-compose.yml/.yaml, compose.yml/.yaml
// Pure: everything is read through `reader` ({ list(dir) → names, kind(path) → 'dir' | 'file' | 'none', read(path) →
// text | null }). The real reader (optional.mjs) only reads, never follows a link out of the projects folder, and
// reads nothing over the network: no clone, no fetch, and the workspace map is never written.
import path from 'node:path';
import { PRIVATE_DIRS } from './projects.mjs';

export const MAX_PROJECTS = 300;
const MAX_REPOS = 30;
const WORD = /(?<![A-Za-z0-9_])(php|mariadb|mysql)(?![A-Za-z0-9_])/i;
const NICE = { php: 'PHP', mariadb: 'MariaDB', mysql: 'MySQL' };
const FILES = {
  php: ['composer.json', 'artisan'],
  fvm: ['.fvmrc', '.fvm/fvm_config.json'],
  docker: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'],
};

const plainName = (n) => typeof n === 'string' && !n.startsWith('.') && !PRIVATE_DIRS.includes(n);

/** The projects (folders of the projects folder, at most `max`) and their code repositories: [{ project, places: [{ where, dir }] }]. */
export function projectPlaces(projectsDir, reader, { max = MAX_PROJECTS } = {}) {
  const out = [];
  for (const name of reader.list(projectsDir).filter(plainName).sort()) {
    if (out.length >= max) break;
    const dir = path.join(projectsDir, name);
    if (reader.kind(dir) !== 'dir') continue;
    const places = [{ where: '', dir }];
    const code = path.join(dir, 'code');
    if (reader.kind(code) === 'dir') {
      for (const r of reader.list(code).filter(plainName).sort().slice(0, MAX_REPOS)) {
        const d = path.join(code, r);
        if (reader.kind(d) === 'dir') places.push({ where: `code/${r}`, dir: d });
      }
    }
    out.push({ project: name, places });
  }
  return out;
}

/** How many projects past the cap were not read (0 when all were): one kind() per name, nothing inside them is read. */
export function projectsLeftOut(projectsDir, reader, { max = MAX_PROJECTS } = {}) {
  const n = reader.list(projectsDir).filter(plainName).filter((name) => reader.kind(path.join(projectsDir, name)) === 'dir').length;
  return Math.max(0, n - max);
}

/** The one line pc setup, pc status and the Setup tab say when the cap was hit. */
export const leftOutText = (n) => `Only the first ${MAX_PROJECTS} projects (by name) were read for suggestions and PHP versions: ${n} more ${n === 1 ? 'was' : 'were'} not.`;

const said = (project, where) => (where ? `${project} (${where})` : project);

/** [{ kit, project, reason }]: one per kit and project, the first reason found. */
// A project needs Java when it holds a Gradle or Maven build file, at its top or in its `android` folder (an Android
// or Flutter app).
const JAVA_FILES = ['gradlew', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml'];

/** Does a project here need Java (JAVA_FILES)? Read as the kits' suggestions are: by file names only. */
export function javaWanted(projectsDir, reader, opts = {}) {
  for (const { places } of projectPlaces(projectsDir, reader, opts)) {
    for (const { dir } of places) {
      for (const base of [dir, path.join(dir, 'android')]) {
        if (JAVA_FILES.some((rel) => reader.kind(path.join(base, rel)) === 'file')) return true;
      }
    }
  }
  return false;
}

export function suggestKits(projectsDir, reader, opts = {}) {
  const out = [];
  for (const { project, places } of projectPlaces(projectsDir, reader, opts)) {
    for (const kit of Object.keys(FILES)) {
      let reason = null;
      for (const { where, dir } of places) {
        const f = FILES[kit].find((rel) => reader.kind(path.join(dir, rel)) === 'file');
        if (f) {
          reason = `${said(project, where)} has ${f}`;
          break;
        }
      }
      if (!reason && kit === 'php') {
        for (const { where, dir } of places) {
          for (const f of where ? ['AGENTS.md'] : ['AGENTS.md', 'project.json']) {
            const m = WORD.exec(reader.read(path.join(dir, f)) || '');
            if (m) {
              reason = `${said(project, where)}'s ${f} names ${NICE[m[1].toLowerCase()]}`;
              break;
            }
          }
          if (reason) break;
        }
      }
      if (reason) out.push({ kit, project, reason });
    }
  }
  return out;
}

/**
 * What each PHP project asks for: [{ project, where, wants, error? }] for every composer.json that names PHP in its
 * `require` (wants: require.php as it is, text or not), or that cannot be read as JSON (error).
 */
export function phpWishes(projectsDir, reader, opts = {}) {
  const out = [];
  for (const { project, places } of projectPlaces(projectsDir, reader, opts)) {
    for (const { where, dir } of places) {
      const text = reader.kind(path.join(dir, 'composer.json')) === 'file' ? reader.read(path.join(dir, 'composer.json')) : null;
      if (text === null) continue;
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        out.push({ project, where, wants: null, error: 'its composer.json is not valid JSON' });
        continue;
      }
      const req = json && typeof json === 'object' && json.require && typeof json.require === 'object' ? json.require : null;
      if (req && Object.hasOwn(req, 'php')) out.push({ project, where, wants: req.php });
    }
  }
  return out;
}
