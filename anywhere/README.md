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
- **A name:** `anywhere.rockfrog.ai`, pointing at the server (A and AAAA).

## Deploy on NixOS

```nix
# configuration.nix of the relay machine
imports = [ /path/to/chattering/anywhere/deploy/nixos.nix ];
services.chattering-anywhere = {
  enable = true;
  domain = "anywhere.rockfrog.ai";
  source = /path/to/chattering;              # a checkout; only anywhere/ and wsserver.js are used
  turnSecretFile = "/var/lib/secrets/anywhere-turn";
};
```

```sh
install -d -m 0750 /var/lib/secrets
openssl rand -hex 32 > /var/lib/secrets/anywhere-turn
chown root:turnserver /var/lib/secrets/anywhere-turn && chmod 0440 /var/lib/secrets/anywhere-turn
nixos-rebuild switch
curl https://anywhere.rockfrog.ai/healthz      # ok
```

Caddy gets the certificate. coturn serves TURN on 3478 (UDP and TCP) and on
5349 over TLS (with Caddy's certificate, for networks that let nothing else
out). The module opens those ports, 80/443, and the UDP range coturn relays
through.

## Deploy anywhere else (Debian, Ubuntu…)

1. Node 22 or newer, Caddy, coturn.
2. Copy `anywhere/` and `wsserver.js` from a Chattering checkout to
   `/opt/chattering-anywhere/`.
3. The relay, as a service: see `deploy/anywhere-relay.service`.
4. Caddy (`/etc/caddy/Caddyfile`), with no `log` directive:
   ```
   anywhere.rockfrog.ai {
     encode zstd gzip
     reverse_proxy 127.0.0.1:8790
   }
   ```
5. coturn: `deploy/turnserver.conf` into `/etc/turnserver.conf`, with the
   same secret as the relay's `TURN_SECRET`.
6. Firewall: TCP 80, 443, 3478, 5349; UDP 3478, 5349, 49152–65535.

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
