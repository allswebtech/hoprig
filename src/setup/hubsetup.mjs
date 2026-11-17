// The HTTPS part of `hoprig setup --hub`: decide (https.mjs), confirm once, do, and check from the outside view.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { APP, DEFAULT_PORT, probe } from './checks.mjs';
import { stateDir, tilde } from '../paths.mjs';
import {
  caddyInstallSteps, caddyPaths, caddySite, cleanDomain, detectWebServer, dnsAdvice, dnsCheck, firewallPlan, hubSettings,
  httpsCheck, httpsPlan, isPublicIp, publicAddresses, showStep, urlHost, withDefaultSni, withImport,
} from './https.mjs';
import { capture, forThisUser, osRelease, runQuiet, showCommand, which } from './system.mjs';
import { withoutSecrets } from '../secretenv.mjs';

/** The address to serve: { address, ip: boolean } from --domain / --ip / this server's public address, or null. */
export function hubAddress(opts, publicIps) {
  if (opts.domain) return { address: cleanDomain(opts.domain), ip: false };
  // --tls-internal: Caddy's own certificate, so any address works, a private one included.
  if (opts.ip) return isPublicIp(opts.ip) || (opts.tlsInternal && net.isIP(opts.ip)) ? { address: opts.ip, ip: true } : null;
  return publicIps.length ? { address: publicIps[0], ip: true } : null;
}

const su = (sys, argv) => (sys.root ? argv : ['sudo', ...argv]);

/** Where the output of this step's commands goes (the package manager's is long): shown only when one fails. */
export const hubLog = () => path.join(stateDir(), 'setup-hub.log');

/**
 * Run one command of this step without showing its output (it goes to hubLog()). When it fails its last lines
 * are shown, with where the rest is. sudo asks for its password on the terminal itself.
 */
async function quiet(ui, sys, argv) {
  const r = await runQuiet(argv, { env: withoutSecrets(sys.env), log: hubLog() }); // package installs run their scripts
  if (!r.ok) {
    if (r.tail) ui.out(r.tail.split('\n').map((l) => `    ${l}`).join('\n'));
    ui.note(`All of its output: ${tilde(hubLog())}`);
  }
  return r.ok;
}

/** Put `text` at `dest` (root-owned, mode 644) through a temporary file: `install` does it in one step. */
async function putFile(ui, sys, text, dest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-'));
  const tmp = path.join(dir, path.basename(dest));
  fs.writeFileSync(tmp, text);
  try {
    return await quiet(ui, sys, su(sys, ['install', '-m', '644', '-D', tmp, dest]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runStep(ui, sys, step) {
  if (step.argv) return quiet(ui, sys, step.argv);
  const res = await fetch(step.download, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return false;
  const text = await res.text();
  if (step.to) return putFile(ui, sys, text, step.to);
  // The signing key: gpg --dearmor, as the install page does.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-'));
  try {
    fs.writeFileSync(path.join(dir, 'key'), text);
    return await quiet(ui, sys, su(sys, ['gpg', '--batch', '--yes', '--dearmor', '-o', step.dearmor, path.join(dir, 'key')]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Reload (or start) Caddy so it reads the new site. */
async function reloadCaddy(ui, sys, paths) {
  const systemd = sys.has('systemctl') && (await capture(['systemctl', 'is-system-running'], { env: sys.env, timeout: 5000 })).stdout.trim() !== 'offline'
    && fs.existsSync('/run/systemd/system');
  if (systemd) {
    if (!(await quiet(ui, sys, su(sys, ['systemctl', 'enable', '--now', 'caddy'])))) return false;
    return quiet(ui, sys, su(sys, ['systemctl', 'reload', 'caddy']));
  }
  // No systemd (a container): reload a running Caddy through its admin API, or start one in the background.
  const reload = await capture(su(sys, ['caddy', 'reload', '--config', paths.caddyfile]), { env: sys.env, timeout: 30_000 });
  if (reload.ok) return true;
  return (await capture(su(sys, ['caddy', 'start', '--config', paths.caddyfile]), { env: sys.env, timeout: 30_000 })).ok;
}

/**
 * The HTTPS step. Returns true when it is set up (or nothing was to be done), false when it stopped.
 * Sets state.httpsOrigin (to check after the service starts) and state.phoneUrl.
 */
export async function stepHttps(ui, sys, opts, state, { detect = detectWebServer, resolver, caddyDir } = {}) {
  const cfg = loadConfig();
  const port = cfg.server.port || DEFAULT_PORT;
  const publicIps = sys.publicIps ?? publicAddresses();
  if (opts.domain && !cleanDomain(opts.domain)) {
    ui.line('fail', `"${opts.domain}" is not a domain name (like hub.example.com).`);
    return false;
  }
  if (opts.ip && !isPublicIp(opts.ip) && !opts.tlsInternal) {
    ui.line('fail', `${opts.ip} is not a public address: Let's Encrypt can only certify an address the internet reaches.`);
    return false;
  }
  const where = hubAddress(opts, publicIps);
  if (!where) return null; // no public address and no domain: a hub at home, the normal access question applies
  const origin = `https://${urlHost(where.address)}`;

  if (!where.ip && !opts.tlsInternal) {
    if (!publicIps.length && !opts.ip) {
      ui.line('warn', 'This server shows no public address of its own (a cloud server behind NAT?). Checking the domain anyway.');
    }
    const d = await dnsCheck(where.address, opts.ip ? [opts.ip] : publicIps, resolver);
    if (!d.ok) {
      const found = [...d.records.A, ...d.records.AAAA];
      ui.line('fail', `${where.address} does not point to this server yet${found.length ? ` (it points to ${found.join(', ')})` : ''}.`);
      if (d.want.length) {
        ui.note('At your domain\'s DNS provider, create:');
        for (const l of dnsAdvice(where.address, d.want)) ui.note(`  ${l}`);
      } else ui.note(`Create an A record for ${where.address} with this server's public IPv4 address (or pass it: --ip <address>).`);
      ui.note(`Then run this again (DNS changes can take a few minutes): ${APP} setup --hub --domain ${where.address}`);
      return false;
    }
    ui.line('ok', `${where.address} points to this server`);
  }

  const web = await detect({ env: sys.env, platform: sys.platform });
  const plan = httpsPlan({ web, address: where.address, port, ip: where.ip });
  const settings = hubSettings(origin, cfg.server.allowedOrigins || []);
  const applySettings = () => {
    if (ui.dryRun) return;
    const now = loadConfig().server;
    if (Object.entries(settings).some(([k, v]) => JSON.stringify(now[k]) !== JSON.stringify(v))) {
      saveConfig({ server: settings });
      state.changed = true;
    }
  };

  if (plan.action === 'blocked') {
    ui.line('fail', `${plan.reason}: ${APP} cannot put HTTPS in front of the hub by itself here. Free them, or use a domain with your web server.`);
    return false;
  }
  if (plan.action === 'print' || plan.action === 'panel') {
    ui.line('info', plan.action === 'panel'
      ? `${plan.panel} manages the web server here: add a reverse proxy site for ${where.address} to 127.0.0.1:${port} in it (WebSockets on). For reference, the nginx form:`
      : `${plan.server === 'nginx' ? 'nginx' : 'Apache'} already serves ports 80/443; ${APP} does not change it. Add this site to it:`);
    ui.out(plan.block.split('\n').map((l) => `    ${l}`).join('\n'));
    applySettings();
    ui.line(ui.dryRun ? 'info' : 'ok', `${ui.dryRun ? 'Would set' : 'Set'} the hub's own settings: host 127.0.0.1, trustProxy, allowedOrigins ${origin}`);
    state.phoneUrl = `${origin}/`;
    state.httpsOrigin = origin;
    return true;
  }

  // Caddy: install it if needed, then our site.
  const paths = caddyPaths(caddyDir);
  const mode = opts.tlsInternal ? 'internal' : where.ip ? 'ip' : 'domain';
  const site = caddySite({ address: urlHost(where.address), port, mode });
  const current = (() => {
    try {
      return fs.readFileSync(paths.site, 'utf8');
    } catch {
      return null;
    }
  })();
  let caddyfile = '';
  try {
    caddyfile = fs.readFileSync(paths.caddyfile, 'utf8');
  } catch {
    /* a fresh install writes it */
  }
  const install = plan.install ? caddyInstallSteps(sys.pm === 'apt-get' ? 'apt' : sys.pm, { root: sys.root, osId: osRelease().ID || '' }) : [];
  if (install === null) {
    ui.line('fail', `There is no documented Caddy package for this system: install Caddy (https://caddyserver.com/docs/install), then run this again.`);
    return false;
  }
  const fw = await firewallPlan({ env: sys.env, platform: sys.platform, root: sys.root });
  // A hub reached by its IP address needs one global option in the Caddyfile (https.mjs: withDefaultSni); a hub on
  // a domain needs none, and a line of ours from an earlier address is taken out.
  const sni = where.ip ? where.address : null;
  /** The Caddyfile as it has to be, or null when it is right already. */
  const nextCaddyfile = (text) => {
    const a = withDefaultSni(text, sni) ?? text;
    const b = withImport(a) ?? a;
    return b === text ? null : b;
  };
  const todo = [];
  for (const s of install) todo.push(forThisUser(showStep(s, sys.root), sys));
  if (current !== site) todo.push(`write ${paths.site} (our site: ${origin} → 127.0.0.1:${port})`);
  if (withImport(caddyfile) !== null || plan.install) todo.push(`add "import ${path.basename(paths.site)}" to ${paths.caddyfile}`);
  if (sni && (withDefaultSni(caddyfile, sni) !== null || plan.install)) todo.push(`add "default_sni ${sni}" to the global options of ${paths.caddyfile} (a browser names no server when it opens an IP address)`);
  if (!sni && withDefaultSni(caddyfile, null) !== null) todo.push(`take our "default_sni" line (from an earlier IP address) out of ${paths.caddyfile}`);
  if (fw) for (const s of fw.steps) todo.push(forThisUser(showCommand(s), sys));
  if (todo.length) {
    const how = mode === 'internal' ? ' (Caddy\'s own certificate: browsers warn once, it is not publicly trusted)' : mode === 'ip' ? ' (a Let\'s Encrypt certificate for the IP address, renewed every few days by Caddy)' : '';
    ui.line('info', `HTTPS for ${origin} with Caddy${how}. To do:`);
    for (const t of todo) ui.note(`  ${t}`);
    if (!fw) ui.note('Open ports 80 and 443 in your cloud provider\'s firewall too, if it has one.');
    if (!(await ui.confirm('Go ahead?', true))) {
      if (!ui.dryRun) ui.note('Nothing was changed.');
      applySettings();
      state.phoneUrl = `${origin}/`;
      return ui.dryRun;
    }
    if (!sys.root && typeof sys.has === 'function' && !sys.has('sudo')) {
      ui.line('fail', `These need administrator rights and sudo is not installed: run "${APP} setup --hub …" as root.`);
      return false;
    }
    try {
      fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      fs.writeFileSync(hubLog(), '', { mode: 0o600 });
    } catch {
      /* without a log the commands still run */
    }
    if (install.length) ui.note(`Installing Caddy… (the commands' output: ${tilde(hubLog())})`);
    for (const step of install) {
      if (!(await runStep(ui, sys, step))) {
        ui.line('fail', `"${showStep(step, sys.root)}" did not succeed.`);
        return false;
      }
    }
    if (plan.install && !caddyfile) {
      try {
        caddyfile = fs.readFileSync(paths.caddyfile, 'utf8');
      } catch {
        caddyfile = '';
      }
    }
    if (current !== site && !(await putFile(ui, sys, site, paths.site))) {
      ui.line('fail', `Could not write ${paths.site}.`);
      return false;
    }
    const next = nextCaddyfile(caddyfile);
    const backup = `${paths.caddyfile}.before-hoprig`;
    if (next !== null) {
      if (caddyfile && !fs.existsSync(backup)) await quiet(ui, sys, su(sys, ['cp', '-p', paths.caddyfile, backup]));
      if (!(await putFile(ui, sys, next, paths.caddyfile))) {
        ui.line('fail', `Could not change ${paths.caddyfile}.`);
        return false;
      }
    }
    const caddy = which('caddy', sys.env, sys.platform) || 'caddy';
    const valid = await capture(su(sys, [caddy, 'validate', '--config', paths.caddyfile]), { env: sys.env, timeout: 60_000 });
    if (!valid.ok) {
      ui.line('fail', `Caddy does not accept the configuration: ${(valid.stderr || valid.stdout).trim().split('\n').slice(-3).join(' ')}`);
      if (next !== null && fs.existsSync(backup)) {
        await quiet(ui, sys, su(sys, ['cp', '-p', backup, paths.caddyfile]));
        ui.note(`${paths.caddyfile} is back as it was.`);
      }
      return false;
    }
    if (!(await reloadCaddy(ui, sys, paths))) {
      ui.line('fail', 'Caddy did not reload. See: systemctl status caddy   (or: journalctl -u caddy)');
      return false;
    }
    if (fw) for (const s of fw.steps) await quiet(ui, sys, s);
    ui.line('ok', `Caddy serves ${origin}`);
  } else ui.line('ok', `Caddy serves ${origin}`);
  applySettings();
  state.phoneUrl = `${origin}/`;
  state.httpsOrigin = origin;
  state.httpsUntrusted = mode === 'internal';
  return true;
}

/** After the dashboard runs: does https://<address>/login answer from the outside view? */
export async function stepHttpsVerify(ui, state, { check = httpsCheck, local = probe } = {}) {
  if (!state.httpsOrigin || ui.dryRun) return true;
  const port = loadConfig().server.port || DEFAULT_PORT;
  if ((await local('127.0.0.1', port)) !== 200) {
    ui.line('info', `${state.httpsOrigin} answers once the dashboard runs: ${APP} serve`);
    return true;
  }
  const r = await check(state.httpsOrigin, { untrusted: !!state.httpsUntrusted });
  if (r === 200) {
    ui.line('ok', `${state.httpsOrigin}/login answers over HTTPS`);
    return true;
  }
  ui.line('warn', `${state.httpsOrigin}/login does not answer yet (${r}). The certificate can take a minute; if it stays so: ports 80 and 443 open? the dashboard running (${APP} doctor)?`);
  return false;
}
