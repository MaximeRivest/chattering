# 92 — Shared links: anyone with the link, served from your own computer

*2026-10-02. Builds on design/46 (shared documents), 56 (doors, guard),
67 (artifacts, the preview address), 69 (closed by default), 76 (programs
you ship), 85 and 86 (the relay; the page from your own computer).
Decided with Maxime on 2026-10-02. Modules: `shares.js`,
`share-page/` (the visitor's page), `shares-ui.js` (the owner's dialog);
changes in `collab.js` (pinned names, a budget), `server.js` (the gate on
the preview listener, `/api/shares*`), `policy.js`, `live-file.js`.
Tests: `test/shares.test.js`.*

## The job

*When I want someone to read or edit something I made, let me send a link,
like a Google Doc, without uploading it anywhere: it lives on my computer,
it is online when my computer is, and I can take it back at once.*

Maxime's bet: people's computers will be connected most of the time. When
one is off, its links say so and wait. Hosting copies for people is a later
option that must not change the design.

## Three kinds of thing, one share

| Kind | Examples | The visitor gets |
|---|---|---|
| **Live document** | a `.md` people edit together | the real file, as it changes |
| **Frozen copy** | a web artifact, a game, a rendered `.md`, a conversation, slides, a notebook with its results | a snapshot, named by its content |
| **Live program** | a FunctAI program (design/76) | a form or API that runs here |

A **share** is one record on the computer: *what* (a file, a copy, a
program), *live or frozen*, *who* (anyone with the link; named people
later), *can* (view, edit; comment and run later), *until when*, *limits*.
Every request from outside passes **one gate** that reads that record;
nothing else on the computer is reachable from a share.

## The foundations, in order of how hard they are to change later

1. **The share record and the gate** (built). One store
   (`~/.local/share/chattering/shares.json`), one gate (`shares.js`),
   re-checked on every request: the share is active, the thing it names
   still exists, and *the person who shared it still has the right to*.
2. **The link format** (built, v1). `<origin>/s/<id>/#<secret>`.
   - `id`: 16 lowercase base32 characters, so it can become a host name
     (`<id>.<user>.rockfrog.site`) without changing.
   - `secret`: 128 bits after `#`, which browsers never send to a server:
     not in request lines, logs, Referer, or the relay. The page proves it
     once and gets a session cookie for that share's path only.
   - Derived (HMAC of id and a generation, key in a 0600 file), so the
     owner can copy the link again any time; **New link** bumps the
     generation, ending the old link and all its sessions.
   - Frozen copies add the copy's content fingerprint to the link (below).
3. **Public addresses: the relay routes, it never reads** (next). Exactly
   design/86 Level 2, applied to shares: `*.rockfrog.site` points at the
   relay; the relay reads only the name in the TLS hello (SNI) and pipes
   the encrypted bytes to the computer that registered that name; **the
   certificate lives on the computer** (Let's Encrypt, DNS-01 through
   acme-dns). So the relay neither sees the content nor serves the code
   (the weak point of design/85's shell is absent here). Each computer
   watches Certificate Transparency logs for its own names.
   Names: `<id>.<user>.rockfrog.site` per share, `<name>.<user>…` for a
   chosen name, and **your own domain** by a CNAME to the relay (the relay
   routes it once the owner proves the domain; HTTP-01 for its certificate).
4. **Frozen copies named by their content** (next). A publish writes the
   files once to a content-addressed store (the checkpoint store already
   does this for artifacts) and the link names the root hash. A browser
   can check what it got against the name, whoever served it: the
   computer, a cache, a friend's server, a host Rockfrog runs later. That is
   what makes "hosting later" trustless, so it stays cheap, distributed and
   owned. Renderers turn things into copies: artifact folder (as is), `.md`
   → page, conversation → page (**with a review screen**: paths, command
   output, anything that looks like a key; whole steps can be left out),
   notebook → page with results, slides.
5. **Live documents** (built): the Yjs document Chattering already holds
   for every file under edit (`collab.js`); the share joins people to it.
6. **Live programs** (later): design/76's server behind the gate, with the
   share's budget and rate as hard limits (public = an API key, never a
   subscription; D4 there).
7. **Copies elsewhere** (later): content-addressed copies and CRDT
   documents can live on more machines (your laptop, a €4 server, a
   friend's, Rockfrog's), encrypted at rest for link-only shares.
8. **Protection and control**: the relay — speed limits, size caps, a per-
   name kill switch, a report link, the domain on the Public Suffix List;
   the computer — who opened what, live counts, turn off or replace in one
   click (built).

## What is built today (2026-10-02)

- **Owner**: a **Share** button on every Markdown document (file view head,
  and ⋯ on narrow screens). The dialog lists the document's links (can
  view / can edit, switchable), makes new ones (no end, a day, a week, a
  month), copies, replaces (**New link**) and turns off; it says who can
  open the link and how many people are on it now. Guests never see it,
  and the API refuses them (`member` in policy.js).
- **Visitor**: opens the link in any browser, says a name (or stays
  anonymous), and edits or reads the document live with everyone else: the
  owner in Chattering, agents writing the file, other visitors. Pictures
  beside the document show. When the computer is off the page says so and
  reconnects by itself; when the link is turned off or replaced the page
  says so and stops; a role change reconnects with the new role.
- **Served from** the preview listener (port 7435, Tailscale Serve 8443,
  LAN TLS 7445), never the app's address. Links today open for people on
  the tailnet (or the home network); `shareBase` in settings puts the
  public address first once rockfrog.site exists.

### The gate, precisely

- `GET /s/<id>/`: the same page for every id, known or not (no oracle).
- `POST /s/<id>/open`: proves the secret (constant time; the sign-in
  limiter per address, design/56); refused if another site starts it
  (`Sec-Fetch-Site`). Answers the title, role, the sharer's name, the file
  name: **never the path**. Sets `chattering_share_<id>` (HttpOnly,
  SameSite=Strict, Path=/s/<id>/, Secure behind https).
- `GET /s/<id>/asset?src=`: pictures only (by extension), only in the
  document's folder or below, after resolving links (a symlink out is
  refused), 25 MB at most; an SVG gets a sandboxing policy of its own.
- `WS /s/<id>/collab`: the session cookie and the page's own Origin; at
  most 50 people per share and 300 in all; 512 KB per message and 4 MB a
  minute per visitor (over that, the connection closes).
- Every answer: a strict policy (`script-src 'self'`, `connect-src 'self'`,
  `frame-ancestors 'none'`, no plugins, no forms), `noindex`, no referrer.
- **Names cannot be faked.** A visitor's name at their cursor is set by the
  server ("Ada (via link)"), whatever their page sends, and a visitor can
  speak only for cursors they introduced (`pinUser` in `collab.js`).
- **Edits land like anyone's**: through the ordinary save path (file
  history, ledger), attributed to `link:<share>:<visitor>`.
- **A link that ends ends now**: turn off, replace and role changes close
  live connections at once; expiry and the sharer losing access close them
  within a minute (the sweep).
- While visitors are connected the file is watched on its own, so an
  agent's write reaches them even in a folder Chattering does not watch.

### The same look as in Chattering

A shared document is drawn by the same editor with the same theme and CSS
as the owner's file view: `document-look.js` (the editor theme from the
design tokens, and ```mermaid diagrams) and `document-editor.css` (headings,
code and output blocks, the reading column) are one source, loaded by
`app.html` and by the share page. `test/shares.test.js` compares the
computed styles of the same document in both and fails if they differ.
A notebook's saved results (`<iframe class="rat-output"
src="_assets/generated/…html">`) are served from an `_assets/generated`
folder beside the document only, always with `sandbox allow-scripts` (an
origin of their own: no cookies, no reach into the page), framed by the
share page only. Differences that remain on purpose: no Run, AI, history
or line gutter for visitors, and the visitor's own light or dark mode
rather than the owner's theme.

### Conversations (built 2026-10-03)

A conversation is shared **live** (new messages appear as they are
written) or as a **snapshot** (a copy kept when the link is made, which the
owner can update), always read only. Owner: the conversation's "who can see
this" dialog → *Share by link…*, which first says what Chattering found that
looks like a secret.

- **Read in Chattering's own page, not a copy of it.** The share serves
  `app.html` itself at `/s/<id>/view`, with `share-page/viewer.js` first:
  it answers the app's requests from the share's routes (`/s/<id>/api/
  session`, `sessions`, `users`, `media`, `events`), which name only this
  conversation; everything else gets "not found", and anything that would
  change something is refused (by the page, and the server has no route for
  it). `viewer.css` hides the composer, the side list, message actions and
  the owner's controls; the app itself only skips its composer when
  `CHATTERING_VIEWER` is set. The app's files are served at their own paths
  from `APP_FILES` (the table the app serves from), minus its service worker.
- **Nothing in a conversation can run as code there**: the page's policy
  allows its own inline scripts by their SHA-256 and nothing else.
- **The page knows it as "shared"**: no file name, no internal key; the
  index fields only the owner's screens use are left out.
- **Secrets are hidden before they leave** (`redactDeep` in shares.js:
  private keys, provider API keys, GitHub/AWS/Google/Slack tokens, JWTs,
  authorization headers, credentials in URLs, `NAME_KEY=…` values shaped
  like a key). A snapshot is kept raw on this computer
  (`share-snapshots/<id>.json`, 0600) and hidden when served, so better
  patterns apply to old copies too.
- **Live** follows the app's own `update` event for that conversation.

Trade-offs: what a step changed in files (the "changes" under a box of
steps), artifacts and widgets, and a reply while it is being written are
not shown to visitors (the first two would reach beyond the transcript; the
third arrives when the message is saved). Secret detection is by shape:
a password in plain words, or a code like a transfer code, is not caught,
which the dialog says. The visitor sees their own light or dark mode.

### Publications: frozen copies at their own addresses (built 2026-10-03)

A web page or game an agent made (an artifact), or an AI program made here,
published as a **frozen copy**, **signed**, at **its own address**:
`https://<slug>.<name>.rockfrog.site` (and `http://<slug>.pub.localhost:7435`
here). Modules: `publications.js` (the store, the fingerprint, the verifier),
`publication-gate.js` (what answers at a publication's address),
`program-page/` (a published program's page), `vendor/functai-browser/`
(`scripts/vendor-functai-browser.js`); in `server.js` the "publications"
block; `shares-ui.js` `openPublication`; the **Publish** button of the
artifact panel; **On the web** in a program's Endpoint tab. Tests:
`test/publications.test.js`, the publication part of `test/site.test.js`.

**A version is its content.** Every file is kept once under its SHA-256
(`publications/blobs/`), and a version is a manifest (`publications/
manifests/<root>.json`: each path with its hash, size and type, the entry,
the kind). Its fingerprint, the *root*, is the SHA-256 of the manifest
written canonically. This computer signs `chattering-publication/1\n<root>`
with the key its public address and phone link already prove (ECDSA P-256;
its id is the hash of that key). `/.well-known/chattering-publication.json`
serves manifest, root, signature and signer; `/_v/<root>/<path>` serves one
exact version, unchanging; every file carries `ETag` = its hash,
`Repr-Digest` and `X-Chattering-Fingerprint`. `node publications.js <url>`
(or `verifyPublication` in a page) checks every file against the manifest,
the manifest against the root, the root against the signature and the key
against the computer's id. So a copy served by anyone — a cache, a friend's
server, hosting later — can be checked without trusting who served it.
Versions stay (roll back to any); unpublishing deletes what no live
publication names (`gc`).

**What goes out is shown first.** For an artifact: the version on screen
(from the checkpoints) or the disk; left out, and said: names starting with
a dot (`.env`, `.git`), dependency and build folders, links leading outside
the folder, files over the limits (5000 files, 64 MB each, 256 MB in all);
text that looks like a secret is pointed out by file (the patterns of shared
conversations). A folder needs its `index.html`; one picture, PDF, video or
sound file publishes alone. For a program: its live version.

**Its own address, for isolation.** A page an agent wrote runs any script it
likes on its own origin, so it reaches nothing of Chattering, of shared
documents and conversations, or of other publications. Nothing else answers
at a publication's address (the gate routes by host first). Each address has
its own certificate (HTTP-01 through the relay, like the computer's own; one
order at a time, a failed address retried after an hour); the relay's Caddy
answers checks for two-level names (`http://*.*.rockfrog.site`).

**Access**: *anyone with the link* (`https://game.maxime.rockfrog.site/#k=…`:
a small page of ours proves the secret once for a `__Host-` cookie of that
address, then reloads; `noindex`, framed only by itself) or *public* (no
secret; embeddable; indexable).

#### AI programs on the web

A program's publication is its live version (`program.json`,
`functai.json`), the page that runs it (`program-page/`), FunctAI for
browsers (`functai.mjs`, 661 KB: FunctAI + lmcc + lm15's browser build, the
same versions of a program as Chattering's own FunctAI — checked on every
program made here), and `providers.json` (twelve AI companies a page may
call directly, from lm15's registry, each with its address and where to get
a key). The page is a form from the program's inputs, the answer as it is
written, and how to call it from code (FunctAI in TypeScript or Python with
`functai.json`; `curl` when its maker pays).

**Paid by the visitor, in their own browser** (always offered, as lm15's
playground does it). FunctAI runs in the page; the request goes from the
visitor's browser to the AI company with their key. The page's policy
(`connect-src 'self'` + the companies' addresses, `script-src 'self'`) lets
the key go to that company and nowhere else: not to the maker, not to
Rockfrog, not to anything injected. A key can be remembered on the device,
encrypted (AES-GCM under a non-extractable browser key in IndexedDB, for
that address only).

**Paid by its maker**, when chosen (the owner tier only): on this computer,
with **a key kept for public programs only** (`public-program-keys.json`,
0600; never Pi's sign-ins: a subscription is never billed for strangers,
design/76 D4), a **monthly budget in money** from Chattering's price tables
(a model without a known price cannot be chosen), **a limit per visitor**
per hour, an input size cap, and each call's most possible cost reserved
before it starts (its input and the longest answer it may write, 2048
tokens), then counted as it was. It runs the same FunctAI build as the page.
`POST /` (or `/_chattering/run`) runs it; `GET /` with `Accept:
application/json` describes it.

**Calls come back only when the visitor ticks the box** (off by default;
the maker can refuse them). What is sent is FunctAI's own record of the call
(a build-time patch hands it to the page where a browser has no file to
write it to: `vendor-functai-browser.js`); it holds the request and the
answer, never a key. The computer keeps it in the call log beside its own
calls (`visitors-<id>.jsonl`), the caller set to `visitor` with a keyed hash
of their address, never the address, so it is judged like any other call.

#### Trade-offs, stated

- **Browsers do not check the signature by themselves.** The fingerprint,
  the signature and the verifier make tampering detectable by anyone who
  checks (and by hosts later); a browser loading the page trusts TLS, as for
  any site. Automatic checking in the page needs a service worker or signed
  web packages: later.
- **Until rockfrog.site is on the Public Suffix List**, publications are the
  same *site* as the computer's address: a published page could set a cookie
  for the whole domain. Share sessions are `__Host-` cookies and only a
  cookie that proves itself is taken, so this can break nothing but a page's
  own cookies. And every publication counts against Let's Encrypt's 50 new
  certificates a week for the whole domain.
- **No tailnet address for publications**: the tailnet name has no room for
  one address per publication, so isolation would be lost. Here they open at
  `<slug>.pub.localhost`; elsewhere through the public address.
- **Publishing a program makes its instruction public** (`functai.json`):
  the visitor's browser needs it to run it.
- **A visitor's key in the page**: a script on that address could read it;
  the address holds only the published page, whose scripts are ours and
  checkable, and nothing else can run there (`script-src 'self'`).
- **Paths reserved at a publication's address**: `/.well-known/chattering-
  publication.json`, `/_v/…`, `/_chattering/…`; files with those names in an
  artifact are shadowed.
- **Programs with tools or code** (FunctAI modules) are not publishable yet:
  only one-step programs, the kind made here.
- **Cost counted conservatively**: cached input is counted at the full input
  price.
- **Slides** need Chattering's viewer and are not publishable yet.

## The public address (built 2026-10-02)

`https://<name>.rockfrog.site` reaches one computer. Modules: relay
`anywhere/site.js` (+ `relay.js`), home `site-home.js`, `acme.js`; deploy
`setup-ubuntu.sh` (`SITE_DOMAIN`). Tests: `test/site.test.js` (Pebble,
Let's Encrypt's test server; a real browser through the relay).

```
visitor ──TLS (ends on the home)──▶ relay :443 HAProxy ── SNI *.rockfrog.site ──▶ site.js
                                                    └─ any other name ─▶ Caddy (PROXY v2), as before
site.js: reads the name in the hello only, asks the home (its /site WebSocket)
         to open a tunnel (/site/tunnel?cid), pipes the bytes both ways
home:    TLSSocket over the tunnel, its own certificate; only the shared-links
         gate answers (no app, no previews): 404 for anything else
```

- **The certificate is the home's.** HTTP-01 through the relay: Caddy on
  :80 sends `http://*.rockfrog.site` to `relay.js`, which answers the
  challenge tokens its home sent it over the authenticated connection.
  Renewed 30 days before it ends. Per-home certificates, not wildcards
  (CAA forbids wildcards: `issuewild ";"`), so nothing on the relay or in
  DNS changes when a computer joins.
- **Why not DNS-01 as design/86 planned:** it would need either a DNS API
  token on the relay or acme-dns run by Rockfrog; HTTP-01 through the
  relay needs neither and gives Rockfrog the same power it has anyway as
  the domain's owner (it could get a certificate for any name under it).
  That power is watched: each home reads crt.sh daily and reports a
  certificate it did not ask for (`ctWarning`, shown in the Share dialog).
- **Names are by invitation** (`/etc/chattering-site/homes`, one computer
  id a line, read on every claim) until abuse can be handled (reports, a
  kill switch per name). One name per computer; first come; kept in
  `site-names.json`, the relay's one new piece of state.
- **Only the relay's front changed for everyone else:** HAProxy holds :443
  and hands every other name to Caddy on 8443 with the visitor's address
  (PROXY v2). Cost: no HTTP/3 for the relay's page (UDP does not pass
  through HAProxy).
- **DNS** (Cloudflare, DNS only, DNSSEC on, DS at GoDaddy): `rockfrog.site`
  and `*.rockfrog.site` A/AAAA → the relay; CAA `letsencrypt.org` only.
- **Settings**: `publicLinks: { on, name }`; the owner turns it on in the
  Share dialog. `/api/public-links` (GET household, POST owner).

Trade-offs of the public address:

- **A computer that is off is a browser error** ("site can't be reached"),
  not a friendly page: the relay holds no certificate for the name, so it
  cannot answer in its place. Once the page has loaded, the page itself
  says the computer went away and reconnects.
- **Until rockfrog.site is on the Public Suffix List**, every name shares
  Let's Encrypt's limit of 50 new certificates a week for the domain, and
  browsers treat `a.rockfrog.site` and `b.rockfrog.site` as the same *site*
  (not the same origin: cookies are host-only and pages cannot read each
  other). Submit the PSL request after a few weeks of use.
- **Every visitor connection is a new WebSocket from the home to the
  relay** (one round trip more on a new connection; browsers reuse them).
- **The relay can see who visits which name** (addresses, sizes, times), in
  memory only, like any internet router. It cannot see what is said.

## Trade-offs, stated

- **Links open on the tailnet only until rockfrog.site is running.** The
  Funnel door (design/56) could open the preview port to the internet
  today; not done, because it opens every preview capability to the
  internet with it, and it is a decision for Maxime.
- **On the tailnet, shares share one address with artifact previews**
  (`lambda…:8443`). An agent-written artifact page opened in the same
  browser could use a share session of that browser (never read it: the
  cookie is HttpOnly). On rockfrog.site every share has its own address.
- **A path names the file.** Moving or renaming it ends its links ("moved
  or deleted"); Google Docs links survive renames. A file identity that
  follows renames (the ledger can) is a later step.
- **An edit link lets its holder see any picture in the document's folder
  tree** by writing its path into the document. Pictures only, never
  above the folder.
- **Pictures from other websites load directly** in the visitor's browser
  (`img-src https:`), so an editor can learn other visitors' addresses
  with a tracking image. Google proxies images; a proxy here would cost the
  computer's bandwidth. Revisit with the relay.
- **After a dropped connection the page starts fresh** (the computer may
  have restarted with a new copy of the file; merging an old copy would
  repeat the text). Typing pauses while it is down; a keystroke in flight
  at the moment it drops can be lost.
- **Visitors are attributed by an id, not a person.** The ledger shows the
  share and a random visitor id; the name they typed is shown live, not
  stored.
- **No comments yet.** The role exists in the design, not in the code.
- **The secret is derivable on this computer** (to re-show links): whoever
  reads the key file can make every link. It sits beside the install's
  other secrets (0600).

## The domain

**Registered 2026-10-02** at GoDaddy for 3 years (renews in 2029), DNS
on Cloudflare (same account as
rockfrog.ai), DNSSEC on (DS key tag 2371 at GoDaddy), registrar lock and
auto-renew on. Remaining: submit `rockfrog.site` to the Public Suffix List
(a `_psl` TXT record and a pull request), so each `<name>.rockfrog.site` is
its own site to browsers and to Let's Encrypt's limits. Weeks to merge,
months to reach every browser; nothing waits on it.

Trade-off: `.site` is a cheap ending that spam lists watch more than
`.page` or `.com`; ChatGPT uses `chatgpt.site` for the same purpose.
`rockfrog.page` was also free (HTTPS-only by the registry's rule).

## Next

1. Public Suffix List submission for rockfrog.site; abuse reports and a
   per-name kill switch on the relay; then names for everyone.
2. Checking publications in the page itself (a service worker that verifies
   each file against the signed manifest), so copies hosted elsewhere need
   no trust at all; then copies on other machines, for addresses that stay
   up when the computer is off.
3. Programs with tools and code on the web (sandboxed, design/76 phase 3).
4. Own domains; slides as publications.
