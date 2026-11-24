// The environment of the box: a closed short list, never the caller's (docs/BOX.md, "Your environment").
import path from 'node:path';
import { BOX_HOME } from './linux.mjs';

/**
 * The box's whole environment, a closed short list: never the caller's. PATH starts with the runtime's own bin;
 * LANG is the caller's only when it is a plain locale name (it is the one value read from the caller, and it starts
 * nothing). The caller's `env` (names checked by planRun) comes last but cannot replace HOME. bwrap adds PWD itself
 * (the cwd the caller named) after it changes folder; it cannot be unset and holds nothing the caller did not give.
 */
export function boxEnv(runtime, env = {}, lang = '') {
  const plainLang = typeof lang === 'string' && /^[A-Za-z]{1,8}(_[A-Za-z0-9]{1,8})?(\.[A-Za-z0-9-]{1,16})?(@[A-Za-z0-9]{1,16})?$/.test(lang) ? lang : 'C.UTF-8';
  return { PATH: `${path.join(runtime, 'bin')}:/usr/local/bin:/usr/bin:/bin`, LANG: plainLang, TERM: 'dumb', CI: '1', ...env, HOME: BOX_HOME };
}
