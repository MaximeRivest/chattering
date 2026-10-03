# Chattering Anywhere: the relay

A phone opens Chattering from its own computer, from anywhere, with no app
and no account. This folder holds the three parts that make it work, and how
to run the one part that lives on a rented server. The design and its
trade-offs are in [design/85](../design/85-anywhere.md).

| part | where it runs | file |
| --- | --- | --- |
| the home | inside Chattering, on the person's computer | `../anywhere-home.js` |
| the phone | the phone's browser, served by the relay | `public/`, `client.js`, `protocol.js` |
| the relay | a small rented server | `relay.js` and coturn |

## What the relay can and cannot see

Phone and computer talk over WebRTC, encrypted end to end (DTLS). Both ends
prove who they are with keys that never pass through the relay: the computer
signs with the key whose fingerprint was in the QR code, the phone with the
key it registered when it paired. A relay that tried to sit in the middle
would fail that check, and the phone would refuse to send anything.

- **It cannot see:** conversations, files, requests, answers, keys, names of
  projects or people.
- **It does see, while a connection is being made:** that a computer with a
  given random id is online, that a phone asks for it, both internet
  addresses, and, when the data has to go through it (TURN), how many bytes
  pass. That is all any server on the internet sees.
- **It keeps:** nothing. No database, no files, no logs. Everything lives in
  memory while sockets are open. After a restart it knows nobody, and homes
  reconnect within a minute.

"We can't read it" is enforced by the encryption, and people can check it
from the code. "We keep no logs" is a promise the operator makes: deploy it
as described here and keep it that way.

**One trust point remains:** the phone's page (`public/`) is served by the
relay. Whoever runs the relay could serve a changed page, and that page would
have the phone's keys in hand. This is true of every web app that encrypts in
the browser. It is kept small on purpose: the shell is a few hundred readable
lines, cached on the phone after the first visit, and everything else,
Chattering itself, comes from the person's own computer through the tunnel.
An app that carries the shell inside itself (the Android app could; not
built yet) removes this point entirely.

## What it costs

- **A small server:** about €4–5 a month (e.g. Hetzner CX22: 2 vCPU,
  4 GB, 20 TB of traffic a month). The meeting point is tiny: a few KB per
  connection, in memory.
- **Traffic:** only for connections that cannot go directly (mobile carriers
  often force this). Reading conversations moves little data: a busy person
  uses tens of MB a day. 20 TB covers thousands of people. Video through the
  relay is what would cost; `maxBps` caps each session.
- **A name:** `encrypted-link-to-your-devices.rockfrog.ai`, pointing at the server (A and AAAA).

## Deploy (Ubuntu: what runs at encrypted-link-to-your-devices.rockfrog.ai)

The relay runs on a small OVHcloud VPS in Beauharnois, Québec (VPS-1:
2 vCPU, 4 GB, unlimited traffic, anti-DDoS included; about $6 CAD a month),
on Ubuntu LTS. Ubuntu rather than NixOS for this one machine: it patches
itself every day with no one watching, it is the image the host supports,
and the machine holds no state, so it is rebuilt from one script rather
than maintained (design/85, "Where it runs").

**A new server, from nothing** (as the admin user, from a checkout):

```sh
scp anywhere/deploy/setup-ubuntu.sh ubuntu@SERVER:/tmp/
ssh ubuntu@SERVER 'sudo DOMAIN=encrypted-link-to-your-devices.rockfrog.ai bash /tmp/setup-ubuntu.sh'
ssh ubuntu@SERVER 'sudo tailscale up --advertise-tags=tag:relay --hostname=encrypted-link-relay --ssh=false --accept-dns=false'
RELAY_HOST=ubuntu@SERVER anywhere/deploy/deploy-relay.sh
ssh ubuntu@encrypted-link-relay 'sudo DOMAIN=encrypted-link-to-your-devices.rockfrog.ai SITE_DOMAIN=rockfrog.site PUBLIC_SSH=0 bash /tmp/setup-ubuntu.sh'
```

`setup-ubuntu.sh` (safe to run again) installs Caddy from Caddy's signed
repository and Tailscale from Tailscale's (keys checked against their
published fingerprints), coturn and Node from Ubuntu; turns on daily
security updates from all of them with a reboot at 04:00 when one needs
it; keeps the journal in memory for a day and removes syslog; runs the
relay as a throwaway user that can write nothing and reach nothing but
Caddy on the same machine; turns Caddy's admin API off and allows only
Let's Encrypt; gives coturn Caddy's certificate on every renewal, and
keeps it from relaying to this machine or any private network (Tailscale
ranges included); and sets a firewall that opens only the relay's ports,
with SSH through Tailscale once `PUBLIC_SSH=0`.

**New relay code**: commit, push, then `anywhere/deploy/deploy-relay.sh`.
It only ships a commit that is on GitHub, never a working tree; each
release stays read-only on the server, and going back is
`deploy-relay.sh <older commit>`.

**Tailscale**: the relay is tagged `tag:relay`. The tailnet policy lets
your own devices start connections and tagged devices none, so the relay
answers SSH from you but cannot reach any of your machines, even taken
over. The policy's tests check this on every save.

**Ubuntu Pro** (free for personal use, up to five machines): attach it
(`sudo pro attach <token>`) so Node and coturn, which Ubuntu ships in its
community section, get Canonical's security fixes too.

Other systems: `deploy/nixos.nix` (NixOS), `deploy/anywhere-relay.service`
and `deploy/turnserver.conf` (any systemd Linux, by hand).

## Public addresses for shared links (design/92)

With `SITE_DOMAIN=rockfrog.site` the same server gives each invited
computer `https://<name>.rockfrog.site`: HAProxy holds :443, passes those
TLS streams unread to `site.js` (which pipes them to the computer through a
tunnel it opens), and hands every other name to Caddy as before. The
computer holds the certificate. Invite a computer by adding its id (shown
in Chattering when it is refused) to `/etc/chattering-site/homes`; no
restart needed.

```sh
ssh ubuntu@encrypted-link-relay 'sudo DOMAIN=encrypted-link-to-your-devices.rockfrog.ai SITE_DOMAIN=rockfrog.site PUBLIC_SSH=0 bash /tmp/setup-ubuntu.sh'
```

## Pointing Chattering at another relay

Settings → machines → your phone, anywhere → *relay and switch*. It must be
`https://` (or `http://localhost…` for testing on one computer). Phones
already paired keep the relay they were paired through: pair them again
after changing it.

## Running it locally, for development

```sh
node anywhere/relay.js                      # http://127.0.0.1:8790
# in Chattering: settings → machines → relay: http://127.0.0.1:8790
```

A phone needs https for its connection helper (service worker), so to try a
real phone, put the relay behind an https name (Tailscale Serve works:
`tailscale serve --bg --https=8443 http://127.0.0.1:8790`).

## Tests

`test/anywhere.test.js` (protocol, pairing, tunnel, relay),
`test/anywhere-server.test.js` (a real Chattering),
`test/anywhere-browser.test.js` (a phone-sized Chromium),
`test/anywhere-turn.test.js` (through a real coturn;
`nix shell nixpkgs#coturn -c node --test test/anywhere-turn.test.js`).
