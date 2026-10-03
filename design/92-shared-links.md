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
2. Frozen copies: publish an artifact folder by content; then `.md`,
   conversations (with the review screen), notebooks, slides.
3. Live programs behind the gate (design/76).
4. Own domains; an "open to everyone" mode for pages search engines
   should find (the relay may see those).
5. Copies on other machines, for links that stay up with the computer off.
