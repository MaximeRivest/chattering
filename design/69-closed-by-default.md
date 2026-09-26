# 69 · Closed by default: every exit says who may use it

*2026-09-26. Module `policy.js`; gate in `server.js` (`handleRequest`,
`upgradeRequest`, `broadcast`); tests `policy`, `guest-exits`. First step
of the market-readiness work (TODO item 2, "Sign-in and access review").*

## Why this first

Chattering is going to people who are not this household. Before
installers, platforms or team features, what the server hands out has to be
right, because a leak cannot be taken back and every later feature adds
routes. An audit on 2026-09-26 found the server open by default: of 233
API routes, 183 had no identity check, and checks were added at
chokepoints one by one (design/46, 53). Two holes let an invited guest
become the owner:

- `GET /api/settings` returned the connect links, which carry the
  install token, the owner's credential, to every signed-in person.
- `POST /api/machines/register` accepted a new trusted machine from any
  signed-in person; a registered machine's key signs handoffs, and a
  handoff that names the owner's id signs in as the owner.

Beyond those, a guest could read and edit any raw transcript, use the
records API over every conversation, and receive every live event (titles,
folders, files, streaming text) of every conversation on the machine.

## The rule

Two exits carry data out: HTTP routes (sockets included) and the live
event stream. Both are closed by default.

- **Routes.** `policy.js` lists every `/api/` route with a level:
  `guest` (anyone signed in; the object is checked in the handler or by a
  declared query parameter), `member` (the household), `owner` (console,
  owner, admin). An unlisted route answers the owner tier only. One gate
  in `handleRequest` and the same gate in `upgradeRequest` apply it before
  any handler runs. A route that names a conversation in its query string
  declares it (`see('id')`) and the gate checks it, so the handler cannot
  forget.
- **Events.** `broadcast()` asks `policy.eventView(ev, receiver)` per
  browser. Each event type has a rule (about a conversation, a project, a
  file, or the household); an event can be narrowed (a list of titles
  loses the hidden ones) or dropped. An unknown type reaches the owner
  tier only. `/api/jobs`, `/api/recent-files` and `/api/agent-read` apply
  the same rules to their listings.
- **The test is the guard.** `test/policy.test.js` reads `server.js` and
  fails when a route or an event type has no decision, or when the table
  names a route that no longer exists. Adding a route means deciding who
  may call it, in review, where the decision is visible.

## What changed for whom

- **Owner, console, admins:** nothing.
- **Household members** (Lilly on lambda): the same routes as before,
  with three exceptions, all administration: registering a machine,
  changing usage billing, and seeing the connect links (they hold the
  owner's token). A conversation hidden from them by a rule is now also
  refused by the routes that name it in the query (media, context, diffs,
  file history, compare, note), which it was not before.
- **Guests:** the shared project works as before: list, read, send,
  fork, files, save, commit, run commands behind the walls, live updates,
  shared typing. Now refused: records API, raw transcripts, notes, epics,
  project memory, agents and delegations on the machine, voice, notebooks,
  change reviews, git and file history panes, file asks. A guest's read
  marks are answered but not written into the household's one inbox.

## Trade-offs, stated

- Guests lose features they had, because those features were open to them
  without a check, not because they are wrong for guests. Each can come
  back once its handler checks the project: notebooks (`/api/doc/*`, rat
  outside the sandbox today), change reviews, file and git history, and
  the records tools for a guest's agent (needs a records instance over the
  guest's visible index only).
- Member-level routes are still household trust ("polite walls",
  design/46). Deciding which of them should be the owner tier's
  (killing processes, editing modes, rescanning, usage) is a product
  decision, not a security fix; the table is where it will be made.
- The settings a guest reads still include this machine's service
  addresses (semantic, speech). No secrets, but more than a guest needs.
- Project memory is written from every conversation of a project. A
  conversation hidden from members by a rule can still shape the memory
  they read. Not yet fixed; guests cannot read memory at all now.
- A guest's live view of a brand-new conversation starts once it is
  indexed (well under a second in practice), not from Pi's first event.

## Verified

`test/guest-exits.test.js` boots a real server, invites a guest and adds
a member, and tries the attacks: the owner's token in settings, a forged
machine, raw transcripts, records, notes, a hidden conversation named in
a query, and a change to a hidden conversation on the live stream. It
fails on the code before this change (the token leak), and fails again
when the event filter or the register rule is removed on purpose. The app
was also loaded as a guest in headless Chromium: the shared conversation
and a file open, with no page errors and no warnings.
