# Your phone, anywhere: a relay that cannot read

Status: built, tested end to end, and **live** at
`https://encrypted-link-to-your-devices.rockfrog.ai` since 2026-09-30
(see "Where it runs"). Checked in production with a phone-sized browser
pairing with lambda (direct, 2.3 s) and a client forced through TURN
(0.3 s). Not yet tried on a real iPhone or Android phone. Level 2 (the page
from the person's own computer): design/86.

## The question

Until now, a phone reached Chattering through Tailscale: install it on the
computer and the phone, sign both in, and (for everything to work) run a
`tailscale serve` command. That is how this household does it. It is too
much for a new person, and Chattering's installer did none of it.

What a new person should do: press **Add a phone** on the computer, scan the
code with the phone. Chattering is on the phone, from anywhere, with no app
and no account. Nothing readable passes through anyone else's server, and
that server keeps nothing.

## The name

The relay's address is what a person sees when the phone's camera reads the
code ("Open encrypted-link-to-your-devices.rockfrog.ai?"), so it says what
happens: your devices, linked, encrypted. It is not a "tunnel" or a
"bridge": the tunnel runs between the devices themselves; the relay
introduces them and, when it must, passes along what it cannot read.
Chosen before any phone paired, because a phone stays with the address it
paired through.

## The shape

```
 phone browser ──── WebRTC data channel (DTLS, end to end) ──── Chattering
      │                 direct when possible,                   (anywhere-home.js)
      │                 else through TURN (coturn)                    │
      └──── relay: the page, the introductions, TURN credentials ─────┘
                (anywhere/relay.js; keeps nothing)
```

- **The home** (`anywhere-home.js`, in the Chattering server) keeps one
  WebSocket open to the relay, *only* while a phone is paired or a code is
  showing. It answers WebRTC offers with node-datachannel, runs the
  handshake, then replays each request it receives against its own HTTP
  port, as the person who paired the phone.
- **The relay** (`anywhere/relay.js`) serves the phone's page, lets phones
  ask for a home by id, passes offers, answers and network candidates
  between them, and hands both short-lived TURN credentials (coturn's
  `use-auth-secret`, so coturn never asks it anything). Memory only.
- **The phone** (`anywhere/public/`) is a page and a service worker. The page
  (the shell) pairs, connects, reconnects, and shows Chattering in a
  full-screen frame. Every request the frame makes goes to the service
  worker, then to the shell, then through the tunnel. `inside.js`, put first
  in every app page, replaces `WebSocket` and `EventSource` for this site,
  because a service worker cannot see the first and should not hold the
  second.

## Trust: who proves what

WebRTC encrypts; it does not say who is at the other end. The two DTLS
certificate fingerprints travel through the relay, so a dishonest relay
could hand each side its own. The handshake (`anywhere/protocol.js`,
`transcript`) closes that:

1. The QR code carries the home's id: the first 16 bytes of the SHA-256 of
   its public key (ECDSA P-256), a single-use pairing id, and a 128-bit
   secret. It sits after `#` in the link, which browsers never send to a
   server.
2. On the open channel, both send a fresh nonce; the home sends its public
   key. The phone checks the key hashes to the id in the code.
3. The home signs the transcript: protocol version, home id, **both
   fingerprints as each side sees them**, both nonces. The phone checks it.
   A relay in the middle would make the fingerprints differ between the two
   sides, so the signature fails. The phone sends nothing more and says
   "this connection could not be verified".
4. The phone answers with its own signature over the same transcript, by a
   key the browser generated as *non-extractable* (no script can read it
   out, not even ours later). The first time, it adds an HMAC of the
   transcript with the pairing secret, and its public key. The home
   registers the key, issues a credential for the person who showed the
   code, and burns the code.

The relay also makes a home prove it holds its key (a signed challenge)
before it may register under an id, so nobody can take another home's calls
(they would fail step 3 anyway, but could deny service).

**Requests on the home** carry that credential as a Bearer token and are
marked `X-Forwarded-For: anywhere`, so `isLocalRequest` is false: a phone is
never this machine's console. They use the person's own rights, walls
included. Headers a phone could use to pretend otherwise (cookie,
authorization, forwarded, origin, sec-*) are dropped. Cookies from the
server stay home.

**Revocation**: the credential is an ordinary one (`users.js`, labelled
"<phone> · anywhere"). Revoking it in People, removing the person, or
pressing *remove* in settings closes that phone's live connection at once
(`anywhere.prune()` after every roster change) and refuses its next
handshake. The phone then says it was removed and forgets the computer.

## The wire

One ordered, reliable data channel, framed (`protocol.js`): a type, a stream
id, a payload; a "more follows" bit joins messages larger than 16 KiB (the
size every WebRTC stack delivers whole). Many requests share the channel;
the sender takes turns between streams, so a 1 MB page never holds a small
API call behind it. Response bodies have a window (1 MiB): the phone credits
what its reader took, so a paused video holds the computer back instead of
filling the phone's memory. Text responses are gzipped by the home for the
trip (not event streams: each event must arrive when written); the shell
decompresses. The shell caches app files that carry an ETag and asks with
`If-None-Match`, so opening Chattering again moves a few hundred bytes, not
the 1 MB app.

## Delight, specifically

- The QR dialog watches for the phone: the moment it pairs, a check mark
  and its name ("Pixel 8 · Chrome is paired").
- The phone draws the connection: phone, wire, computer; dots travel while
  it finds and connects, a lock appears when the handshake proves both ends.
- A computer asleep is not an error: "lambda is not online… this page
  connects by itself the moment it is back". The relay tells waiting phones
  when their home arrives.
- Back from the pocket: a quick ping says whether the tunnel survived; if
  not, it reconnects while the app stays on screen, and pending requests go
  through once it is back.
- A pill says how it is connected ("Connected to lambda · directly", or
  "through the relay (encrypted)") and then gets out of the way.
- Android offers to install the app after pairing; an iPhone gets the one
  tip that matters (and is asked *before* pairing where it wants Chattering,
  because a home-screen app on iOS has its own storage, apart from Safari's).

## Trade-offs, stated

- **The phone's page comes from the relay.** Whoever runs the relay could
  serve a changed shell that uses the phone's key. Every encrypt-in-the-
  browser product has this weakness. It is kept small here: the shell is a
  few hundred readable lines, cached on the phone; Chattering itself comes
  from the person's own computer. An app that carries the shell (Android)
  would remove it. Not built.
- **"We keep no logs" is a promise, not a proof.** The relay code keeps
  nothing and the deploy files turn Caddy's and coturn's logs off, but a
  person cannot verify what runs on a server. What they can verify, from
  the code, is that the relay cannot read anything.
- **The relay sees metadata**: which random home id is online, from which
  address, which phone addresses call it, and, through TURN, byte counts.
- **A native component**: node-datachannel (libdatachannel, MPL-2.0),
  prebuilt for all six release targets, about 10 MB. Without it the
  settings page says so and nothing else changes. Its threads keep a
  process alive after its cleanup; the server always ends with
  `process.exit`, which stops them (the tests do the same).
- **node-datachannel's statistics call a relayed path "srflx"**, so the
  computer shows the path the *phone* reports (browsers report it right).
- **Pairing codes live in memory**: a restart of Chattering ends any code
  on screen (the phone is told the code expired).
- **One relay per phone**: a phone belongs to the relay it paired through
  (it is that site). Changing the relay means pairing phones again.
- **iOS home-screen apps keep their own storage.** The shell asks first;
  whether iOS keeps the code in the address when adding to the home screen
  is untested on a real iPhone. Safari itself works either way.
- **Not carried yet**: forms that navigate away (`POST` pages). Pages,
  scripts, pictures, downloads, the event stream, WebSockets and artifact
  previews are (the tests cover the app, the event stream, live
  collaboration and previews; voice and PDFs use the same paths, untested).
  Previews were missing until 2026-10-04 (see "Previews").
- **Tailscale stays**: the tailnet door, the public door and LAN links keep
  working as before; Anywhere is another door, not a replacement.
- **Not tested on real phones and networks yet**: the tests cover a
  phone-sized Chromium on one machine and a real coturn on loopback. A week
  on real phones, mobile data included, is the next step.

## Previews (2026-10-04)

What agents make (web pages, slides, widgets) never runs on the app's
origin (design/67): on this computer it is `<artifact>.localhost:7435`, on
the tailnet port 8443. Through the relay the app computed
`https://<relay>:7445`, which nothing carried: the shell's service worker
answers for its own origin only, so the request went to the relay, which
has nothing on that port, and every artifact frame stayed empty.

Now a preview has an address of its own on the phone,
`https://previews.<relay>`, carried by the same tunnel:

```
app frame (relay origin) ── iframe ──▶ previews.<relay>/a/<cap>/…
                                          │ its service worker (sw.js, preview mode)
                                          ▼
 shell ◀── MessagePort ── carrier.html (previews.<relay>, hidden, held by the shell)
   │  only GET/HEAD, only /a/<cap>/…, /_c/proxy.html, /_c/kit.js; few headers
   ▼
 tunnel, request kind 'preview' ──▶ home: the preview server (7435), no credential
```

- **The carrier** (`public/carrier.html`, `carrier.js`) is the one page of
  the preview site the relay serves (with the same `sw.js`, which reads its
  own host). The shell makes it the first time the app shows a preview and
  keeps it for the visit; it installs the preview site's worker and hands
  each request it gets to the shell over a `MessagePort`. Answers stream
  from the shell to the worker directly.
- **Nothing reaches the relay before the worker can answer.** `inside.js`
  gives the app `__anywherePreview` (`origin`, `ready()`); `artifacts.js`
  sets a frame's address only once `ready()` resolves, so the relay never
  sees an artifact's address (its capability names the conversation and the
  folder). The test asserts the relay was asked for the carrier only.
- **Least authority.** Any page of the preview site can do what the carrier
  does (they share an origin), so the carrier gets nothing more than a
  preview may ask anyway. The shell sends only reads of preview paths, with
  an allowlist of headers; the home, which does not trust the shell for this,
  holds to the same list (`protocol.previewPath`), goes only to the preview
  server, sends **no credential** (the capability is the authority, as on
  every door, and is re-checked against the person's access), and refuses
  any other kind. A home that has no preview server says `can: []` in its
  welcome and the phone asks it nothing.
- **Isolation, stated.** One preview origin for all artifacts (like the
  tailnet's), the same *site* as the relay's page. As on the tailnet, a
  different name on one site; here nothing at the relay's origin uses
  cookies (the tunnel is the authority), so a preview page has nothing to
  send along.
- **Framing.** The preview server's `frame-ancestors` and the sandbox proxy's
  host check include the relay's origin while Anywhere is on; the shell's
  policy allows `frame-src previews.<relay>`; the carrier may be framed by the
  relay's page only.
- **The Android app** serves `sw.js` and the carrier for `previews.<relay>`
  from its own files too (`AnywhereShell.kt`), so the relay cannot replace
  code that sees preview content there either.
- **DNS**: `previews.<relay>` needs its own A and AAAA records; Caddy gets its
  certificate like the relay's (setup-ubuntu.sh, nixos.nix). Without them
  the panel says previews could not start, in words.
- **When it cannot**: the frame becomes a line in the panel (not connected,
  an older computer, the preview address unreachable), never a blank.
- Tests: `test/anywhere.test.js` (the home's routing and refusals, the
  relay's preview address), `test/anywhere-previews-browser.test.js` (a
  phone-sized Chromium, a real relay at `relay.localhost` and
  `previews.relay.localhost`, a real Chattering: a web page with a picture
  and storage, a widget through the sandbox proxy).

## Where it runs (Level 1, 2026-09-30)

- **Machine**: OVHcloud VPS-1, Beauharnois QC (2 vCPU, 4 GB, 40 GB,
  unlimited traffic, anti-DDoS), Ubuntu 26.04. Public `144.217.95.30`,
  `2607:5300:205:200::a009`; OVH name `vps-5e7e7197.vps.ovh.ca`.
- **Set up by** `anywhere/deploy/setup-ubuntu.sh`; relay code by
  `anywhere/deploy/deploy-relay.sh` (pushed commits only).
- **Getting in**: `ssh ubuntu@encrypted-link-relay` over Tailscale (keys
  only; SSH is closed to the internet). If Tailscale is down: OVH
  customer area → the VPS → KVM (a console in the browser), then
  `sudo DOMAIN=… PUBLIC_SSH=1 bash /tmp/setup-ubuntu.sh` or fix from there.
- **Tailnet**: the relay is `tag:relay`. The tailnet policy (edited
  2026-09-30) lets `autogroup:member` and `autogroup:shared` start
  connections and tagged devices none; its tests assert the relay reaches
  none of lambda, XPSwhite, lilly-pc, the phone. Checked: the relay
  cannot open lambda:22, lambda:7433, XPSwhite:22, lilly-pc:445.
- **DNS (GoDaddy)**: A and AAAA for the name; CAA `0 issue
  "letsencrypt.org"` on the name (GoDaddy's editor drops `accounturi`; the
  account is `https://acme-v02.api.letsencrypt.org/acme/acct/3809097526`,
  to add once DNS moves, design/86). Domain lock, privacy and auto-renew
  are on. DNSSEC deliberately off until the DNS host is decided.
- **Previews' name** (2026-10-04): `previews.encrypted-link-to-your-devices.rockfrog.ai`,
  A and AAAA to the same addresses, DNS only (never proxied), at Cloudflare,
  where rockfrog.ai's DNS now lives (the CAA above covers it, one level up);
  its certificate from Let's Encrypt through Caddy, like the relay's.
- **Exposed**: TCP 80, 443 (Caddy), 3478 and 5349 (coturn), UDP 443, 3478,
  49152–65535 (coturn relaying), 41641 (Tailscale). Nothing else answers.
- **Checked from outside**: Let's Encrypt certificate; HSTS and the
  shell's headers; coturn refuses expired and wrong credentials and will
  not relay to the server itself; the relay's sandbox (no network out,
  code read-only; systemd exposure 1.1).
- **Learned in the first hour**: a scanner's request (`//%2e%2e%2f.env`)
  crashed the relay; Chattering had the same crash before sign-in. Both
  fixed (requestUrl), with tests. Caddy's error messages recorded visitor
  addresses; they are excluded now, and the journal lives in memory for a
  day.
- **Owner's to do**: two-step sign-in (a hardware key if possible) on OVH,
  GoDaddy and GitHub; `sudo pro attach <token>` (Ubuntu Pro, free) so Node
  and coturn get Canonical's security fixes; Cert Spotter (sslmate.com,
  free) alerts for `rockfrog.ai`.

## Files

`anywhere/protocol.js` (frames, multiplexer, handshake, pairing link),
`anywhere/client.js` (the phone's connection, shared with the tests),
`anywhere/relay.js`, `anywhere/public/` (shell, service worker, inside.js,
the previews' carrier),
`anywhere/deploy/` (NixOS module, systemd unit, coturn config),
`anywhere-home.js` (the home), `anywhere-ui.js`/`.css` (settings → machines),
`vendor/qrcode-generator/` (MIT). Server: `/api/anywhere*` (policy.js),
`settings.anywhere = { relay, off }`, the `anywhere` live event.
