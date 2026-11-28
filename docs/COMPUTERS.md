# Several computers in one dashboard

Hoprig runs on each of your computers. One of them, the **main computer**, shows the sessions of all of them on one
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
| **PCs at home plus one or more servers** | Make one server the main computer; every PC joins it; the other servers join too or are added by SSH. | On the server: `hoprig setup --hub` (see [HUB.md](HUB.md)). On each PC: `hoprig join https://<its address> <code>`. Other servers: `hoprig join …` the same way, or on the main computer `hoprig machines add user@server` |
| **Servers only** | The same: one is the main computer, the others join it or are added by SSH. | As above |

The sections below explain each way of connecting. Putting a main computer on a server (HTTPS, a domain or just the IP
address, SixPanel, Docker, what it needs) is in [HUB.md](HUB.md).

## Which computer should be the main computer?

The one that is **always on and can be reached**: a server, or a cheap VPS. The main computer is the page you open, so when
it is off you see nothing, even if the other computers are fine. Open the main computer's page from your phone at its HTTPS
address (see [HUB.md](HUB.md)). To sign the phone in without typing the password, open
**Settings → Security and sign-in → Sign in another device** on a computer that is already signed in (or run
`hoprig link` on the main computer)
and scan the code with the phone's camera.

## 1. A PC at home or in an office (recommended: the direct link)

No extra software: one dashboard on a computer that can be reached (a server or a cheap VPS), and every other PC
connects **out** to it. Your router stays closed; nothing has to be opened on the PC's side.

1. On the main computer: **Computers → Add a computer →** "It is at home or behind a router and cannot be reached from
   here" **→ Show the line to paste** (or `hoprig machines invite`). The line is the main computer's address with a code,
   such as `https://hub.example.com#join=K7QM-4XP2`; it works once, for 10 minutes.
2. On the PC: **Computers → Link to my main Hoprig** (or **Add a computer → Advanced → Show this computer on
   another dashboard**), paste the line, press **Link**. Or: `hoprig join 'https://hub.example.com#join=K7QM-4XP2'`.

The PC now shows in the main computer's **Computers** list. Its own dashboard keeps the link open and opens it again after
a restart or a dropped network, so let the dashboard run in the background (`hoprig service install`, which setup
offers anyway).

- To stop: **Leave** on the PC (same place: **Show this computer on another dashboard**; or
  `hoprig join --leave https://hub.example.com`), or on the main computer open the computer, **Advanced → Remove from
  this list**. Either one ends it on both sides.
- Control goes one way: the main computer can drive the PC; the PC gets no access to the main computer.
- Use an `https://` address. A plain `http://` address to another computer is refused unless you say
  `--insecure` (in the page: "Connect without encryption"): the link's token, and everything you type into that
  PC's sessions, would otherwise cross the network readable on the way. `--insecure` only means that: it is not
  a way around a certificate.
- A main computer reached by a private IP address, with its own certificate (`hoprig setup --hub --ip … --tls-internal`):
  the line it shows carries its fingerprint (`…&fingerprint=sha256:…`, or `--fingerprint sha256:…` in the terminal
  form). Copy the whole line. The PC then checks the main computer against
  that fingerprint, now and on every later connection; a main computer that does not match is refused before anything is
  sent. The fingerprint stays the same when the main computer's certificate renews. Details:
  [HUB.md](HUB.md#no-public-certificate-possible-the-main-computers-own-certificate-a-private-network-a-test).

## 2. A server you can SSH into

You already log in to it with `ssh user@server` (or a name from `~/.ssh/config`) without typing a password.

On the main computer: **Computers → Add a computer →** "I can reach it by SSH from this computer", type `user@server`,
press **Add**.
Or on the command line: `hoprig machines add user@server`.

Nothing has to be opened in a firewall: the main computer connects through SSH, and the dashboard on the server keeps
listening on its own `127.0.0.1` only. If Hoprig is not installed there yet, the page shows the one line to
install it, and can run the installer for you. No password-free SSH login yet? Once, on the main computer:
`ssh-copy-id user@server`.

**With a key file** (a new server whose provider gave you a key, or one you made): **Computers → Add a computer →**
"I can reach it by SSH from this computer" **→** "I have a key file for it". Type its address (`203.0.113.7`), the
user, the SSH port, and paste the private key or pick its file, then press **Next**.

- The page first shows the server's **host key print** (`SHA256:…`). Compare it with the one the server's provider
  shows, or with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` there. Nothing logs in until you press
  **It matches**. Hoprig keeps that host key in its own file and from then on accepts no other for this computer. If
  the server later shows another one, everything to it stops (its state says "Its host key changed") until you
  choose: its page, **Advanced → Its host key**, shows the kept print and the new one, and **Use the new host key**
  (after a confirmation that names the computer and both prints) keeps the new one.
- The key is kept only in Hoprig's own folder for keys (`ssh-keys/` in its settings folder, the folder readable by you
  alone, the file mode 600), never in the settings file, a log, an error or Activity, and the page never shows it
  again. It is used with `IdentitiesOnly`, so ssh offers no other key. It is removed with the computer, and when an add
  fails.
- A key with a passphrase is refused: Hoprig never asks for a passphrase or keeps one. Use a key without one for this
  server, or a name ssh already knows.
- When Hoprig is not on the server yet, **Install Hoprig on 203.0.113.7** runs the installer there with the same key and
  shows its lines as they come.

Removing a computer and installing on it ask first, and the dashboard checks that the request names that computer.
These steps are the owner's own: another computer, Work and Tia cannot take them.

Some steps still need a terminal on the server itself: installing Claude Code and signing in to it, adding its
providers (a subscription's sign-in or an API key), and every step that asks for the server's administrator password
(sudo). A restart of the server is on its page, under **Advanced → Power → Restart**, where the system lets your user
restart it without that password; where it does not, the page shows the system's refusal, and you restart it from a
terminal there.

**The other direction over SSH.** If the PC can SSH to the main computer but the main computer cannot reach the PC, the
PC can also join over SSH instead of the direct link: `hoprig join user@server` (or **Connect by SSH instead**
under **Computers → Add a computer → Advanced → Show this computer on another dashboard**). The connection then arrives on a port of the server's `127.0.0.1` only, which is
what sshd does by default (`GatewayPorts no`); if the server's sshd is set to `GatewayPorts yes`, joining stops with
a message, because the port would otherwise be open to the whole network.

## Each computer's health, and a gateway on it

A computer's page has a **Health** part: its checks (the same as `hoprig doctor` there) with a **Fix** on each line
Hoprig can fix, Hoprig's and the coding tools' versions, whether its dashboard runs as a service, where it listens,
its load, memory and disks. It is read when you open it or press **Refresh**, through this dashboard's own link to that
computer, never on a timer. A computer that does not answer says "was not reached since …" (or "never"), and nothing
of it is shown as fine. Every **Fix** asks first, naming the computer and the commands it runs, and the computer
checks that name itself; a fix that needs administrator rights says so. Where `sudo` there would ask for a password,
the page gives you the command to type there instead. Tia proposes a fix as a card you confirm; she never runs one
herself.

Under **Gateways** on the same part, each gateway of that computer (the shipped one and yours) can be installed,
started, stopped and **run as a service**. Installing and updating ask first, naming the computer, wherever they are
pressed (Health, Settings → Add-ons, Providers), and the computer checks that name; Tia proposes them as a card. Each
press acts on what really runs and says what it did: **Stop** stops its service and also a copy started outside it
(from Settings, Tia or a session), **Start** leaves such a copy running and says so, and removing a gateway of your
own removes its service first. A service is a user service (systemd on Linux, a launchd agent on macOS) that comes
back after a restart. The page shows the file in full and the commands before anything is written; **Remove the
service** takes them away again. On Linux a user service starts after a restart only when that computer lets its user's services start without a
login (systemd calls this lingering): the page says when it does not and offers **Let them start after a restart**
(an administrator step). Where a gateway listens follows one rule for every start (Health, Settings → Add-ons, Tia,
a session, the start again after an update) and for its service: on a server, and where that computer's dashboard
listens on that computer only, it gets `HOST=127.0.0.1` and its definition's words for it (`--host 127.0.0.1` for the
shipped gateway); where you opened the dashboard to your network, it listens as it always did. A gateway of your own
that reads neither decides where it listens itself.

**Open its page.** A gateway's own page is never shown under the dashboard's address (its scripts would act as you
there). On this computer it is a plain link to its port under the other loopback name (`localhost` when the page is on
`127.0.0.1`), never a name you are signed in under, since a browser sends a name's sign-in to every port of it; signed
in under both, the page says to sign out under one first. For a gateway on a computer added by
SSH, the dashboard opens a forward on its own computer's `127.0.0.1` to that gateway's port and gives you the link and
**Stop**; the forward closes after 15 minutes with nothing moving, when the computer is removed and when the dashboard
stops. It works only from a browser on the computer the dashboard runs on; from a phone or another device the page
says so, and what to do. For a computer linked without SSH (by address or by the link it opened itself) the page says
in one sentence that this dashboard cannot reach that page, and to open it in a browser on that computer.

The link under a running gateway on the Providers page (its steps in Add provider) and on Settings → Add-ons (**Open
its dashboard**) follows the same rule. Opened on a loopback name, the page links under a loopback name you are not
signed in under; signed in under both, it says to sign out under one first. Opened by the computer's name or the
public link, it shows no link but one sentence: the gateway's own page opens only in a browser on the computer the
dashboard runs on, at its `127.0.0.1` address. On another computer's page it says that page opens only on that
computer itself, and that for a computer added by SSH **Open its page** under that computer's Health opens it in a
browser on the computer this dashboard runs on. The dashboard passes no request on to a gateway's own page: only
Claude's API (`/gateway/<id>/v1/…`) goes through it, with a gateway key made here and while sharing is on.

**A first password.** A gateway of your own can name a word of the line where it prints its first password (Add a
gateway → More → *Its first password's line*, or `hoprig gateways add … --first-password <word>`). Then a start shows
what it printed first on the page once (with Start's answer, or **Show what it printed first** when it was started
elsewhere), Hoprig keeps it in memory only, for ten minutes at most, and that line never reaches its log. Without it,
its log (`state/addons/<id>.log` on that computer) is as it prints it, readable by that user only, and the Start
confirmation says so. A gateway run as a service prints into nothing: its errors go to that computer's user journal.

**Adding the same server twice** is refused: by its address, and by its host key under another address.

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

**A main computer that runs this computer's add-ons.** A main computer this computer is linked to may turn the public link on and off
and add its extra services, run Setup and share a gateway here, so one dashboard runs every
computer. Each such change is in this computer's **Work → Activity**, marked "Another dashboard", with the main computer's name
in the sentence, such as "The main computer office-pc started the public link"; what the request carried (a password, a key) is never written there. When you
revoke that main computer's right (**Who may control this computer**, `hoprig tokens revoke`, or Remove on the main computer), what it
opened to the network closes with it: a public link it turned on is turned off and a service it added is removed. What you opened yourself stays, and so does a gateway's sharing switch (the keys the main computer
made end with its right). A main computer never checks this computer's password: when the public link asks for the password to be
typed once, type it on this computer's own page.

## Put the main computer behind HTTPS

`hoprig setup --hub` does it: Caddy with a certificate for your domain or for the server's IP address, or the
ready-to-paste block when nginx or Apache are already there. Everything about it is in [HUB.md](HUB.md).

The administrator password of a Setup job crosses only an encrypted leg between the main computer and another computer (SSH,
HTTPS, a direct link over `wss://`). For a computer reached over plain `http://` or `ws://`, type it on that
computer's own page instead ([PC-SETUP.md](PC-SETUP.md)).

## A schedule on another computer

A schedule that lets the AI work by itself can name a computer linked to this dashboard (Work → Schedules → Add
schedule → **On the computer**; a task's **Run by AI** the same). Each computer is named in Work by a random id of its
own (never its host name), which the dashboard learns from that computer over the link. At the slot this dashboard
asks that computer, with the token it already holds, to start the run; the run, its branch and its result stay there,
and that computer's own projects and providers are checked there. When it cannot be reached (off, not connected), the
slot is recorded as missed with the reason and you are told: it does not run on another computer instead. See
[WORK.md](WORK.md), "Schedules and repeating tasks".

## When something does not work

| You see | What to do |
| --- | --- |
| "SSH could not log in … without a password" | Run `ssh-copy-id user@host` once on the computer that connects. |
| "host key is not known yet" | Connect once by hand (`ssh user@host`), check the key, answer yes. |
| "has no Hoprig" | Install Hoprig there (the page shows the line), or press **Install it there for me**. |
| "that code is wrong or has expired" | Show a new code on the main computer; each one works once, for 10 minutes. |
| "is not encrypted (http://)" | Put the main computer behind HTTPS ([HUB.md](HUB.md)), or confirm with `--insecure` on a network you trust. |
| "certificate was made by the main computer itself" | Copy the whole line from the main computer, with `--fingerprint sha256:…`: `hoprig machines invite` there, or its page's **Show the line to paste**. Never `--insecure`. |
| "does not match the fingerprint" | Nothing was sent. Check the line was copied whole; if the main computer was set up again, show the line there again. |
| "no longer signed by the authority this computer pinned" | The main computer's certificate authority is new (Caddy reinstalled, a new server). Show the line on the main computer again and run it on this computer. |
| "Not allowed any more" | Its right was revoked on that computer. The New session sheet says: "It no longer lets this dashboard in. Add it again here: Computers → Add a computer"; the computer's own page says: "*name* no longer lets this dashboard in. Add it again here: Computers → Add a computer." Until you do, its **Setup** and **Health** tabs cannot read it; under **Advanced**, **Rename** and **Remove from this list** still work. |
| "Offline" | That computer is off, asleep or without network, or its dashboard is not running. A computer that connects by itself comes back on its own. |
| "Needs a Hoprig update" | Run `hoprig update` on that computer. |

## A computer where Hoprig works as root

When you add a server by its root login, **Install it there for me** installs nothing under root by itself. The page
says why and offers first **Make the user and set Hoprig up on <server>**: after one confirmation that names the
server, the installer there makes the user `hoprig` (no password, the key you use for root, sudo through one file in
`/etc/sudoers.d`, lingering) and sets Hoprig up as it. The main computer adds the server as `hoprig@<host>` only after a real
login as that user worked; when it does not, nothing is added and the last line says which key to put there. The
other ways stay: an ordinary login with sudo, or keeping Hoprig on root there on purpose by typing the sentence.

A server where an older Hoprig already works as root can be moved to an ordinary user from this main computer: open the
computer, **Advanced → Move Hoprig to an ordinary user → Show what the move does**. The main computer asks that server over
its SSH login what the move would do (`hoprig move-to-user --dry-run`), and after you type the computer's name it
runs the move there and shows its lines. When Hoprig made no user there, the move makes one first ([INSTALL.md](INSTALL.md),
"Moving Hoprig off root"). That server needs the network for the user's own install (Node.js, Hoprig's packages and
Claude Code come from there): the move asks first and stops, with nothing made or copied, when it cannot reach them.

Afterwards the main computer tries a real login as the new user (`ssh <user>@<host> hoprig version`). Only when that works does
it switch its entry to `<user>@<host>`, and the page says so. When it does not (the user's `~/.ssh/authorized_keys`
lacks your key), the main computer keeps the old login and the last line says what to add. A computer added another way runs
the move on its own page or terminal.
