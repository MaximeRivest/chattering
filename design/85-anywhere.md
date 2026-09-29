# Your phone, anywhere: a relay that cannot read

Status: built and tested end to end (protocol, pairing, tunnel, a real
Chattering, a phone-sized Chromium, a real coturn). Not yet deployed: the
relay at `anywhere.rockfrog.ai` has to be rented and switched on
(anywhere/README.md). Not yet tried on a real iPhone or Android phone.

## The question

Until now, a phone reached Chattering through Tailscale: install it on the
computer and the phone, sign both in, and (for everything to work) run a
`tailscale serve` command. That is how this household does it. It is too
much for a new person, and Chattering's installer did none of it.

What a new person should do: press **Add a phone** on the computer, scan the
code with the phone. Chattering is on the phone, from anywhere, with no app
and no account. Nothing readable passes through anyone else's server, and
that server keeps nothing.

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
- **Not carried yet**: artifact previews (their own origin, port 7435 or the
  tailnet's 8443) and forms that navigate away (`POST` pages). Pages, scripts,
  pictures, downloads, the event stream and WebSockets are (the tests cover
  the app, the event stream and live collaboration; voice and PDFs use the
  same paths, untested).
- **Tailscale stays**: the tailnet door, the public door and LAN links keep
  working as before; Anywhere is another door, not a replacement.
- **Not tested on real phones and networks yet**: the tests cover a
  phone-sized Chromium on one machine and a real coturn on loopback. A week
  on real phones, mobile data included, is the next step.

## Files

`anywhere/protocol.js` (frames, multiplexer, handshake, pairing link),
`anywhere/client.js` (the phone's connection, shared with the tests),
`anywhere/relay.js`, `anywhere/public/` (shell, service worker, inside.js),
`anywhere/deploy/` (NixOS module, systemd unit, coturn config),
`anywhere-home.js` (the home), `anywhere-ui.js`/`.css` (settings → machines),
`vendor/qrcode-generator/` (MIT). Server: `/api/anywhere*` (policy.js),
`settings.anywhere = { relay, off }`, the `anywhere` live event.
