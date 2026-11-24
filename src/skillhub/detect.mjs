// What a project is made of, read from its manifest files only (no AI, nothing run): the dependencies per
// ecosystem, the stacks they imply (web app, mobile, Docker, CI, …), and app artefacts lying around (APK, IPA,
// Electron archives). Each fact keeps its evidence ("code/web/package.json has next ^16.0.1") so a suggestion can
// say why it was made. A project with a `code/` folder of several repositories is read repository by repository.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.dart_tool', '.venv', 'venv', '__pycache__', 'target', 'vendor', 'Pods', '.gradle', '.idea', '.vscode', 'coverage', '.turbo', '.cache', 'no-ai', 'test-data']);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20000;

export const STACKS = ['code', 'web', 'web-ui', 'server', 'mobile', 'flutter', 'react-native', 'electron', 'docker', 'ci', 'postgres', 'mcp', 'multi-repo', 'node', 'python', 'go', 'rust', 'dart'];
export const ARTIFACTS = ['apk', 'aab', 'ipa', 'asar', 'desktop'];
export const ECOSYSTEMS = ['npm', 'pub', 'pypi', 'go', 'cargo'];

const UI_DEPS = { npm: ['next', 'react-dom', 'vue', 'svelte', '@sveltejs/kit', 'nuxt', 'astro', '@angular/core', 'vite', 'solid-js', '@remix-run/react', 'preact'] };
const SERVER_DEPS = {
  npm: ['next', 'express', 'fastify', 'hono', 'koa', '@nestjs/core', '@remix-run/node', 'nuxt', '@sveltejs/kit', 'astro'],
  pypi: ['django', 'flask', 'fastapi', 'starlette', 'aiohttp', 'tornado'],
  go: ['github.com/gin-gonic/gin', 'github.com/labstack/echo/v4', 'github.com/gofiber/fiber/v2', 'github.com/go-chi/chi/v5', 'github.com/gorilla/mux'],
  cargo: ['axum', 'actix-web', 'rocket', 'warp'],
};
const POSTGRES_DEPS = { npm: ['pg', 'postgres', '@supabase/supabase-js', '@neondatabase/serverless', 'drizzle-orm', 'pg-promise'], pypi: ['psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'], go: ['github.com/jackc/pgx/v5', 'github.com/lib/pq'], cargo: ['sqlx', 'tokio-postgres', 'diesel'], pub: ['postgres', 'supabase_flutter'] };
const MCP_DEPS = { npm: ['@modelcontextprotocol/sdk'], pypi: ['mcp', 'fastmcp'] };
const ARTIFACT_EXT = { '.apk': 'apk', '.aab': 'aab', '.xapk': 'apk', '.ipa': 'ipa', '.asar': 'asar', '.dmg': 'desktop', '.msi': 'desktop', '.exe': 'desktop', '.appimage': 'desktop' };

const read = (f, max = 512 * 1024) => {
  try {
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > max) return null;
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

/** Dependencies of a package.json: { name: version }. */
export function npmDeps(text) {
  try {
    const j = JSON.parse(text);
    return { ...j.peerDependencies, ...j.optionalDependencies, ...j.devDependencies, ...j.dependencies };
  } catch {
    return {};
  }
}

/** Dependencies of a pubspec.yaml: { name: version or "sdk: flutter" }; the Flutter SDK shows up as "flutter". */
export function pubDeps(text) {
  const out = {};
  let section = null;
  let last = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (top) {
      section = ['dependencies', 'dev_dependencies', 'dependency_overrides'].includes(top[1]) ? top[1] : null;
      last = null;
      if (top[1] === 'flutter' && !section) out.__flutterSection = true;
      continue;
    }
    if (!section) continue;
    const dep = /^ {2}([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (dep) {
      last = dep[1];
      out[last] = dep[2].replace(/^["']|["']$/g, '') || '';
      continue;
    }
    const sdk = /^ {4,}sdk:\s*(\w+)/.exec(line);
    if (sdk && last) out[last] = `sdk: ${sdk[1]}`;
  }
  delete out.__flutterSection;
  return out;
}

/** Dependencies of requirements*.txt: { name: spec }. */
export function requirementsDeps(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase().replace(/_/g, '-')] = m[3].trim();
  }
  return out;
}

/** Dependencies of a pyproject.toml ([project] dependencies and Poetry's table): { name: spec }. */
export function pyprojectDeps(text) {
  const out = {};
  const src = String(text);
  for (const m of src.matchAll(/^\s*(?:dependencies|requires|dev-dependencies)\s*=\s*\[([\s\S]*?)\]/gm)) {
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) Object.assign(out, requirementsDeps(s[1]));
  }
  let inPoetry = false;
  for (const line of src.split(/\r?\n/)) {
    const sec = /^\s*\[([^\]]+)\]/.exec(line);
    if (sec) {
      inPoetry = /^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.test(sec[1].trim());
      continue;
    }
    const kv = inPoetry && /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.*)$/.exec(line);
    if (kv && kv[1] !== 'python') out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Modules required by a go.mod: { path: version }. */
export function goDeps(text) {
  const out = {};
  let block = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (/^require\s*\($/.test(line)) block = true;
    else if (block && line === ')') block = false;
    else {
      const m = (block ? /^(\S+)\s+(\S+)/ : /^require\s+(\S+)\s+(\S+)/).exec(line);
      if (m) out[m[1]] = m[2];
    }
  }
  return out;
}

/** Crates in a Cargo.toml's dependency tables: { name: version }. */
export function cargoDeps(text) {
  const out = {};
  let inDeps = false;
  for (const line of String(text).split(/\r?\n/)) {
    const sec = /^\s*\[([^\]]+)\]/.exec(line);
    if (sec) {
      const s = sec[1].trim();
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(s);
      const one = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(s);
      if (one) out[one[1]] = '';
      continue;
    }
    const kv = inDeps && /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = (/^"([^"]*)"/.exec(kv[2]) || /version\s*=\s*"([^"]*)"/.exec(kv[2]) || [, ''])[1];
  }
  return out;
}

const MANIFESTS = {
  'package.json': ['npm', npmDeps, 'node'],
  'pubspec.yaml': ['pub', pubDeps, 'dart'],
  'pyproject.toml': ['pypi', pyprojectDeps, 'python'],
  'go.mod': ['go', goDeps, 'go'],
  'Cargo.toml': ['cargo', cargoDeps, 'rust'],
};

/**
 * Read the project at `dir`: { root, deps: { npm: { name: { version, where } } … }, stacks: { stack: evidence },
 * artifacts: { kind: [files] }, files: { name: [where] }, repos: [relative dirs] }.
 */
export function detectProject(dir) {
  const root = fs.realpathSync(dir);
  const deps = Object.fromEntries(ECOSYSTEMS.map((e) => [e, {}]));
  const stacks = {};
  const artifacts = {};
  const files = {};
  const repos = new Set();
  let seen = 0;
  const stack = (s, why) => {
    if (!stacks[s]) stacks[s] = why;
  };
  const addDeps = (eco, map, where) => {
    for (const [name, version] of Object.entries(map)) if (!deps[eco][name]) deps[eco][name] = { version: String(version || ''), where };
  };
  const walk = (abs, rel, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) repos.add(rel || '.');
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        if (e.name.endsWith('.xcodeproj')) {
          (files.xcodeproj ||= []).push(r);
          continue;
        }
        if (depth < MAX_DEPTH) walk(full, r, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const lower = e.name.toLowerCase();
      if (MANIFESTS[e.name]) {
        const [eco, parse, lang] = MANIFESTS[e.name];
        const text = read(full);
        if (text !== null) {
          addDeps(eco, parse(text), r);
          stack(lang, `${r} found`);
          stack('code', `${r} found`);
        }
      } else if (/^requirements([-_.][\w.-]*)?\.txt$/i.test(e.name)) {
        const text = read(full);
        if (text !== null) {
          addDeps('pypi', requirementsDeps(text), r);
          stack('python', `${r} found`);
          stack('code', `${r} found`);
        }
      } else if (/^(Dockerfile|Containerfile)(\..+)?$|\.dockerfile$/i.test(e.name) || /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(e.name)) {
        (files.docker ||= []).push(r);
        stack('docker', `${r} found`);
      } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(r) || /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(r) || e.name === '.gitlab-ci.yml' || r === '.circleci/config.yml' || e.name === 'Jenkinsfile' || e.name === 'bitbucket-pipelines.yml') {
        (files.ci ||= []).push(r);
        stack('ci', `${r} found`);
      } else if (r === 'docs/brief.md') {
        (files.brief ||= []).push(r); // a project's brief (hoprig project new --brief): the new-project skill's signal
      } else if (/^build\.gradle(\.kts)?$/.test(e.name) && /(^|\/)android(\/app)?$/.test(rel)) {
        stack('mobile', `${r} found (Android app)`);
      } else if (e.name === 'Podfile' && /(^|\/)ios$/.test(rel)) {
        stack('mobile', `${r} found (iOS app)`);
      } else if (ARTIFACT_EXT[path.extname(lower)] && !(path.extname(lower) === '.exe' && /node_modules|\.venv/.test(r))) {
        (artifacts[ARTIFACT_EXT[path.extname(lower)]] ||= []).push(r);
      }
    }
  };
  walk(root, '', 0);

  const has = (eco, names) => names.find((n) => deps[eco][n]);
  const depWhy = (eco, n) => `${deps[eco][n].where} has ${n}${deps[eco][n].version ? ` ${deps[eco][n].version}` : ''}`;
  for (const [eco, list] of Object.entries(UI_DEPS)) {
    const n = has(eco, list);
    if (n) stack('web-ui', depWhy(eco, n));
  }
  if (deps.npm.react && (deps.npm['react-dom'] || deps.npm.next)) stack('web-ui', depWhy('npm', 'react'));
  for (const [eco, list] of Object.entries(SERVER_DEPS)) {
    const n = has(eco, list);
    if (n) stack('server', depWhy(eco, n));
  }
  if (stacks['web-ui']) stack('web', stacks['web-ui']);
  if (stacks.server) stack('web', stacks.server);
  if (deps.pub.flutter) {
    stack('flutter', depWhy('pub', 'flutter'));
    stack('mobile', depWhy('pub', 'flutter'));
  }
  const rn = has('npm', ['react-native', 'expo']);
  if (rn) {
    stack('react-native', depWhy('npm', rn));
    stack('mobile', depWhy('npm', rn));
  }
  if (deps.npm.electron) stack('electron', depWhy('npm', 'electron'));
  for (const [eco, list] of Object.entries(POSTGRES_DEPS)) {
    const n = has(eco, list);
    if (n) stack('postgres', depWhy(eco, n));
  }
  if (fs.existsSync(path.join(root, 'supabase', 'config.toml'))) stack('postgres', 'supabase/config.toml found');
  if (deps.npm.prisma || deps.npm['@prisma/client']) {
    const schema = read(path.join(root, 'prisma', 'schema.prisma'));
    if (schema && /provider\s*=\s*"postgres(ql)?"/.test(schema)) stack('postgres', 'prisma/schema.prisma uses postgresql');
  }
  for (const [eco, list] of Object.entries(MCP_DEPS)) {
    const n = has(eco, list);
    if (n) stack('mcp', depWhy(eco, n));
  }
  // Several repositories under code/ (one project folder, its code repositories inside).
  const codeRepos = [...repos].filter((r) => /^code\/[^/]+$/.test(r));
  if (codeRepos.length >= 2) stack('multi-repo', `code/ holds ${codeRepos.length} repositories (${codeRepos.map((r) => r.slice(5)).join(', ')})`);
  for (const a of Object.keys(artifacts)) if (a === 'apk' || a === 'aab' || a === 'ipa') stack('mobile', `${artifacts[a][0]} found`);
  return { root, deps, stacks, artifacts, files, repos: [...repos].sort() };
}

/**
 * Does `signal` ("npm:next", "stack:web", "artifact:apk", "file:docker", "always") hold for a detected project? Returns the
 * evidence text, or null.
 */
export function signalEvidence(project, signal) {
  if (signal === 'always') return 'it comes with Hoprig and helps in every project';
  const i = signal.indexOf(':');
  const kind = signal.slice(0, i);
  const value = signal.slice(i + 1);
  if (ECOSYSTEMS.includes(kind)) {
    const d = project.deps[kind][value];
    return d ? `${d.where} has ${value}${d.version ? ` ${d.version}` : ''}` : null;
  }
  if (kind === 'stack') return project.stacks[value] || null;
  if (kind === 'artifact') return project.artifacts[value] ? `${project.artifacts[value][0]} found${project.artifacts[value].length > 1 ? ` (+${project.artifacts[value].length - 1} more)` : ''}` : null;
  if (kind === 'file') return project.files[value] ? `${project.files[value][0]} found` : null;
  return null;
}

/** Is a signal written the way detectProject can answer it? */
export function validSignal(s) {
  if (typeof s !== 'string') return false;
  if (s === 'always') return true;
  const m = /^([a-z]+):(.+)$/.exec(s);
  if (!m) return false;
  if (ECOSYSTEMS.includes(m[1])) return /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/.test(m[2]);
  if (m[1] === 'stack') return STACKS.includes(m[2]);
  if (m[1] === 'artifact') return ARTIFACTS.includes(m[2]);
  if (m[1] === 'file') return ['docker', 'ci', 'xcodeproj', 'brief'].includes(m[2]);
  return false;
}
