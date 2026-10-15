# 100 — Notifications on a person's devices

Status: built (2026-10-15). Not yet deployed: the relay's new worker and
mailbox, and Android app 0.3.11, ship separately.

## The job

"Tell me when it's done, and when it needs me, wherever I am." An agent
works for minutes; the person walks away. The phone (iPhone or Android),
the e-ink tablet and any browser should buzz when a reply is ready, when an
agent waits for an answer, or when work fails or goes quiet. Then get out
of the way.

Before this, only the Android app could notify. Its switch was hidden
under Settings → sound, off by default, and it listened to the computer's
event stream directly, so it worked only on the home network or Tailscale.
The app's default connection (the encrypted link) never got anything. The
iPhone and browsers had nothing.

## Shape

```
 computer (push.js)  ── encrypted (RFC 8291) + signed (VAPID, RFC 8292) ──▶
     ├─ Apple / Google / Mozilla push service ─▶ browser / iPhone icon ─▶ push-worker.js
     └─ relay mailbox (anywhere/mailbox.js) ─▶ Android app (NotifyService, WebPushCrypto)
```

- **One standard, two carriers.** Every device gets the Web Push message
  format. Browsers use their maker's push service. The Android app has a
  WebView, and a WebView has no push service. E-ink tablets have no Google
  services. So the relay holds a small mailbox: the computer posts to
  `https://<relay>/_push/<id>` exactly as it would post to Apple, and the app
  takes its messages over one WebSocket. The computer's code has one path.
- **No central key.** Each install has its own VAPID key (`push/vapid.json`,
  private). Rockfrog runs nothing that could notify everyone.
- **Through the encrypted link (iPhone).** One browser subscription at the
  relay's address serves every computer the phone is paired with. A
  subscription is bound to one signing key, so the phone makes that key
  itself (`shell.js pushKey`, kept beside its pairings) and gives it to each
  computer. Each computer then signs with it. This was verified with two
  computers in `test/push-anywhere-browser.test.js`.

## When it buzzes (push-policy.js)

Rules a person can predict:

1. Only conversations in their list (opened by someone, design/59). A
   helper agent's own conversation never buzzes.
2. Only the person it is for: who asked; else whoever started the agent's
   program; else whoever wrote in it; else the owner.
3. Never about a conversation they are looking at on any screen (visible,
   touched in the last 15 minutes). Reading it before the 1.5 s wait ends
   drops the pending notification.
4. Not while they use Chattering on another screen: a visible, focused
   window touched in the last 2 minutes. That screen already shows it. Each
   device can opt out ("even while I use Chattering on another screen").
5. Each device chooses: replies, questions, problems (failed or quiet), and
   whether the first words of a reply show (lock screen included).
6. A run the person stopped says nothing. Parallel answers notify once, when
   the last one is in ("3 answers ready").

Screens report where they are (`POST /api/push/here`): visible, focused,
idle time, conversation. They report on each change, at most once a minute
while in use, and synchronously as a page goes away. A report is trusted
for 150 s.

## What a notification says

- **Title:** the conversation's.
- **Body:** the reply's first words, or "Waiting for you: …", or "Stopped
  with an error: …".
- **One notification per conversation.** It has a tag, and the push
  `Topic` uses the same tag, so a newer message also replaces an older one
  still waiting at the push service.
- **Badge:** the app icon's count is the unread replies.
- **Read elsewhere clears it.** Each message lists the tags still unread,
  and the device closes the others. The page also closes them when it sees
  them read.
- **Tapping** opens that conversation in the open window, or a new one. On
  a phone paired with several computers it switches to the right computer
  first (`shell.js openAt`, `?home=`).
- **Timing:** messages are padded to 256-byte steps (the push service learns
  a size class, not a size) and kept at most 3 KB. Urgency is "high" for
  what is shown at once, so a sleeping phone is not minutes late. Quiet-work
  reminders are "normal".

## Settings → notifications (push-ui.js)

- This device: a single on/off. Turning on asks the browser's or Android's
  question in the same tap, which Safari requires. Per-kind choices, a test
  button and rename are there too.
- The person's other devices: last delivered or the last error, test, rename,
  remove.
- **Recent notifications, and why:** each decision with its reason ("not sent
  to iPhone: you were using Chattering on another screen"). This answers
  "why did my phone stay quiet?".
- Clear guidance where notifications cannot work: an iPhone in Safari (add to
  the Home Screen), a blocked permission, a plain-http address, an old
  Android app.
- A one-time offer at the moment it helps: on a phone, when a reply is still
  running 15 s after sending. At most twice, three days apart.

## Trade-offs taken

- **Apple, Google and Mozilla see metadata.** Each notification goes through
  their service. They see the timing and the size class, never the content
  (end-to-end encrypted).
- **The relay keeps waiting messages in memory**, at most 25 per mailbox
  and a day each; nothing touches disk. A relay restart loses what was
  waiting, and the computer is not told. The relay previously kept only
  sockets: `anywhere/README.md` says so now.
- **The Android app shows a permanent "listening" notice.** Android requires
  one for a foreground service, and the app keeps a WebSocket open, as
  ntfy does. Its channel can be hidden. It uses some battery: one idle
  socket, a few bytes every two minutes. The alternative, Google's FCM,
  would need a central secret and fail on de-Googled tablets.
- **The Android app no longer listens to the computer directly.** The relay
  mailbox replaced it in both modes. A phone and computer on a home network
  with no internet get no notifications. An Android app ≥ 0.3.11 talking to
  a computer older than this gets none until the computer updates.
- **Push services are an allowlist** (Apple, Google, Mozilla, Microsoft,
  and the configured relays). Anyone signed in, guests included, can
  register an address, and the computer will post to it; an open list would
  let a guest probe the home network. A browser whose push service is not
  listed is told so and refused.
- **The phone's signing key is shared with its paired computers.** Any of
  them can notify the phone, which is the point. A computer that is
  compromised could do so too, but it could already reach the phone through
  the encrypted link.
- **Stale notifications are cleared late.** Read on the laptop, the phone's
  notification goes on the next message or when the phone opens Chattering.
  It does not go at once: iPhones end subscriptions that receive silent
  pushes, so there is no silent "clear" push.
- **The badge is an approximation.** The computer counts the side list's
  unread replies (listed, not working, visible to the person). The app's own
  count also discounts some delegated work, and the page corrects the
  badge whenever it is open.
- **Live programs (Claude Code, Codex, Agy, Muse in their own terminal).** A
  "done" is the end of "working", confirmed 4 s later, and the reply's
  words are the index's last message. A question is the program's open
  choice, without its text: the terminal reader does not expose it.

## Files

`push.js` (sender, store, crypto), `push-policy.js` (rules, message),
`push-notify.js` (waits, merges, remembers why), server.js (`pushing()`,
`pushRunFinal`, `pushLiveState`, `/api/push*`), `push-ui.js` and
`push-ui.css` (page), `anywhere/public/push-worker.js` (both service
workers), `anywhere/mailbox.js` (relay), Android `NotifyService.kt`,
`WebPushCrypto.kt`, `BootReceiver.kt`.

Tests: `push`, `anywhere-mailbox`, `push-app` (browser: settings, worker,
clearing), `push-server` (a real reply notifies; reading suppresses),
`push-anywhere-browser` (iPhone icon, two computers, one address),
`android-webpush` (Kotlin against RFC 8291).
