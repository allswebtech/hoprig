// The YAML front matter of a SKILL.md, read without a YAML library: only what skills really use (scalars, quoted
// strings, folded/literal blocks, plain multi-line values and one level of nested keys such as `metadata:`).
// Anything it does not understand is kept as raw text, never evaluated.

const unquote = (v) => {
  const s = v.trim();
  if (s.length >= 2 && s[0] === '"' && s.at(-1) === '"') {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.length >= 2 && s[0] === "'" && s.at(-1) === "'") return s.slice(1, -1).replace(/''/g, "'");
  return s;
};

/**
 * Split a SKILL.md into { ok, data, body, raw }. `ok` is false when the file does not start with a `---` line
 * (Claude Code then ignores the front matter). `data` holds top-level keys: strings, or objects for nested keys.
 */
export function parseFrontMatter(text) {
  const src = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  if (lines[0].trim() !== '---') return { ok: false, data: {}, body: src, raw: '' };
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) return { ok: false, data: {}, body: src, raw: '' };
  const fm = lines.slice(1, end);
  const data = {};
  let i = 0;
  const indented = (l) => l === '' || /^\s/.test(l);
  while (i < fm.length) {
    const m = /^([A-Za-z0-9_.-]+):(?:\s(.*)|)$/.exec(fm[i]);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const rest = (m[2] || '').trim();
    i++;
    const block = [];
    while (i < fm.length && indented(fm[i])) block.push(fm[i++]);
    while (block.length && block.at(-1).trim() === '') block.pop();
    if (/^[>|][+-]?$/.test(rest)) {
      const pad = Math.min(...block.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length), 99);
      const body = block.map((l) => l.slice(pad));
      data[key] = rest[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ').trim();
    } else if (rest === '' && block.length && block.every((l) => l.trim() === '' || /^\s+[A-Za-z0-9_.-]+:(\s|$)/.test(l) || /^\s{4,}/.test(l))) {
      // A nested map (one level is enough for `metadata:`).
      const obj = {};
      for (const l of block) {
        const n = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(l);
        if (n) obj[n[1]] = unquote(n[2]);
      }
      data[key] = obj;
    } else if (rest === '' && block.length) {
      data[key] = block.map((l) => l.trim()).join(' ').trim();
    } else {
      data[key] = unquote([rest, ...block.map((l) => l.trim())].join(' ').trim());
    }
  }
  return { ok: true, data, body: lines.slice(end + 1).join('\n'), raw: fm.join('\n') };
}

/** The first sentence-ish line of a description, for one-line listings. */
export function oneLine(text, max = 140) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A license name from a license file's text (the common ones), else ''. */
export function guessLicense(text) {
  const t = String(text || '');
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name|names of its\s+contributors/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return /Version 3/i.test(t) ? 'GPL-3.0' : 'GPL';
  if (/Mozilla Public License,? v(ersion)?\.? ?2\.0/i.test(t)) return 'MPL-2.0';
  if (/Permission to use, copy, modify, and\/or distribute this software/i.test(t)) return 'ISC';
  return '';
}
