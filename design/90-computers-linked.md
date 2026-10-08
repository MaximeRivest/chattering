# Computers linked: one Chattering opens another, from anywhere

Status: step 1 built and tested (two real Chattering servers and a relay;
the link engine on its own with pages, uploads, 3 MB downloads, event
streams, WebSockets, the privacy refusals, the other computer away and
back). Steps 2 and 3 below are next. Follows design/85 (the relay) and
design/86 (Level 2).

## What people want

Two ways to use Chattering on a computer, both from the same install:

1. **Just connect**: a light native window onto their main computer. No
   agents or projects of its own. For people with one real machine.
2. **Full Chattering, linked**: the computer runs its own agents and
   projects, and moves between the person's machines (here: lambda, the
   XPS laptop, Lilly's PC) like the machine switcher does over the home
   network or Tailscale today, but from anywhere and without Tailscale.

Both rest on one piece: an install that holds an encrypted link to another
Chattering and shows it at a local address.

## The link (anywhere-link.js)

This install pairs with the other one exactly as a phone does (design/85:
the code, the handshake, a credential of the person who showed the code),
keeps its key in `<data>/anywhere-links.json` (0600), and serves the other
computer at `http://localhost:<port>` (7461, 7462, …). A request to that
address is carried through the tunnel and answered by the other Chattering,
as the person who paired. On a computer there is no page from the relay at
all: the link is carried by Chattering itself, so the trust point of
design/86 does not exist here.

Who may use a link: only the person who made it, signed in to this
Chattering (this install's sign-in cookie reaches every localhost port), or
this machine's console. The port listens on 127.0.0.1; a request for
another host name (a page whose name was pointed at this computer) or from
another site is refused before anything is carried.

The tunnel opens on first use and is rebuilt when lost; an address whose
computer is away answers a page that says so ("lambda cannot be reached
right now") and works again when it is back.

Settings → machines → **this computer, linked to others**: paste the link
shown under the other computer's code (Add a device), and it appears in the
list and in the machine switcher (entries marked "encrypted link"; only on
this computer's own screen, since the address is local).

## One laptop, two sides, and the server (2026-10-08)

Checked on Lilly's PC (the Windows app, Chattering in WSL, lambda): every
way between the three, as the same person, without Tailscale.

- **Opening the link from this computer's switcher works.** The link
  refused every request from another site, and another port of localhost
  is the same site, so the switcher's jump from the Windows app
  (localhost:7434) to its link (localhost:7461) got "Requests from other
  sites are refused". A page opened there (Sec-Fetch-Mode navigate,
  destination document) from the same site is now let through; a script
  or a WebSocket from another port is still refused, another site always.
- **The way back.** The server's pages, seen through the link, are the
  server's: its switcher knew nothing of the laptop. The install holding
  the link now answers two paths of its own at the link's address, never
  carried: `/_chattering/here` (this install, the other installs on this
  computer, this person's other links: names only, plus the installs'
  public keys so the page leaves out the server's entries that reach the
  same installs another way, such as a Tailscale address) and
  `/_chattering/go?to=…`, which opens one as this person (a handoff to
  the other install here). The server's scripts can list the places; only
  opening a page follows one, so they never read a handoff.
- **The other side of the laptop.** An install's card on this computer
  (design/84) lists the links its owner made. The other install offers
  them to its own owner ("lambda · encrypted link, through LILLY-PC"):
  the switcher signs the person in to the install holding the link and
  goes on into it (`?handoff=…&link=<id>`), one hop for the person.

Tested with a relay and three real servers standing for the two sides and
the server (anywhere-links-local.test.js).

## Next

2. **Both ways, and from the pairing page**: linking A to B also links B
   to A (A issues a code for itself and hands it to B through the link just
   made), and "Add a device" offers "Connect another computer's Chattering"
   next to the phone's code.
3. **Just connect**: the same download with a mode that runs only the link
   and opens its window (no agents, no projects), started with the
   computer; and the pairing page on a desktop without Chattering offers
   the download with the code carried to its first start, as the Android
   app does.
4. Later: shared history (each computer keeps a copy of the other's
   conversations, readable when it is off).

## Trade-offs, stated

- **A link acts as its person on the other computer**, from this computer,
  for as long as it exists: removing it here, or removing the device there
  (Settings → machines, or People), ends it.
- **Local ports**: one per linked computer, on 127.0.0.1. Another person
  signed in to the same computer's Chattering cannot use someone else's
  link; a program running as the same Unix user could read the key file,
  as it could read Chattering's other secrets.
- **Opens only from this computer's screen**: a phone looking at this
  Chattering does not see its links (the addresses are local); it pairs
  with the other computer itself.
- **Separate conversations until step 4**: switching moves between
  computers; it does not merge their lists.
