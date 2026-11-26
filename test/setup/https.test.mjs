import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, pathWith, scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const H = await import('../../src/setup/https.mjs');

test('public or not: loopback, private, CGNAT/Tailscale, link-local, documentation ranges are not public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.215.14', '2606:4700::1111', '::ffff:8.8.4.4']) assert.equal(H.isPublicIp(ip), true, ip);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.5', '100.64.0.1', '100.101.102.103', '169.254.1.1',
    '0.0.0.0', '192.0.2.1', '198.51.100.7', '203.0.113.5', '224.0.0.1', '::1', 'fe80::1', 'fd7a:115c:a1e0::1', 'fc00::1', '2001:db8::1', '::ffff:192.168.0.1',
    'not an ip', '', null]) assert.equal(H.isPublicIp(ip), false, String(ip));
  assert.equal(H.isPublicIp('172.32.0.1'), true, 'just outside 172.16/12');
  assert.equal(H.isPublicIp('100.128.0.1'), true, 'just outside 100.64/10');
});

test('public addresses of this computer, IPv4 first', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', internal: true }],
    eth0: [{ address: '2606:4700:4700::1111', internal: false }, { address: '10.0.0.4', internal: false }, { address: '1.1.1.1', internal: false }],
    tailscale0: [{ address: '100.88.1.2', internal: false }],
  };
  assert.deepEqual(H.publicAddresses(ifaces), ['1.1.1.1']);
  assert.deepEqual(H.publicAddresses(ifaces, { ipv6: true }), ['1.1.1.1', '2606:4700:4700::1111']);
  assert.deepEqual(H.publicAddresses({ eth0: [{ address: '10.0.0.4', internal: false }] }), []);
});

test('domains are checked, IPs are not domains, IPv6 goes in brackets', () => {
  assert.equal(H.cleanDomain('Hub.Example.com.'), 'hub.example.com');
  assert.equal(H.cleanDomain('localhost'), null);
  assert.equal(H.cleanDomain('1.1.1.1'), null);
  assert.equal(H.cleanDomain('bad_name.example.com'), null);
  assert.equal(H.urlHost('2606:4700:4700::1111'), '[2606:4700:4700::1111]');
  assert.equal(H.urlHost('1.1.1.1'), '1.1.1.1');
});

test('DNS: points here, points elsewhere, no record; the record to create', async () => {
  const resolver = (a, aaaa = []) => ({ resolve4: async () => a, resolve6: async () => { if (!aaaa.length) throw new Error('ENODATA'); return aaaa; } });
  assert.equal((await H.dnsCheck('hub.example.com', ['1.1.1.1'], resolver(['1.1.1.1']))).ok, true);
  const elsewhere = await H.dnsCheck('hub.example.com', ['1.1.1.1'], resolver(['1.2.3.4']));
  assert.equal(elsewhere.ok, false);
  assert.deepEqual(elsewhere.records.A, ['1.2.3.4']);
  const none = await H.dnsCheck('hub.example.com', ['1.1.1.1'], { resolve4: async () => { throw new Error('ENOTFOUND'); }, resolve6: async () => { throw new Error('ENOTFOUND'); } });
  assert.equal(none.ok, false);
  assert.deepEqual(H.dnsAdvice('hub.example.com', ['1.1.1.1', '2606:4700:4700::1111']), [
    'A record   hub.example.com   →   1.1.1.1',
    'AAAA record   hub.example.com   →   2606:4700:4700::1111',
  ]);
});

test('ports 80/443 from ss output', () => {
  const ss = [
    'LISTEN 0      511          0.0.0.0:80        0.0.0.0:*',
    'LISTEN 0      4096       127.0.0.1:7433      0.0.0.0:*',
    'LISTEN 0      511             [::]:443          [::]:*',
    'LISTEN 0      128          0.0.0.0:8080      0.0.0.0:*',
  ].join('\n');
  assert.deepEqual(H.busyPorts(ss), { 80: true, 443: true });
  assert.deepEqual(H.busyPorts('LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:4430 0.0.0.0:*'), { 80: false, 443: false });
});

test('which web server owns 80/443, for each case', () => {
  const free = { 80: false, 443: false };
  const busy = { 80: true, 443: true };
  assert.equal(H.classifyWebServer({ ports: free }).kind, 'none');
  assert.equal(H.classifyWebServer({ ports: busy, active: { caddy: true } }).kind, 'caddy');
  assert.equal(H.classifyWebServer({ ports: free, installed: { caddy: true } }).kind, 'caddy', 'installed but stopped, ports free');
  assert.equal(H.classifyWebServer({ ports: busy, active: { nginx: true } }).kind, 'nginx');
  assert.equal(H.classifyWebServer({ ports: busy, active: { apache: true } }).kind, 'apache');
  assert.equal(H.classifyWebServer({ ports: busy, installed: { nginx: true } }).kind, 'nginx');
  assert.equal(H.classifyWebServer({ ports: busy }).kind, 'other');
  assert.deepEqual(H.classifyWebServer({ ports: busy, active: { nginx: true }, panel: 'cPanel' }), { kind: 'panel', panel: 'cPanel', busy: true });
});

test('the plan for each web server, domain and IP', () => {
  const p = (kind, ip = false) => H.httpsPlan({ web: { kind, panel: 'Plesk' }, address: ip ? '1.1.1.1' : 'hub.example.com', port: 7433, ip });
  assert.deepEqual(p('none'), { action: 'caddy', install: true, mode: 'domain' });
  assert.deepEqual(p('caddy'), { action: 'caddy', install: false, mode: 'domain' });
  assert.deepEqual(p('none', true), { action: 'caddy', install: true, mode: 'ip' });
  assert.equal(p('nginx').action, 'print');
  assert.equal(p('nginx').server, 'nginx');
  assert.equal(p('apache').server, 'apache');
  assert.equal(p('panel').action, 'panel');
  assert.equal(p('other').action, 'blocked');
  assert.equal(p('nginx', true).action, 'blocked', 'an IP certificate needs Caddy on 80/443');
});

test('the Caddy site, exactly, for a domain, an IP and an internal certificate', () => {
  const mark = '# hoprig hub: written by `hoprig setup --hub`; hoprig rewrites this file, edit the Caddyfile instead';
  assert.equal(H.caddySite({ address: 'hub.example.com', port: 7433 }), `${mark}\nhub.example.com {\n\treverse_proxy 127.0.0.1:7433\n}\n`);
  assert.equal(H.caddySite({ address: '1.1.1.1', port: 7433, mode: 'ip' }),
    `${mark}\n1.1.1.1 {\n\ttls {\n\t\tissuer acme {\n\t\t\tprofile shortlived\n\t\t}\n\t}\n\treverse_proxy 127.0.0.1:7433\n}\n`);
  assert.equal(H.caddySite({ address: 'hub.test', port: 8000, mode: 'internal' }), `${mark}\nhub.test {\n\ttls internal\n\treverse_proxy 127.0.0.1:8000\n}\n`);
});

test('the import line is added once, keeping the Caddyfile', () => {
  const def = ':80 {\n\troot * /usr/share/caddy\n\tfile_server\n}';
  assert.equal(H.withImport(def), `${def}\n\nimport hoprig.caddy\n`);
  assert.equal(H.withImport(H.withImport(def)), null);
  assert.equal(H.withImport(''), '\nimport hoprig.caddy\n');
});

test('the nginx and Apache blocks, exactly', () => {
  assert.equal(H.nginxSite({ domain: 'hub.example.com', port: 7433 }), `server {
    listen 443 ssl;
    server_name hub.example.com;
    # ssl_certificate and ssl_certificate_key: your certificate for hub.example.com (for example: sudo certbot --nginx -d hub.example.com)

    location / {
        proxy_pass http://127.0.0.1:7433;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
        client_max_body_size 30m;
    }
}
`);
  assert.equal(H.apacheSite({ domain: 'hub.example.com', port: 7433 }), `# Needs Apache 2.4.47 or newer and: sudo a2enmod ssl proxy proxy_http headers
<VirtualHost *:443>
    ServerName hub.example.com
    # SSLEngine on, SSLCertificateFile and SSLCertificateKeyFile: your certificate (for example: sudo certbot --apache -d hub.example.com)
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "https"
    ProxyPass / http://127.0.0.1:7433/ upgrade=websocket
    ProxyPassReverse / http://127.0.0.1:7433/
    ProxyTimeout 3600
</VirtualHost>
`);
});

test('a hub reached by its IP address: default_sni goes into the Caddyfile global options, a domain gets none', () => {
  const note = '# hoprig hub: the certificate for a visitor who names no server (a browser opening an IP address). hoprig setup --hub keeps the next block.';
  // the Caddyfile the package installs: no global options yet, so a block is put on top
  const pkg = '# The Caddyfile is an easy way to configure your Caddy web server.\n\n:80 {\n\troot * /usr/share/caddy\n\tfile_server\n}\n';
  const withIp = H.withDefaultSni(pkg, '1.1.1.1');
  assert.equal(withIp, `${note}\n{\n\tdefault_sni 1.1.1.1 # hoprig hub\n}\n\n${pkg}`);
  assert.equal(H.withDefaultSni(withIp, '1.1.1.1'), null, 'already there: nothing changes');
  // the address changed: our line follows it; IPv6 is written without brackets (a name, not a place to connect to)
  assert.equal(H.withDefaultSni(withIp, '[2606:4700:4700::1001]'), withIp.replace('default_sni 1.1.1.1', 'default_sni 2606:4700:4700::1001'));
  // the hub moved to a domain: our line and the block we made go, the file is as it was
  assert.equal(H.withDefaultSni(withIp, null), pkg);
  assert.equal(H.withDefaultSni(pkg, null), null);
  // an owner's own global options: the line goes into that block and comes out again without touching the rest
  const own = '{\n\temail admin@example.com\n\tservers {\n\t\tprotocols h1 h2\n\t}\n}\n\nexample.com {\n\trespond "hi"\n}\n';
  const inOwn = H.withDefaultSni(own, '1.1.1.1');
  assert.equal(inOwn, own.replace('{\n', '{\n\tdefault_sni 1.1.1.1 # hoprig hub\n'));
  assert.equal(H.withDefaultSni(inOwn, null), own);
  // an owner who set default_sni themselves keeps it (also below a nested block)
  assert.equal(H.withDefaultSni('{\n\tservers {\n\t\tprotocols h1\n\t}\n\tdefault_sni hub.example.com\n}\n', '1.1.1.1'), null);
  // a default_sni inside a site's own block is not the global one
  const site = 'example.com {\n\ttls {\n\t\tdefault_sni x\n\t}\n}\n';
  assert.equal(H.withDefaultSni(site, '1.1.1.1'), `${note}\n{\n\tdefault_sni 1.1.1.1 # hoprig hub\n}\n\n${site}`);
  // a fresh, empty Caddyfile, then our import: the global options stay first
  const fresh = H.withDefaultSni('', '192.168.1.9');
  assert.equal(fresh, `${note}\n{\n\tdefault_sni 192.168.1.9 # hoprig hub\n}\n`);
  assert.match(H.withImport(fresh), /^# hoprig hub[^\n]*\n\{\n\tdefault_sni 192\.168\.1\.9 # hoprig hub\n\}\n\nimport hoprig\.caddy\n$/);
});

test('Caddy install commands from caddyserver.com/docs/install, per package manager', () => {
  const apt = H.caddyInstallSteps('apt');
  assert.deepEqual(apt.map((x) => H.showStep(x)), [
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get update',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg',
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
    "curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list",
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get update',
    'sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y caddy',
  ]);
  // apt is told not to ask (https.mjs uses system.mjs's APT): as root too
  assert.deepEqual(H.caddyInstallSteps('apt', { root: true })[0].argv, ['env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'update']);
  assert.deepEqual(H.caddyInstallSteps('dnf', { osId: 'fedora' }).map((x) => x.argv.join(' ')),
    ['sudo dnf install -y dnf5-plugins', 'sudo dnf copr enable -y @caddy/caddy', 'sudo dnf install -y caddy']);
  assert.equal(H.caddyInstallSteps('dnf', { osId: 'rocky' })[0].argv.join(' '), 'sudo dnf install -y dnf-plugins-core');
  assert.deepEqual(H.caddyInstallSteps('pacman', { root: true }).map((x) => x.argv.join(' ')), ['pacman -Syu --noconfirm caddy']);
  assert.deepEqual(H.caddyInstallSteps('apk', { root: true }).map((x) => x.argv.join(' ')), ['apk add caddy']);
  assert.equal(H.caddyInstallSteps('zypper'), null, 'no documented command: none invented');
});

test('the hub settings for its address', () => {
  assert.deepEqual(H.hubSettings('https://hub.example.com', ['https://other.example']), {
    host: '127.0.0.1', trustProxy: true, allowedOrigins: ['https://other.example', 'https://hub.example.com'], publicUrl: 'https://hub.example.com/',
  });
  assert.deepEqual(H.hubSettings('https://hub.example.com', ['https://hub.example.com']).allowedOrigins, ['https://hub.example.com']);
});

test('firewall: ufw or firewalld when active, with the command for 80 and 443', { skip: process.platform === 'win32' && 'Linux firewalls and web servers are handed in, and Linux PATH rules cannot read a Windows PATH' }, async () => {
  const ufw = fakeBin(path.join(s.tmp, 'fw-ufw'), { ufw: 'exit 0', systemctl: '[ "$2" = ufw ] && echo active || echo inactive' });
  assert.deepEqual(await H.firewallPlan({ env: { PATH: pathWith(s.tmp, ufw) }, platform: 'linux' }), { name: 'ufw', steps: [['sudo', 'ufw', 'allow', '80,443/tcp']] }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  const fwd = fakeBin(path.join(s.tmp, 'fw-firewalld'), { 'firewall-cmd': 'exit 0', systemctl: '[ "$2" = firewalld ] && echo active || echo inactive' });
  assert.deepEqual((await H.firewallPlan({ env: { PATH: pathWith(s.tmp, fwd) }, platform: 'linux', root: true })).steps, // seal: only the test's own folders, in an environment that keeps the runner's variables
    [['firewall-cmd', '--permanent', '--add-service=http', '--add-service=https'], ['firewall-cmd', '--reload']]);
  const off = fakeBin(path.join(s.tmp, 'fw-off'), { ufw: 'exit 0', systemctl: 'echo inactive' });
  assert.equal(await H.firewallPlan({ env: { PATH: pathWith(s.tmp, off) }, platform: 'linux' }), null); // seal: only the test's own folders, in an environment that keeps the runner's variables
});

test('detection with fake programs: nginx running, Caddy installed, nothing', { skip: process.platform === 'win32' && 'Linux firewalls and web servers are handed in, and Linux PATH rules cannot read a Windows PATH' }, async () => {
  const run = async (programs, exists = () => false) => H.detectWebServer({ env: { PATH: pathWith(s.tmp, fakeBin(path.join(s.tmp, `web-${Object.keys(programs).join('-')}`), programs)) }, platform: 'linux', exists }); // seal: only the test's own folders, in an environment that keeps the runner's variables
  const nginx = await run({ nginx: 'exit 0', ss: 'echo "LISTEN 0 511 0.0.0.0:80 0.0.0.0:*"', systemctl: '[ "$2" = nginx ] && echo active || echo inactive' });
  assert.equal(nginx.kind, 'nginx');
  const caddy = await run({ caddy: 'exit 0', ss: 'echo "LISTEN 0 128 127.0.0.1:7433 0.0.0.0:*"', systemctl: 'echo inactive' });
  assert.equal(caddy.kind, 'caddy');
  const none = await run({ ss: 'true' });
  assert.equal(none.kind, 'none');
  const panel = await run({ ss: 'echo "LISTEN 0 511 0.0.0.0:443 0.0.0.0:*"' }, (p) => p === '/usr/local/psa');
  assert.deepEqual([panel.kind, panel.panel], ['panel', 'Plesk']);
});

test('the outside check: 200, retried, then the last answer', async () => {
  let n = 0;
  assert.equal(await H.httpsCheck('https://hub.example.com', { waitMs: 1, fetchImpl: async () => ({ status: ++n < 3 ? 502 : 200 }) }), 200);
  assert.equal(await H.httpsCheck('https://hub.example.com', { tries: 2, waitMs: 1, fetchImpl: async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); } }), 'ECONNREFUSED');
});
