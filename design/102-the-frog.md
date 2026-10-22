# 102 — The frog: one conversation that steers all the others

*2026-10-17. Part 1, the walkie-talkie of part 2 and the call of part 4
built (below); the rest is the plan. Modules: `frog-assistant.js` (asks, events, the
workspace picture, short ids, the model, hand-over words, speech text),
`extensions/frog.ts` (its tools), `extensions/modes/frog.json` (its mode),
the `/api/frog/*` block in `server.js`, the AI program `frog_turn_end`
(`ai-programs.js`), the walkie-talkie in `voice-commands.js`. Tests:
`frog-assistant`, `frog-extension`, `frog-server`, `frog-jev-real` (on
request: `CHATTERING_REAL_JEV=1`).*

**Its name.** It was "the Navigator" on its first day; it is **the frog**
(Rockfrog's frog, design/94: the same character, now also the assistant).
Everything was renamed. Its first conversation goes on (same file, the frog
mode by name, its title, `~/notes/chattering/navigator` → `frog`, its
preferences file → `preferences.md`, `AGENTS.md` rewritten when unedited);
`/api/navigator/*` still answers for scripts written that day; the file
`extensions/navigator.ts` is a temporary copy for the server started before
the rename, to delete after its restart.

## The ask (2026-10-17, three passes)

> one place I talk to, always the same conversation, that sends my messages
> to my other ones … stops, forks, branches, organizes them, moves them
> between groups … talks to me uninterrupted by its tool calls, because I
> want it by voice, on the phone, with the iFlytek as a sketchboard … "who's
> working on what?" gets a tiny fast reply, then a good spoken answer while
> it keeps getting results … long memory (OptMem).

> You overdid it on safety. It should be very powerful: create
> conversations, create projects … an assistant folder where it starts
> conversations that build its own assets (cron, notifications, anything)
> … "call me when they're done or if they crash", "call me if I get a
> Slack message / an email" … make my phone ring … and the voice pipeline:
> while I talk for five minutes, the first half is already being studied
> and turned into context; a very short first reply goes to Kokoro at once,
> a longer one follows, rewritten for voice sentence by sentence; figures
> appear on the e-ink as it talks; I interrupt ("say that sentence again",
> "no, that one"), and say "talk faster".

> It should definitely be the frog. Pauses in my speech are dangerous: I
> would be nervous my message gets sent. More like a walkie-talkie: I say
> "over", "over to you", "done", and a little model checks that. The main
> model should be settable, now Claude Opus 5.5 through the subscription in
> Pi, for the conversation, the memory, everything; except that classifier:
> too slow and too costly for that, so Jev for now, as an AI program in
> Chattering, so I build a dataset to train a specialized classifier later.
> Speech: Kokoro; listening: the Parakeet pipeline we use here.

## What it is

- **One conversation, the person's front door.** Opened from the side
  list's ▾ menu ("Frog · talk to all your conversations"); pinned at the
  top; the same reader, composer, microphone and read-aloud as every
  conversation, on every device.
- **It lives in the assistant project** (`~/Projects/assistant`, made on
  first open, with an `AGENTS.md` and `automations/`). That project is also
  where it builds what it lacks: watchers, timers, pipelines. Its own
  memory is that project's memory; every other project's memory stays about
  its project, because work is started *in* the project it belongs to.
- **Powerful by design.** Full owner rights (the install token), every
  conversation and project, plus `bash`, `edit`, `write` for quick things
  itself. The few rules it keeps are about being *right*, not cautious:
  ids only from what its tools showed (an invented one is refused), ask
  only when two conversations could be meant and the wrong one would
  matter, say where things went, never state what runs from memory.

## Built: part 1, the frog core (2026-10-17)

| Tool | Does |
|---|---|
| `workspace` | who works on what (and on what step, for how long), who waits for the person, who stopped with an error, who replied unread, the groups, the asks |
| `find_conversations` | by words in title, project, last words; newest first |
| `read_conversation` | the current branch's latest messages, with entry ids |
| `send_to_conversation` | as the person; Pi/Codex queued behind a running turn, a program-held conversation through its program, a Claude terminal through its terminal; the row joins the list |
| `start_conversation` | in a project or folder, with prompt, title, model, mode, group |
| `create_project` | folder + Git + registration + purpose |
| `stop_conversation`, `fork_conversation`, `branch_conversation`, `rename_conversation` | as named (fork defaults to the newest message) |
| `organize_list` | open, close, pin, unpin, group by *name* (made if missing, existing names kept as written), ungroup, fold, rename a group |
| `ask_when` / `list_asks` / `cancel_ask` | durable watches: on done, failed or question → tell, notify, or call |
| `notify_person` | an urgent notification on every device, now |

- **The fast first answer.** Before each of the person's messages, the
  live workspace is added as a hidden note (only in this mode, only when it
  changed), so "who's working on what?" is answered from the first words
  with no tool call. Put last, it keeps the provider's prompt cache.
- **Asks** survive restarts (`~/notes/chattering/navigator/watches.json`).
  A web run's end, or an agent's program going from working to idle, checks
  them. A fired ask becomes an **event**.
- **Events** reach the frog as one turn (a `frog-event` message),
  queued on disk while it is busy and delivered when its run ends (and
  every 30 s as a backstop). Anything on the machine can send one:
  `POST /api/frog/event {source, text, notify?}` with the install
  token; the assistant project's `AGENTS.md` shows the line. That is the
  hook every watcher (mail, Slack, a cron) uses.
- **A new notification kind, `ask`**: the person asked for it, so it is
  sent even while they are at a screen and no setting turns it off; urgent,
  6 h to live. Android shows it on the attention channel from the next app
  build (source changed, app not rebuilt).
- **Tools are opt-in** (`extensions/modes.ts` `OPT_IN_TOOLS`): every web
  session loads the extension, only the frog mode gets the tools, so
  no other conversation pays for them in its prompt. The installed copy at
  `~/.pi/agent/extensions/modes.ts` was updated with the same change.

## Built: the frog's model (2026-10-17)

One model for everything the frog thinks: `claude-code/claude-opus-5-5`
(Claude Opus 5.5 through the subscription, in Pi) by default, kept in its
state (`~/notes/chattering/frog/state.json`). Every frog turn uses it,
whoever starts it: the person, an ask that fired, a script's event
(`startAgentRun`). It is set where any conversation's model is, in the
frog's own model picker (that pick becomes the frog's model), or by
`POST /api/frog/model {model}`. Its memory (part 3) will use the same one.
The only exception is the end-of-turn check below.

## Built: the walkie-talkie (2026-10-17)

- **Talk**, beside Send, only in the frog's conversation. Pressed, the
  microphone listens (design/64: Parakeet, re-transcribed at pauses) and
  everything said goes into the frog's message box. **A pause never
  sends.** After each utterance, one check: did the person hand the turn
  over? "over", "over to you", "your turn", "go ahead", "done" closing what
  they said sends it, with those words taken off; the same words inside a
  sentence ("the run is over now and…") do not. Sure (≥ 0.85): sent. Unsure
  (0.5–0.85): "Send it to the frog?" with a button (another "over" also
  sends). Otherwise it keeps listening. Typed edits in the box are kept.
- **The check is an AI program**, `frog_turn_end` (inputs: the turn so far,
  the words said last; output: handed_over or still_talking), on **Jev**
  through FunctAI's own TypeSafe wire, with the saved TypeSafe key.
  Measured on the real Jev: 6 of 6 right on hand-overs and on "over" /
  "done" inside sentences, 60–120 ms after the first call; certainty 1.00
  or 0.01–0.02. Every call goes to the FunctAI call log with its inputs, its
  answer and Jev's probabilities (in the exchange), so it shows on the
  Programs page, where ✓ / ✗ and "what should it have said" build the
  answer key: the dataset for a classifier of its own later (design/74).
- **It speaks.** While talk is on, the frog's words are read by Kokoro on
  the screen the person is at (design/100): what it says before its tools
  (a few words: "Checking the bigspin run.") as soon as it is written,
  then its answer, in pieces of a few sentences (the first sentence alone,
  to be heard soonest), markdown, code, links and paths left to the screen.
  Talking over it stops it (two words heard), and so do "stop" or "shh".
  "Talk faster" / "slower" changes its speed by a quarter (0.7× to 2.5×).
  Talk ends five minutes after the last page that keeps it on stops.
- **Fixed on the way: Jev's sure answers were refused.** lm15 keeps a
  probability written `1.0` as its raw lexeme (a `RawNumber`), and lmcc's
  check of a reply's probabilities accepted only plain numbers, so every
  answer Jev was certain of failed ("must map each answer key to a number").
  Fixed in lmcc (`ts/src/core.ts`, `probabilityOf`, with a test that fails
  without it; not yet released) and the same lines patched in Chattering's
  copy of FunctAI (`vendor/functai/0.1.0/SOURCE.json` names the patch).
- **The TypeSafe key** is put in the server's environment for FunctAI's
  wire (FunctAI 0.1.0 takes keys from there only) and taken out of the
  environment agents start with, unless the person gave it there.

## Built: replies that are good to hear (2026-10-17)

> When it writes lists with asterisks, Kokoro reads the symbols out loud.
> It has to pause in the right places and announce what is coming: with my
> eyes I see a list start; by ear I only know after the fact. "Three
> things", then first, second, third.

**Why the symbols were read.** The read button asks the voice model (the
local Qwen, settings → sound) to rewrite a reply for speech; that server was
down (connection refused on every read that day), and on failure the reply
went to Kokoro as written, markdown and all, without a word to anyone. And
Kokoro's server joins its sentences with no gap, so nothing gave a list or a
paragraph its breath.

- **The speech script** (`speech-script.js`, every read-aloud: the read
  button, the frog's talk, a rewrite's output too): a list is announced
  ("Three things.") unless the line before already says how many ("Three of
  your conversations are still working:"; "…first, then:" becomes "…first,
  then two things."), and numbered aloud ("First, … Second, … And third,
  …"), sub-items said within their item; a heading, or a bold label opening
  a paragraph, is said as a sentence with a pause; code, tables, pictures and
  addresses become "on your screen"; a file is said by its name ("server dot
  js"); marks, emoji and symbols go, a few said as words ("→" to, "3×" 3
  times, "e.g." for example).
- **Real pauses.** Each segment ends in a silence of its own (about a third
  of a second after an announcement or an item, two thirds after a list or a
  paragraph), made by Chattering between Kokoro's pieces, shorter as the
  voice speeds up. Pieces are made three at a time: a 70-second reply took
  1.7 s, the same as one piece before (`scratch/speech-before-after/` has
  both to hear).
- **The frog writes for the ear** (its mode): no markdown at all, the
  answer first in one short sentence, how many before several things and
  then "First, … Second, …", five at most, a blank line between ideas, short
  sentences, numbers and names as said, what must be seen put on the screen.
  Its replies are not rewritten by the voice model (its own model wrote
  them for listening; one model, as asked), only passed through the script.
- Clips made before are not reused (their id changed): a reply read again
  is made again.

**Limits, stated:** the script reads structure, not meaning: a list
written as prose, or a run-on reply from another agent, is read as it is;
the voice model's rewrite, when its server runs, may still choose its own
words for other conversations.

## Built: its rhythm, waiting when asked, knowing where it was cut (2026-10-17)

> It reads too fast and feels cut and choppy. Before, with the read
> button, normal was a bit slow and 1.25 was pretty much perfect. As soon
> as I talk, it stops: risky when it is noisy, and sometimes I want to talk
> while still listening. After I interrupt and send, it should know where
> it was cut off, to finish or to answer with that in mind.

- **Speed is a playback rate, 1× by default** (corrected the same day: "I
  said 1.25, but 1 is best; the read button with Kokoro is very good, keep
  that"). Talk mode had Kokoro speak at 1.5 (the done-voice's speed). Now
  the frog's speech is made at Kokoro's own speed and the page plays it at
  the frog's rate, pitch kept, as the read button does; "talk faster /
  slower" moves it by 0.15 and applies to what is playing. The computer's own speakers cannot change a
  rate: their copy is made at that speed by Kokoro. The read button
  remembers the last speed chosen on each device.
- **Kokoro's own gaps carry the rhythm.** Measured: Kokoro's server leaves
  about 0.75 s between two sentences at speed 1 (0.26 s before, 0.48 s
  after each). The first day's pauses were added on top of that, and colons
  and semicolons gave Kokoro a full sentence break inside a sentence. Now a
  list item or a label adds nothing, a heading 0.15 s, a paragraph 0.25 s,
  a list's end 0.3 s; "x: y" and "x; y" are said with a comma; a decimal
  point no longer ends a sentence ("0.12" was "0." then "12.").
- **Speaking never stops it.** Talking over the frog goes into its box as
  always and it keeps speaking. It waits when asked by name, alone in what
  was said ("frog, wait", "hold on, frog", "hey frog stop"; plain "stop" or
  "wait" do nothing), or with the pause button of the "speaking" pill; "frog,
  go on" (or the button) goes on. A message sent to it (spoken "over", or
  typed) and turning Talk off stop it for good.
- **It knows where it was cut off.** Each piece of its speech is recorded
  with its sentences' places in the clip; the page that plays it says which
  clip and where when it pauses, resumes or stops (\`/api/frog/heard\`). A
  new turn also stops it on every other screen (\`frog-cut\`), and pieces
  never sent count as not heard. Before its next turn the frog is told,
  once: what was heard last, the sentence it was in, and what was not heard,
  with the rule to pick up without repeating (\`extensions/frog.ts\`,
  \`frogLib.cutNote\`). Resuming to the end cancels the note.

**Limits, stated:** without headphones the frog's own voice may be
written into its box when the browser's echo cancellation misses it;
"say that again" is still not built (the ledger it needs exists now,
\`/api/frog/spoken\`); the speaking pill is shared with the computer's own
announcements, so on lambda's own screen one can hide the other's pill.

## Built: unread stays honest (2026-10-17)

> Give it a way to mark conversations as read. Even better, it should
> figure out on its own whether I have actually received and read a reply
> (it told me about it, or I opened it), or whether I still need to really
> go and consider it; then it should stay unread.

- **Opening a conversation** marks it read, as always (design/59).
- **Telling is not receiving.** When the frog has told the person what a
  reply says, fully enough that they need not open it (a status, a result,
  work finished with nothing left for them), it calls `mark_read` (as
  told). That reply becomes read only once the person has the frog's answer:
  the frog's turn has ended, and then they read its conversation (on any
  device; a reply arriving while it is on screen counts) or write to it
  next (the walkie-talkie's way). If the conversation said anything new
  before that (a message, a run's end; not its file's bookkeeping lines),
  it stays unread. Waiting marks last a day (`~/notes/chattering/frog/told.json`).
- **What needs considering stays unread.** The frog's mode says so: a reply
  that asks the person to decide, review a change, look at a page, try
  something or read something long is mentioned and left unread; only the
  headline given is not received; unsure is unread. The workspace note shows
  "you told them; read once they have your answer" on what waits, so the
  frog does not tell it twice.
- **When the person asks**, `mark_read` as read or unread acts at once
  ("mark it read", "keep it, I'll look later").
- **The frog's mode reaches its conversation.** Pi keeps a copy of a
  conversation's mode inside it, so a newer frog mode (here: the new tool)
  would never reach the frog's own conversation. At its turns, when the
  installed frog mode differs from that copy, the mode by name is added
  after its last entry and Pi records the new copy. A person's own edit of
  the installed frog mode is kept and followed.

**Limit, stated:** the judgment "fully enough that they need not open it"
is the frog's (its model, its mode's rule); a wrong call costs one reply
shown as read that should not have been, or the other way round, and the
person can say "keep that unread".

**Limits of the walkie-talkie, stated:** only while the frog's
conversation is on screen (elsewhere nothing is written, so no other box
ever gets the frog's words); the frog's answer is spoken when each message
is complete, not word by word yet (part 2's speech writer); a long first
sentence waits for Kokoro to make all of it; "say that again" and "the one
before" are not built (the spoken ledger of part 2); the hand-over words
are found by a list (taking them off only; the check decides).

**Limits of part 1, stated:** owner only (other people's Frogs are
part 6); a Claude Code conversation in a plain terminal counts as done only
when the program exits; stopping a conversation held by its agent's own
program closes the program (the conversation is kept); `then: call` sends
an urgent notification until calls exist; the workspace note adds up to a
few hundred tokens to the conversation each time it changes (the memory of
part 3 bounds the total).

## Part 2: talk mode, the voice pipeline

The target: the first spoken word **under a second** after the person ends
a turn, however long the turn was, and a conversation that feels like
talking, not like dictating to a chat box.

1. **Listening** is design/64's streaming window (Parakeet, re-transcribed
   at pauses). A turn ends by a hand-over word, checked by Jev (built,
   above). Silence alone never sends (a standing rule, confirmed: pauses
   make the person nervous).
2. **Preparing while the person talks.** Each closed utterance extends an
   open *turn draft*. At pauses (at most every ~15 s, only when the draft
   grew meaningfully), a small fast *scout* reads the draft so far and
   gathers what the answer will need: the conversations named (find, read),
   project memory, records search, the workspace. Results are kept by draft
   prefix, so at the end of a five-minute turn the bundle is ready except for
   the last sentences. The main turn gets the bundle attached; nothing the
   scout did is a decision, only reading. (Cost: a few small calls per long
   turn; reads only, so a wrong guess costs time, never an action.)
3. **Two voices, one answer.**
   - **The opener**, < ~300 ms: a tiny fast model (or local) writes one
     short sentence from the draft and the workspace ("Okay, sending that to
     the groups one." / "Three are running; I'll check the paper one.").
     Kokoro speaks it at once.
   - **The main answer** is the frog's turn, told what the opener
     already said so it does not repeat it. Its text streams; a *speech
     writer* turns each finished sentence into spoken form (no markdown;
     numbers and names as said; code, ids, paths and tables replaced by
     "it's on your screen") and queues it. Tool calls are silent; a soft tick
     plays while they run.
   - **Length follows the moment.** Managing ("send it", "who's waiting")
     is one or two sentences. Explaining ("walk me through the idea") is
     paragraphs, the first spoken before the rest is written.
4. **The spoken ledger.** Every spoken sentence gets an index, its source
   span in the answer, and its audio timing. This is what "say that again",
   "no, the sentence before", "what was the second point?" refer to.
5. **Interrupting.** The microphone stays open while it speaks (echo
   cancellation keeps its voice out). Voice from the person pauses
   playback at once and records where (sentence, offset). A small decision
   (the voice-commands pattern, design/64) reads the utterance:
   repeat / back N / rephrase that / faster / slower / stop / go on / a new
   request. Repeat and back come from the ledger with no model call;
   rephrase is one small call on that sentence; a new request becomes the
   next turn with "I was interrupted after sentence N" in its context.
6. **Speed.** "Talk faster" sets the playback rate (the browser keeps the
   pitch), 0.8× to 2.5×, at once and with no new synthesis; remembered per
   person.
7. **Figures as it talks.** The frog may place a figure marker in its
   text; the speech writer holds it until the sentence that refers to it is
   spoken, then the board shows it (part 5).

## Part 3: memory for a conversation that never ends

As before: one conversation for the person, native segments underneath (a
fresh segment between turns past ~60k tokens; design/87's chain), each
waking with its system prompt, an OptMem-style memory print, and the last
turns verbatim. The memory is OptMem's design (append-only one-line log, a
binary tree of summaries, an age-decaying cover within a fixed budget,
`zoom` to the raw lines, `recall` over everything), reimplemented (the
repository has no licence) with credit. Compressions run between turns so
voice turns stay fast. The raw transcript is never lost. This is the one
conversation Chattering compacts by itself: an exception made on request.

**Speed first, before the full memory (asked 2026-10-17, the same day):**

> The frog is only at about 150k tokens of context, but it's already
> noticeably slower, and for voice that hurts. I doubt it needs all the
> context and every tool call and result since the start. Old tool calls
> and results should be dropped or shrunk early, keeping the messages and
> a compact memory, so the frog stays fast.

What the frog's context holds is mostly its own tool steps: workspace
notes (a few hundred tokens each, one per changed turn), `read_conversation`
results, finds, the cut notes. Those age fast: a workspace note is stale
the next turn, a read result matters for one answer. The messages (what
the person said, what the frog answered) are what the conversation *is*,
and they are small. So the order of work:

1. **Shrink early, by age.** Before a frog turn, every tool call and
   result older than the last N turns (N small, say 3) is replaced by one
   line ("read the paper conversation: 8 messages", "workspace note"), and
   results past the last turn are cut to their first lines. Messages are
   never touched. The raw transcript stays on disk (nothing is lost; the
   same clean-turn packer `harness/handoff.js` already knows messages from
   steps). How: a fresh Pi segment with the shrunk history (design/87's
   chain, as `fresh_start` does today, carried over in place with the
   same key), done between turns so a voice turn never waits for it;
   with the provider's prompt cache in mind, do it at a threshold (every
   ~20k tokens of growth), not every turn.
2. **A compact memory** of what went before the kept turns: the OptMem
   print above, written by Opus between turns; until it exists, a short
   summary of the dropped turns (the handoff's style) stands in.
3. Then the full OptMem design (zoom, recall).

Measure before and after: time to the first spoken word at ~150k, then
at the shrunk size. The target is the part 2 one: under a second after
"over".

**Built and measured (the same day): it did not help, so it is off.**
Step 1 is built (`frog-context.js`, Pi's request-local `context` hook in
`extensions/frog.ts`, `test/frog-context.test.js`): the last 3 to 8 turns
whole, older ones keep their words, lose workspace notes and thinking,
tool calls clipped, results cut to their first words (marked so), every
call still paired with its result; the cut moves 6 turns at a time so the
prompt cache holds between moves. On the frog's real conversation it
took what is sent from ~197k tokens (instructions and tools included) to
~82k (old turns 110k → 34k; the words alone are ~19k).
Then measured (`scratch/frog-speed/measure.sh`: a copy of the real
conversation, Pi run as Chattering runs it, Opus 5.5 through the
subscription, nothing real read or changed):
- Cache warm, 8 runs each, alternating: first token, full 2.55 s median,
  shrunk 2.72 s. First answer word: full 2.70 s, shrunk 3.60 s: the
  shrunk history made it think before answering every time (8 of 8; the
  full one 2 of 8), with or without its old thinking kept.
- Cache cold (a quiet spell): full 2.8–3.9 s, shrunk 2.7–12 s.
- For scale: Pi starts in 0.5 s; an empty conversation's first token is
  0.8 s after that. Anthropic's cache reads 200k nearly as fast as 80k.
- Today's real turns (the record): its first finished sentence 2.5–8 s
  after the message, not growing from 124k to 203k; the cache hit on
  nearly every turn; the long turns (one to three minutes) are those with
  many tool calls. Message to voice playing on the phone: 2.3–12 s.
So at this size the context is not what the person feels. Shrinking stays
built and off (`CHATTERING_FROG_SHRINK=1` turns it on), for when the
context grows well past this or the memory work (2, 3) needs it.

**Where the seconds are instead, and the levers (not yet tried):**
- *Thinking before speaking.* The frog runs at thinking level high
  (since its first turn); a turn that thinks first speaks 1–3 s later.
  A lower level for talk turns is the largest likely gain; the cost is
  answers that think less. To measure on real requests before choosing.
- *Tools before the first sentence.* When it reaches for a tool before
  saying anything, the first words wait for a round trip; the mode asks
  it to say a few words first, and it does not always.
- *Quiet spells.* After ~5 minutes without a request the cache is gone
  and the next turn rereads everything (about a second more at 200k).
  Pi can keep a cache warm (`cache_warming_decision`); while Talk is on,
  warming the frog's would remove that.
- *After the model:* Kokoro making the first piece and the phone fetching
  it (0.1–3 s in the record).

## Part 4: the phone rings

1. **First, through the Chattering app** (built, see "talk is a call"
   below): a `call` notification kind opens a full-screen incoming-call
   screen with a ringtone (Android CallStyle + full-screen intent).
   Answering opens talk mode with the frog; the audio runs over the
   encrypted link (design/85). Free, private, works on Wi-Fi or mobile
   data. App 0.3.12.
2. **Later, a real phone call** (Twilio or similar): rings without the app
   or data; the call's audio streams to Parakeet and back from Kokoro. Costs
   money per minute and a number, needs a public webhook (the relay), and
   needs an account. Only if (1) is not enough.

## Part 5: the board (the iFlytek as a sketchboard)

A handwritten note page shared with the frog (design/98, 99): the
person's ink is theirs; the frog's graphs, tables and notes go on a
separate layer (never under the pen's fast layer, never moving a stroke,
removable as one piece), black and white for e-ink, shown in time with the
sentence that mentions them. It reads sketches as pictures. Built only
after the open stroke-loss bug (56 → 23 strokes) is fixed.

## Part 6: everything it learns to do

The assistant project grows by itself: "call me if I get an email from X"
becomes a conversation there that builds a watcher in
`automations/mail-x/` (IMAP IDLE or the provider's API; the credentials
asked for once), runs it as an `assistant-*` user service, and sends events.
Slack the same way (a Socket Mode app). Each automation has a README with
how to turn it off; `list_asks` and `systemctl --user list-timers
'assistant-*'` together say everything that can wake the frog. Other
people's Frogs (Lilly, Jacob) come with their own assistant folders
and their own rights.

## Built: the opener, and other people's words (2026-10-17)

- **The opener is the frog's own first sentence** (decided: no second
  model, the person's one-model rule). While its text streams, its first
  sentence is spoken the moment it ends, then whole paragraphs (a long one
  at its last sentence end); a list or a code block waits until whole, to
  be announced and counted; the rest when the message is whole
  (\`frogStreamSpeech\`; \`test/frog-stream.test.js\`). Before, each message
  was spoken only once complete. A fast opener model can still be added if
  Opus's first words come too late.
- **Other people's words.** The frog's mode says the microphone hears the
  room, that others' words arrive mixed into the person's message, to keep
  what is said to it, leave out what is said to someone else, never act on
  someone else's words, and ask in one sentence when it matters and it
  cannot tell. (Recognising the person's voice: research below.)

## Fixed: its voice not heard on the phone (2026-10-17)

> I'm talking to the frog from my phone; I asked "can you hear me?", it
> answered, and nothing played on the phone.

What the records showed: the reply's speech was made (09:37:52, "Yes, I can
hear you." among them) and sent to a screen; which one, nothing recorded.
Talk had been kept on by a page until 09:38:36 and lapsed five minutes
later, so the replies after 09:43 were not spoken at all. Two causes, both
fixed, since the record could not tell which one it was:

- **The wrong screen.** Speech goes to the screen touched last, from the
  screens' own reports, and while a person kept tapping a page reported at
  most once a minute: the laptop could be "touched last" while the phone was
  in hand. Now a page reports within 10 s of a tap, and at once when a
  message is sent from it: the screen a message comes from is where its
  answer sounds.
- **A refused sound.** The Android app's WebView requires a tap to start
  any media unless told otherwise, and a hands-free turn ("over") has none;
  the page dropped a refused sound without a word. Now the app allows the
  computer's sounds (\`mediaPlaybackRequiresUserGesture = false\`, needs the
  next app release; a page the app shows may now play sound unprompted too),
  and the page shows "Tap to hear the frog" for a refused sound instead of
  losing it (\`test/screen-sound-gesture.test.js\`, under Chromium's
  gesture-required rule, fails without it).
- **A record.** Every sound's destination, the screens there were (kind of
  device, visible or not, last touched) and the page's word on it (started,
  refused) are logged as \`[sound]\` lines and kept, the last 40, at
  \`/api/frog/sounds\`.

## Decided 2026-10-17

The frog; the walkie-talkie (never silence); one settable model for
everything (Opus 5.5 by default), Jev only for the end-of-turn check;
Kokoro and Parakeet; the opener above; memory: OptMem's design, rebuilt
(part 3), next to build.

## Built: talk is a call on the phone (2026-10-17, app 0.3.12)

> I want the phone closed in my pocket with my Bluetooth headphones on
> and be able to do everything hands-free, at all times: just talk to the
> frog, get things from it, have it answer my questions, interrupt it.
> Right now the text appears but I have to press to hear it, and if I
> close the phone the audio stops. The headset's button should answer,
> hang up, and start a talk with the frog, while I use the phone for
> other things.

**What stopped it, found in the records.** Every frog clip sent to the
phone that morning was refused (`NotAllowedError`, the app's WebView
wanting a tap per sound; fixed in the source the day before, app not
rebuilt). And with the screen off Android paused the page (`web.onPause`),
closed the app's microphone (the bridges pause in the background: no
foreground service, no microphone) and let the process sleep.

**The design: Talk on the phone is a call** (research A below, built).
While Talk is on, the app holds a self-managed call in Android's own call
system (Jetpack Core-Telecom 1.0.1, `FrogCallService`, a foreground
service of the phone-call and microphone kinds, a wake lock and a Wi-Fi
lock), so:
- the page, its microphone and its voice go on with the screen off and
  behind other apps (`MainActivity.onPause` skips the page's pause while a
  call is on; `MicBridge` and `ListenBridge` skip theirs; when the call
  ends with the app still behind, `callEnded` applies them);
- the sound goes to the Bluetooth headset as for any call, and its
  microphone is the call's (the call system routes; the service asks for
  the headset, else a wired one, else the speaker, never the earpiece);
- the headset's button hangs up (the call system's `onDisconnect`) and
  answers when the frog calls (`onAnswer`); other apps' music pauses (the
  call system takes the audio focus);
- the person's screen shows a call notification ("The frog · Say over to
  send. The headset's button hangs up.", a Hang Up button; `CallStyle`)
  and the call icon in the status bar.

**Ways in.** Talk beside Send (the page calls `ChatteringCall.start()`);
the quick-settings tile "Call the frog" (`FrogCallTile`, add it from the
panel's edit button; with a call on it hangs up); the app icon's long-press
shortcut (`res/xml/shortcuts.xml`); the headset's button when no call is
on (`FrogCallButtonReceiver`: the frog's call runs a media session, so the
app is the one that "played last" and Android sends the next play/pause
press to it, unless something else played since; best effort, untestable
here); and the frog calling (below). Each opens the app on the frog with
Talk on (`frogCallOpen`, through `MainActivity`'s `ACTION_OPEN`); a page
loading under a call still on takes it up.

**Ways out.** Talk off, the pill's ✕ (listening off; before, that ended
the walkie-talkie without telling the frog, and would have left the call
on: fixed, `voiceStop` ends Talk), the notification's Hang Up, the tile,
the headset's button, the app closing. Each hangs up and turns Talk off
(`chatteringCallEvent` `ended`).

**The frog calls (part 4, first half).** `notify_person` with `call: true`
and `ask_when then: call` send a push of kind `call` (push-policy: sent
even at a screen, 90 s to live: a ring an hour late is a wrong one). The
app rings it as an incoming call: the phone's own ringtone and vibration,
the headset rings by itself (the call system's), and on a locked or
sleeping phone the screen turns on with a ring page (`FrogRingActivity`,
the only screen of the app declared `showWhenLocked` + `turnScreenOn`:
the workspace itself never shows on a locked phone) with Decline and
Answer; 45 s unanswered is a "Missed call from the frog" notification
that calls back. Answered (the headset, the ring page, the notification's
Answer), the app opens on the frog with Talk on and the tool's result
tells the frog to greet and say why it called. A browser shows the `call`
kind as an urgent notification.

**The server follows the talking screen.** A page with Talk on reports
`talking` in its "I am here" (`push-ui.js`), hidden or not, once a minute
and on each change; `soundScreen` (push-policy) sends the frog's voice to
a talking screen first, then as before to the visible one touched last:
a phone in a pocket is hidden and untouched and is where the voice must
sound (`test/screen-sound.test.js`). The app ticks the page every 30 s
while the call is on (a hidden page's own timers run once a minute at
best), and the tick posts the talk keep-alive and the here report.

**Tested on the Android 15 emulator** (`scripts/android-emulator.sh`,
the app connected to this server by address): the call is ACTIVE and
self-managed in `dumpsys telecom`, the service's kinds are phone-call +
microphone, the call system holds the audio focus and the wake lock is
held; with the screen asleep the microphone stays open (audio policy:
recording Active, not silenced) and the page's code runs (the 30 s ticks
reached it, `hidden=true`); Hang Up from the notification, the pill's ✕
and Talk off each end the call, stop the service and release the locks;
the frog's call on a sleeping phone turns the screen on with the ring
page, Answer makes the call active and opens the frog with Talk on.
**Not testable here:** a Bluetooth headset (its button, its microphone,
the sound through it), the emulator having no audio at all; the
headset-button hang-up goes through the call system's own disconnect,
the path WhatsApp-style calls use, so it should hold.

**Trade-offs, stated:**
- With a headset, a call uses the headset's call profile (HFP): the
  frog's voice is heard at phone-call quality (16 kHz wideband on this
  headset's generation), not music quality; that is the price of the
  headset's microphone and button. Without a headset, the speaker.
- The frog's voice is still the page's `<audio>` (the ledger, pauses,
  asides and the cut note all live there). In a call Android sends media
  to the call's route (music follows the phone during calls), which should
  carry it to the headset; if on the real phone it does not, the fallback
  is to play the frog's clips natively through the call's own stream (the
  page would hand them to the app), about a day's work.
- A call holds a wake lock and the Wi-Fi: it costs battery like any
  call. Samsung's battery manager can still stop a sleeping app; the app
  asks once to be exempted ("Let app always run in background": allow).
- Starting from the headset's button with the app closed: Android does
  not let a service open a screen from behind, so the call waits 45 s for
  the app, then ends and leaves a "Talk with the frog · tap to open"
  notification. The tile and the shortcut always work.
- `setSilent(true)` on the ringing notification put it in a silent group
  and Android then never launched its full-screen page (found on the
  emulator); the channel is silent instead.

## Fixed: never left in silence, and "over" is always a hand-over (2026-10-17)

> When I say "over", I don't know whether the frog is still listening or
> got my message. I said "over" several times, then "hello". I need an
> immediate sound cue when "over" is recognised and the message is sent,
> and something telling me the frog is thinking. Also, an "over" I said
> while the frog was speaking got captured as an aside instead of ending
> my turn.

The record (FunctAI's log of `frog_turn_end`) showed every "over" of that
call understood as a hand-over. What was missing was sound: a message
sent made none; a second "over" with nothing new to send did nothing,
silently; an unsure check showed only a button on a locked screen; and an
"over" said while the frog spoke went to the aside path ("Noted.").

- **Cues** (`frogCues`, `voice-commands.js`), made in the page (no
  network, at once) and played through `<audio>`, the route the frog's own
  voice takes to the headset: *sent* (two rising notes), *unsure* (a
  questioning pair: say "over" again), *nothing* (one low note: nothing to
  send, the frog idle), *failed* (two falling notes), and *thinking*: a
  soft tick every 1.6 s while the frog's run is on and it is not speaking,
  before its first words and while its tools run, stopping when its voice
  starts and when its run ends. "Over" again while it works: one tick
  (it is on it). The ticking is a looping sound, not a timer: a hidden
  page's timers run once a minute at best. The run's start and end come
  from the page's run events (`app.html`), so a turn the frog starts itself
  (an ask that fired) ticks too.
- **"Over" while it speaks is a turn**: the reading stops (it knows where,
  as before) and the message goes. An aside now needs "frog, wait" (or the
  pause button) first: `ScreenSound.frogWaiting()`. The frog's mode and the
  listening overlay's help say so.
- Test: `test/frog-server.test.js` (the browser part): sent, ticking
  while the fake frog works and quiet after, the empty-handed note, the
  unsure cue with nothing sent, the aside after "hold on, frog", and "over"
  while it speaks sent as a turn, cut, not an aside.

**Not checked on the phone:** how loud the cues are against the frog's
voice in the headset (set at roughly its level, the tick softer).

## Fixed: who hears what, turns, and the frog's volume (2026-10-17, app 0.3.13)

> The logic of how my speech gets cut into turns, which device hears what,
> and how it's sent feels slightly wrong, between the app open and the
> phone locked. The volume on the call is low: with phone and headset at
> maximum, the frog is quieter than things through the speaker.

**What the records of that call showed** (the frog's session, FunctAI's
log of `frog_turn_end`, `asides.json`, the `[sound]` lines, the voice
log): every "over" was understood. The repeats ("Anything waiting on us…"
three times) were the person saying it again because nothing was heard
back, and with the frog speaking each went to the asides (fixed before:
cues, and "over" while it speaks is a turn). New here:
1. **Two screens heard him.** The laptop's page listened too, in command
   mode, and acted on his words to the frog ("over the app pause stop stop
   over…" became "stop listening").
2. **Other conversations were read into his headset** between the frog's
   pieces (PageLimit, Audible): "many things running at once".
3. **Elsewhere in the app, Talk dropped his words**: away from the frog's
   conversation the walkie-talkie ignored what was said.
4. **Repeated "over"s stayed in the message** ("…the message. over. Over.
   Hello.").
5. **The microphone in a call was the plain one** (`MIC`), not the call's:
   which microphone Android gives it with a Bluetooth headset is then not
   guaranteed, and nothing cancels the frog's own voice on a speaker.
6. **Volume.** Kokoro's clips are quiet and even (speech -23.5 dBFS RMS,
   peaks about -8, within half a dB clip to clip; phone speech sits near
   -16). And in a call the volume buttons set the call's volume, while the
   frog plays as media, whose level on the headset's call connection is a
   separate one those buttons never reach (likely; not measurable here).

**Changes:**
- **One talking screen.** Talk tells the server which screen it is
  (`conn`); the person's other screens get `frog-talk` and stop their own
  Talk and their listening until it ends (or the talking screen's stream
  closes; a look every 30 s as a backstop), then listen again.
  `/api/frog/talk` says the `owner`. Only that person's screens.
- **No other voice in the ear while talking.** Another conversation's
  finished run is a chime, not a spoken digest, while Talk is on, and the
  page holds any non-frog sound until the frog is quiet (never between its
  pieces). The frog sees new replies in its workspace note.
- **Talk works anywhere in the app.** Away from the frog's conversation,
  what is said waits in a box of its own (`frogTalk.offText`) and goes
  straight to the frog's conversation (`/api/node/send`, queued behind a
  running turn), with the same cues; back on the frog's page, what waited
  is in its box.
- **Every lone "over" comes off** (`stripHandOver`, `LONE_OVER`): "over"
  as a sentence of its own anywhere in the turn; "Is it over?" and "Game
  over." stay.
- **The call's microphone in a call** (`VOICE_COMMUNICATION`, then `MIC`):
  the headset's boom mic, with the phone's echo cancelling; reopened at the
  call's start and end without a gap the page sees (`MicBridge`,
  `ListenBridge` `callChanged`). Out of a call, the plain microphone as
  before. Trade-off: the phone's call processing (noise suppression, gain)
  now shapes what Parakeet hears in a call; that is the price of the right
  microphone and of no echo.
- **Louder speech** (`speech-level.js`): every clip +7 dB with a 3 ms
  look-ahead limiter at -1 dBFS: speech -23.5 → -16.6 dBFS, peaks ≤ -1,
  nothing clipped, ~0.1 s per minute of speech. All read-aloud (the read
  button and the computer's own speakers too); clip ids moved to v4.
- **The frog's voice follows the call volume** (`FrogCallService`
  `mirrorVolume`): while the call is on, when media goes to a call-only
  device (the headset's call connection), its media level is set to the
  call volume's fraction of range, at the start and whenever the call
  volume changes. The speaker's and the music headset's levels are never
  touched; the call connection's level stays set after the call.

**Tested:** `test/frog-server.test.js` (browser part: from another
conversation "over" sends to the frog, not into the box on screen; a
second screen's Talk makes this one step aside and listen again after;
4 runs in a row green), `test/frog-assistant.test.js` (lone overs),
`test/speech-level.test.js`, the day's real clips measured. Emulator: in a
call the microphone is `VOICE_COMMUNICATION`, also with the screen locked,
and `MIC` again after hanging up (the app connected by address; the
encrypted-link path, `MicBridge`, has the same change, untried here).
**Not testable here:** a Bluetooth headset's volume and microphone.

## The live test on the phone (2026-10-17, app 0.3.14, by adb)

Lambda paired with the phone over wireless debugging (adb, `maxime@lambda`),
so its state is read directly. Measured in a real call: the call is
routed to the ISOtunes LINK 2.0 (`bt_sco`), the microphone is that
headset's (`AUDIO_DEVICE_IN_BLUETOOTH_SCO_HEADSET`, `VOICE_COMMUNICATION`,
16 kHz, the phone's echo canceller on).

- **Volume, fixed in 0.3.14.** Samsung keeps the Bluetooth call's volume
  on the Bluetooth-call stream (6): 15/15, while the call stream read 5/8,
  so 0.3.13 set the frog to 9/15. And `getAudioDevicesForAttributes` answers
  nothing on this phone, so it often did nothing. Now: the louder of the two
  call fractions, and the call's own device (`communicationDevice`).
- **Microphone with the screen off, fixed in 0.3.14.** A call begun while
  the screen was off could not claim the microphone kind of foreground
  service (Android: not eligible); the app claims it again when it comes on
  screen (`FrogCallService.onScreen`, `ACTION_REFRESH`).
- **"My messages don't get sent properly" during the live test:** the
  phone's log shows the app restarted three times in those minutes, each
  by an install from lambda (12:15:27, 12:16:46, 12:20:19 local): each one
  ended the call and lost what was said and what was being played. Rule
  kept since: no install on the phone while the person uses it. The one
  gap of the design: words said without "over" waited in silence, which
  sounded like "not heard", so the person asked again. Now the listener
  says when it has been quiet ~4 s after speech (`voice-window.js`, a
  `quiet` event, from the audio itself, not the page's sleeping timers) and
  the page plays a soft double blip once for words still waiting.

## Built: the voice session, one rule (2026-10-17, app 0.3.15)

> When a phone call with the frog is on, that call is the truth and
> overrides everything: messages come back there, I talk there, information
> comes there, even if Chattering is also open on my computer or on the
> phone's screen. While the call is on, even with the phone closed, it must
> keep listening to everything I say at all times, and everything the frog
> says must come through. Design the state around that one rule: one active
> voice session owns the mic and the speaker.

**Before:** who owned the voice was spread over three loosely linked
pieces: a talk flag that lapsed after five minutes without a keep-alive,
a talking screen that the server dropped the moment its stream closed,
and the guess of which screen was touched last; and each reply chose its
screen once, at its start.

**Now: `voice-session.js`, one session per person** (`test/voice-session.test.js`):
- held by one screen (its stream, `conn`) for one **holder** (the page,
  the same across its stream's reconnects and reloads: `sessionStorage`), as
  a `call` (the Android app) or a `talk` (Talk on a screen);
- **every sound for that person goes to the holder**, decided at the moment
  each is sent (`sendScreenSound('voice:<user>')`), never to another screen
  nor to the computer's own speakers; other conversations' news too (a chime);
- **only the holder listens**: the person's other screens are told
  (`frog-talk`) and stop listening; a screen opened during a session asks
  (`frogVoiceConnected`, at each stream's hello) and stays quiet; its Talk
  button says "📞 on call";
- **a call is the truth**: a Talk pressed elsewhere is refused with the reason
  (a toast); a call takes over a Talk; the newest call or Talk otherwise wins;
- **a blink is not an end**: when the holder's stream closes, a grace (two
  minutes for a call, 45 s for a Talk); what the frog says meanwhile waits
  (`pending`, two minutes' worth) and is delivered when the holder claims
  again with its new stream (at its hello, and on every keep-alive);
- it ends when its holder ends it, past the grace, or with no keep-alive for
  three minutes; the screens are told, the frog stops speaking. `[voice]`
  lines in the log say each of these.

**Listening at all times, fixed on the way:**
- **The app's microphone stopped after ten minutes** (`MicBridge`'s limit
  for a dictation applied to listening too, the encrypted-link path, the
  phone's): listening now has no limit (`ChatteringMic.listen()`, 0.3.15;
  the page falls back to `start()` on an older app).
- **The keep-alive keeps listening alive**: on each tick (the app's 30 s
  tick while a call is on), a closed microphone is opened again and a
  dropped connection reconnected; a microphone that ended during Talk is
  reopened after 1.5 s.
- **"The box went away"**: when the frog's run ends the page redraws the
  conversation and the message box is a new element; a send that found the
  box before the "over" check failed against the old one, and the message
  was lost. The send now finds the live box (`frogLiveBox`), or the
  off-screen one.

**Tested:** `test/frog-server.test.js`, browser part, on a real server: a
second event stream stands for the phone's call; the page steps aside, its
button says "on call", its Talk is refused, a Talk from another screen is
refused; the frog's sound reaches the call's stream and nothing plays on
the page; with the call's stream closed, the frog's next reply waits and
arrives when the call claims again with a new stream; at the call's end the
page listens again (5 of 6 runs green, the sixth a rare earlier flake of
the aside step). The voice and frog suites: 75 green.

**A rule for testing, learned the hard way:** the emulator's app must be
pointed at a test server, never the person's live one: a call started on
the emulator holds the person's real voice session (it happened once, for
half a minute, released at once). And nothing is installed on the person's
phone while they use it (three restarts during a live test, earlier).

## Fixed: the asides loop, and the frog's lost tools (2026-10-17)

> After the restart there's a stuck process that keeps bringing up the
> same five items. The asides list never clears, so the frog keeps being
> told to come back to them. The frog doesn't have the asides tool.

- **The five asides** were false ones from before "over" was a turn
  ("over." twice, his repeated questions, fragments). Closed by hand
  through `/api/frog/asides`.
- **The loop:** each time the frog's reply ended and the person stayed
  quiet 3.5 s, `/api/frog/asides/return` started a turn on the first open
  aside, at most once a minute, with the same list, forever. Now a set of
  open asides is raised once; only a new aside, or one closed, raises them
  again (`frogReturnedFor`).
- **Why the frog had no asides tool** (nor `context_use`, `fresh_start` or
  the memory tools): its conversation ran on its mode as copied at 13:35
  UTC. The carry-over of the newer mode was written at 13:44, and four
  seconds later a send from the page, whose last-seen entry was the one
  before, branched around it (`startAgentRun`: a `node` that is not the
  file's last entry means "branch here", one label anchor), leaving the
  carry-over on a dead side branch, never read. Found by starting Pi as
  Chattering does on a copy of the frog's file with a probe: `asides`
  registered, not active.
  - The send path now asks `conversationFlow.sameContext` first: when only
    bookkeeping lies between the sender's entry and the end (settings,
    labels, session info, any `custom` entry: a mode carried over, an
    extension's records), it is the same conversation and goes on from the
    end. `sameContext` counts every `custom` entry as bookkeeping (Pi never
    sends them to the model; `custom_message` still counts as new).
    Test in `test/frog-server.test.js` (fails with the fix off) and
    `test/conversation-flow.test.js`.
  - `frogCarryOver` reads the mode on the conversation's branch (from its
    last entry back), as Pi does, not the file's last mode line: the
    orphaned one had made it think there was nothing to carry over.

## Built: pause and go on from the pocket (2026-10-17, app 0.3.16)

> Is there a way I can stop the frog while it's talking? On the call it
> was talking, I started talking, and it didn't stop. I want more control
> over pausing and starting it.

Talking alone still never stops it (the standing rule, for noisy places).
What was missing is a pause reachable with the phone locked:
- **The call's notification** has one button beside Hang Up: *Pause the
  frog* while it speaks, *Go on* while it waits; its title says which
  ("The frog is speaking" / "The frog waits").
- **The lock screen's media controls** (the call's media session) pause and
  play the same way.
- The page tells the app what the frog's voice does (`ChatteringCall.
  frogVoice`: speaking, paused, quiet); the app's Pause and Go on come back
  as `pause` / `resume` call events and act like "frog, wait" / "frog, go
  on": paused where it was, the place reported, a thought then "over" is an
  aside; "frog, stop" or a new message ends it.
- Tested in the browser test with a stand-in app (the reports and both
  buttons); the Android side compiles and is published; not yet seen on the
  phone.

## Fixed: "frog, wait" on a call (2026-10-17)

> I was shouting "frog, wait" several times right at the beginning of a
> story it was reading, and it kept going. Chattering then recorded the
> place where I cut it off well after the moment I said it.

The records: the story started playing at 17:45:27.6 (UTC); the listener
handed on the utterance "Frog, wait, wait, frog, frog." at 17:45:43.3,
sixteen seconds later, at a paragraph break of the story; it matched no
command (the patterns wanted one clean "frog, wait"), went into the box,
and the next "over" sent it, which cut the story only then. An utterance
closes after ~0.8 s of quiet; with the frog's voice in the headset reaching
the boom microphone, the microphone was not quiet until that break
(inferred from the timing: the break is where it closed).

- **Live commands** (`frogLiveHeard`): the listener's pass at each short
  pause (~0.3 s; the frog's own sentence gaps give those) is searched for
  "frog wait", "wait frog", "hold on frog", "frog stop", "frog go on"
  among the words not yet handed on; the latest command said wins; ignored
  when it is the frog's own words now being spoken (`/api/frog/spoken`).
- **However it is said** (`frogCommandOf`): "frog" plus only one command's
  words and fillers ("Frog, wait, wait, frog, frog." is a wait; "the frog
  had never seen" and "frog, wait, tell me X" are not).
- **Where it was said** (`ScreenSound.pauseBack`): a voice pause steps back
  1.5 s, reported as where the person stopped hearing; "go on" repeats it.
  A clip paused at its very start counts as waiting (`pausedHere`).
- Tested in `test/frog-server.test.js`: pause and go on from live words,
  the step back, the repeated command not written into the message.
- **Not fixed: the leak itself.** The frog's voice plays as media and the
  phone's echo canceller in a call likely does not take it as its reference.
  Playing it through the call's own stream (native, the page handing clips
  to the app) would let the call cancel it: the next step if live commands
  are still slow.

## Built: "frog, stop" means not wanted (2026-10-17)

> A way to cut the frog off that is not an aside. It just stops without
> finishing, and the frog knows what I heard and that I didn't hear the
> rest, but I didn't want to hear it, so it shouldn't offer it again.

Three ways to interrupt it, now distinct:
- **"Frog, wait"** (or Pause): it waits where it was (a step back); "go on"
  continues; a thought then "over" is an aside.
- **A new message** ("over" while it speaks, or typed): it stops, and its
  note says what was heard and missed; it may offer what was missed.
- **"Frog, stop"** ("stop, frog", "enough, frog"; live or as an utterance):
  it stops for good, reported as a cut with `why: 'stopped'` (so a server
  not yet restarted still cancels the rest of the reply); the note
  (`cutNote`, state `stopped`) gives what they heard and says they did not
  want the rest: do not offer it, repeat it, sum it up or mention it unless
  asked. The unheard text is not handed to the frog at all. Nothing comes
  back by itself after a stop: the asides' return waits for the person's
  next message (`ScreenSound.frogStopped`).
- Tests: `test/frog-assistant.test.js` (the note), `test/frog-server.test.js`
  ("Frog, stop." while a new reply plays: reported stopped, not written into
  a message, no asides' return in the next 4.5 s; fails with that guard off).

## Built: the frog's own "over" (2026-10-17)

> I say "over" when I'm done; the frog should have its own "over", a short
> sound at the end of its reply so I know it's my turn.

Two soft falling notes (`frogCues` `over`) after the frog's last spoken
word. The server sends it (`frogSpeechEnd`, at the run's end, once its
speech line has sent its last piece) into the same queue as the speech
(`{ cue: 'over', frog: { job, end } }`), so it plays right after the last
clip, never when the writing ended while the last pieces are still being
made. None for a reply cut off or stopped, or one that said nothing aloud.
The page plays it only while talking with the frog. Test in
`test/frog-server.test.js` (after a reply said to the end; none after one
cut; fails with the server's mark off).

## Fixed: Talk's listening ends with Talk (2026-10-17)

Found by the person in the code: `frogTalkSet(true)` turned listening on
when it was off, and `frogTalkSet(false)` set the mode back to commands but
left the microphone on, so after Talk what was said drove the app as voice
commands. Now Talk notes when it turned listening on (`frogTalk.
ownsListening`, not saved as the person's preference) and turns it off when
it ends, also when another screen takes the voice (then nothing is held to
come back); voice commands that were on before Talk stay on. Test at the
end of the browser part of `test/frog-server.test.js` (fails with the
turning-off removed). The voice-print recording (`voiceEnrolStart`, from
the "Who's talking" work) did the same: now listening it turned on goes off
when the recording is over (`voiceEnrolOver`: recorded, failed, cancelled,
or it could not start), not saved as a choice; if Talk began meanwhile, the
listening is Talk's and ends with it. (What is said while recording was
already never acted on.) Tested at the end of the same browser test.
The old rare failure of the aside step ("speaking again") was the test
reading the clip's progress while "Noted." still played: it now waits for
the clip to play again (5 of 5 runs green after).

## Built: the voice corpus; measured: a short-word print (2026-10-17)

> Record everything that happens through voice in Chattering, audio and
> transcriptions, from any device: the phone's microphone, headphones,
> other microphones. A very diverse dataset, to train a much smaller,
> faster model specialised on my voice and commands.

- **The laptop's recordings** (voiced, ~/Projects/voiced): 57,420 clips,
  18.8 h transcribed, 459 hand-corrected, moved by the laptop to lambda
  (~/Recordings-archive/XPSwhite), the only copy, on a 97% full disk. Now
  mirrored nightly to /mnt/bulk/voice-dataset (never deletes; Home Manager
  `hm/voice-dataset.nix`), README there.
- **Chattering's own** (`voice-corpus.js`): each utterance the listener
  hands on, its audio (16 kHz, as heard) and a sidecar (text, the
  listener's text before any cut, the voice check's verdict, mode, device,
  microphone: a call's headset by name, the browser's name for its mic, the
  app's), only the install owner's, in CHATTERING_VOICE_CORPUS_DIR (lambda:
  /mnt/bulk/voice-dataset/chattering, second copy nightly on /mnt/fast).
  The page sends `{type:'context'}` on the listening stream when what it
  knows changes. Not for the app connected by address (its native listener
  has no way to send it). Applies at the next restart with a Home Manager
  switch (the variable is in `hm/voice-dataset.nix`).
- **The training work** started as its own conversation, "My voice model",
  in ~/Projects/myvoice: data manifest, Parakeet baseline on the corrected
  set, then a plan for a small distilled model, proposed before training.
- **"Record my short commands": measured, not built**
  (`scratch/short-print/`): a print of short words raises other voices'
  short words as much as the person's; no gain at an equal rate of others
  let in, three times as many in at today's bars. His misses came from his
  one print being recorded with another headset (X08) than the one he
  talks through (ISOtunes): one print per microphone is the fix (the
  existing "Record on this device too").

## Research: calls (2026-10-17, A built above; B not)

The ask: talk with the frog like a real call, through a boom-mic Bluetooth
headset outside, while using the phone for other things; the headset's
button answers its call, hangs up, and starts a call with it; a quick dial.

**A. The app as a proper calling app** (Android's own call system, Jetpack
Core-Telecom 1.1, \`CallsManager\` in a \`phoneCall\` foreground service):
- The call is a system call: it goes on while other apps are used (a call
  notification to come back or hang up), audio goes to the Bluetooth headset
  as for any call, and the headset's button answers and hangs up (Android
  documents headsets, watches and cars as able to manage such calls).
  Ringing: a full-screen call notification, allowed to calling apps.
- Audio: the phone's call audio to and from lambda over what the app
  already holds (the server address, or the encrypted link outside): 16 kHz,
  as Parakeet wants it, Kokoro at its own 24 kHz quality. Free. Needs a data
  connection.
- **Starting** a call from the headset is the uncertain part: its button
  "redial" goes to the phone's dialer, not to an internet-calling app; its
  long press opens the phone's assistant, which Chattering could become
  (an assistant app is a thing Android lets a person choose), to be tested
  with this phone and this headset. Sure ways: a home-screen shortcut, a
  quick-settings tile, a "call the frog" button in its notification.
- Work: native code in the app (a calling service, audio routing, the
  call screen and notification), and the server side of a call: the
  walkie-talkie's listening and speaking, already built, fed by the call.
  Weeks, not days; an app release.

**B. A real phone number** (Telnyx or Twilio, streaming the call's audio to
lambda):
- Works from any phone, without the app or data, with the phone's own
  dialer: every headset button works as for any call, redial included (the
  frog's number as the last one called), and the frog can call.
- Cost: a number ~$1/month; per minute, Telnyx about 0.9¢ in and 1¢ out
  (line, call control, audio stream), Twilio about 1.3¢ in and 1.8¢ out.
  Half an hour a day: about $9–13 a month.
- But: phone-line audio (8 kHz): Parakeet and the voice check hear worse,
  Kokoro sounds like a phone; the call's audio passes through the company;
  it needs an address the company can reach on the internet (the relay or a
  public tunnel); a Canadian number asks for an address on file.

**Recommendation:** A first (better sound, free, private, every Chattering
voice feature on the call), with the quick-dial shortcut, tile and
notification button; B later as a backup line if starting from the headset
button matters or the app cannot be used. Both reach the same frog
conversation.

## Research: who is speaking (2026-10-17, measured, not built)

- **Dialt** (dialt.com) is a hosted voice agent (its own speech-to-speech
  models, $3.90 an hour, $1.99 on spare capacity): it would replace the
  frog's brain, not filter the microphone; its several-speakers mode is an
  internal pilot that needs each person on a separate audio line.
- **Open models, measured on lambda** (\`scratch/frog-voice-research/\`):
  - *TitaNet-large* (NVIDIA, CC-BY-4.0; VoxCeleb1 error rate 0.68% in its
    paper): "is this the person?" from a recording of their voice. 6–11 ms a
    check on one 3090; on 38 speakers of clean read speech no mistake from 3
    seconds of speech, 3% at 1.5 seconds.
  - *Streaming Sortformer* (NVIDIA Open Model License: commercial use and
    derivatives allowed): who speaks when, voices switching with no pause.
    Every turn right on an A-B-A-B test with 0.15 s gaps, a switch found in
    ~0.9 s, 54 s of audio in 3.9 s. *Nemotron 3 Diarization* (newer, 8
    speakers, OpenMDW licence) not tried yet.
  - *Multitalker Parakeet streaming 0.6B* (NVIDIA Open Model License):
    transcribes one chosen speaker even when two talk at once, one copy of
    the model per speaker, guided by the diarizer. Not tried.
  - ECAPA (SpeechBrain, Apache-2.0), WeSpeaker, CAM++ are equivalents of
    TitaNet; TitaNet won because it runs in the Parakeet environment as is.
- **Proposal, alongside Parakeet (not instead):** enrol the person's voice
  once (about a minute); each utterance the window closes is checked
  against it; another voice's utterance is not sent (shown greyed in the
  listening overlay, one tap to add it back); unsure, it is sent marked so
  the frog knows. Then the diarizer, to split an utterance where voices
  switch without a pause. The multitalker model only if talking over each
  other turns out to matter. First step: measure on the person's own voice
  in their real rooms, phone and headset.

## Research: Tiron and MOSS-Transcribe-Diarize (2026-10-17, measured, not built)

Asked: do Tiron (Trelis, Apache 2.0, Whisper large-v3 with speaker tokens,
up to 8 speakers per 30 s window) or MOSS-Transcribe-Diarize (Apache 2.0,
0.9B, whole recordings in one context) work for live turns, alongside or
instead of Parakeet, and how would they keep only the person's speech?

Measured on lambda (\`scratch/frog-voice-research/\`, table in its README):
twelve turns (alone; someone between the person's sentences; someone over
them, quiet; someone over them, as loud), the person's voice print from
three other recordings.

- **Instead of Parakeet: no.** The live text is the whole listening window
  transcribed again at every pause (design/64: Parakeet, 60 s in 0.23 s).
  Tiron takes 0.8–2.1 s for one turn of up to 30 s and MOSS 0.7–4.2 s
  (Hugging Face transformers, one GPU); their "43×" and "3×" real time are
  whole meetings decoded in parallel, not the wait for one turn.
- **Keeping only the person's speech** works the same for all: each
  speaker label's audio is compared with the person's voice print, and only
  the best match is kept (with overlap, every label's audio contains the
  person's voice, so "every label above a bar" kept the other voice too).
  Kept-as-mine word error, mean of the twelve: Tiron 0.05, MOSS 0.06, the
  fast path (Sortformer + TitaNet + Parakeet, 0.11–0.34 s) 0.09, Parakeet
  alone 0.25 (the other person's words in).
- **Where Tiron is better:** two people at the same volume at the same
  moment. Tiron writes each voice separately (0.05 there); the fast path
  gives Parakeet mixed audio (0.59 in one such turn). MOSS mostly heard one
  voice in overlaps. MOSS is a model for finished recordings.
- **Proposal:** Parakeet stays for live text. When an utterance closes, the
  fast path decides whose words they are (a tenth to a third of a second,
  while the person goes on talking). Only when it finds two voices at the
  same moment does Tiron redo that utterance, about a second, in the
  background. Untried: Tiron through faster-whisper (CTranslate2), likely
  2–4× faster. Languages are no reason to switch: the Parakeet running here
  is tdt-0.6b-v3 (25 European languages, French included).
- **Caveat:** read speech mixed by a program; the person's own voice, rooms,
  phone and headset are the real test, and the first step of building it.

## Built: only my voice (2026-10-17, measured on real meetings, behind a setting)

The ask: only the person's own speech reaches the frog. They are often
somewhere noisy, or talking with their girlfriend while dictating, and her
words end up in their messages; they also want to talk while the frog
speaks without other voices stopping it. Keep Parakeet's speed for the live
text; add who-is-speaking.

**What was measured this time** (`scratch/frog-voice-research/`, README
third round). Clean read speech flattered the earlier numbers, so the test
moved to real meetings: the AMI test set (16 speakers, each on their own
headset microphone, plus a table microphone), ~6,400 turns, half under
1.5 s ("yeah", "okay", "mm-hmm": the "over" case). Each speaker enrolled
from a minute of speech in one meeting; every other turn checked against
all 16 prints.

- *Four models.* TitaNet-large (NVIDIA, CC-BY-4.0, runs in the Parakeet
  environment as is) and ReDimNet-M (IDRnD, MIT, Interspeech 2024) are
  the best two and close; ReDimNet-B2 and SpeechBrain's ECAPA are clearly
  behind. With one strict bar (others pass 1%): turns of 2 s and more are
  nearly never rejected (0.2–1.6%); 1–2 s turns 8–12% rejected; under 1 s
  34–50% rejected. **Short turns are the whole difficulty**, not the model.
- *The device matters more than the model.* A print from the headset,
  checked on the table microphone: 55% of the person's turns rejected. Loud
  café babble: short turns much worse. So: **enrol on the device and
  headset you talk from**, one print per device (up to four, the best match
  counts).
- *The rule* (`bench_policy.py`, each speaker's turns replayed in order
  with another speaker's turns inserted, scored in words): one bar for
  everything keeps 96% of the person's words but only 55% of their short
  turns; a lower bar for turns ≤ 1.2 s, and lower still within 4 s after
  one of the person's own turns (the "over" after their sentence), keeps
  98.6% of their words, 96% of their 0.8–1.2 s turns, and lets in 1.2–1.9%
  of the other voice's words (their own short "yeah"s) and 0–0.3% of the
  other voice's sentences. Fusing both models adds 0.4% words and 4 points
  on short turns: not worth a second model yet. **Letting the print drift**
  toward accepted turns was tried and dropped: with the other voice close
  to the microphone it let 6–9% of their words in within minutes.
- *Two voices in one utterance* (no pause long enough to close it): the
  whole utterance still passes the strict bar 73% of the time, so a
  per-utterance check alone lets the second voice's words in. Checking 1 s
  pieces every 0.5 s against the print keeps 91–95% of the person's audio
  and leaks 10–17% of the other's (the piece at the boundary); the person's
  pieces are then transcribed again by Parakeet. This replaces the
  Sortformer diarizer of the earlier fast path for this case: same
  environment, one model, and the boundary is what it costs.
- *Dialt* (dialt.com), checked again from its public docs: a hosted voice
  agent engine ($3.90/h Fast, $5.10/h Smart, $1.99/h spot); its
  `multispeaker` mode is an internal pilot with "isolated input-line
  provenance, not verified identity": each person on their own audio line,
  no voice print, nothing that filters one microphone. Not relevant here.

**Built** (nothing restarted; it waits for a restart and the service):

- `speaker/speaker_service.py`: the voice-print service, TitaNet-large
  behind HTTP (`/embed` for an enrolment, `/check` with the person's prints
  in a header → the whole utterance's score and its 1 s pieces'). Stateless;
  runs with the Parakeet environment (NeMo is there): `CUDA_VISIBLE_DEVICES=1
  …/parakeet-stream/.venv/bin/python speaker/speaker_service.py --port
  8079`; a user unit `speaker/chattering-speaker.service`; README. 0.35 GB
  of GPU; a check 15–35 ms round trip, ~90 ms for a long utterance holding
  two voices (+ ~55 ms of Parakeet on the kept part).
- `voice-speaker.js`: the rule above (`decide`), the cut (`slicePcm`), the
  print store (`~/.local/share/chattering/voice-prints.json`, 0600, one
  entry per person, embeddings never sent to a page), the service client,
  `makeCheck` (fails open: with the service down everything counts as the
  person's, marked), `makeEnrolment`. Tests `test/voice-speaker.test.js`.
- `voice-window.js`: an optional `check(pcm, text)` hears each utterance's
  audio before it is handed on; its answer rides on the `utterance` event
  as `speaker` ({mine: yes | no | unsure, score, secs, mixed, dropped}),
  and a `text` in it replaces the words (the person's part). An optional
  `onSpeech` tap gets the speech frames (the enrolment).
- `server.js`: `speakerUrl` (setting / `SPEAKER_URL`), the capability
  `speaker`, `GET/POST /api/voice/print` (status; `{on}`, `{forget: id}`),
  and on the listening socket: `{type:'enrol', seconds, label}` collects
  the next minute of speech from whatever microphone the device listens
  with (browser, app, headset) into a print, with `enrol` progress and
  `enrolled` events, then the check starts at once; `enrol-finish`,
  `enrol-cancel`, `speaker` (re-read the setting). `ready` says whether the
  check is on. `settings.js`, `app.html` (the field in Settings → sound).
- `voice-commands.js`: an utterance that is another voice's is not acted on
  and never reaches the frog's box: it shows struck through in the debug
  view with **It was me** (one tap runs it as heard now). A doubtful one
  goes through, noted "unsure it was you (0.27)"; a cut one is noted
  "another voice cut out (2.9 s)". The overlay head says "only your
  voice". Settings → sound → voice commands → **only my voice**: the
  toggle, the recordings (device, when, seconds, how clean), *Record my
  voice* (turns listening on if needed, a minute of talking, a progress
  bar, "That's enough" from 20 s), *forget*. While recording, what is
  said is not a command.
- Verified end to end without Chattering (`e2e_window.js`: the real
  VoiceWindow, the real Parakeet bridge, the real service, AMI audio): the
  person's sentences 0.78–0.90, the other voice −0.04 and skipped, their
  "oh great" skipped, a two-voice utterance cut to the person's sentence
  ("I'll be happy when this week is over.", the other's gone).

**First real call (2026-10-17, 13:40, phone + headset, print 60 s, clean
75%):** the other person's "Monday" got into the message. No verdicts were
logged then, so the cause is inferred: a short word right after the
person's own sentence faced the doubt bar (0.13) *and* the unsure band
under it (sent from 0.07), which lets about 40% of other voices' short words
through on AMI — far looser than the simulation measured, because the
simulation treated unsure as rejected. Changed:
- the benefit of the doubt after the person's own turn goes only to short
  *control phrases* (a hand-over, "frog, wait", yes / no: `isControl`,
  using frog-assistant's HAND_OVER), where missing one costs a turn; a short
  plain word ("Monday") faces the short bar (0.20, others pass 10%);
- a short utterance is never "unsure, sent": under its bar it is not the
  person's (struck through, *It was me*). Unsure stays for long utterances;
- every verdict is written to `~/.local/share/chattering/voice-speaker.jsonl`
  (0600: time, text, seconds, score, bar, verdict, control, time since the
  person's last turn, piece scores), so the next miss is read, not guessed.
Still possible: her word inside the same utterance as his sentence (no 800
ms pause): a single short word cannot be cut by 1 s pieces. If the log shows
that, the next step is Parakeet word timestamps or the diarizer.

**What the person has to do:** start the service (above), set its address
in Settings → sound, then *Record my voice* once on each device they talk
from (laptop, phone with the headset): about a minute of ordinary talking;
the recording is not kept, only 192 numbers. Then switch *only my voice*
on. The first days: watch the debug view for struck-through lines that were
theirs (tap *It was me*) and for the other voice getting through; the
scores there are what the bars are set from (strict 0.32, short 0.20, right
after their own turn 0.13, unsure within 0.06 under the bar), and those
bars come from AMI's distributions, not yet from their voice.

**Limits, stated:**
- Measured on English meeting speech of other people; the person's own
  voice, rooms and headset are not measured yet. Expect short turns to be
  the thing that misses ("over" alone, long after a sentence: a doubtful
  score goes through marked; a clear miss is struck through, one tap).
- When the other voice talks *over* the person at the same moment, the
  mixed audio reads as neither: Tiron (earlier research) handles that case;
  not built.
- Unsure utterances are sent, but the frog is not told; only the debug
  view says so.
- Enrolment from inside the Android app needs one method on its
  `ListenBridge` (`sendText(json)` to the listening socket), which belongs
  to the phone conversation; until then enrol from the phone's browser
  (https) with the same headset, or from the laptop. The check itself runs
  on the server, so the app is covered.
- The bars are fixed numbers; a per-person calibration from the first
  day's scores would be the next step, and a second model (ReDimNet-M)
  fused in is a small, known gain.

## Built: asides (2026-10-17)

> I hear the frog's reply and something in it sparks a thought. I want to
> say it right away, with the frog pausing, not stopping. The frog notes the
> aside, then resumes the paragraph I cut off, from where it was. Later we
> come back around to the asides I dropped. Right now I do this by hand with
> play, stop and replay on the read controls, and it works well.

The dynamic, as built (walkie-talkie, talk on):

1. **Pause.** "Frog, wait" (or "hold on, frog", or the pill's pause) pauses
   its voice where it is. Talking alone does not (a noisy room; the person
   may talk while listening), so an aside said without "frog, wait" plays on
   under it until the person hands over.
2. **The aside.** What is said while the frog speaks or waits, ended with
   "over", is an aside, not a turn: it does not go to the frog's
   conversation, no turn starts. It is kept as a thread
   (\`~/notes/chattering/frog/asides.json\`) with the sentence it was said
   during, and "Noted." is played (Kokoro, made once and reused).
3. **Resume.** The reading goes on from the start of the sentence that was
   cut (\`resumePoint\`: within a piece made of several sentences, placed by
   their length, a beat early), not from the paragraph's start, not from the
   cut word.
4. **Threads to return to.** Before each frog turn the open asides are in
   its note, with the rule: never answer one in the middle of something
   else; once finished, one at a time, briefly, ask before the next; close
   each with the \`asides\` tool. When its reply has played to the end and
   the person says nothing for 3.5 s, the frog comes back to the first open
   aside in a turn of its own (\`/api/frog/asides/return\`, a \`frog-asides\`
   message, at most once a minute).
5. **Stop is stop.** "Frog, stop" ends the reading for good (what was not
   heard is noted for its next turn, design above); a message typed while it
   speaks is a turn and cuts it too.

**Limits, stated:** an aside is recognised by when it is said, not by what
it says: "no, stop, do X instead" said while it speaks is an aside too
(say "frog, stop" first); the resume point is estimated within a piece from
sentence lengths; on a phone before app 0.3.12, "Noted." may need a tap.

## Built: context use and fresh starts (2026-10-17)

- **\`context_use\`**: each listed conversation's context, its last reply's
  tokens against its model's window (the catalog's, else the assumed
  window), fullest first. The workspace note marks those past half
  ("context 62% used"), and the frog's mode asks it to say so once when it
  matters and to offer a fresh start near the end. Plan usage limits are not
  readable: neither Chattering nor the Claude provider keeps them (Codex's
  are, through Codex, not wired).
- **\`fresh_start\`**: a new Pi conversation from an old one, its messages
  only (what the person and the agent said; no tool call, no result, no
  step notes), through \`harness/handoff.js\` (turnsOf, piSessionLines), then
  the frog's message; same folder, model, mode and side-list group, titled
  "… · fresh"; the old one untouched.
- **\`mark_read\`**: built before (unread stays honest).

## Built: its memory (2026-10-17, part 3)

> Use OptMem's design, reimplemented, with credit: an append-only log of
> one-line memories, a tree of summaries that get shorter as they age within
> a fixed budget, the option to zoom back into the raw lines, and recall
> over everything. The raw transcript is never lost. This is the one
> conversation Chattering compacts by itself.

**The design is OptMem's** (Victor Taelin, github.com/VictorTaelin/OptMem;
no licence on the repository, so the idea is rebuilt in `frog-memory.js`,
not the code): an append-only log of one-line memories (280 bytes each,
never edited); a binary tree of summaries above it (#0-1, #2-3 one line
each, #0-3 one line of those two, every block an aligned power-of-two
range); a *print* within a fixed budget of lines (64 here; OptMem prints
96), finest near the present: the newest memories as they are, older ones
as summaries of ever larger ranges, and nothing summarized at all while
everything fits (OptMem's cover, same algorithm); `zoom` opens a block
into its halves down to the memories; `recall` searches every memory ever
recorded; `forget` drops a bad summary so it is written again. The store
is JSON lines read whole (`~/notes/chattering/frog/memory/`: `log.jsonl`,
`tree.json`, `state.json`), not OptMem's fixed-width records: thousands of
lines, not millions, so seeks would buy nothing.

**What differs: the memories are written for it, between turns.** OptMem's
agent notes memories itself in a shell. Here, after each of the frog's
turns (and every ten minutes, and 45 s after a start), a pass runs in the
background (`frogMemoryWork`, server.js):
1. **Digest.** Of the turns in its context, the oldest leave in steps of
   8 once more than 8 + 8 are there (the last 8 always kept whole; the cut
   moves in steps so the provider's prompt cache holds between). Those
   turns (the person's words, the frog's answers, its tool steps one line
   each, events; workspace notes left out, stale by the next turn) go to
   the AI program `frog_memory_lines` on the frog's own model (Opus), with
   the last twelve memories as known, and come back as one-line memories,
   appended to the log with where each came from (the conversation part's
   id and the entries). Checked on the real conversation: 33 turns gave 27
   lines, each true to the transcript, in 32 s. What was digested is
   remembered (`state.json`), so a turn is never digested twice.
2. **Merge.** The summaries the print needs, halves before parents, plus a
   few more each pass so the tree fills in: `frog_memory_merge`, a block of
   up to 16 memories from the memories, bigger ones from their two halves
   (OptMem's rule). A missing summary never blocks: the print shows that
   block as its halves instead, and says which it wanted.
3. **The compaction entry.** At a quiet moment (no run, no terminal), Pi's
   own `compaction` entry is appended to the frog's session file: its
   summary is the memory print (with a line saying what the lines mean and
   which tools go further), `firstKeptEntryId` the first entry of the kept
   turns. From there on the model reads the print and the kept turns; the
   file keeps every entry, the reader shows them all with the "▤ compacted"
   mark where the model continues from. Nothing is removed, ever.

Both programs are in the FunctAI log, on the Programs page, so a digest can
be judged there. The frog's model does them (one model, as asked); a merge
or digest that fails is reported in the server log and tried again next
pass. What this buys, given the measurement above (at ~200k the context is
not what the person feels): a conversation that goes on indefinitely within
a bounded context, and the cost of each turn (a cache read of 220k tokens
was about 4¢ a turn; the kept turns and the print are a few tens of
thousands). The seconds are to be measured after the restart, as said
there; the shrink (`frog-context.js`) stays off unless turned on.

**The frog's side:** three tools, `remember` (one line now, for what must
be kept exactly), `recall_memory` (all the words, or a regex; newest last),
`zoom_memory` (a range like #16-31 into its halves), and `read_conversation`
takes `at`: the messages around an entry a memory names, so a memory is one
step from the words it came from. Its mode says to answer from its memory
as memory. `context_use` was already in its session (the mode by name since
09:44, the installed mode has it).

**Segments (the fresh start, made to fit).** A new file, when the frog
asks `fresh_start` on itself or the file passes 48 MB (a big file is loaded
whole at each turn) and talk is off: everything but the last 8 turns is
digested first, then a new Pi session in the same folder with the frog
mode, the memory print as its first entry (a compaction entry that keeps
nothing before it) and the last turns copied as they were (calls and
results paired), chained to the old part (`harness/chains.js`): the list
shows one row, the reader shows the old part above the new, the old part
can no longer be written to ("continued … open where it continues"). The
frog's identity moves (`state.json`), the pin and the group follow, a screen
on the old one follows too (`frog-home`), and the walkie-talkie learns the
new key. Asked during a turn, it happens when the turn ends (the tool says
so). `fresh_start` on other conversations is as before.

**Its own switch (the same day).** The first passes were refused:
every background model call goes through the machine's background-AI
gate, which knows names, memory and steps, and the frog's kind was none of
them. The person's rule: the machine's "automatic memory" (project notes
re-read for every conversation on the machine, other people's included)
is one question; the frog's memory, which reads one conversation on the
frog's own model, is another. So `frog-memory` is its own kind in the
gate, answered by the frog's switch (`state.json` `memory`, on unless
turned off), shown in settings → model beside the other two ("the frog's
memory"), `POST /api/frog/memory/switch {on}` (owner or admin; turned on,
a pass runs at once), `GET /api/frog/memory` says `on`. Found on the way:
the machine's own memory switch was on ("since before Chattering asked"),
not off as the person thought; left as it was, for them to decide.

**For scripts and the person:** `GET /api/frog/memory` (the print, counts,
the last pass), `/memory/recall?q=`, `/memory/zoom?id=%2316-31`,
`POST /memory/note {text}`, `/memory/forget {id}` (a bad summary),
`/memory/compact` (a pass now; `{force:true}` keeps only the last 8),
`/memory/segment {message?}`. `~/notes/chattering/frog/memory/config.json`
may set `keep`, `step`, `budget`, `segmentBytes`.

**Tests:** `frog-memory` (the cover, the store, pending and naps, zoom,
recall, forget, turns, the plan and its steps, the digest text, the print)
and `frog-memory-server` (a real server, a stand-in model: digest,
compaction entry, the reader, a second pass does nothing, print, recall,
note, zoom, read-around, a segment chained with the memory in front and its
first turn).

**Trade-offs, stated:**
- A memory longer than 280 bytes is cut at a word with an ellipsis (the
  program is told the limit; Opus mostly keeps it). A bad line stays in
  the log (append-only is the point; a person can edit the file); a bad
  summary can be forgotten and is rewritten.
- The first pass on the real conversation digests 80 turns in three Opus
  calls (about a minute and a half, in the background, only while the frog
  is quiet); after that, one short call every 8 turns and a merge now and
  then. The calls share the subscription with the frog's own turns.
- The compaction changes the prompt's prefix once per 8 turns (one cache
  miss). The measurement above saw a shrunk history make the frog think
  before answering; a print-plus-eight-turns context may do the same:
  watch the first turns after the first compaction.
- The kept turns (8) and the budget (64 lines) are first guesses, set in
  `config.json` once heard in use; more kept turns cost tokens, not speed.
- Pi's own auto-compaction, if it ever fires on the frog, writes a plain
  summary; the next pass builds on it (the latest compaction on the path
  is where the context starts, whoever wrote it).

## Built: the woven timeline and barge-in (2026-10-18)

> I want to control you by voice: interrupt you, stop, next sentence,
> previous sentence. But also fully natural: I just talk, we interrupt each
> other. Right now while your audio plays nothing else happens. We need a
> model of exactly what audio played out and how it weaves with what I'm
> saying. If I'm clearly talking, you pause; when I pause, you continue;
> if I ask something that means I don't want you to continue, switch gears.

**What went wrong before** (the frog's own map, assistant/docs/frog-interrupts.md,
and the voice-filter log of the 14:52 test): every command needed the word
"frog"; "pause" alone was dropped as another voice; "frog, stop" ended the
reply for good so "continue" did nothing; the cut-off point was where the
page understood the command, a second or more after the person spoke; and
nothing recorded what each utterance did.

**One clock, both voices** (`frog-timeline.js`, tests `test/frog-timeline.test.js`):
- *The frog's side.* Each clip carries its sentence table (the runs Kokoro
  made, split by length within a run; `sentencesOf`), sent to the page with
  the clip. The page reports every `play`, `pause`, `seek` and `ended` of a
  frog clip with the clip's own time and its clock (`/api/frog/heard`, the
  player's events, `app.html` `played`); the computer places the page's clock
  on its own by the fastest message seen (`createClocks`) and keeps the
  playing segments. From them every sentence gets the wall moments it
  sounded on the device, and a status: heard (≥ 85% played or reached its
  end), partial (with the words heard, by proportion), unheard, unsent.
- *The person's side.* The listener (`voice-window.js`) now stamps when
  speech began and was last heard, from the frames (a chunk's arrival minus
  the audio after the frame); `utterance` events carry `startedAt` and
  `endedAt`; a `speech` event says the first frame at once. Each utterance in
  talk mode goes to the timeline with its device, microphone and the voice
  check's verdict; the page says afterwards what it did with it
  (`/api/frog/said`: a command, a reaction, sent, kept waiting).
- *The note* (`note()`, through `/api/frog/interrupted`, in place of
  `cutNote` whenever the page reported playback): sentences and the person's
  words interleaved, seconds from the reply's first sound on the device,
  "you said", "you said, cut off: "Second," of "…"", "they said: … (what was
  done)", "not said: …", more than six whole sentences folded to first two
  and last two. Told once per spoken ledger. Every event is also appended to
  `~/.local/share/chattering/frog-timeline.jsonl`; `GET /api/frog/timeline`
  shows the last turns and the note as it stands.

**Barge-in** (the listener on the computer decides; the page holds the sound):
- *With the voice print on:* half a second of speech in a row
  (`BURST_FRAMES`, `onBurst`) while the frog's voice is playing on the
  person's device (`speakingAt`, from the reports) → the first half second
  is checked against the print (`/check`, ~30 ms) → theirs at the lenient
  bar (0.20) → the page gets `barge` with when they began and where to
  resume (`resumeFor`: 400 ms before the word they cut into, or the start of
  that sentence when they began within 1.5 s of it). Each burst verdict is
  in `voice-speaker.jsonl` (`barge: true`), to set the bar from real data.
- *Without a print:* the live words at the first short pause, two or more,
  that are not the frog's own words (its text is known): later, and other
  voices pause it too (stated).
- *The page* (`ScreenSound.bargePause`) pauses at once, reports the place it
  really stopped, then steps back to the resume point. The player's own
  pause after a step back is reported first with the true place (`__told`).
- *Then the decision* (`frogBargeDecide` → `POST /api/frog/barge` → the AI
  program `frog_barge` on Jev; inputs: the sentence cut into, the one
  before, what was said): **reaction** ("mm-hmm", "right", "go on") → the
  words leave the box and the reading goes on; **wants an answer** (a
  complete question, an objection, an instruction, or any hand-over word) →
  sent as a message, the reading cut; **still talking** → the words wait in
  the box, the frog waits, and goes on when they fall quiet (the listener's
  `quiet`, ~4 s). Unsure it wants an answer and no hand-over word → wait (a
  pause never sends). Without a key or on failure, a rule: hand-over word
  sends, a short backchannel resumes, the rest waits. The frog's own turn,
  with the woven note, then decides whether to pick its reading up or change
  course: that is the main path the person asked for; Jev only sorts out
  what cannot wait for a full turn.
- Anything said while the frog is held for any reason (a barge-in, "pause",
  the button, the app's notification) goes through the same decision. **The
  page no longer makes asides by itself** ("Noted." and on): that path
  confused more than it helped (the five false asides); the frog's asides
  tool remains, and its mode says to use it for dropped thoughts.

**Controls, plain** (`frogCommandOf(text, bare)`, while the frog speaks or
waits; with "frog" anywhere, any time): pause / wait / hold on / hang on /
shh → **wait**; stop / enough → **stop** (held like a pause, marked not
wanted; "continue" brings it back; the ledger is no longer cancelled by a
stop, only by a new turn or talk off); go on / continue / resume / keep
going → **go**; next / skip / next sentence → **next**; previous sentence /
go back / the sentence before → **prev**; say that again / repeat / what /
pardon → **repeat** (`ScreenSound.seekSentence`). The live words act on
them too, except "what"/"again" (too common mid-sentence), with the
frog's own words excluded by whole-word match ("stopped" is not "stop").
The voice filter's control list (`voice-speaker.js` `YES_NO`) now holds
them, so a short plain "pause" after the person's own turn faces the
doubt bar, not the short bar.

**Fixed on the way:** `voice-commands.js` had two functions named
`voiceContext`; the later (the understanding's) won, so the listener's
context message (mode, device, microphone) was never sent: the corpus had
no device, and nothing on the computer knew a listener was in talk mode.
Renamed `voiceListenContext`.

**Tested:** `test/frog-timeline.test.js` (placement, the clock, the weave,
resume points, the note's forms); `test/voice-window.test.js` (onset,
burst, utterance times); `test/frog-server.test.js` browser part: plain
"pause", a reaction resumes, next / before / again by the sentence table, a
barge event holds at once and reports the true place with the page clock,
a question over it becomes a turn, "Frog, stop" holds and "continue"
brings it back; server part: play / ended / pause reports → statuses,
device, the woven note told once. 84 voice and frog tests green.

**Not yet tried by the person** (nothing voice is claimed to work until he
has): the barge-in on the phone call with the headset, the bars, the
resume point's feel. **Trade-offs, stated:**
- The frog's voice leaks into the microphone; with the print on, the leak
  reads as another voice (Kokoro's) and does not barge; with it off, the
  leak's words are excluded by text, but any other voice pauses the frog.
- "When I pause, you continue" waits the listener's 4 s quiet; a thought
  held longer than that resumes the reading (say "wait").
- A quick model (Jev) sorts reaction / answer / still talking because the
  frog's own turn takes seconds and "mm-hmm" cannot wait; everything that is
  not an obvious reaction reaches the frog with the full weave.
- "The sentence before" at a clip's start replays that clip's start; the
  previous clip is gone from the player.
- The barge bar (0.20 on half a second) comes from AMI, not his voice; the
  burst verdicts in the log are the data to set it from.
- Needs a restart (server: the timeline, barge, the mode text) and a page
  reload (the player, the commands); the Android app needs no release (it
  passes every listener event through).

## Fixed: talking from outside, a wood mill running (2026-10-19)

> The voice filter and the small voice model seem problematic when I'm
> outside milling wood. Check the logs from the last half hour.

**Read** (`voice-speaker.jsonl`, `frog-timeline.jsonl`, the corpus audio,
18:11–18:19 UTC, the phone call with the ISOtunes LINK 2.0): the mill sits
at 300–4,000 RMS with dips to 20; the voice at 10,000+. The gate's floor is
the quietest frame of ten seconds × 2.5 ≈ 75, so every mill frame was
"speech": utterances of 17, 25 and 43 s, "slower" said eight times before
one closed, the words handed on long after they were said. Every barge
check scored below 0.1: the first half second of "speech" was the mill.
"over to you" came padded with mill to 1.8 s, met the strict bar (0.32) at
0.23 and was dropped three times. "slow down" and "go slower slower" did
not match the speed command. Parakeet wrote "sour sour" for the mill.

**Done:**
- A noise-level term in the gate was tried and dropped (steady speech with
  few gaps raised it to the voice's own level: it cut the speaker off in
  `voice-print-api.test.js`). Instead, two caps: 15 s of "speech" with no
  800 ms dip closes the utterance at the next 300 ms pause
  (`SPEECH_RUN_MAX`); and the server closes it at once
  (`VoiceWindow.closeUtterance`) when the live words end with a hand-over
  or a control phrase (`closeOnHandOver`), so "over" is seen while the mill
  keeps the gate open.
- Barge checks at 0.5, 1.5 and 3 s of speech, on its last second
  (`BURST_FRAMES`, `stage` in the log).
- A control phrase faces the lenient bar (0.20) whatever its length
  (`decide`): "over to you" at 0.23 passes.
- The speed command takes "slow down", "speed up" and repeats.

**Limits, stated:** an energy gate cannot tell a mill's bursts from a
voice; the real fix is a neural voice-activity model (Silero VAD: 2 MB,
about a millisecond a frame) in the listener, not built. In heavy noise
the voice print scores the person at 0.15–0.25 (the pieces), under every
bar for plain sentences: one of his sentences was dropped at 0.15. The
print was recorded indoors; a second print on the same headset with the
mill running (up to four, the best match counts) is the quickest gain.
Not yet tried by the person.

## Built: "It was me" teaches the filter; the small models started (2026-10-19)

> I've been pressing "It was me" when it wasn't recognizing me. Check
> whether those presses already make the filter better; if not, use them.
> And go: a very small model for voice, pauses and silence, and one trained
> on our "over" data so we stop paying for Jev on turn ends.

- **Before:** the press only ran the words again; nothing learned.
- **Now** (`voiceClaim`, `POST /api/voice/print/claim`): each utterance
  event carries an `id`; its audio is kept ten minutes on the server. A
  press logs the verdict as `claimed: true` in `voice-speaker.jsonl` (with
  the score and the bar it faced: the data to move the bars from) and
  appends the audio to the person's pool (`~/.local/share/chattering/
  voice-claims/<user>.pcm`, 0600). At 20 s of pooled speech the pool (its
  newest 90 s) becomes a print labelled "from your corrections (device)",
  replacing the previous one, kept beside the enrolled prints (four at
  most, the best match counts), and every open listener of that person
  re-reads the prints at once (`voiceListenersByUser`). So the presses
  made next to the mill become a print of him next to the mill. The debug
  line says "kept for a print (12 of 20 s)", a toast says when one is made.
  Test in `test/voice-print-api.test.js`.
- **The small models:** conversation "Voice gate and turn-end models"
  (01a1557e, project myvoice, group frog), with the full brief: Silero VAD
  as the baseline then a model of his speech / pause / noise on 100 ms
  frames running in Node without a GPU, in place of the RMS gate behind a
  setting; and a turn-end classifier trained on the `frog_turn_end` call
  log, the timeline's real outcomes and the hand-over rule, to match Jev
  before it replaces it. Data named there. Needs a restart when it lands.

## Fixed: "…right now, over" only asked about (2026-10-19)

The record: Jev gave "it seems to work well right now over" 0.73 (the
voice filter passed it at 0.46), under the 0.85 bar to send, so the page
asked and the person said "over to you" again 15 s later (0.99). Now two
signals combine (`turnDecision`, `closesWithHandOver`): when a hand-over
phrase closes the words (HAND_OVER) and Jev leans the same way (≥ 0.5),
it is sent; Jev alone still needs 0.85. "The training is over" matches the
phrase too and rests on Jev's low probability, as before. Needs a restart.

Same day, after that restart, in a browser: "so is the restart done now
over" got 0.37 from Jev and was held again (the fix was live; 0.37 is
under the 0.5 the two-signal rule asks). Jev under-rates a lone "over"
after "now" three times in a day. Now the words' own strength counts
(`handOverStrength`): **strong** ("over to you", "your turn", or "over"
after a word that cannot take it as a predicate: "done now over") sends
unless Jev is sure it is not (< 0.15); **weak** ("is over", "it's over",
"take over", "done") sends at 0.5; none: 0.85. The server logs each send
made on the words with Jev's number, the data for the turn-end model to
learn from. Needs a restart.

## Built: the restart script (2026-10-19)

`scripts/restart-chattering.sh [--report <id>] [--delay <s>] [--frog]`:
notes every busy conversation, launches itself as the user unit
`chattering-restart` (the restart cannot end it), waits, restarts only the
`chattering` service, waits until it answers, resumes each conversation
that was busy from the recovery records, checks 15 s later, and with
`--report` wakes the asking conversation to verify. The frog's own
conversation is skipped unless `--frog`. Log: `/tmp/chattering-restart.log`.
Replaces the one-off `scratch/restart-and-resume.sh` (ids by hand).

## Handoff (2026-10-17, for the next conversation)

**The person's latest feedback, in order:** it is the frog, not the
Navigator; pauses must never send (walkie-talkie, "over"); one settable
model, Opus 5.5, for everything but the end-of-turn check (Jev, logged for
a dataset); Kokoro and Parakeet; replies written for the ear (no markdown,
counts before lists); speed 1×, as the read button plays (corrected from
1.25×); talking alone must not
stop it; it must know where it was cut off; other people's words get into
the microphone; asides as above; the frog's voice was not heard on the
phone (fixed in two ways, app release pending); context and fresh starts.

**Built and tested, uncommitted** (nothing of design/102 is committed):
- New: \`frog-assistant.js\`, \`speech-script.js\`, \`extensions/frog.ts\`,
  \`extensions/modes/frog.json\`, tests \`frog-assistant\`, \`frog-extension\`,
  \`frog-server\`, \`frog-stream\`, \`frog-jev-real\` (on request),
  \`speech-script\`, \`screen-sound-gesture\`; this file.
- Changed: \`server.js\` and \`app.html\` (the frog block, \`/api/frog/*\`,
  speech, sound records; both also hold other people's uncommitted work, so
  commit by hunk), \`voice-commands.js\`, \`ai-programs.js\` (Jev programs,
  \`frog_turn_end\`), \`push-policy.js\`, \`push-notify.js\`, \`push-ui.js\`,
  \`policy.js\`, \`extensions/modes.ts\` (also installed at
  \`~/.pi/agent/extensions/modes.ts\`), \`android/…/MainActivity.kt\`,
  \`NotifyService.kt\`, \`vendor/functai/0.1.0/functai.mjs\` and
  \`SOURCE.json\` (the RawNumber patch), \`test/ai-programs.test.js\`,
  \`test/side-panel.test.js\`. Not this work: \`agent-modes.js\`,
  \`test/agent-modes.test.js\`.
- In \`~/Projects/lmcc\`: \`ts/src/core.ts\`, \`ts/tests/order.test.ts\` (the
  RawNumber fix, upstream of the vendored patch), uncommitted, unreleased.
- Research, measured: \`scratch/frog-voice-research/\` (gitignored).
- Chattering needs a restart for each round (\`systemctl --user restart
  chattering\`); never restart it from a turn it hosts.

**Second handoff (the same day, the conversation after "Navigator"):**
built the call (above): new \`android/.../FrogCallService.kt\`,
\`FrogRingActivity.kt\`, \`FrogCallTile.kt\`, \`FrogCallButtonReceiver.kt\`,
\`res/xml/shortcuts.xml\`; changed \`MainActivity.kt\` (CallBridge,
\`current\`, pause skipped in a call, \`ACTION_OPEN\`), \`MicBridge.kt\`,
\`ListenBridge.kt\`, \`NotifyService.kt\` (the \`call\` kind),
\`AndroidManifest.xml\`, \`build.gradle\` (core-telecom, coroutines),
\`strings.xml\`; \`package.json\` androidApp 0.3.12; \`voice-commands.js\`
(the call events, \`frogCallOpen\`, \`voiceStop\` ends Talk), \`push-ui.js\`
(\`talking\`, \`here()\`), \`push-policy.js\` (\`soundScreen\`, the \`call\` kind),
\`server.js\` (here.talking, \`frogNotify\` call), \`extensions/frog.ts\`
(\`notify_person\` call), \`test/screen-sound.test.js\`. Built and signed:
\`dist/Chattering-android.apk\` = \`chattering.apk\` (served at
\`/chattering.apk\`); not published to the GitHub release (the person's
call). Not yet tried on the real phone and headset.

**Third handoff (the same day, the memory conversation):** new
`frog-memory.js`, `test/frog-memory.test.js`, `test/frog-memory-server.test.js`;
changed `server.js` (the memory block after `frogFresh`: `theMemory`,
`frogMemoryWork`, `frogMemoryCompact`, `frogSegment`, `frogMemoryApi`;
`frogRunEnded` schedules a pass; `frogFresh` on the frog itself;
`frogRead` takes `at`), `frog-assistant.js` (`piBranchMessages` `at`),
`ai-programs.js` (`frog_memory_lines`, `frog_memory_merge`),
`extensions/frog.ts` (three tools, `at`), `extensions/modes/frog.json` (the
memory line, three tools), `extensions/modes.ts` and its installed copy
(`FROG_TOOLS`), `app.html` (the `frog-home` event). Needs a restart; the
first pass runs 45 s after it, while the frog is quiet.

**Fourth handoff (the same day, the voices conversation):** new
`speaker/` (service, unit, README), `voice-speaker.js`,
`test/voice-speaker.test.js`, `test/voice-print-api.test.js` (a real
server, stand-in speech and voice-print services: the routes, an enrolment
over the socket, checked utterances); changed `voice-window.js` (`check`,
`onSpeech`; `flushUtterance` async), `server.js` (the `voiceSpeaker` block
after the `VoiceWindow` require, `speakerUrl`, the `speaker` capability,
`/api/voice/print`, the enrol frames in `voiceListenUpgrade`),
`settings.js` (`speakerUrl`), `app.html` (the field), `voice-commands.js`
(the `speaker`/`enrol`/`enrolled` events, skipped entries with *It was
me*, the *only my voice* settings block), `voice-commands.css`. Research
in `scratch/frog-voice-research/` (README, `fetch_ami.py`, `bench_ami.py`,
`embed_ami.py`, `bench_policy.py`, `bench_switch.py`, `e2e_window.js`);
data and a throwaway venv in `/mnt/fast/frog-voice/` (home was at 96%).
The service is a Home Manager user unit on lambda since 12:48:
`~/Projects/os/machines/hm/chattering-speaker.nix` (`chattering-speaker.service`,
:8079, GPU 1; deployed, commit b07e482); `speakerUrl` is already written
in `~/.config/chattering/settings.json` for the restart. For the phone conversation: one
`@JavascriptInterface fun sendText(json: String)` on `ListenBridge` that
writes a text frame to its socket would let the app enrol too. Seen while
testing, not mine: `test/fresh-install.test.js` fails on this tree because
`ensureFrogMode` writes `notes/frog/mode-installed.sha256` at startup, and
`notesHaveData()` then counts a fresh home as a prior install (legacy
defaults get applied).

**Next, in the order the person has been leaning:**
1. The real phone: install 0.3.12, a talk with the headset in the pocket;
   if the voice does not reach the headset, the native-playback fallback
   (stated above). Publish 0.3.12 if he says yes.
2. Speed (part 3, "speed first"): shrinking old tool steps was built and
   measured, and did not help at ~200k (off; see there). The levers that
   remain: a lower thinking level while talking, keeping the cache warm
   during Talk, the first sentence before any tool. Memory: built (above,
   "its memory"), needs a restart; then watch the first pass in the server
   log (`[frog] memory:` lines) and `GET /api/frog/memory`.
3. Voices: built ("only my voice" above). To use it: start the service,
   set its address, record the voice on each device, switch it on; then
   watch the debug view for a day and set the bars from the person's own
   scores. Tiron for voices overlapping at the same moment: not built.
4. Smaller: "say that again" from the ledger (\`/api/frog/spoken\`), the
   board (part 5), other people's frogs; a real phone number (B) only if
   the app cannot be used somewhere.

## Fixed: replies that were never read aloud (2026-10-18)

> Sometimes your text doesn't read out to me. Your last three messages, on
> the laptop, didn't come out. I had a message at the same time and said
> "over"; I think because of my message they were cut.

**The record** (the frog's session, the `[sound]` lines, 19:18–19:20
local): the frog said "Finding that idea." (heard), then ran tools for
twenty seconds. The person's question was sent while they ran, so
Chattering queued it into the running turn (Pi's follow-up: it was
appended 2 ms after the frog's message ended, in the same run). From then
on the server logged "The frog → the voice session" for every piece and
sent none: "Found it: put the list before the paper…", "I queued it in
Comparison…" and the answer to the question itself were silent. Three
replies on screen, none heard, and no "over" cue.

**Why.** The frog's speech was recorded on one ledger per run. A message
to the frog cancels the ledger (`frogNewTurn`: what it was saying stops,
by design), but a queued message does not start a new run: the same run
went on, found its ledger cancelled, and dropped every later piece. The
same happened to the part after the tools whenever a message arrived
during them.

**Now.** A ledger is one message of the frog, not one run (`frogSpokenFor`:
the run's id, then `run#2`, `run#3`…, which is what the pages see and
report back). A cut still silences the rest of the message being said; the
frog's next message in that run is new words and is spoken, with its
"over" after it. `frog-cut` names the ledgers it cut, and the page stops
only those (a piece of the next words already on its way is not swept).
Also: after its tools, the first sentence of the answer is spoken as soon
as it ends, as the words before the tools were (it waited for a paragraph
break or the message's end). The log says when pieces were not spoken
because the message was cut off, instead of naming a destination nothing
went to. Test: `test/frog-speech-ledger.test.js` (the server's own code,
the incident replayed; fails on the code before).

**Limits, stated:** a message queued into a running turn gets no
`before_agent_start` in Pi, so the frog does not receive the cut note or a
fresh workspace note for it (it reads them at its next proper turn). The
"frog, stop" meaning changed the same evening in the Woven conversation
(held and resumable, the rest still made); this fix does not decide that.
Needs a restart to take effect.

## Decisions still open

1. Voices: built as "only my voice" (above), behind a setting; the
   service is a lasting unit and its address is set, so after the restart
   only the recording remains. Open: Tiron for voices overlapping at the
   same moment (not built).
2. Memory: built (OptMem's design rebuilt). Open: the kept turns (8) and
   the budget (64 lines), to set in `~/notes/chattering/frog/memory/config.json`
   once heard in use.
3. Publish Android app 0.3.12 to the GitHub release (it is built, and
   served by this computer)?

## Built: two small models for the listener (2026-10-19, from the myvoice conversation)

> Build a voice-activity model that tells my speech from pauses and from
> noise, and a turn-end model that says whether what I just said hands the
> turn over, so Chattering stops paying Jev for that check.

Both live behind settings (Settings → sound → voice services), off by
default; nothing changes until they are switched on. Built and measured in
`~/Projects/myvoice` (`myvoice/vad/`, `myvoice/turnend.py`; its README has
the full tables). Not yet tried by the person.

**The microphone gate** (`voice-vad.js`, weights `models/voice-vad.json`,
764 KB; `voice-window.js` `gate`, `isSpeech`, GATE_ON 0.4 / GATE_OFF 0.2):
a 34k-weight network (log-mel, two small convolutions, a GRU across frames)
that gives each 100 ms frame a probability of being Maxime's speech, a
pause (his channel's quiet) or noise. Plain JavaScript, no native module:
0.4–0.7 ms a frame on one loaded core (the test demands under 2). Trained
from his recordings (2,700 laptop clips, his Chattering utterances) with
Silero VAD as the teacher for which frames are speech, mixed at random
levels with the mill's own sound (the mill-only stretches of half the mill
clips), DEMAND environments and AMI meeting voices. Measured on the real
clips with Silero's labels as truth (checked by eye on spectrograms of 11
clips; Silero itself never flagged the mill):

| set | gate | mill frames taken as speech | missed speech | utterances closed ≤ 1 s after the last word | split mid-utterance | never opened |
|---|---|---|---|---|---|---|
| mill, held-out half (11 clips) | energy (today) | 64% | 3% | 6/19 | 0 | 0 |
| | model | 3% | 6% | 19/19 | 0 | 0 |
| his Chattering utterances, no mill (104) | energy | 61% | 5% | 81/117 | 1 | 0 |
| | model | 5% | 1% | 106/111 | 2 | 6 (one- to three-frame blips, and three "over"s at RMS 43–179) |
| clean laptop test clips (459) | energy | 15% | 1% | 432/460 | 0 | 0 |
| | model | 4% | 3% | 452/456 | 0 | 4 (blips, one "No.") |

Silero VAD itself is the better model (it is the truth here, so its row
means nothing; by eye it is clean on every mill clip) and would be the
choice if Chattering shipped onnxruntime-node (a native module, platform
binaries). The tiny model is what runs without it; a v3 trained for
quieter speech caught the quiet "over"s but took one loud mill burst as
speech, so v2 is the one shipped.

**The end-of-turn check** (`frog-turn-end.js`; `server.js`
`frogTurnEndLocally`): a rule set, not a network. The 371 recorded Jev
decisions were read against the frog's HAND_OVER regex: they agreed on
354; the 17 others were labelled by hand (four left ambiguous). Jev's
misses were long sentences ending in "over" (0.16–0.47, the person said
"over" again each time, seven cases); the regex's misses were closing
words inside a sentence ("I want it to be done", "start over", "is done",
"it will come to you"). The rule set keeps the closing phrases, excludes a
closing word after a word that makes it part of the sentence, takes a
sentence break before it as a cue ("still to do? Over."), and maps the
recognizer's garbled "over do you" / "over you" to "over to you". On the
record: 367/367, Jev 360/367, the regex 359/367; on "over"/"done" inside
sentences 9/9 (Jev 9/9, the regex 5/9). Stated plainly: the rules were
written after reading all 17 disagreements, so that number is the fit, not
a held-out test; the real test is the coming days of use, and
`python -m myvoice.turnend` rescoring the growing log. Probabilities are
the category shares (0.98 cue, 0.08 in a sentence, 0.01 none), so the
frog's thresholds (`turnDecision`) read them as they read Jev's. Each
decision is appended to the FunctAI call log as `frog_turn_end`, kind
`code`, version the file's hash, with its reason, so the Programs page
lists it beside Jev's and takes ✓/✗ (`programs.js` `appendCall`).
Text only: the record holds too few in-sentence cases to train prosody on.
0.02 ms a decision.

**Tests:** `test/voice-vad.test.js` (the JS front end and network against
the training side's NumPy reference on real clips, to 1e-3; speed; the
mill clip followed by four seconds of the mill alone closes within 1 s
and the energy gate does not; a clean clip opens on the first words and is
not split; a model that throws hands back to the energy floor),
`test/frog-turn-end.test.js`, and in `test/frog-server.test.js` the local
path over the real server with the log record and the Programs listing.

**Seen on the way:** the Woven conversation is adding `handOverStrength`
(a strength of the closing words that moves Jev's send threshold) at the
same time; it covers the same ground as the rule set from the Jev side.
With the local setting on, the rule set's probabilities go through that
`turnDecision` unchanged (0.98 sends at any threshold, 0.08 at none).
One of the two should lead; the person's call. `test/frog-server.test.js`
fails today at "the unsure cue" ("that is the plan, maybe over") from that
in-flight change, before the local block is reached.

**Needs a restart** (server: the settings, the gate, the local check) and
a page reload (the two checkboxes). The listener takes the gate when it
opens: a listener already open keeps its gate until it reconnects.
