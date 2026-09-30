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
