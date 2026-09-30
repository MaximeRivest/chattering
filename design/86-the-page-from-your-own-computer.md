# The page from your own computer (Level 2 of the relay's security)

Status: proposal, prerequisites listed. Follows design/85 (the relay as
built: Level 1).

## The problem left after Level 1

Level 1 made the relay hard to break into and quiet: it answers only its
ports, patches itself, keeps no logs, cannot reach anything, and the tunnel
between phone and computer is end to end with a handshake the relay cannot
fake. One trust point remains, and it is the one that matters: **the
phone's page (the shell) comes from the relay.** Whoever controls the relay
(an attacker who got in, or Rockfrog itself) could serve a changed shell to
some phones, and that shell would hold the phone's key and see everything
the phone does. It would leave no trace a person could see.

Level 2 removes it: **the phone gets its page from its own computer**, over
TLS that ends on that computer. The relay forwards encrypted bytes and can
neither read nor replace them.

## The shape

```
phone ──TLS (ends on the home)──▶ relay :443 ──SNI routes the bytes──▶ home
          <id>.encrypted-link-to-your-devices.rockfrog.ai          (holds the certificate)
```

1. **A name per computer.** Each home gets
   `<home-id>.encrypted-link-to-your-devices.rockfrog.ai`, with the home id
   it already has (the hash of its key). A wildcard DNS record points all of
   them at the relay.
2. **The certificate lives on the computer.** The home obtains a Let's
   Encrypt certificate for its own name with the DNS-01 challenge: it
   publishes a TXT record through a small, narrow service (below), proves
   control, and keeps the private key. The relay never has it.
3. **The relay routes by name, blind.** On port 443 a small SNI router
   (Node, ~150 lines, in `relay.js` or beside it) reads only the name a
   connecting phone asks for in its TLS hello, and pipes the raw bytes into
   that home's registered connection (the WebSocket it already keeps open,
   carrying a byte stream per phone). The relay's own name still goes to
   Caddy, for the introductions and TURN credentials.
4. **The phone loads the shell from the home.** The pairing link becomes
   `https://<home-id>.encrypted-link-to-your-devices.rockfrog.ai/#pair=…`.
   Everything the phone runs, shell included, now comes from the person's
   own Chattering, which ships the shell (`anywhere/public/`) itself.
5. **Faster data afterwards.** The page and its requests can keep using the
   WebRTC data channel for speed (direct when possible); the TLS path through
   the relay is what makes the *code* trustworthy.

## Why Rockfrog still cannot cheat silently

Rockfrog controls the DNS, so it *could* obtain a certificate for a
person's name and serve its own page there. Every certificate is written to
public Certificate Transparency logs. **Each home watches the logs for its
own name** (a daily query to a CT search service, from the computer itself)
and tells its person, in Chattering, if a certificate appears that it did
not request. A silent attack becomes a visible one. That is the property
worth having: not "trust us", but "you would know".

## The DNS-01 service

The home needs to set one TXT record, `_acme-challenge.<home-id>…`, and
nothing else. Two ways:

- **acme-dns on the relay machine** (open source, made for exactly this):
  `encrypted-link-to-your-devices.rockfrog.ai`'s challenge names are
  delegated to it by a CNAME; each home registers once and gets credentials
  that can update only its own record. Rockfrog runs it; the home proves
  itself to it with its key.
- **A DNS provider's API**, with per-name tokens if the provider has them.

acme-dns is the better fit: narrow by design, no provider account shared
with homes.

## Prerequisite: DNS that can do this (a decision for Maxime)

GoDaddy is enough for Level 1 but not for Level 2:

- its API is closed to small accounts, so neither a CNAME delegation
  workflow nor automation is practical;
- its CAA editor drops parameters, so `accounturi` (only *our* Let's
  Encrypt account may issue) cannot be set;
- DNSSEC works there, but moving DNS later means turning it off first.

Recommended: keep GoDaddy as the registrar (domain lock, privacy and
auto-renew are on), and **move the DNS hosting** to a provider with an API,
full CAA and one-click DNSSEC: **Cloudflare DNS, in "DNS only" mode** (grey
cloud; never proxied, which would put Cloudflare in the middle again), or
**deSEC** (non-profit, DNSSEC by default, open source). Then turn DNSSEC on,
and set `accounturi` on the relay's CAA record.

## Other steps

- **Migration.** Phones paired under Level 1 keep working through the
  relay's own name. New pairings use the per-home name. Chattering offers
  each old phone a one-tap move (a fresh code shown on the computer).
- **Certificate renewal** on the home, every 60 days, with the same DNS-01
  flow; failure is shown in settings → machines, never silent.
- **Tests**: the SNI router with real TLS and the relay unable to read the
  stream (it holds no key); a CT alert on a certificate the home did not
  ask for; renewal; an old phone still working.

## Trade-offs, stated

- **Page traffic always passes through the relay** (TLS through a router,
  not WebRTC): more bytes on the relay. Mitigated by keeping app data on the
  WebRTC channel once the page is loaded.
- **Rockfrog runs one more service** (acme-dns) that can publish TXT records
  under the relay's name. It cannot issue a certificate by itself without
  showing up in CT logs, which homes watch.
- **More moving parts on the home** (certificate issuance and renewal).
- **iOS home-screen apps** keep their own storage: the per-home origin
  means pairing in the home-screen app, as today.
