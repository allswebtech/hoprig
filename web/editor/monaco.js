// Monaco (VS Code's editor core) for the editor page: loaded once, from this dashboard's own files (never through
// another computer: /vendor/monaco.json and the files it names are always this dashboard's), with its workers started
// from same-origin files (the page's content security policy allows no blob: workers). The editor's colours follow
// the page's light or dark theme, also when it changes while the editor is open. The three settings of Settings →
// Editor are kept per browser.
import { add, api, h, prefs } from '../lib.js';

/** The per-browser settings, with their defaults (a phone gets smaller text and wrapped lines). */
const phone = () => typeof innerWidth === 'number' && innerWidth < 700;
export const editorPrefs = () => ({
  fontSize: prefs.get('editor.font', phone() ? 13 : 14),
  tabSize: prefs.get('editor.tab', 2),
  wordWrap: prefs.get('editor.wrap', phone()),
  plain: prefs.get('editor.plain', false),
});
export const PREFS_EVENT = 'editor-prefs';
/** Keep one setting and tell an open editor. */
export function setEditorPref(key, value) {
  prefs.set(`editor.${key}`, value);
  window.dispatchEvent(new Event(PREFS_EVENT));
}

/** Which worker file a language needs (the five Monaco ships). */
export function workerFor(label) {
  if (label === 'json') return 'json';
  if (['css', 'scss', 'less'].includes(label)) return 'css';
  if (['html', 'handlebars', 'razor'].includes(label)) return 'html';
  if (['typescript', 'javascript'].includes(label)) return 'ts';
  return 'editor';
}

let loading = null;
/** Monaco's API object, loaded on first use. Rejects with a plain message when it cannot load. */
export function loadMonaco() {
  if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);
  if (loading) return loading;
  loading = (async () => {
    let m;
    try {
      m = await api('~/vendor/monaco.json');
    } catch (e) {
      throw new Error(e.status === 404 ? 'The code editor is not installed with this dashboard.' : e.message);
    }
    await new Promise((resolve, reject) => {
      add(document.head, h('script', { src: `${m.base}loader.js`, onload: resolve, onerror: () => reject(new Error('The code editor could not be loaded.')) }));
    });
    window.require.config({ paths: { vs: m.base.replace(/\/$/, '') } });
    const monaco = await new Promise((resolve, reject) => window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (e) => reject(new Error(`The code editor could not be loaded: ${e.message || e}`))));
    // After editor.main: it sets its own environment when it loads, whose workers start from blob: URLs, which the
    // page's content security policy refuses. These start from the same files on this dashboard instead.
    self.MonacoEnvironment = { getWorker: (_id, label) => new Worker(m.workers[workerFor(label)] || m.workers.editor, { name: label }) };
    defineThemes(monaco);
    // The TypeScript worker sees one file at a time, not the project, so every import would show as an error. Syntax
    // errors stay; type errors are the project's own checker's job.
    const ts = monaco.typescript || {};
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) if (d) d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
    return monaco;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

// ---------- colours ----------

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
/** The page's theme now: the choice in Settings → Appearance, or the system's. */
export const pageDark = () => (document.documentElement.dataset.theme || (darkQuery && darkQuery.matches ? 'dark' : 'light')) === 'dark';

// The page's own tokens (style.css) as the editor's background, so the editor sits in the page, not on it.
const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function defineThemes(monaco) {
  const colors = () => ({
    'editor.background': token('--surface') || (pageDark() ? '#151827' : '#ffffff'),
    'editorGutter.background': token('--surface') || (pageDark() ? '#151827' : '#ffffff'),
    'editorWidget.background': token('--surface-2') || (pageDark() ? '#191d30' : '#fbfbfe'),
    'editorLineNumber.foreground': token('--muted') || (pageDark() ? '#9aa0b5' : '#5b6172'),
  });
  // Defined again on every change: the page's tokens are what the page shows now.
  defineThemes.apply = () => {
    const dark = pageDark();
    monaco.editor.defineTheme('page', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [], colors: colors() });
    monaco.editor.setTheme('page');
  };
  defineThemes.apply();
}

/** Follow the page's theme (Settings, the light/dark button and the system all change it); returns the stop. */
export function followTheme(onChange = () => {}) {
  const apply = () => {
    if (defineThemes.apply) defineThemes.apply();
    onChange(pageDark());
  };
  const obs = new MutationObserver(apply);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  darkQuery && darkQuery.addEventListener('change', apply);
  return () => {
    obs.disconnect();
    darkQuery && darkQuery.removeEventListener('change', apply);
  };
}

/** The language Monaco knows for a file name ('plaintext' when none). */
export function languageOf(monaco, path) {
  const name = path.split('/').pop().toLowerCase();
  for (const l of monaco.languages.getLanguages()) {
    if ((l.filenames || []).some((f) => f.toLowerCase() === name)) return l.id;
  }
  for (const l of monaco.languages.getLanguages()) {
    if ((l.extensions || []).some((x) => name.endsWith(x.toLowerCase()))) return l.id;
  }
  return 'plaintext';
}

/** "TypeScript" for 'typescript': the name Monaco gives a language. */
export function languageName(monaco, id) {
  const l = monaco && monaco.languages.getLanguages().find((x) => x.id === id);
  return (l && l.aliases && l.aliases[0]) || (id === 'plaintext' ? 'Plain text' : id);
}
