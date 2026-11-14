// Throwaway certificate authorities for the tests, made with node:crypto alone (no openssl: the suite also runs on
// Windows). A few lines of DER: X.509 v3, P-256 keys, ECDSA with SHA-256, basicConstraints for an authority and
// subjectAltName (DNS names and IP addresses) for a server. Enough for Node's TLS to verify a chain like Caddy's
// internal one: root -> intermediate -> leaf, the server sending leaf + intermediate.
import crypto from 'node:crypto';
import net from 'node:net';

const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const oid = (s) => {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s));
const time = (d) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const bits = (buf) => tlv(0x03, Buffer.from([0]), buf);
const octets = (buf) => tlv(0x04, buf);
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octets(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/** One certificate: { key, cert (PEM), x509 }. `issuer` signs it (itself when absent). */
export function makeCert({ cn, issuer = null, ca = false, dns = [], ips = [], days = 30, notBefore = new Date(Date.now() - 60_000) } = {}) {
  const { privateKey: key, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exts = [];
  if (ca) {
    exts.push(ext('2.5.29.19', true, seq(tlv(0x01, Buffer.from([0xff])))));
    exts.push(ext('2.5.29.15', true, tlv(0x03, Buffer.from([1, 0x06])))); // keyCertSign, cRLSign
  } else {
    const alt = [...dns.map((d) => tlv(0x82, Buffer.from(d))), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number))))];
    exts.push(ext('2.5.29.17', false, seq(...alt)));
  }
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(crypto.randomBytes(12)),
    ECDSA_SHA256,
    name(issuer ? issuer.cn : cn),
    seq(time(notBefore), time(new Date(notBefore.getTime() + days * 86_400_000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...exts)),
  );
  const sig = crypto.sign('sha256', tbs, issuer ? issuer.key : key);
  const der = seq(tbs, ECDSA_SHA256, bits(sig));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cn, key, keyPem: key.export({ type: 'pkcs8', format: 'pem' }), cert, x509: new crypto.X509Certificate(cert) };
}

/** A Caddy-like authority: root, intermediate, and leaves for a host signed by the intermediate. */
export function makeAuthority(cn = 'Test Local Authority') {
  const root = makeCert({ cn: `${cn} - Root`, ca: true, days: 3650 });
  const inter = makeCert({ cn: `${cn} - Intermediate`, issuer: root, ca: true, days: 7 });
  const leaf = (host) => makeCert({ cn: host, issuer: inter, ...(net.isIP(host) ? { ips: [host] } : { dns: [host] }), days: 1 });
  return { root, inter, leaf };
}

/**
 * An HTTPS front like Caddy's in front of a hub: TLS on 127.0.0.1, every connection piped to `targetPort` (plain
 * HTTP). `use({ key, chain })` swaps the certificate (a renewal, a new authority); `drop()` cuts live connections.
 */
export async function tlsFront(targetPort, { key, chain }) {
  const tls = await import('node:tls');
  const socks = new Set();
  let connections = 0;
  const server = tls.createServer({ key, cert: chain }, (s) => {
    connections++;
    const up = net.connect(targetPort, '127.0.0.1');
    socks.add(s);
    s.on('close', () => socks.delete(s));
    s.pipe(up).pipe(s);
    up.on('error', () => s.destroy());
    s.on('error', () => up.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    get connections() {
      return connections;
    },
    use: ({ key: k, chain: c }) => server.setSecureContext({ key: k, cert: c }),
    drop: () => {
      for (const s of socks) s.destroy();
    },
    close: () => new Promise((r) => {
      for (const s of socks) s.destroy();
      server.close(() => r());
    }),
  };
}
