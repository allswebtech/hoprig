// Settings the browser may change, and their validation. Each clean* function returns the value to store or
// throws an Error whose message is shown to the user as is. Nothing from the browser reaches config.json without
// passing one of these.
import fs from 'node:fs';
import path from 'node:path';
import { cleanNotify } from './notify.mjs';
import { uploadsDirName } from './uploads.mjs';

/** The virtual profile of Auto mode: the router inside the launcher picks the account per request. */
export const AUTO = Object.freeze({ name: 'auto', label: 'Auto' });

// A first look keeps to what a newcomer needs; /compact and /model stay one line away in Settings → Quick messages.
export const DEFAULT_QUICK_ACTIONS = [
  { label: 'continue', text: 'continue' },
  { label: '/clear', text: '/clear' },
];

/** server.quickActions: up to 20 chips, each { label ≤ 24, text ≤ 500 }, one line each for the label. */
export function cleanQuickActions(v) {
  if (!Array.isArray(v)) throw new Error('quick actions must be a list');
  if (v.length > 20) throw new Error('at most 20 quick actions');
  return v.map((a, i) => {
    if (!a || typeof a !== 'object') throw new Error(`quick action ${i + 1} is empty`);
    const label = typeof a.label === 'string' ? a.label.trim() : '';
    const text = typeof a.text === 'string' ? a.text.replace(/\r\n?/g, '\n') : '';
    if (!label || label.length > 24 || /[\n\0]/.test(label)) throw new Error(`quick action ${i + 1}: the label must be 1 to 24 characters on one line`);
    if (!text.trim() || text.length > 500 || text.includes('\0')) throw new Error(`quick action "${label}": the text must be 1 to 500 characters`);
    return { label, text };
  });
}

/** server.roots: up to 20 absolute folders that exist. */
export function cleanRoots(v) {
  if (!Array.isArray(v) || !v.length) throw new Error('give at least one folder');
  if (v.length > 20) throw new Error('at most 20 folders');
  const out = [];
  for (const p of v) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) throw new Error(`"${p}" is not an absolute folder path`);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      throw new Error(`${p} does not exist`);
    }
    if (!st.isDirectory()) throw new Error(`${p} is not a folder`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** server.publicUrl: where the page is reached from outside (for links in notifications). Empty clears it. */
export function cleanPublicUrl(v) {
  if (v === '' || v === null || v === undefined) return '';
  let u;
  try {
    u = new URL(String(v));
  } catch {
    throw new Error('the page address is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('the page address must start with https:// or http://');
  return u.toString().replace(/\/+$/, '');
}

/** server.allowedOrigins: up to 10 origins ("https://host[:port]") besides the page's own. */
export function cleanOrigins(v) {
  if (!Array.isArray(v) || v.length > 10) throw new Error('give at most 10 addresses');
  return [...new Set(v.map((o) => {
    let u;
    try {
      u = new URL(String(o));
    } catch {
      throw new Error(`"${o}" is not an address like https://pc.example.net`);
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.pathname !== '/' || u.search || u.hash) throw new Error(`"${o}" must be only scheme, host and port`);
    return u.origin;
  }))];
}

/**
 * The `server` part of a settings patch from the browser. Only known keys; unknown keys are an error so a typo
 * is not silently dropped.
 */
export function cleanServerPatch(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('send an object');
  const out = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'quickActions') out.quickActions = cleanQuickActions(v);
    else if (k === 'roots') out.roots = cleanRoots(v);
    else if (k === 'reach') {
      // How far Files and the editor reach (folders.mjs reachRoots): the allowed folders, or the whole disk.
      if (v !== 'home' && v !== 'everything') throw new Error('reach is "home" or "everything"');
      out.reach = v;
    }
    else if (k === 'notify') out.notify = cleanNotify(v);
    else if (k === 'publicUrl') out.publicUrl = cleanPublicUrl(v);
    else if (k === 'allowedOrigins') out.allowedOrigins = cleanOrigins(v);
    else if (k === 'getStartedDismissed') {
      // Home → "Get started" closed by the owner; kept on the server so it stays closed on every device.
      if (typeof v !== 'boolean') throw new Error('getStartedDismissed must be true or false');
      out.getStartedDismissed = v;
    }
    else if (k === 'trustProxy') {
      if (typeof v !== 'boolean') throw new Error('trustProxy must be true or false');
      out.trustProxy = v;
    } else if (k === 'uploadsDir') {
      const d = uploadsDirName(v);
      if (!d) throw new Error('the uploads folder must be a folder name inside the session folder, like .uploads');
      out.uploadsDir = String(v);
    } else if (k === 'uploadMaxMB') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 1024) throw new Error('the upload limit must be a whole number of MB from 1 to 1024');
      out.uploadMaxMB = n;
    }
    else throw new Error(`"${k}" cannot be changed here`);
  }
  return out;
}
