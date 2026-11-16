# Several computers in one dashboard

Hoprig runs on each of your computers. One of them, the **hub**, shows the sessions of all of them on one
page (also on your phone) and lets you drive every one of them from there. Nothing is copied between computers:
each keeps its own sessions, providers and settings.

Install Hoprig on every computer first (see [INSTALL.md](INSTALL.md)). Then find your case below. All of them
are free except the server you may already rent.

## Which setup is mine?

| You have | What to do | Commands |
| --- | --- | --- |
| **One PC** | Nothing more: its own dashboard is all you need. For your phone on the same Wi-Fi, setup's "devices on my network" is enough. | `hoprig setup` |
| **Two or more PCs on the same network** | No server needed: on one of them, add the others. | On the one you open: **Computers → Add a computer →** "It has an address (the same network, or its public link)"; on each other PC: `hoprig pair` |
| **PCs at home, and you want them from elsewhere, no server** | Turn on the public link on the main one; the others link themselves to it ([below](#from-anywhere-the-public-link)). | **Settings → Public link** (`hoprig public on`); on each other PC: **Computers → Link to my main Hoprig** |
| **PCs at home plus one or more servers** | Make one server the hub; every PC joins it; the other servers join too or are added by SSH. | On the server: `hoprig setup --hub` (see [HUB.md](HUB.md)). On each PC: `hoprig join https://<hub> <code>`. Other servers: `hoprig join …` the same way, or on the hub `hoprig machines add user@server` |
| **Servers only** | The same: one is the hub, the others join it or are added by SSH. | As above |

The sections below explain each way of connecting. Putting a hub on a server (HTTPS, a domain or just the IP
address, SixPanel, Docker, what it needs) is in [HUB.md](HUB.md).

## Which computer should be the hub?

The one that is **always on and can be reached**: a server, or a cheap VPS. The hub is the page you open, so when
it is off you see nothing, even if the other computers are fine. Open the hub's page from your phone at its HTTPS
address (see [HUB.md](HUB.md)). To sign the phone in without typing the password, open
**Settings → Security and sign-in → Sign in another device** on a computer that is already signed in (or run
`hoprig link` on the hub)
and scan the code with the phone's camera.

## 1. A PC at home or in an office (recommended: the direct link)

No extra software: one dashboard on a computer that can be reached (a server or a cheap VPS), and every other PC
connects **out** to it. Your router stays closed; nothing has to be opened on the PC's side.

1. On the hub: **Computers → Add a computer →** "It is at home or behind a router and cannot be reached from
   here" **→ Show the line to paste** (or `hoprig machines invite`). The line is the hub's address with a code,
   such as `https://hub.example.com#join=K7QM-4XP2`; it works once, for 10 minutes.
2. On the PC: **Computers → Link to my main Hoprig** (or **Add a computer → Advanced → Show this computer on
   another dashboard**), paste the line, press **Link**. Or: `hoprig join 'https://hub.example.com#join=K7QM-4XP2'`.

The PC now shows in the hub's **Computers** list. Its own dashboard keeps the link open and opens it again after
a restart or a dropped network, so let the dashboard run in the background (`hoprig service install`, which setup
offers anyway).

- To stop: **Leave** on the PC (same place: **Show this computer on another dashboard**; or
  `hoprig join --leave https://hub.example.com`), or on the hub open the computer, **Advanced → Remove from
  this list**. Either one ends it on both sides.
- Control goes one way: the hub can drive the PC; the PC gets no access to the hub.
- Use an `https://` address. A plain `http://` address to another computer is refused unless you say
  `--insecure` (in the page: "Connect without encryption"): the link's token, and everything you type into that
  PC's sessions, would otherwise cross the network readable on the way. `--insecure` only means that: it is not
  a way around a certificate.
- A hub reached by a private IP address, with its own certificate (`hoprig setup --hub --ip … --tls-internal`):
  the line it shows carries its fingerprint (`…&fingerprint=sha256:…`, or `--fingerprint sha256:…` in the terminal
  form). Copy the whole line. The PC then checks the hub against
  that fingerprint, now and on every later connection; a hub that does not match is refused before anything is
  sent. The fingerprint stays the same when the hub's certificate renews. Details:
  [HUB.md](HUB.md#no-public-certificate-possible-the-hubs-own-certificate-a-private-network-a-test).

## 2. A server you can SSH into

You already log in to it with `ssh user@server` (or a name from `~/.ssh/config`) without typing a password.

On the hub: **Computers → Add a computer →** "I can reach it by SSH from this computer", type `user@server`,
press **Add**.
Or on the command line: `hoprig machines add user@server`.

Nothing has to be opened in a firewall: the hub connects through SSH, and the dashboard on the server keeps
listening on its own `127.0.0.1` only. If Hoprig is not installed there yet, the page shows the one line to
install it, and can run the installer for you. No password-free SSH login yet? Once, on the hub:
`ssh-copy-id user@server`.

**The other direction over SSH.** If the PC can SSH to the hub's computer but the hub cannot reach the PC, the
PC can also join over SSH instead of the direct link: `hoprig join user@server` (or **Connect by SSH instead**
under **Computers → Add a computer → Advanced → Show this computer on another dashboard**). The connection then arrives on a port of the server's `127.0.0.1` only, which is
what sshd does by default (`GatewayPorts no`); if the server's sshd is set to `GatewayPorts yes`, joining stops with
a message, because the port would otherwise be open to the whole network.

## From anywhere: the public link

- **From anywhere:** Settings → Public link → On. *Temporary* gives a new https address at each start with nothing
  to set up; *Custom* keeps your own address and needs a domain on a free Cloudflare account.
- **Another computer:** on it, **Computers → Link to my main Hoprig**, and paste the line the main one shows
  (**Settings → Public link → Link another computer**). No server, nothing opened on any router.
- **A server:** add it from the main one by SSH, or link it the same way.

With Temporary, a linked computer must be linked again when the main one's address changes: whenever Hoprig or the
computer restarts there (an update of Hoprig restarts it too).
Computers that should stay linked need Custom on the main one, or a server as the main one.

### How it works

**Settings → Public link** (or `hoprig public on`) makes this dashboard reachable from anywhere, with no server of
your own and nothing opened on your router: Cloudflare's program `cloudflared` connects out to Cloudflare and
visitors arrive through it. It is one switch, off until you turn it on, with one of two kinds; turning one kind on
turns the other off. The first time, Hoprig installs `cloudflared` into its own folder. Anyone who has the address
reaches the sign-in page, so the switch turns on only with a strong dashboard password (at least 12 characters and
not a common one; `hoprig public on --new-password FILE` makes one), and your traffic passes through Cloudflare.
The switch is remembered: when it was on, it is on again after the dashboard or the computer restarts.

**Temporary** (the default) needs nothing: Cloudflare's free quick tunnel gives this dashboard an
`https://…trycloudflare.com` address. It is new each time the link starts: whenever Hoprig or the computer restarts (an update of Hoprig restarts it too);
each new address is shown on the page and sent to your phone when **Settings → Notifications** has a push address.
Under **Advanced**, one more local service (such as TRouteAI's dashboard) can get a temporary address of its own while
the link is on as Temporary; it stops when the switch goes off or to Custom.

**Custom** keeps your own address, such as `https://office.example.com`. It needs a free Cloudflare account with a
domain on it (a domain you own, added to Cloudflare). To set it up:

1. Press **Set up**, then **Open Cloudflare**. Sign in, pick the domain for this address and press **Authorize**.
   You can do this in any browser, also on your phone; the page goes on by itself.
2. Type the address (a name under that domain; the computer's name is suggested) and press **Make it**. Hoprig
   makes a tunnel named `hoprig-<address>` in your Cloudflare account and a DNS record for the address, and turns
   the public link on as Custom.
3. Done. It runs with the dashboard and starts again by itself when it stops (after 2 seconds, then waiting longer
   each time, at most 5 minutes).

Everything cloudflared keeps (the sign-in to Cloudflare, the tunnel's key, its settings) stays in Hoprig's state
folder, readable only by you; your own `~/.cloudflared` is never read or changed.

Under **Advanced** for Custom:

- **Another service on this computer**: one more local service under a name of its own, such as TRouteAI's own
  dashboard on port 20017 at `trouteai-office.example.com`. Hoprig looks whether the service has a sign-in page of
  its own and asks first when it has none, because then anyone with the address can use it.
- **Use a tunnel token instead**: for a tunnel made in the Cloudflare dashboard (Networks → Tunnels). Give it a
  public hostname there that leads to `http://127.0.0.1:7433` (the dashboard's port), then paste its install
  command or token.
- **Stop using my domain**: Hoprig deletes the tunnel in your Cloudflare account and removes every file of it from
  this computer. The DNS records stay in Cloudflare, because cloudflared cannot remove DNS records: delete them under
  your domain → DNS → Records. Until then the address shows a Cloudflare error page (1016).

From a terminal: `hoprig public` (on or off, and the address), `hoprig public on [--temporary|--custom]` (it shows
the address and a QR code that signs a phone in once), `hoprig public off`.

**Signing in from outside.** Failed sign-ins are limited per visitor address (an IPv6 visitor by its /64), and all
password tries from elsewhere together are limited too, so guessing from many addresses gets nowhere. Someone failing
on purpose cannot lock you out: a sign-in QR made on a device that is already signed in always works, and so does
this computer itself. A link that is on never runs with a weak password: until the password is strong it waits, and
**Settings → Public link** asks for a stronger one in place. (A Custom link that already ran before an update keeps
running until your next sign-in shows how strong the password is.)

**A hub that runs this computer's add-ons.** A hub this computer is linked to may turn the public link on and off
and add its extra services, run Setup and share a gateway here, so one dashboard runs every
computer. Each such change is in this computer's **Automations → Activity** under the hub's name, such as "The hub
office-pc started the public link"; what the request carried (a password, a key) is never written there. When you
revoke that hub's right (**Who may control this computer**, `hoprig tokens revoke`, or Remove on the hub), what it
opened to the network closes with it: a public link it turned on is turned off and a service it added is removed. What you opened yourself stays, and so does a gateway's sharing switch (the keys the hub
made end with its right). A hub never checks this computer's password: when the public link asks for the password to be
typed once, type it on this computer's own page.

## Put the hub behind HTTPS

`hoprig setup --hub` does it: Caddy with a certificate for your domain or for the server's IP address, or the
ready-to-paste block when nginx or Apache are already there. Everything about it is in [HUB.md](HUB.md).

The administrator password of a Setup job crosses only an encrypted leg between the hub and another computer (SSH,
HTTPS, a direct link over `wss://`). For a computer reached over plain `http://` or `ws://`, type it on that
computer's own page instead ([PC-SETUP.md](PC-SETUP.md)).

## When something does not work

| You see | What to do |
| --- | --- |
| "SSH could not log in … without a password" | Run `ssh-copy-id user@host` once on the computer that connects. |
| "host key is not known yet" | Connect once by hand (`ssh user@host`), check the key, answer yes. |
| "has no Hoprig" | Install Hoprig there (the page shows the line), or press **Install it there for me**. |
| "that code is wrong or has expired" | Show a new code on the hub; each one works once, for 10 minutes. |
| "is not encrypted (http://)" | Put the hub behind HTTPS ([HUB.md](HUB.md)), or confirm with `--insecure` on a network you trust. |
| "certificate was made by the hub itself" | Copy the whole line from the hub, with `--fingerprint sha256:…`: `hoprig machines invite` there, or its page's **Show the line to paste**. Never `--insecure`. |
| "does not match the fingerprint" | Nothing was sent. Check the line was copied whole; if the hub was set up again, show the line there again. |
| "no longer signed by the authority this computer pinned" | The hub's certificate authority is new (Caddy reinstalled, a new server). Show the line on the hub again and run it on this computer. |
| "Not allowed any more" | Its right was revoked on that computer. Add it again (**Computers → Add a computer**). |
| "Offline" | That computer is off, asleep or without network, or its dashboard is not running. A computer that connects by itself comes back on its own. |
| "Needs a Hoprig update" | Run `hoprig update` on that computer. |
