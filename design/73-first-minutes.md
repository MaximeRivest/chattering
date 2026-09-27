# 73 · The first minutes: connect an AI, a first reply

*2026-09-27. Modules `ai-accounts.js`, `ai-accounts-worker.js` (server),
`ai-connect.js`, `welcome.js`, `ai-connect.css` (page); routes `/api/ai/*`
(owner tier, policy.js); tests `ai-accounts`, `first-minutes`, and the
stranger tests of every download and installer (`scripts/journey.js`).*

## The problem

A stranger who installed Chattering met, in order: a question about "AI
working on its own" before any AI existed ("your default AI model (none is
set up yet)"), then an empty screen that said "no conversations match".
Nothing in the app could connect a model; that took Pi's `/login` in a
terminal, which a newcomer does not know exists. The stranger test passed
with zero models, so nothing caught it.

## The rule

**Done means a first reply.** Every stranger test (the archive, the Mac disk
image, the Windows Setup, the page in a browser on all three systems)
connects a model and holds a conversation until the reply is saved. The
model is a local server speaking the OpenAI-compatible protocol
(`test/helpers/fake-openai.js`), exactly what Ollama or LM Studio are on a
person's computer, so the path tested is a real one people take.

## Decisions

- **Pi's accounts, Pi's code.** Sign-ins, keys, model servers and the
  default model are Pi's (`auth.json`, `models.json`, `settings.json`).
  Chattering runs Pi's own `ModelRuntime.login` in a helper process
  (`ai-accounts-worker.js`) and relays its steps; it does not reimplement
  any provider's sign-in. What Pi supports, the page supports: 40
  providers today, and the next one Pi adds.
- **One protocol for every sign-in.** Pi's logins speak in a few kinds of
  step: open this address (`auth_url`), enter this code on any device
  (`device_code`), paste the address you ended on (`manual_code`), pick one
  (`select`), type this (`text`, `secret`). The dialog draws each kind;
  it knows no provider except for kinder names and where each hands out
  keys.
- **Another device is normal.** A plan's sign-in returns to `localhost` on
  the computer running Chattering. From a laptop or phone reaching it,
  that page cannot load; the dialog knows (`location.hostname`) and says,
  before it happens, to copy the address bar and paste it; for ChatGPT it
  recommends the code sign-in instead.
- **The first question waits for an AI.** The background-AI question
  (design/32 §2) now comes after a model is connected: before that nothing
  can run, and the question was about nothing. The promise holds: the
  server still runs nothing in the background until the owner answers.
  In the welcome it is step 2, inline; on a home with history it is the
  dialog, once an AI exists.
- **The welcome is the empty home.** Three steps: connect, the helpers,
  start (with example first messages). A home with conversations but no AI
  gets one line above them: they can be read now, continued once
  connected. Settings → AI accounts is the same panel, for later changes.
- **The model's first words.** Every connection ends with a real request
  ("say you are ready") and shows the answer. A person sees it work; a
  broken key fails there, not in their first conversation.
- **A default, visibly.** The first provider connected becomes the default
  with Pi's own recommended model for it (`defaultModelPerProvider`); the
  panel says which and lets it change. Signing out of the default's
  provider moves the default to another connected one.
- **Model servers on this computer are found.** Ollama (11434) and LM
  Studio (1234) are asked for their models when the panel opens; a running
  one is offered in one click.
- **Owner only.** Accounts and keys belong to the machine; `/api/ai/*` is
  the owner tier. Members see that an AI is (or is not) connected.

## Installers (design/71)

- **Mac:** `Chattering-mac-<arch>.dmg` with the app and an Applications link.
  The app is small (a script and the download as one archive) so its
  first-open check is quick; the first open unpacks it into the same
  program folder the command-line install uses (versions side by side,
  `chattering-app update` and `rollback` alike). Opening an older app after
  an update runs the newer version; dragging in a newer app installs it.
- **Windows:** `Chattering-Setup-<arch>.exe`, Inno Setup, per person, no
  administrator: Start menu, optional desktop icon and start at sign-in, the
  commands on the PATH, "Open Chattering" at the end, an uninstaller in
  Settings → Apps. The Start menu opens `Chattering.exe`, Node marked as a
  windowed program (`scripts/pe-windowed.js`), which starts the launcher
  hidden: no console flashes. A start failure is a message box.
- **Setup over a running Chattering** stops it first, unless work is
  running: then it says so and changes nothing.
- **Two starts at once give one server** (a start lock): a double-click
  while it starts opens the same Chattering.

## Trade-offs, stated

- **Not signed.** Without an Apple Developer ID and a Windows code-signing
  certificate, the first open asks once (Mac: Privacy & Security → Open
  Anyway; Windows: More info → Run anyway). The release notes and README
  say exactly where to click. The command-line install does not ask.
- **The Mac's Gatekeeper question is not tested by CI**: it needs a person.
  CI tests the app with the download's quarantine mark set, and as Finder
  opens it without that mark.
- **`Chattering.exe` shows Node's own icon and description** in Explorer
  and Task Manager (the shortcuts carry Chattering's icon). Changing an
  .exe's resources needs another tool; not worth a build dependency yet.
- **The Mac app's first open takes a few seconds** (unpacking about 300 MB);
  the Dock icon bounces meanwhile. Later opens take about a second.
- **Uninstalling on a Mac** is moving the app to the Trash; the program
  folder (`~/Library/Application Support/Chattering/program`) stays until a
  `chattering-app` uninstall exists.
- **A sign-in left open** is given up after 15 minutes.
- **Keys typed in the page** travel to the server (over the same signed-in
  connection as everything else) and into Pi's file; they are never
  logged, echoed, or sent anywhere but the provider.
