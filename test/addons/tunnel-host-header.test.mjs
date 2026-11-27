// The gateway counts a request as local only with a loopback socket, a loopback Host and no forwarded header. So the
// tunnel must hand the PUBLIC host name through to it: the ingress rule written for the gateway carries the service
// address and the hostname, and nothing that rewrites the Host (no httpHostHeader, no originRequest, no flag for it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { configYaml } from '../../src/addons/fixedlink.mjs';

test('the written ingress rule of the gateway is its hostname and its service, and nothing that rewrites the Host', () => {
  const yaml = configYaml({ tunnelId: 'tid', creds: '/s/tunnel.json', hostname: 'dash.example.com', port: 7433, extra: [{ hostname: 'gw.example.com', port: 20017 }] });
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.includes('"gw.example.com"'));
  assert.ok(at > 0, 'the gateway has its rule');
  assert.equal(lines[at + 1], '    service: "http://127.0.0.1:20017"', 'its service address');
  assert.ok(!lines[at + 2].startsWith('    '), 'no key follows the service: the rule has no option of its own');
  assert.doesNotMatch(yaml, /httpHostHeader|originRequest|http-host-header|originServerName|localhost/i);
});

test('no code that writes or starts the tunnel sets a host header of its own', () => {
  for (const f of ['src/addons/fixedlink.mjs', 'src/addons/trouteaipublic.mjs', 'src/addons/linkswitch.mjs']) {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[^]*?\*\//g, '');
    assert.doesNotMatch(src, /httpHostHeader|http-host-header|originRequest|setHeader\(\s*['"]host['"]/i, `${f} leaves the Host as it came`);
  }
});
