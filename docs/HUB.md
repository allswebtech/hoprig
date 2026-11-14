# Put a hub live

A **hub** is one Hoprig dashboard that can always be reached, usually on a small server, that shows and drives
all your other computers on one page, your phone included. It does no work itself: no Claude Code and no
terminals run on it. It only relays.

Not sure you need one? Check [Which setup is mine?](COMPUTERS.md#which-setup-is-mine) first: with several PCs on
one network, or with Tailscale, you need no server at all.

## The one command

On a fresh Linux server (Debian, Ubuntu, Fedora, Arch or Alpine), after [installing Hoprig](INSTALL.md):

```sh
hoprig setup --hub                            # reached by the server's IP address: https://203.0.113.10/
hoprig setup --hub --domain hub.example.com   # or by your own domain: https://hub.example.com/
```

It does, in this order:

1. **A dashboard password**: made for you and kept in a private file. You will rarely type it: you sign in by
   scanning a QR code.
2. **HTTPS in front**, with [Caddy](https://caddyserver.com), which gets and renews the certificate by itself. When
   nothing uses ports 80 and 443 yet, setup lists what it will do and asks **once**:
   - install Caddy with the commands from [caddyserver.com/docs/install](https://caddyserver.com/docs/install)
   - write its site to `/etc/caddy/hoprig.caddy` and one `import` line into `/etc/caddy/Caddyfile` (the
     original is kept as `Caddyfile.before-hoprig`)
   - open ports 80 and 443 in the firewall when `ufw` or `firewalld` is on
3. **Runs it in the background**, so it starts with the server.
4. **Shows a QR code**: scan it with your phone to sign in, and the command to connect each PC (below).

`--yes` answers the one question with yes; `--dry-run` shows everything and changes nothing. A hub stops there:
the coding parts of setup (tools, a project, skills; see [INSTALL.md](INSTALL.md)) are for the computers that
join it, not for the hub.

### By IP address, with no domain

Without `--domain`, the hub uses the server's public IP address, over HTTPS with a real certificate: Let's Encrypt
has issued certificates for IP addresses since 15 January 2026. They last six days (160 hours); Caddy renews them
by itself, so you do nothing. Two conditions, both normal on a VPS: the address must be the server's own public one,
and ports 80 and 443 must be open to the internet (also in your cloud provider's firewall, if it has one).

A server behind NAT (some clouds show only a private address on the machine): pass its public address,
`--ip 203.0.113.10`.

### With a domain

Create a DNS record first, at the company where your domain is:

| Type | Name | Value |
| --- | --- | --- |
| A | `hub` (for hub.example.com) | your server's IPv4 address |

When the domain does not point to the server yet, setup says exactly which record to create and stops without
changing anything. Run it again a few minutes after you made the record.

### nginx or Apache already on the server

Setup never touches them. It prints the site block to add (ready to paste: the proxy to `127.0.0.1:7433` with
WebSockets passed through) and sets the hub's own settings (`trustProxy`, the allowed address). A control panel
(cPanel, Plesk, aaPanel, …) manages the web server: add a reverse proxy there to `127.0.0.1:7433` with WebSockets on.

### No public certificate possible: the hub's own certificate (a private network, a test)

A hub reached by a private IP address (a small server at home, `192.168.1.5`) or a name only your network knows
cannot get a public certificate. Then Caddy makes its own, from its own certificate authority:

```sh
hoprig setup --hub --ip 192.168.1.5 --tls-internal       # by IP address
hoprig setup --hub --domain hub.lan --tls-internal       # by a private name
```

It is still encrypted. Browsers warn once, because no public authority vouches for it. The other computers do
not need to be told to "trust anything": the line the hub shows carries a **fingerprint** of its authority, and
they check the hub against it:

```sh
hoprig join https://192.168.1.5 K7QM-4XP2 --fingerprint sha256:Jx6Tq…(43 characters)
```

Step by step:

1. On the hub: `hoprig setup --hub --ip <its address> --tls-internal`. At the end it prints the whole line. For
   the next computer: `hoprig machines invite` on the hub, or on its page **Computers → Add a computer →** "It is
   at home or behind a router and cannot be reached from here" **→ Show a code**. Each shows the whole line.
2. On the other computer: type (or paste) that whole line. It checks the hub's certificate against the
   fingerprint, then joins. Without the fingerprint it stops and says where to read the line; with a wrong one it
   stops and sends nothing.
3. Done. From then on that computer checks the hub against the same fingerprint on every connection (also
   after a restart or a dropped network).

**What the fingerprint is.** `sha256:` and 43 characters: the SHA-256 of the public key of Caddy's own root
authority on the hub (base64url). You read it on the hub, where you also read the code, and you type both on the
other computer: whoever could change what you read there could already take the code. With it, the other computer
accepts a certificate no public authority signed **only** when it was signed by that one authority, for that
address. Nothing is switched off: the address in the certificate, its dates and its signatures are checked as
always, and a connection that does not match is refused before the code or anything else is sent.

**When the certificate renews.** Caddy renews the hub's certificate every few hours and the authority's
intermediate certificate every few days. Neither changes the fingerprint (it is the root's key, valid ten years),
so nothing happens on the computers.

**When the fingerprint changes.** Only when Caddy's authority itself is new: Caddy reinstalled with its data
folder lost, a new server, or the root at the end of its ten years. Then each joined computer stops connecting and
says so ("…is no longer signed by the authority this computer pinned when it joined…"). Show the line on the hub
again and run it on each computer.

**When the hub cannot tell its fingerprint.** The hub reads Caddy's authority from Caddy's admin API
(`localhost:2019`, on by default, also in a container) and checks that its own address really presents a
certificate signed by it. When that fails (the admin API turned off, another web server in front), the line comes
without the fingerprint and says so. Read it on the hub by hand:

```sh
hoprig machines fingerprint
# or, from Caddy's data folder (Debian/Ubuntu/Fedora package):
sudo cat /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt | hoprig machines fingerprint -
```

and add `--fingerprint <it>` to the line.

**Not `--insecure`.** `--insecure` is for a plain `http://` address on a network you trust: no encryption at
all. It does nothing for a certificate, and a certificate problem is never fixed with it.

A hub with a public certificate (a domain, or a public IP with Let's Encrypt) needs none of this: its line has no
fingerprint, and the same command works as always. A fingerprint given anyway is still checked.

## Connect each PC

At the end, setup prints a line like this, ready to copy. Run it on each PC (the code works once, for 10 minutes):

```sh
hoprig join https://hub.example.com K7QM-4XP2
```

For a hub with its own certificate (`--tls-internal`), the line ends with `--fingerprint sha256:…`: copy all of it
([why](#no-public-certificate-possible-the-hubs-own-certificate-a-private-network-a-test)).

For the next PC, make a new code on the hub with `hoprig machines invite` (or on the hub's page: **Computers → Add a
computer →** "It is at home or behind a router and cannot be reached from here" **→ Show a code**).
The PCs connect out to the hub, so nothing has to be opened at home. Other servers can join the same way, or be
added by SSH name. All of it is in [COMPUTERS.md](COMPUTERS.md).

## What it needs

Measured on 14 Nov 2026 on a 4-core Linux PC (Node.js 26). The numbers are for the hub process alone, with 20
computers linked and 20 terminals open through it, each printing a line every 50 ms (about 1.3 KB/s each):

| Load | Memory (RSS) | CPU (one core) |
| --- | --- | --- |
| idle, nothing linked | 77 MB | 0.1 % |
| 20 computers linked | 81 MB | 0.2 % |
| 20 computers, 5 busy terminals | 81 MB | 1.7 % |
| 20 computers, 20 busy terminals | 89 MB (peak 109 MB) | 6 % |

It still ran correctly with its JavaScript heap capped at 16 MB (at 12 MB it ran out of memory). So:

- **Smallest server: 512 MB RAM, 1 CPU core.** That leaves room for the system, Caddy and a few sign-ins at once
  (each password check takes 32 MB for a moment). 256 MB is too tight once the system and Caddy are counted.
- Disk: about 100 MB for Node.js and Hoprig.
- Bandwidth: what your terminals print, a few KB/s each.

## On SixPanel

SixPanel is a hosting control panel for your own servers. A Node.js site on it is described by a `sixpanel.json`
at the root of its files, and Hoprig has one:

1. In SixPanel, create a Node.js website from this repository (or upload its files).
2. Deploy. The file already sets everything: Node.js 24, `npm ci` without the terminal module (no build tools
   needed), one process (the hub keeps its connections in memory), a 256 MB limit, the health check
   `/healthz`, the folder `data/` kept between deploys, and the hub's settings
   (`HOPRIG_HUB=1`, `HOPRIG_CONFIG_DIR`, `HOPRIG_STATE_DIR`, `HOPRIG_PUBLIC_URL=${SITE_URL}`).
3. Give the website its domain in SixPanel (it makes the certificate).
4. Your password is in `data/dashboard-password.txt` in the website's files. Sign in with it, then sign in your
   phone from **Settings → Security and sign-in → Sign in another device**.

Nothing to fill in by hand. What we could not check in SixPanel's schema: which variable carries the port (the hub
reads `PORT`), and whether its web server passes WebSockets through (the hub needs that). See the note at the end.

## With Docker

The `Dockerfile` in this repository builds a hub-only image (Node.js slim, no build tools, no terminal module):

```sh
docker build -t hoprig-hub .
docker run -d --name hoprig-hub --restart unless-stopped \
  -p 127.0.0.1:7433:7433 -v hoprig-data:/data hoprig-hub
docker exec hoprig-hub cat /data/dashboard-password.txt   # your password
```

Put HTTPS in front on the host (`hoprig setup --hub` does not run inside the container; Caddy on the host with
`hub.example.com { reverse_proxy 127.0.0.1:7433 }` does it), and set the address the hub is reached at:
`-e HOPRIG_PUBLIC_URL=https://hub.example.com`. The image answers `/healthz` for Docker's health check.

Any other process manager works the same way: `PORT` and `HOST` choose where it listens, `HOPRIG_CONFIG_DIR` and
`HOPRIG_STATE_DIR` where it keeps its data, `HOPRIG_HUB=1` makes it a hub, and
`hoprig serve --password-file FILE` makes a password on the first start instead of refusing to start.

## Shared hosting usually does not work

Ordinary shared web hosting (the kind sold for WordPress) runs PHP for each request and stops programs that keep
running. A hub is a program that has to run all the time and keep WebSocket connections open to every computer
and browser. Choose a VPS (from about 512 MB RAM), a hosting panel that runs Node.js apps on your own server, or
Docker instead.

---

**Sources, read 14 Nov 2026.** IP-address certificates:
[letsencrypt.org, "6-day and IP Address Certificates are Generally Available"](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)
and [ACME profiles](https://letsencrypt.org/docs/profiles/); Caddy's `profile` setting:
[caddyserver.com/docs/caddyfile/directives/tls](https://caddyserver.com/docs/caddyfile/directives/tls) (marked
experimental). SixPanel's schema: <https://installer.allsweb.net/sixpanel/sixpanel.schema.json>.
