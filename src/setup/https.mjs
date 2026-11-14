// HTTPS in front of a hub: `hoprig setup --hub [--domain hub.example.com]`.
//
// The dashboard speaks plain HTTP on 127.0.0.1; a web server with a certificate stands in front of it. The least
// that works unattended is Caddy: one package, it gets and renews the certificate by itself and passes WebSockets
// through. So:
//   nothing on ports 80/443   install Caddy (one confirmation), write our site to /etc/caddy/hoprig.caddy, import
//                             it from /etc/caddy/Caddyfile, validate, reload
//   Caddy already there       the same, without installing
//   nginx / Apache / a panel  never touched: print the ready-to-paste site block for it
// and hoprig's own settings: server.host 127.0.0.1, trustProxy, allowedOrigins and publicUrl for the address.
//
// The address: a domain (its A/AAAA record must point here first, else we say which record to make and stop), or,
// without a domain, this server's public IP: Let's Encrypt issues certificates for IP addresses (generally available
// since 15 Jan 2026, https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability: "IP address certificates
// must be short-lived certificates", 160 hours, http-01 or tls-alpn-01 only), requested with the ACME profile
// "shortlived" (https://letsencrypt.org/docs/profiles/). Caddy sends a profile with `issuer acme { profile <name> }`
// (https://caddyserver.com/docs/caddyfile/directives/tls, marked experimental) and renews by itself.
//
// Sources for the Caddy parts (read 14 Nov 2026): install https://caddyserver.com/docs/install, the site and its
// reload https://caddyserver.com/docs/running ("sudo nano /etc/caddy/Caddyfile" then "sudo systemctl reload caddy"),
// WebSockets and X-Forwarded-* https://caddyserver.com/docs/caddyfile/directives/reverse_proxy, import
// https://caddyserver.com/docs/caddyfile/directives/import ("always relative to the file the import appears in").
import dns from 'node:dns';
import fs from 'node:fs';
import { request as httpsRequest } from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { APT, capture, which } from './system.mjs';

export const CADDY_DIR = '/etc/caddy';
export const SITE_FILE = 'hoprig.caddy';
export const IMPORT_LINE = `import ${SITE_FILE}`;
const MARK = '# hoprig hub: written by `hoprig setup --hub`; hoprig rewrites this file, edit the Caddyfile instead';

// ---------------------------------------------------------------- addresses

// Not public: loopback, RFC 1918, CGNAT 100.64/10 (Tailscale's addresses are in it), link-local, documentation and
// benchmark ranges, multicast and reserved; IPv6 loopback, link-local, unique-local (Tailscale's fd7a:115c:a1e0::/48
// is in fc00::/7), documentation.
const PRIVATE = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fe80::', 10], ['fc00::', 7], ['2001:db8::', 32], ['ff00::', 8], ['64:ff9b::', 96]]) PRIVATE.addSubnet(a, p, 'ipv6');

/** True for an address the internet can reach (as far as its number says). */
export function isPublicIp(ip) {
  const v = net.isIP(String(ip || ''));
  if (!v) return false;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return isPublicIp(m[1]);
  return !PRIVATE.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

/**
 * This computer's own public addresses, IPv4 first. IPv6 only on request: a home PC has global IPv6 addresses that
 * its router's firewall keeps closed, so they do not make it "a server on the internet". On a cloud server behind
 * 1:1 NAT there are none (pass --ip then).
 */
export function publicAddresses(ifaces = os.networkInterfaces(), { ipv6 = false } = {}) {
  const out = [];
  for (const list of Object.values(ifaces)) for (const a of list || []) if (!a.internal && isPublicIp(a.address) && (ipv6 || net.isIP(a.address) === 4)) out.push(a.address);
  return out.sort((x, y) => net.isIP(x) - net.isIP(y));
}

/** A valid DNS name (at least two labels), lower case; null otherwise. */
export function cleanDomain(d) {
  const s = String(d || '').trim().toLowerCase().replace(/\.$/, '');
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s) && !net.isIP(s) ? s : null;
}

/** The address as it goes in a URL: IPv6 in brackets. */
export const urlHost = (h) => (net.isIP(h) === 6 ? `[${h}]` : h);

/**
 * Does `domain` point here? { ok, records: { A: [...], AAAA: [...] }, want: [ip...] }. `ours` are this server's
 * public addresses. ok when any A/AAAA record is one of ours.
 */
export async function dnsCheck(domain, ours, resolver = dns.promises) {
  const records = { A: [], AAAA: [] };
  try {
    records.A = await resolver.resolve4(domain);
  } catch {
    /* none */
  }
  try {
    records.AAAA = await resolver.resolve6(domain);
  } catch {
    /* none */
  }
  const all = [...records.A, ...records.AAAA];
  return { ok: all.some((a) => ours.includes(a)), records, want: ours };
}

/** The DNS record(s) to make, as one line each. */
export function dnsAdvice(domain, ours) {
  return ours.map((ip) => `${net.isIP(ip) === 6 ? 'AAAA' : 'A'} record   ${domain}   →   ${ip}`);
}

// ---------------------------------------------------------------- what is on this server already

const PANELS = [
  ['cPanel', '/usr/local/cpanel'], ['Plesk', '/usr/local/psa'], ['DirectAdmin', '/usr/local/directadmin'],
  ['aaPanel', '/www/server/panel'], ['CyberPanel', '/usr/local/CyberCP'], ['HestiaCP', '/usr/local/hestia'],
  ['Webmin/Virtualmin', '/etc/webmin'], ['CloudPanel', '/home/clp'],
];

/** Ports 80 and 443 in `ss -ltnH` output: { 80: true|false, 443: ... }. */
export function busyPorts(ssText) {
  const out = { 80: false, 443: false };
  for (const line of String(ssText || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c) => /[:.](80|443)$/.test(c) && /\d/.test(c));
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (port === 80 || port === 443) out[port] = true;
  }
  return out;
}

/** Which web server owns 80/443, from facts gathered by detectWebServer(). Pure. */
export function classifyWebServer({ ports, active = {}, installed = {}, panel = null }) {
  const busy = ports[80] || ports[443];
  if (panel) return { kind: 'panel', panel, busy };
  if (active.caddy || (installed.caddy && !busy)) return { kind: 'caddy', busy, installed: true };
  if (active.nginx) return { kind: 'nginx', busy };
  if (active.apache) return { kind: 'apache', busy };
  if (busy) return { kind: installed.nginx ? 'nginx' : installed.apache ? 'apache' : 'other', busy };
  return { kind: 'none', busy: false };
}

/** Look at this server: ports 80/443, Caddy / nginx / Apache installed or running, a control panel. */
export async function detectWebServer({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const has = (c) => !!which(c, env, platform);
  const ss = has('ss') ? await capture(['ss', '-ltnH'], { env }) : { stdout: '' };
  const ports = busyPorts(ss.stdout);
  const activeOf = async (units) => {
    if (!has('systemctl')) return false;
    for (const u of units) if ((await capture(['systemctl', 'is-active', u], { env, timeout: 5000 })).stdout.trim() === 'active') return true;
    return false;
  };
  const installed = { caddy: has('caddy'), nginx: has('nginx'), apache: has('apache2') || has('httpd') };
  const active = { caddy: await activeOf(['caddy']), nginx: await activeOf(['nginx']), apache: await activeOf(['apache2', 'httpd']) };
  const panel = (PANELS.find(([, p]) => exists(p)) || [null])[0];
  return { ...classifyWebServer({ ports, active, installed, panel }), ports, installed, active };
}

// ---------------------------------------------------------------- Caddy

/**
 * The commands that install Caddy, from https://caddyserver.com/docs/install. Steps are { argv } or
 * { download: url, to: file } (fetched over https by us, then put in place with `install`, the same as the
 * page's `curl … | sudo tee` and `chmod o+r`). null where the page has no command for this system.
 */
export function caddyInstallSteps(pm, { root = false, osId = '' } = {}) {
  const su = (argv) => (root ? argv : ['sudo', ...argv]);
  if (pm === 'apt') {
    return [
      // A fresh system has empty package lists, and the page's first line then finds nothing to install.
      { argv: su([...APT, 'update']) },
      // The page's first line, plus gnupg: minimal Debian/Ubuntu images do not have gpg, which the next line needs.
      { argv: su([...APT, 'install', '-y', 'debian-keyring', 'debian-archive-keyring', 'apt-transport-https', 'curl', 'gnupg']) },
      { download: 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key', dearmor: '/usr/share/keyrings/caddy-stable-archive-keyring.gpg' },
      { download: 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt', to: '/etc/apt/sources.list.d/caddy-stable.list' },
      { argv: su([...APT, 'update']) },
      { argv: su([...APT, 'install', '-y', 'caddy']) },
    ];
  }
  if (pm === 'dnf' || pm === 'yum') {
    const plugins = /fedora/.test(osId) ? 'dnf5-plugins' : 'dnf-plugins-core';
    return [
      { argv: su(['dnf', 'install', '-y', plugins]) },
      { argv: su(['dnf', 'copr', 'enable', '-y', '@caddy/caddy']) },
      { argv: su(['dnf', 'install', '-y', 'caddy']) },
    ];
  }
  if (pm === 'pacman') return [{ argv: su(['pacman', '-Syu', '--noconfirm', 'caddy']) }];
  // Not on caddyserver.com's install page; Alpine's own community repository has the package.
  if (pm === 'apk') return [{ argv: su(['apk', 'add', 'caddy']) }];
  return null;
}

/** How a step reads when shown to the user. */
export function showStep(s, root = false) {
  const sudo = root ? '' : 'sudo ';
  if (s.argv) return s.argv.join(' ');
  if (s.dearmor) return `curl -1sLf '${s.download}' | ${sudo}gpg --dearmor -o ${s.dearmor}`;
  return `curl -1sLf '${s.download}' | ${sudo}tee ${s.to}`;
}

/**
 * Our Caddy site. mode: "domain" (automatic HTTPS), "ip" (Let's Encrypt, profile shortlived), "internal" (Caddy's own
 * CA: a browser warning, for tests and private networks). reverse_proxy passes WebSockets through and sets
 * X-Forwarded-For/-Proto/-Host by itself. A site for an IP address also needs the global option that
 * withDefaultSni() puts into the Caddyfile: a site block cannot say it.
 */
export function caddySite({ address, port, mode = 'domain' }) {
  const tls =
    mode === 'ip'
      ? ['\ttls {', '\t\tissuer acme {', '\t\t\tprofile shortlived', '\t\t}', '\t}']
      : mode === 'internal'
        ? ['\ttls internal']
        : [];
  return [MARK, `${address} {`, ...tls, `\treverse_proxy 127.0.0.1:${port}`, '}', ''].join('\n');
}

const SNI_MARK = '# hoprig hub';
const SNI_NOTE = '# hoprig hub: the certificate for a visitor who names no server (a browser opening an IP address). hoprig setup --hub keeps the next block.';
const OUR_SNI = /^\s*default_sni\s+\S+\s+# hoprig hub\s*$/;

/**
 * The Caddyfile with the global option `default_sni <address>`, for a hub that is reached by its IP address.
 *
 * A browser sends no server name for an IP address (the TLS name is for host names only). Caddy then looks for a
 * certificate for the address the connection arrived at on this computer. Behind NAT (most cloud servers) and in a
 * container that is a private address, not the one in the certificate, and the handshake ends in "internal
 * error". `default_sni` is the name Caddy takes when none was sent (https://caddyserver.com/docs/caddyfile/options).
 * A domain needs none of this: its name is always sent.
 *
 * Global options are the first block of the Caddyfile, so the line goes into that block (a new one on top when
 * there is none), marked as ours. A default_sni the owner wrote there is left alone. `address` null takes our line
 * out again (the hub moved to a domain). Returns the new text, or null when nothing changes. An IPv6 address is
 * written without brackets: it is a name here, not a place to connect to.
 */
export function withDefaultSni(caddyfile, address) {
  const text = String(caddyfile || '');
  const lines = text.split('\n');
  const mine = lines.findIndex((l) => OUR_SNI.test(l));
  const line = address ? `\tdefault_sni ${String(address).replace(/^\[|\]$/g, '')} ${SNI_MARK}` : null;
  if (mine >= 0) {
    if (line && lines[mine] === line) return null;
    if (line) lines[mine] = line;
    else {
      lines.splice(mine, 1);
      // the block we made ourselves, now empty, goes with it
      if (mine >= 2 && lines[mine - 2] === SNI_NOTE && lines[mine - 1].trim() === '{' && (lines[mine] || '').trim() === '}') {
        lines.splice(mine - 2, 3);
        if (lines[mine - 2] === '') lines.splice(mine - 2, 1);
      }
    }
    return lines.join('\n');
  }
  if (!line) return null;
  // The global options block: the first thing in the file that is not a comment, when it is a lone "{".
  const first = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
  if (first >= 0 && /^\{\s*(#.*)?$/.test(lines[first].trim())) {
    let depth = 0;
    for (let i = first; i < lines.length; i++) {
      const t = lines[i].replace(/\s+#.*$/, '').trim();
      if (depth === 1 && /^default_sni(\s|$)/.test(t)) return null; // the owner's own choice stays
      if (t.endsWith('{')) depth++;
      if (t.startsWith('}')) depth--;
      if (depth === 0) break;
    }
    lines.splice(first + 1, 0, line);
    return lines.join('\n');
  }
  return `${SNI_NOTE}\n{\n${line}\n}\n${text ? `\n${text}` : ''}`;
}

/** The Caddyfile with our import line added once (at the end). null when it is already there. */
export function withImport(caddyfile) {
  const text = String(caddyfile || '');
  if (text.split('\n').some((l) => l.trim() === IMPORT_LINE)) return null;
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}\n${IMPORT_LINE}\n`;
}

// ---------------------------------------------------------------- nginx / Apache: printed, never written

export function nginxSite({ domain, port, uploadMb = 25 }) {
  return `server {
    listen 443 ssl;
    server_name ${domain};
    # ssl_certificate and ssl_certificate_key: your certificate for ${domain} (for example: sudo certbot --nginx -d ${domain})

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        client_max_body_size ${uploadMb + 5}m;
    }
}
`;
}

export function apacheSite({ domain, port }) {
  return `# Needs Apache 2.4.47 or newer and: sudo a2enmod ssl proxy proxy_http headers
<VirtualHost *:443>
    ServerName ${domain}
    # SSLEngine on, SSLCertificateFile and SSLCertificateKeyFile: your certificate (for example: sudo certbot --apache -d ${domain})
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass / http://127.0.0.1:${port}/ upgrade=websocket
    ProxyPassReverse / http://127.0.0.1:${port}/
    ProxyTimeout 3600
</VirtualHost>
`;
}

/** hoprig's own settings for a hub behind HTTPS at `origin` (https://host). */
export function hubSettings(origin, allowed = []) {
  return { host: '127.0.0.1', trustProxy: true, allowedOrigins: [...new Set([...allowed, origin])], publicUrl: `${origin}/` };
}

// ---------------------------------------------------------------- the firewall

/** ufw or firewalld when active, with the command that opens 80 and 443 (80: the certificate's http-01 check). */
export async function firewallPlan({ env = process.env, platform = process.platform, root = false } = {}) {
  const has = (c) => !!which(c, env, platform);
  const su = (argv) => (root ? argv : ['sudo', ...argv]);
  const active = async (unit) => has('systemctl') && (await capture(['systemctl', 'is-active', unit], { env, timeout: 5000 })).stdout.trim() === 'active';
  if (has('ufw') && (await active('ufw'))) return { name: 'ufw', steps: [su(['ufw', 'allow', '80,443/tcp'])] };
  if (has('firewall-cmd') && (await active('firewalld'))) {
    return { name: 'firewalld', steps: [su(['firewall-cmd', '--permanent', '--add-service=http', '--add-service=https']), su(['firewall-cmd', '--reload'])] };
  }
  return null;
}

// ---------------------------------------------------------------- the plan

/**
 * What to do, decided from what was found. Pure.
 *   web     detectWebServer()'s answer       address  domain or IP        port  the dashboard's port
 * Returns { action, mode, ... }:
 *   "caddy"      write our site (install first when `install`), reload
 *   "print"      nginx/apache own 80/443: show `block` (never written)
 *   "panel"      a control panel manages the web server: add a reverse proxy there (show nginx block as a guide)
 *   "blocked"    something else listens on 80/443: say so
 */
export function httpsPlan({ web, address, port, ip = false }) {
  const mode = ip ? 'ip' : 'domain';
  if (web.kind === 'caddy') return { action: 'caddy', install: false, mode };
  if (web.kind === 'none') return { action: 'caddy', install: true, mode };
  if (ip) return { action: 'blocked', mode, reason: `${web.kind === 'other' ? 'Another program' : web.kind} already uses ports 80/443` };
  if (web.kind === 'nginx') return { action: 'print', server: 'nginx', block: nginxSite({ domain: address, port }), mode };
  if (web.kind === 'apache') return { action: 'print', server: 'apache', block: apacheSite({ domain: address, port }), mode };
  if (web.kind === 'panel') return { action: 'panel', panel: web.panel, block: nginxSite({ domain: address, port }), mode };
  return { action: 'blocked', mode, reason: 'another program already uses ports 80/443' };
}

/** GET <origin>/login, retried while the certificate is being issued. Resolves to a status or an error code. */
/** One GET that accepts a certificate nobody vouches for (Caddy's own CA): we check reachability, not trust. */
export function getUntrusted(url) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { rejectUnauthorized: false, timeout: 8000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

export async function httpsCheck(origin, { tries = 20, waitMs = 3000, fetchImpl = globalThis.fetch, untrusted = false } = {}) {
  if (untrusted) fetchImpl = (url) => getUntrusted(url);
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchImpl(`${origin}/login`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      if (r.status === 200) return 200;
      last = r.status;
    } catch (e) {
      last = (e.cause && e.cause.code) || e.code || e.message;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, waitMs));
  }
  return last;
}

export const caddyPaths = (dir = CADDY_DIR) => ({ dir, caddyfile: path.join(dir, 'Caddyfile'), site: path.join(dir, SITE_FILE) });
