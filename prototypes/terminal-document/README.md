# Terminal document: a real CLI, rendered as a Chattering conversation

**Prototype, October 1, 2026.** It is now part of Chattering: the terminal
parts live in `harness/terminal/` (host, reader, actions, hub, profiles,
recorder, terminal holder), the recordings in `test/fixtures/terminal/`, the
replay tool in `scripts/terminal-replay.js`, and the design in
`design/91-agents-own-programs.md`. This folder stays as the lab: its
benches and its standalone page use Chattering's modules. Below, the
prototype's record as it was written.

The unmodified, interactive Claude Code (and Pi) runs on a real pseudoterminal, exactly as in any terminal app. A full terminal engine (xterm.js headless, the one inside VS Code's terminal) keeps the exact screen. A reader turns that screen into an *interaction document*: the input box, menus, dialogs, transcript, status. The page draws Chattering's own conversation from it, and every key, paste and click goes back as ordinary terminal input.

```
page (HTML conversation, composer, buttons, diffs)
   ↕ WebSocket: document out · keys / paste / clicks in
host: pseudoterminal ⇄ the real CLI          (host.js)
      terminal engine = the screen, exactly   (xterm headless; answers the CLI's queries)
      reader: screen → document               (reader.js, pure, 0.3 ms)
      actions: click → keys, verified on screen (actions.js)
      Claude's session log → exact diffs       (journal.js, read-only)
```

## Try it

```sh
cd prototypes/terminal-document
node server.js --cwd /some/folder -- claude          # open http://127.0.0.1:7480/
node server.js --profile generic --cwd /some/folder -- pi --no-session
node --test test/*.test.js                            # reader rules + replays of recorded sessions
node bench.js            # Claude Code input, editing, paste, menu, dialog — no model call
node bench.js --live     # + one real turn with a permission dialog (uses your plan)
node browser-bench.js [--live]                        # the same, end to end in Chromium
```

Dependencies live only here (`node-pty`, `@xterm/headless`, `ws`). Localhost only, no sign-in: a prototype, not something to expose.

## Measured (this machine, Claude Code 2.1.285–2.1.286, Pi)

| What | Result |
|---|---|
| Keystroke → shown on the page, confirmed by the program (Chromium, 4 runs) | median **25–29 ms**, 95th percentile **32–85 ms** |
| …of which Claude Code itself (write → its first output byte) | median **4–12 ms** |
| Keystroke → the program's editor shows it (no browser) | median **10–15 ms**, 95th **55–96 ms** |
| Reader per screen update / snapshot | **0.27 ms** / **0.6 ms** median (p95 < 1.7 ms) |
| Data to the page per update (whole document + screen, uncompressed) | **~6 KB** |
| Fast typing: 43 keys, 12 ms apart | all in order; last key shown 22–30 ms later |
| Claude Code's own `/` menu appears after typing `/mo` | 84–104 ms (its debounce) |
| Menu item picked by a click (verified) | 190–290 ms |
| Dialog option chosen by a click (verified, incl. 150 ms "screen still" check) | 240–500 ms |
| Live turn: Enter → "working" / → permission dialog / → done | ~0.2 s / 2.2–2.6 s / 5.3–5.8 s (model time) |
| Pi via the generic rules: input ready / keystroke median | 0.7 s / 10–18 ms |

Raw numbers: `results/*.json`. Screenshots: `results/browser-*.png`.

Works, end to end, against the real programs: typing, cursor movement and editing (the program's own editor decides; Home, ←, Ctrl+U…), new lines inside a message, bracketed paste (Claude Code still folds a large paste into its own "[Pasted text #1 +59 lines]"), its own `/` completion as an HTML menu, the folder-trust and tool-permission dialogs as buttons, the transcript as bubbles, answers and tool cards, exact diffs from the session log, a stop button (Esc), and anything not understood kept on the page as the program drew it.

## What we learned (the trade-offs)

1. **Claude Code does not stream its words to the terminal.** While it writes, the screen shows only a spinner and a token count; a 1,558-character answer appeared in one update at 6.8 s. No terminal reader can stream what was never drawn. Word-by-word streaming needs Claude Code's machine mode (stream-json / Agent SDK) instead, which means giving up the interactive terminal for that session.
2. **Exact meaning sometimes is not on the screen.** The screen shows a few lines of a diff; the full edit is in Claude Code's own session log, which the prototype reads alongside (screen for interaction, log for the record). The log also tells Claude's real answers from its system notices, which share the same `●` mark on screen.
3. **Inference has limits, so actions are guarded.** Placeholder vs typed (dim style), selected item (colour or `→`), trailing spaces (cursor position), wrapped vs typed line breaks (word-fit rule; one ambiguous case remains) are all inferred. A structure becomes clickable only when confident: a dialog needs a "Enter to confirm / Esc to cancel" line or numbered options. Without that rule the reader once mistook an echoed two-line message for a dialog.
4. **Blind keystroke bridges are unsafe; closed loops fix it.** Keys sent 70–450 ms after start were silently dropped (the program had raw mode on but was not yet listening); the trust dialog was redrawn from scratch at ~490 ms with the highlight back on "No, exit"; the option list wraps around. A blind "down, enter" closes Claude Code. The host holds input until the program turns on its input modes, and every click is: move → wait for a still screen → check the highlight → press Enter → check the dialog is gone.
5. **It is a moving target.** Claude Code updated itself mid-test (2.1.285 → 2.1.286) and its message mark had changed (`⏺` → `●`). Each CLI needs a small profile and recorded sessions (`recordings/*.cast`, replayed in tests) re-checked on every update.
6. **"Generic" needed two additions for Pi** (an input box with no prompt sign; selection shown by `→`). Expect small rules per new CLI, not zero.
7. **Latency is terminal-like.** ~25–30 ms median, occasional ~100 ms when the program itself is slow to repaint. The page shows typed characters at once (faded) until the program confirms them.

## From a phone, an e-ink tablet or a laptop, through the encrypted link

`anywhere.js` puts the prototype on Chattering's own encrypted link (design/85) and the live relay, as a home of its own (own key and devices in `~/.cache/chattering-terminal-prototype/`; Chattering's are untouched). A paired device gets a WebRTC channel to this computer; the CLI, the terminal and the reader stay here, and only the conversation document travels.

```sh
node anywhere.js --cwd ~/scratch/x -- claude --permission-mode manual   # prints a pairing link + QR (10 min)
kill -USR1 <pid>                                                       # a fresh code → pair.txt / pair.svg
node phone-bench.js [--laptop] [--rtt=50] [--live]                     # Chromium as a phone, through the live relay
```

What changed for remote devices:

- **Only changes are sent.** Each page has the parts it already holds; a patch carries the changed parts, and lists (transcript, session log) from the first changed entry. The raw screen goes only to a page that shows it. A spinner tick alone goes at most 4×/s.
- **Phone keyboards** (`phone keyboard` switch; on by default on touch screens): an ordinary text box, so autocorrect, swipe and voice typing work. On each pause (350 ms; at once after `/` or `@`) the CLI's own editor is brought to the same text, closed-loop: cursor to the end, delete back to the common start, type or paste the rest, each step checked on screen. Its suggestions then show and can be tapped; Send closes an open suggestion list first (Enter would pick from it), presses Enter and checks the box emptied.
- **E-ink** (`e-ink` switch): black on white, no animation, "Working…" instead of a spinner, larger buttons, at most one update a second (dialogs and the box: at once).
- **One typist at a time:** input from a second device within 2.5 s of the first device's last input is refused with "phone is typing".
- **Nothing applied twice:** every message carries (device id, sequence number); a message seen again is ignored. After a drop the page reconnects, re-sends nothing, and says how many keys were not confirmed.

Measured (Chromium as a Pixel 8 or a laptop, paired through the live relay at rockfrog.ai; WebRTC found the direct path, both ends being this machine):

| What | Result |
|---|---|
| Pairing, from opening the link to the conversation on screen | 1.9–2.8 s |
| The link's own round trip (no CLI) | ~1 ms (same machine) |
| Laptop keyboard, key → confirmed by Claude Code, on screen | 25 ms; **63 ms** at a simulated 50 ms round trip (typical 4G/5G), **169 ms** at 150 ms (poor). Letters show at once, faded, until confirmed |
| Phone keyboard: last edit → Claude Code's own box holds the text | 0.39–0.48 s (mostly the 350 ms pause); 0.44 s at 50 ms, 0.54 s at 150 ms |
| Claude Code's `/` suggestions on the phone after typing `/mo` | 0.56–0.72 s (incl. its own ~0.1 s) |
| Tap a suggestion → it is in the phone's box | 0.2–0.37 s |
| Tap an answer in a dialog (verified on screen) | 0.19–0.82 s |
| One real task, phone: Send → permission dialog → tap Yes → done | 2.4 s → 0.2 s → 5.9 s total (model time) |
| Data for that task: whole document each time → patches | **236 KB → 9 KB** to the phone (23 updates); the e-ink page: 10 updates |
| Second device types while the first is typing | refused, "phone is typing" |
| The same message received twice | applied once |
| Connection dropped with 4 keys in flight | reconnected; nothing doubled; the page said 4 keys were not confirmed (with a simulated delay those keys were lost and must be retyped) |

`?rtt=N` delays the page's messages by N ms (half each way): a simulation of distance, not a measurement of a real phone network. Forcing the relay's TURN server from this machine did not work (Chromium and the computer always found each other directly), so the relayed path is untested here; the relay is 5 ms from lambda, so it should add little.

## Found on a real phone (first try, 2026-10-01) and fixed

| Seen | Cause | Fix (test) |
|---|---|---|
| The Claude Code logo repeated many times at the top | After a panel closes (or a resize) Claude Code erases every line and reprints its view from the top; lines that had scrolled up stay in the history, so a real terminal also holds the copy | The host notes each "restart" (cursor home + every line erased, or erase display) from the parser; the reader drops the earlier rows the restart prints again (old tail = new head) (`replay.test.js`: logo once; the terminal itself holds it twice) |
| `/usage` showed as garbled text in the conversation, and could not be closed from the phone | A full panel (tabs, no input box) was read as conversation; a phone has no Esc/Tab/arrows | A screen with no box, dialog or status is a **panel**: shown as the program drew it, outside the conversation, with a row of keys (Esc, Tab, ⇧Tab, arrows, Enter) (`phone-bench`: opens in 0.15 s, Esc tap closes in 0.2 s) |
| "hello" then "you there?" arrived as "helloyou there?" | The phone box emptied only once the send was confirmed, and copied Claude Code's not-yet-cleared text back; the next words were added to it | The box empties at once on Send (the message comes back only if sending fails); the program's text is copied into the phone box only when the program changed it by itself, never our own text or the message just sent (`phone-bench --live`: the next message typed right after Send reaches Claude Code alone) |

## Recording and replaying a session

`anywhere.js --record FILE.cast` writes, every second, two private files (0600):

- `FILE.cast` — the terminal side, asciicast v2: every byte Claude Code printed, every key it received, resizes.
- `FILE.events.jsonl` — the devices' side, same clock: which device connected, what it sent (draft, submit, tap, key), what it was answered (with timings and the box's text), refusals, repeats ignored, and every patch it was shown.

```sh
node replay.js                      # the running instance's session: a timeline of what devices did
node replay.js --at 13:22:05        # (or seconds) the terminal then, what the reader made of it, and what devices sent and saw ±5 s
```

Replaying the phone test this way found two more problems, fixed: sending `/usage` counted as done only once the panel closed (a panel now counts as the command's result), and the panel was cut into seven boxes at its blank lines (now one).

## Flicker on the e-ink tablet (found by replaying its recording)

Claude Code **blinks the dot** of a step that is still running ("● Bash(…)" / "  Bash(…)", about once a second). With the dot off the reader took the line for the end of the previous answer: the step disappeared and came back, and every blink sent the conversation again (75 of the tablet's 81 updates). Now a line that reads as a tool call after a blank line is that step, dot or not (`replay.test.js`, on the tablet's own recording: one shape for the whole run). A scan of every recording for states that flip back and forth found two brief ones more: an empty screen while Claude Code redraws (no longer called a panel; a panel or empty state reaches a device only if it lasts 150 ms), and a quarter second of blank screen at start-up (the key row appears only if it lasts 1.5 s).

## Inside Chattering: its own view for the conversation, the terminal for the live part

The screen turned out to be a poor record (reprints, blinking marks, panels) and a good live surface. So in Chattering:

- **The conversation** is Chattering's own view of Claude Code's session file: messages, steps, the file-change cards and reviews, as for any Claude Code conversation. Nothing of the history is read from the screen.
- **The live part** comes from the real, interactive `claude` on an invisible terminal: its input box (keys straight into its editor, or the phone keyboard mode), its `/` and `@` suggestions, its questions as buttons, its panels with the key row, "working…", and while it works a window of the terminal as drawn ("in the terminal now", e.g. a progress bar).

Files: `live-terminal.js` (server: one `claude` per conversation, shared by every device, recorded under `<cache>/live-terminal/`), `live-terminal-ui.js` + `live-terminal.css` (the strip), hooks in `server.js` (routes `/api/live-terminal/*`, owner only), `app.html` (the strip replaces the Claude composer), `conversation-draft.js` ("Claude Code" on the new-conversation screen). **Off unless `CHATTERING_LIVE_TERMINAL=1`**; the hub, reader and terminal parts are still this prototype's (`hub.js`, `reader.js`, `host.js`, `actions.js`) and node-pty / @xterm/headless are not Chattering dependencies yet.

`./test-instance.sh start|stop|pair` runs a separate copy of Chattering with it switched on (port 7499, own settings, data, cache, notes and pairings; reads the real conversations; background AI off). `node chattering-bench.js [--phone]` tests it end to end in Chromium (uses your plan: small requests).

Measured on the test copy (2026-10-01):

| What | Result |
|---|---|
| New Claude Code conversation from the draft screen → Claude Code's "trust this folder?" in the strip | 0.4–0.8 s |
| … → the conversation open in Chattering's view | 2.0 s |
| … → task done (Write a file; your Claude Code is in auto mode, so no permission question) | 7.3 s |
| Keys typed in the strip → confirmed by Claude Code (laptop, same machine) | 15 ms typical, 95 ms slow |
| Phone through the live relay: pairing → app | 3.2 s |
| Phone keyboard text → in Claude Code's box | 0.26 s |
| Phone Send → reply in Chattering's view | 4.0–4.1 s |
| Message shown once, logo never repeated, `/usage` panel never in the conversation | yes (checked in each run) |
| E-ink (Chattering's e-ink theme): calm strip, black on white | yes |

Known: Chattering's sidebar calls a conversation "working" while its Claude Code runs and was active recently (its rule for any Claude terminal), even when idle. Your Claude Code hooks fail on this machine (`pi-rust`, `jobs-done.wav` missing) and show as notices.

## Pi and Codex through the same strip (the generality test)

A Pi or Codex conversation can be continued in its own terminal program inside Chattering: "+ → Continue in Pi's / Codex's own program", and back with "Use Chattering's box" (the program ends first: one writer per conversation; Chattering's own Pi session or Codex connection lets go before it starts). The conversation stays Chattering's own view of their files.

| | Codex (`codex resume`) | Pi (`pi --session`) |
|---|---|---|
| Its box, placeholder, status lines read | yes | yes |
| Keys typed → confirmed | 23 ms typical | 9–10 ms |
| Its own editor keys (Home, Delete, Backspace) | yes | yes |
| Its `/` menu as HTML | /model, /fast, /ide… | settings, model, tree… |
| "Working" shown, Stop | yes | yes (from its frame line) |
| Enter → reply in Chattering's view (tiny request) | 5.1–6.1 s | 5.7 s |
| Message shown once; back to Chattering's box | yes | yes |

What it took (all general rules, no product names in the code):

- **Codex** draws its box with no frame: a `›` line holding the cursor, indented continuation lines, its suggestion list below with `>` on the selected row. The reader now also finds a box as "the cursor's line starts with a prompt mark", and a selection mark may stand at column 0. Its "trust this folder?" question was recognised as is (numbered options).
- **Pi** writes its reply word by word in the conversation area and **parks its cursor there** while it does; "⠦ Working" sits inside its box's top frame line. The reader now finds the box by shape (a small framed region: the one with the cursor, else the lowest), reads a label in a frame line as the program's status, and knows braille spinners. Before this fix the page waited 33 s for a 2 s reply (the box was not found); replayed from the recording, now a test (`replay.test.js`).
- **"In the terminal now"** shows only what follows the message just sent: during Pi's reply, its words as they stream (Claude Code and Codex print a reply when it is done).

So far: three agents, one small profile (Claude Code's marks) plus generic rules. Not yet tried: a full-screen interface (alternate screen, e.g. OpenCode), Pi/Codex panels and approval questions in the strip, phones and e-ink with Pi/Codex (the same strip; tested with Claude Code).

## Not done or not tested

A real phone and a real e-ink tablet (only Chromium imitating them); the relayed (TURN) path; window resizing (Claude Code redraws everything); very long sessions and scrollback limits; full-screen (alternate-screen) programs; mouse; several people typing at once; sending only changes instead of the whole document; integration into Chattering; checking each tool's terms for this use (it runs the real CLI under your own login, like VS Code's terminal does, but that is not a legal review).

## Files

`host.js` pseudoterminal + terminal engine + input gating + recording · `reader.js` screen → document · `actions.js` verified clicks and editor sync · `journal.js` Claude Code session log · `server.js` + `public/` the page (patches, devices, typist, replays) · `anywhere.js` the encrypted link · `bench.js`, `browser-bench.js`, `phone-bench.js`, `stream-probe.js` measurements · `test/` reader rules, replays, server rules.
