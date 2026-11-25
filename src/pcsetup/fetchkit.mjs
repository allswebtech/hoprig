// The checked download of a toolchain (the Flutter kit, and the Android kit's command-line tools): the vendor's own
// published list is read, the entry for this computer chosen, the archive downloaded over https from the vendor's own
// host only, its size held against the list (when it gives one), against the ceiling in the kit's data and against
// what arrives (a server may send no Content-Length, or a false one: the bytes are counted and cut at the ceiling),
// and its checksum checked. Nothing here unpacks (unpack.mjs) or puts anything in place (devinstall.mjs).
//
// Only the kit's data names an address: no environment variable or request field changes it. Tests hand in a
// stand-in getter (a server of their own on 127.0.0.1) as an argument; it is asked exactly the checked addresses.
//
// A getter: get(url, { signal }) → Promise<{ status, headers (lower-case names), body (a readable stream) }>. It asks
// once and follows no redirect itself: a redirect comes back here and is checked like the first address.
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';

/** A refusal or a failure of a download, in words a person reads: { code, message, todo }. */
export class FetchError extends Error {
  constructor(code, message, todo = 'Run it again later; if it fails the same way, tell the Hoprig project.') {
    super(message);
    this.code = code;
    this.todo = todo;
  }
}

const MAX_REDIRECTS = 3;
const IDLE_MS = 60_000;

/** The getter of a real run: one https request, no redirect followed, no compression asked for. */
export function httpsGet(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal, headers: { 'user-agent': 'hoprig', 'accept-encoding': 'identity' } }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
    req.setTimeout(IDLE_MS, () => req.destroy(new FetchError('network', 'the vendor\'s server sent nothing for 60 seconds')));
    req.on('error', reject);
  });
}

/** The address, when it is https on `host` (no user, no other port): else a refusal. */
export function checkAddress(url, host) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new FetchError('address', `"${String(url).slice(0, 200)}" is not an address`);
  }
  if (u.protocol !== 'https:') throw new FetchError('http', `${u.origin} is not https: Hoprig downloads a toolchain only over https`);
  if (u.hostname !== host || u.port || u.username || u.password) throw new FetchError('host', `${u.host} is not the vendor's own host (${host}): nothing was downloaded from it`);
  return u;
}

/** The address must stay under the vendor's own folder `prefix` on its host (a redirect too). */
function checkPrefix(u, prefix, host) {
  if (prefix && !u.pathname.startsWith(prefix)) throw new FetchError('redirect', `${host}${u.pathname.slice(0, 200)} is outside ${prefix} on ${host}: refused`);
  return u;
}

/** Ask `url`, following at most three redirects that stay on `host` over https, under `prefix`. → the 200 response. */
async function ask(url, { host, prefix = null, get, signal }) {
  let at = checkPrefix(checkAddress(url, host), prefix, host);
  for (let n = 0; ; n++) {
    let res;
    try {
      res = await get(at.href, { signal });
    } catch (e) {
      if (signal && signal.aborted) throw new FetchError('stopped', 'the download was stopped', 'Start it again when you want it.');
      throw e instanceof FetchError ? e : new FetchError('network', `the vendor's server could not be reached (${e.code || e.message})`, 'Check the internet connection, then run it again.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (res.body && res.body.resume) res.body.resume();
      if (n >= MAX_REDIRECTS) throw new FetchError('redirect', `${host} sent more than ${MAX_REDIRECTS} redirects`);
      let next;
      try {
        next = new URL(res.headers.location, at);
      } catch {
        throw new FetchError('redirect', `${host} sent a redirect that is not an address`);
      }
      if (next.protocol !== 'https:' || next.hostname !== host || next.port || next.username || next.password) throw new FetchError('redirect', `${host} sent the download on to ${next.host || next.protocol}, which is not its own host over https: refused`);
      at = checkPrefix(next, prefix, host);
      continue;
    }
    if (res.status !== 200) {
      if (res.body && res.body.resume) res.body.resume();
      throw new FetchError('status', `the vendor's server answered ${res.status} for ${at.pathname}`);
    }
    return res;
  }
}

const lengthOf = (headers) => {
  const v = headers && headers['content-length'];
  return v !== undefined && /^\d{1,15}$/.test(String(v)) ? Number(v) : null;
};

/** Bytes in words: "about 1.5 GB", "12 MB". */
export function sizeWords(n, about = true) {
  const units = [['GB', 1e9], ['MB', 1e6], ['kB', 1e3]];
  const [u, d] = units.find(([, v]) => n >= v) || ['bytes', 1];
  const x = n / d;
  return `${about ? 'about ' : ''}${x >= 10 || d === 1 ? Math.round(x) : Math.round(x * 10) / 10} ${u}`;
}

/**
 * Download `url` into `file` (a new file: never one that is there): the size held against `ceiling`, against
 * `size` (the list's, when it gives one) and against Content-Length, the bytes cut at the ceiling, and the checksum
 * `{ type: 'sha256' | 'sha1', hex }` checked at the end. A failure leaves the part that came in `file`: the caller
 * removes it with its temporary folder. → { bytes }
 */
export async function download(url, { host, prefix = null, ceiling, size = null, checksum, file, get = httpsGet, signal, onProgress = () => {} }) {
  if (!checksum || !['sha256', 'sha1'].includes(checksum.type) || !/^[0-9a-f]+$/.test(checksum.hex || '')) throw new FetchError('checksum', 'the list gives no checksum for it: nothing is downloaded without one');
  if (size !== null && size > ceiling) throw new FetchError('size', `the list says it is ${sizeWords(size, false)}, more than Hoprig's ceiling of ${sizeWords(ceiling, false)} for it: refused`);
  const res = await ask(url, { host, prefix, get, signal });
  const told = lengthOf(res.headers);
  const refuse = (e) => {
    if (res.body && res.body.destroy) res.body.destroy();
    throw e;
  };
  if (told !== null && told > ceiling) refuse(new FetchError('size', `the server says it is ${sizeWords(told, false)}, more than Hoprig's ceiling of ${sizeWords(ceiling, false)} for it: refused`));
  if (told !== null && size !== null && told !== size) refuse(new FetchError('size', `the server says ${told} bytes, the vendor's list ${size}: refused`));
  const hash = crypto.createHash(checksum.type);
  const out = fs.openSync(file, 'wx', 0o600);
  let bytes = 0;
  // A stop while the server sends nothing must end the wait too, not only a stop seen between two pieces.
  const stop = () => res.body && res.body.destroy && res.body.destroy(new FetchError('stopped', 'the download was stopped', 'Start it again when you want it.'));
  if (signal) signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const chunk of res.body) {
      if (signal && signal.aborted) throw new FetchError('stopped', 'the download was stopped', 'Start it again when you want it.');
      bytes += chunk.length;
      const most = size !== null ? size : ceiling;
      if (bytes > most) throw new FetchError('size', `more than ${size !== null ? `the ${size} bytes the vendor's list gives` : `Hoprig's ceiling of ${sizeWords(ceiling, false)}`} arrived: the download was cut off`);
      hash.update(chunk);
      fs.writeSync(out, chunk);
      onProgress(bytes, told ?? size);
    }
  } catch (e) {
    if (res.body && res.body.destroy) res.body.destroy();
    if (e instanceof FetchError) throw e;
    if (signal && signal.aborted) throw new FetchError('stopped', 'the download was stopped', 'Start it again when you want it.');
    throw new FetchError('network', `the download broke off (${e.code || e.message})`, 'Check the internet connection, then run it again.');
  } finally {
    if (signal) signal.removeEventListener('abort', stop);
    fs.closeSync(out);
  }
  if (signal && signal.aborted) throw new FetchError('stopped', 'the download was stopped', 'Start it again when you want it.');
  const want = size ?? told;
  if (want !== null && bytes !== want) throw new FetchError('size', `${bytes} bytes arrived, ${want} were due: the download is not whole`, 'Run it again.');
  const got = hash.digest('hex');
  if (got !== checksum.hex.toLowerCase()) throw new FetchError('checksum', `its ${checksum.type} is not the one the vendor publishes: the download was thrown away`, 'Run it again. If it fails the same way, do not install it by hand from that place: tell the Hoprig project.');
  return { bytes };
}

/** Read a vendor's list (small: held in memory, cut at `ceiling`). → its text */
export async function readList(url, { host, prefix = null, ceiling, get = httpsGet, signal }) {
  const res = await ask(url, { host, prefix, get, signal });
  const told = lengthOf(res.headers);
  if (told !== null && told > ceiling) {
    if (res.body.destroy) res.body.destroy();
    throw new FetchError('size', `the vendor's list is ${sizeWords(told, false)}, more than the ${sizeWords(ceiling, false)} a list may have`);
  }
  const parts = [];
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > ceiling) throw new FetchError('size', `the vendor's list is longer than ${sizeWords(ceiling, false)}`);
      parts.push(chunk);
    }
  } catch (e) {
    if (res.body.destroy) res.body.destroy();
    throw e instanceof FetchError ? e : new FetchError('network', `the vendor's list broke off (${e.code || e.message})`, 'Check the internet connection, then run it again.');
  }
  return Buffer.concat(parts).toString('utf8');
}

const ARCHIVE_RE = /^stable\/(linux|macos)\/[A-Za-z0-9._-]{1,120}\.(tar\.xz|zip)$/;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:[-+][0-9A-Za-z.]{1,40})?$/;

/**
 * The current stable Flutter for this computer from Flutter's release list (releases_<os>.json): the entry whose hash
 * is `current_release.stable`, on macOS the one for this CPU (`dart_sdk_arch`). Everything taken from the list is
 * checked: the base address is on `host` over https, the archive a plain name, the checksum 64 hex digits.
 * → { version, url, sha256, kind: 'tar.xz' | 'zip' }
 */
export function chooseFlutter(text, { platform, arch, host }) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw new FetchError('list', 'Flutter\'s release list is not valid JSON');
  }
  const base = list && typeof list.base_url === 'string' ? list.base_url.replace(/\/+$/, '') : '';
  checkAddress(`${base}/x`, host);
  const stable = list.current_release && list.current_release.stable;
  if (typeof stable !== 'string' || !/^[0-9a-f]{40}$/.test(stable)) throw new FetchError('list', 'Flutter\'s release list names no current stable release');
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!cpu || (platform === 'linux' && cpu !== 'x64')) throw new FetchError('cpu', `Flutter publishes no ${platform === 'darwin' ? 'macOS' : 'Linux'} archive for this computer's CPU (${arch})`, 'See https://docs.flutter.dev/install for other ways.');
  const os = platform === 'darwin' ? 'macos' : 'linux';
  const r = (Array.isArray(list.releases) ? list.releases : []).find((x) => x && x.hash === stable && x.channel === 'stable' && (platform === 'darwin' ? x.dart_sdk_arch === cpu : !x.dart_sdk_arch || x.dart_sdk_arch === 'x64'));
  if (!r) throw new FetchError('list', `Flutter's release list has no stable archive for ${os} (${cpu})`);
  const m = ARCHIVE_RE.exec(String(r.archive || ''));
  if (!m || m[1] !== os || r.archive.split('/').includes('..')) throw new FetchError('list', 'Flutter\'s release list names an archive Hoprig does not take');
  if (!/^[0-9a-f]{64}$/.test(String(r.sha256 || ''))) throw new FetchError('checksum', 'Flutter\'s release list gives no sha256 for it: nothing is downloaded without one');
  if (!VERSION_RE.test(String(r.version || ''))) throw new FetchError('list', 'Flutter\'s release list gives no version for it');
  return { version: r.version, url: `${base}/${r.archive}`, sha256: r.sha256, kind: m[2] };
}

const ZIP_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.zip$/;
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([^<]{0,200})</${name}>`).exec(xml);
  return m ? m[1].trim() : null;
};

/**
 * The Android SDK command-line tools for this computer from the list sdkmanager reads (repository2-3.xml): the
 * package `cmdline-tools;latest`, on the channel the list calls stable, its whole archive (never a patch) for this
 * host-os (`macosx` with host-arch on a Mac). Everything taken from it is checked: the archive a plain .zip name (so
 * it stays under `base` on the host), an exact size under the ceiling, a sha1 of 40 hex digits.
 * → { version, url, sha1, size }
 */
export function chooseAndroid(text, { platform, arch, base, ceiling }) {
  const xml = String(text || '');
  if (!/<sdk:sdk-repository\b/.test(xml)) throw new FetchError('list', 'Google\'s Android list is not the list sdkmanager reads');
  const stable = /<channel id="(channel-\d+)">stable<\/channel>/.exec(xml);
  const pkgs = [...xml.matchAll(/<remotePackage\b([^>]*)>([\s\S]*?)<\/remotePackage>/g)].filter((m) => /\bpath="cmdline-tools;latest"/.test(m[1]));
  if (pkgs.length !== 1 || /\bobsolete="true"/.test(pkgs[0][1])) throw new FetchError('list', 'Google\'s Android list names no current command-line tools');
  const body = pkgs[0][2];
  const channel = (/<channelRef ref="(channel-\d+)"\/>/.exec(body) || [])[1];
  if (!stable || channel !== stable[1]) throw new FetchError('list', 'the command-line tools in Google\'s Android list are not on its stable channel');
  const os = platform === 'darwin' ? 'macosx' : platform === 'linux' ? 'linux' : null;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x64' : null;
  const fit = [...body.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map((m) => m[1]).filter((a) => {
    const hostArch = tag(a, 'host-arch');
    return tag(a, 'host-os') === os && (!hostArch || hostArch === cpu);
  });
  if (!os || fit.length !== 1) throw new FetchError('cpu', `Google's Android list has no command-line tools for this computer (${platform}, ${arch})`, 'See https://developer.android.com/studio for other ways.');
  const complete = (/<complete>([\s\S]*?)<\/complete>/.exec(fit[0]) || [])[1] || '';
  const name = tag(complete, 'url') || '';
  if (!ZIP_NAME_RE.test(name)) throw new FetchError('list', 'Google\'s Android list names an archive Hoprig does not take');
  const sizeText = tag(complete, 'size') || '';
  if (!/^\d{1,12}$/.test(sizeText)) throw new FetchError('list', 'Google\'s Android list gives no size for the command-line tools');
  const size = Number(sizeText);
  if (size > ceiling) throw new FetchError('size', `Google's Android list says the command-line tools are ${sizeWords(size, false)}, more than Hoprig's ceiling of ${sizeWords(ceiling, false)} for them: refused`);
  const sum = /<checksum type="sha1">([0-9a-f]{40})<\/checksum>/.exec(complete);
  if (!sum) throw new FetchError('checksum', 'Google\'s Android list gives no sha1 for the command-line tools: nothing is downloaded without one');
  const major = tag(body, 'major');
  const minor = tag(body, 'minor');
  const version = major && /^\d{1,4}$/.test(major) ? `${major}.${minor && /^\d{1,4}$/.test(minor) ? minor : '0'}` : null;
  return { version, url: `${base}${name}`, sha1: sum[1], size };
}
