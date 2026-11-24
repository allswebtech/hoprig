// The dashboard's own icons (web/icons.js), drawn as inline SVG at build time, so the site and the product share one
// set. Read from the product's file at every build: a new icon there is one here.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), '..');
let paths: Record<string, string[]> | null = null;

function load(): Record<string, string[]> {
  if (paths) return paths;
  const src = fs.readFileSync(path.join(ROOT, 'web/icons.js'), 'utf8');
  const map: Record<string, string[]> = {};
  for (const m of src.matchAll(/^\s{2}(\w+): \[(.*)\],$/gm)) map[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  // Drawn for the site only: the phone menu.
  map.menu = ['M4 7h16', 'M4 12h16', 'M4 17h16'];
  paths = map;
  return map;
}

export function Icon({ name, className }: { name: string; className?: string }) {
  const d = load()[name];
  if (!d) throw new Error(`no icon "${name}" in web/icons.js`);
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {d.map((p) => <path key={p} d={p} />)}
    </svg>
  );
}

/** The product's mark (assets/logo-mark.svg), decorative: the link around it carries the name. */
export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false" className="logo">
      <rect width="64" height="64" rx="15" fill="#4f46e5" />
      <path d="M32 32C28 26 25.2 23 21 23a9 9 0 0 0 0 18c4.2 0 7-3 11-9" fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
      <path d="M32 32c4 6 6.8 9 11 9a9 9 0 0 0 0-18c-4.2 0-7 3-11 9" fill="none" stroke="#a5f3d0" strokeWidth="6" strokeLinecap="round" />
      <circle cx="32" cy="32" r="4" fill="#ffffff" />
    </svg>
  );
}
