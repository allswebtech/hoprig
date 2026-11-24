// Where a webhook's delivery may go (docs/WORK.md, "Another program"). Pure checks and one name lookup:
//
// - https only; plain http only to this computer itself (a loopback address or "localhost");
// - no user name or password in the address;
// - the host is resolved once and EVERY address it resolves to is checked; the delivery then connects to the one
//   address checked, with the name for its certificate (hooks.mjs), so a name that answers otherwise a moment later
//   changes nothing;
// - an address of this computer or of a private network (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, the
//   local NAT64 prefix 64:ff9b:1::/48, also an IPv4 address written as IPv6) only for a webhook the owner marked "on my
//   own network";
// - never an unspecified (0.0.0.0, ::), link-local (169.254/16, fe80::/10), multicast, documentation (192.0.2/24,
//   198.51.100/24, 203.0.113/24, 2001:db8::/32, 3fff::/20) or reserved (192.0.0/24, 240/4) address, marked or not.
import dns from 'node:dns';
import net from 'node:net';

const fail = (message, code = 'address') => Object.assign(new Error(message), { status: 400, details: { code } });
const URL_MAX = 2000;

/** An IPv6 address as 8 numbers, or null. */
function v6Groups(a) {
  let s = a.toLowerCase();
  const v4tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4tail) {
    const p = v4tail[1].split('.').map(Number);
    if (p.some((x) => x > 255)) return null;
    s = s.slice(0, -v4tail[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  if (s.includes('::')) while (h.length + t.length < 8) h.push('0');
  const all = [...h, ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? all : null;
}

function v4Kind(a) {
  const [x, y, z] = a.split('.').map(Number);
  if (x === 0) return 'never'; // 0.0.0.0/8: "this network", 0.0.0.0 reaches this computer
  if (x === 127) return 'local';
  if (x === 169 && y === 254) return 'never'; // link-local, also a cloud's metadata address
  if (x >= 224) return 'never'; // multicast, reserved, broadcast
  // The protocol assignments (192.0.0/24) and the documentation ranges: no receiver is ever there.
  if ((x === 192 && y === 0 && (z === 0 || z === 2)) || (x === 198 && y === 51 && z === 100) || (x === 203 && y === 0 && z === 113)) return 'never';
  if (x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127)) return 'private';
  if (x === 198 && (y === 18 || y === 19)) return 'private';
  return 'public';
}

/**
 * What kind of address `ip` is: 'public', 'local' (this computer), 'private' (a private network), 'never' (an address
 * a delivery never goes to) or null (not an address).
 */
export function addressKind(ip) {
  const a = String(ip || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const fam = net.isIP(a);
  if (fam === 4) return v4Kind(a);
  if (fam !== 6) return null;
  const g = v6Groups(a);
  if (!g) return null;
  const v4of = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // An IPv4 address written as IPv6 (mapped ::ffff:a.b.c.d, the old compatible ::a.b.c.d, translated
  // ::ffff:0:a.b.c.d, NAT64 64:ff9b::/96): as itself.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return g[7] === 1 ? 'local' : 'never'; // ::1 and ::
    return v4Kind(v4of(g[6], g[7]));
  }
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return v4Kind(v4of(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Kind(v4of(g[6], g[7]));
  // The local NAT64 prefix (RFC 8215) goes through a gateway of the owner's own network, and where the IPv4 address
  // stands in it depends on a prefix length a lookup does not tell: a private address, whatever follows.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return 'private';
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'never'; // documentation
  if (g[0] === 0x3fff && g[1] < 0x1000) return 'never'; // documentation too, since 2024 (RFC 9637)
  if (g[0] === 0x2002) return v4Kind(v4of(g[1], g[2])) === 'public' ? 'public' : 'never'; // 6to4 of a private address
  if ((g[0] & 0xfe00) === 0xfc00) return 'private'; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return 'never'; // link-local, multicast
  if ((g[0] & 0xffc0) === 0xfec0) return 'private'; // the old site-local
  return 'public';
}

const isLocalName = (host) => host === 'localhost' || host.endsWith('.localhost') || addressKind(host) === 'local';

/** A webhook's address, checked as written (not resolved yet): a URL. */
export function checkHookUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > URL_MAX) throw fail(`give the webhook's address, an https address of at most ${URL_MAX} characters`);
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    throw fail('that is not an address (it starts with https://)');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw fail('a webhook\'s address starts with https://');
  if (u.username || u.password) throw fail('a webhook\'s address holds no user name or password: the deliveries are signed with its secret');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw fail('that address names no computer');
  if (u.protocol === 'http:' && !isLocalName(host)) throw fail('plain http only to this computer itself: use an https address');
  if (net.isIP(host) && addressKind(host) === 'never') throw fail(`${host} is an address a delivery never goes to`);
  u.hash = '';
  return u;
}

/**
 * Resolve a webhook's address once and check every address it resolves to. → { address, family, host } (the one
 * the delivery connects to). `lookup`: a stand-in for dns.lookup (tests). Refusals say why without the address's path.
 */
export async function resolveHook(rawUrl, { ownNetwork = false, lookup = dns.promises.lookup } = {}) {
  const u = checkHookUrl(rawUrl);
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let found;
  if (net.isIP(host)) found = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      found = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw fail(`${host} could not be found`, 'not-found');
    }
  }
  if (!Array.isArray(found) || !found.length) throw fail(`${host} could not be found`, 'not-found');
  for (const f of found) {
    const kind = addressKind(f.address);
    if (!kind || kind === 'never') throw fail(`${host} leads to an address a delivery never goes to`);
    if (kind !== 'public' && !ownNetwork) throw fail(`${host} is on this computer or on a private network: only a webhook marked "on my own network" may go there`, 'private');
    if (u.protocol === 'http:' && kind !== 'local') throw fail('plain http only to this computer itself: use an https address');
  }
  return { address: found[0].address, family: net.isIP(found[0].address), host, url: u };
}
