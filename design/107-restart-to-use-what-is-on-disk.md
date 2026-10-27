# 107 · Restart to use what is on disk

*2026-10-27. Modules: `app-update.js` (what changed, how to restart),
`app-update-ui.js` (the notice), `server.js` (`/api/app/update`,
`/api/app/restart`, `/_chattering/update`, `restartChattering`),
`module-stamps.js` (design/82). Tests: `app-update`, `app-update-server`
(a server from a copy of the app; a real systemd unit; an install's
launcher), `anywhere-links-local` (through a link).*

## Why

A running Node server keeps the code it loaded. On 24 October a fix for
Lilly's artifacts (seen through the link from her Windows app to lambda)
was copied into her installed app; the app had been running since 10
October and ran the old code until 27 October. Nobody could see that,
and her artifacts stayed blank for three more days.

## What it does

- **Detects** it from the files the process loaded: one whose time on disk
  differs from its time at load, or that is gone, once nothing has changed
  for 30 s (an agent saving file after file is not an update yet); and a
  newer version an install says is current (`current.txt`), at once. Only
  this program's own code counts, not its tests or a project's files.
- **Tells** the computer's owner tier: an `app-update` event and a notice
  at the foot of the side panel (and a toast once per new state, for
  phones). A page shown through a link between computers also asks the
  install that holds the link (`/_chattering/update`), the only way that
  install can be reached from the page: that was Lilly's case.
- **Restarts**, from the button, once no reply is being written (or now,
  confirmed: running replies show as interrupted), by what started it:
  - a systemd unit (lambda): its manager restarts it, from a transient
    unit that outlives this process. Only when this process *is* the
    unit's main process: a server started from inside a service (an
    agent's shell, a test) shares its cgroup and environment, and would
    otherwise restart someone else's server (found by a test);
  - an install (Windows, macOS, the Linux installer): a helper waits for
    this process to end, then runs the install's launcher (`start`), which
    follows `current.txt`. On Windows the launcher is a `.cmd`, run by
    `cmd.exe /d /s /c` with the command quoted once more (verified on
    Windows: without it, nothing started);
  - started by hand: no button; the notice says to restart it where it was
    started.
  A restart through a link needs the button's own header
  (`X-Chattering-Restart`), which another site's page cannot send.

## Trade-offs, stated

- On a checkout agents edit all day (lambda), the notice is up most of
  the time for its owner. That is true, and calm (no modal); the button
  waits for running replies, so it can wait a long time there.
- The restart button does not resume replies itself: it waits until none
  is running. "Restart now" interrupts them; they show as interrupted and
  continue on request. `scripts/restart-chattering.sh` (lambda) still
  resumes busy conversations after a restart, for an operator.
- Only the owner tier is told and may restart. A member on a hub (Lilly on
  lambda) is not told that the hub's code is old; she is told about the
  install on her own computer.
- Files the page loads (app.html, its scripts) are read at each load: a
  reload uses them, and a new server boot already offers one.
