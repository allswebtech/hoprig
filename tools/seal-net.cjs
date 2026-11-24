'use strict';
// The seal's second half, in the test file's own process (tools/test-seal.mjs loads it): no test connects to a
// DEFAULT port of the product, on any host. Those are where a contributor's own dashboard, router and gateway listen;
// a test that starts the dashboard, or runs the Operator's look, with settings that name no ports of their own knocks
// there once per tick. Every TCP client in Node passes through net.Socket.prototype.connect (net.connect and
// createConnection, http, https, tls and the global fetch), so that one function is wrapped: a connection to such a
// port fails as a closed port does (ECONNREFUSED, which every caller already handles) before a packet leaves, and one
// line goes into the runner's log, so the run fails by name.
//
// The numbers are read from the product's own source, not typed again here (test/seal.test.mjs holds them equal to
// the constants). Reading the text, not importing the modules, keeps the product's modules from loading before a test
// has set its own folders. HOPRIG_SEAL_EXTRA_PORTS only ADDS ports: the seal's own proof uses a port of its own.
// Listening on those ports is not refused; nothing of the product learns that it runs under a test.
// CommonJS, so the wrap (tools/test-seal.cjs) can load it as a --require preload; tools/seal-net.mjs re-exports it.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => { try { return fs.readFileSync(path.join(SRC, rel), 'utf8'); } catch { return ''; } };
const constant = (rel, name) => Number(new RegExp(`^export const ${name} = (\\d+);`, 'm').exec(read(rel))?.[1]) || null;

/** The gateways the product ships, from its source: [{ id, port }] (a test helper gives each a port of its own). */
function shippedGateways() {
  const shipped = /^export const SHIPPED = \[([\s\S]*?)^\];/m.exec(read('addons/gateways.mjs'))?.[1] || '';
  return [...shipped.matchAll(/^ {4}id: '([^']+)',[\s\S]*?^ {4}port: (\d+),/gm)].map((m) => ({ id: m[1], port: Number(m[2]) }));
}

/** The product's default ports, each with what listens there: [{ port, what }]. */
function defaultPorts() {
  const out = [
    { port: constant('server/server.mjs', 'DEFAULT_PORT'), what: 'the dashboard' },
    { port: constant('routerstate.mjs', 'DEFAULT_ROUTER_PORT'), what: 'the router' },
    ...shippedGateways().map((g) => ({ port: g.port, what: `the gateway ${g.id}` })),
    { port: constant('machines/hubcert.mjs', 'CADDY_ADMIN_PORT'), what: "Caddy's admin API" },
  ];
  return out.filter((p) => p.port);
}

/** Ports from HOPRIG_SEAL_EXTRA_PORTS (only adds): numbers 1 to 65535, by commas or spaces. */
const extraPorts = (value) => String(value || '').split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);

/**
 * Wraps net.Socket.prototype.connect so a connection to one of `ports` ([{ port, what }]) is refused and `onKnock`
 * ({ port, what, host }) is told. A Unix socket or a named pipe is never refused.
 */
function refusePorts(ports, onKnock) {
  const by = new Map(ports.map((p) => [p.port, p.what]));
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function sealedConnect(...args) {
    const norm = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    const o = (norm && norm[0]) || {};
    const port = o.path ? NaN : Number(o.port);
    if (!by.has(port)) return connect.apply(this, args);
    const host = o.host || 'localhost';
    try { onKnock({ port, what: by.get(port), host }); } catch { /* the refusal holds even when the log cannot be written */ }
    const err = Object.assign(new Error(`connect ECONNREFUSED ${host}:${port}`), { errno: -111, code: 'ECONNREFUSED', syscall: 'connect', address: host, port });
    this.connecting = true;
    process.nextTick(() => this.destroy(err));
    return this;
  };
}

module.exports = { shippedGateways, defaultPorts, extraPorts, refusePorts };
