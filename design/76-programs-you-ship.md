# 76 — AI programs you make, run, and take anywhere

Status: proposal, 2026-09-28. Builds on design/74 (AI programs: see, judge,
live). Nothing here is built yet. Decisions for Maxime at the end.

## The job

*When I notice a task a model could do for me again and again, let me turn
it into a dependable service in minutes, call it from anywhere — my scripts,
my phone, the internet — and keep seeing whether it is right, wherever it
runs.*

Hired instead of: a script with a prompt pasted in, an n8n "ChatGPT" step, a
custom GPT, copying into a chat window, or a small hand-written web service
around a model. None of these says whether the answers are right, none makes
a change of prompt measurable, and the hand-written service is code to host
and keep alive.

Who and how:
- **Maxime, from his own things**: a git hook asks for a commit title; a phone
  shortcut turns a voice note into to-dos; a home automation asks whether a
  camera description shows a person at the door.
- **Family, with no code**: "check my French sentence", made from one
  sentence, used from a form on a phone.
- **Agents**: a conversation needs a repeatable step (sort, extract, decide)
  and uses a program instead of improvising a prompt each time.
- **Anyone on the internet**: a small public service (a form on a website,
  an API a friend's app calls) that Maxime made and watches.
- **A program that outgrows the machine**: downloaded and run on a server
  elsewhere, and still judged from Chattering.

## The one idea: one artifact, any host

What you build is a **FunctAI saved program**: the folder FunctAI already
defines (`functai.json` + `code/` + `requirements.lock` + `files/`,
functai `contract/saved.md`). What serves it over HTTP is **FunctAI's own
server** (`functai serve <folder>`), defined by a new FunctAI contract,
`contract/serve.md`, so Python and TypeScript serve the same way.

Chattering runs that same server for the programs it hosts. A server
elsewhere runs it too, from the same folder. So "it works in Chattering"
means "it works when downloaded", by construction: there is one runtime,
not a Chattering one and an export.

Rejected: an endpoint implemented inside Chattering (the first sketch). It
would need a second implementation for external servers, and the two would
drift; it would also lock programs to Chattering.

Chattering's roles:
- **studio**: create, edit, try, judge, compare (design/74 pages, plus edit);
- **registry**: versions (a saved folder, named by its hash), channels
  (`live`, `draft`), publishing, rollback;
- **host**: runs the server of each published program, sandboxed, behind
  keys, limits and budgets; privately or on the internet;
- **observatory**: reads the call log of its own hosts *and* of external
  deployments, so every answer, wherever it ran, can be judged in the same
  place.

## Two kinds of program, one page

1. **One step** (an AI function: instruction, typed inputs and outputs,
   examples). Data only, runs in any language. Made with a form.
2. **Several steps, tools, code** (a FunctAI module: code that calls AI
   functions, tools the model may call, ordinary functions, packages). Made
   as code in a project, by a person or an agent. **Python first**: FunctAI
   saves code, tools, requirements and a lock file only in Python today
   (TypeScript saves AI functions alone; `saved-code` refusals). TypeScript
   programs with code need a FunctAI change (a bundled `code/` for
   TypeScript) and come later.

Both show on the same program page. A program with steps also shows its
**map** (from `functai.check`: its AI steps, tools and code), and each AI
step is a program of its own, with its own examples to judge. That is how a
multi-step program is debugged: which step was wrong. The live view (design/74)
then shows the whole tree of a call — steps and tool calls as they happen —
rather than only the outer call.

## The experience

1. **New program.** "What should it do?": one sentence and two or three
   examples (input → what it should answer). Then either
   - *one step*: Chattering drafts name, inputs, outputs (text, number,
     yes/no, one of a list, a record, a list) and instruction; you edit
     them as fields;
   - *several steps or tools*: Chattering writes a starter
     `programs/<name>/program.py` in the project (the AI functions, the
     module, tool stubs), opened in the editor, or asks an agent to write it
     from the description.
2. **Try.** A panel beside the editor: an input, and the answer live —
   for several steps, each step and each tool call appears as it happens.
   ✓ / ✗ with the right answer: each becomes the **answer key**.
3. **Publish.** One button runs, in order, and shows each result:
   - `check` (the graph, problems),
   - `save` (the saved folder: the version),
   - `verify` in a fresh environment built from the lock file alone (code
     programs; the proof that it will run elsewhere),
   - the answer key on this version, beside the current live version
     (design/74 *Compare versions*).
   Publishing a version that got worse asks for a reason, which is written
   down.
4. **Where it runs** — three choices, any combination:
   - **Here, private**: your devices on your Tailscale network, and people
     you give a key.
   - **Here, on the internet**: a public address (below).
   - **Somewhere else**: *Download* gives the folder as a zip, with a
     `Dockerfile`, a `README` (three commands), `.env.example` naming the
     model and the keys it needs, and `tests/answer-key.jsonl`, so the
     server it lands on can prove it answers like it did here.
     Later: *Deploy to…* (a provider) does the same through its API.
5. **Use.** A card per address: the URL, keys (shown once, revocable, last
   used), limits, and snippets (curl, Python, JavaScript, a phone shortcut).
   A browser opening the address gets a form; a script gets JSON.
6. **Watch and improve.** Calls from every host land in the examples, live
   for this machine's hosts, within seconds for external ones, marked by
   where they ran. Judging grows the answer key. Editing makes a draft;
   `live` changes only on publish; rollback is one click.

## The server contract (FunctAI `contract/serve.md`)

```
GET  /               what it is: name, version, inputs and outputs (JSON Schema),
                     examples; an HTML form when a browser asks
POST /               {"message": "I was charged twice"}
                     → {"result": "billing", "outputs": {...}, "version": "sha256:…", "call": "01a0…"}
                     Accept: text/event-stream → the events of contract/streaming.md, then the result
GET  /openapi.json   generated from the signature
GET  /health
GET  /_functai/calls?after=<id>   the call log, for an observatory (admin key)
```

- Inputs are checked against the signature before any model is called
  (`400`, naming the field). An unreadable reply after FunctAI's re-ask is
  `422` with lmcc's refusal code; a provider failure `502`; limits `429`;
  a spent budget `402`.
- Keys: bearer keys, stored hashed (`FUNCTAI_SERVE_KEYS` or a keys file),
  one admin key for `/_functai/*`. An open program (no key) is a choice
  that has to be made explicitly.
- The server writes FunctAI's call log as any FunctAI program does
  (`caller: {kind: "endpoint", key: <key name>}`).
- The same contract in Python (`python -m functai serve`) and TypeScript
  (`npx functai serve`); test cases in `contract/cases/serve/`, as for every
  other FunctAI contract.
- Later, from the same description: an MCP server, so any agent can use a
  program as a tool.

## Hosting here

- **One-step programs** run inside Chattering (the TypeScript server as a
  library, mounted at `/programs/<name>`): no code, nothing to wall off,
  fastest.
- **Programs with code** run one server process per published version, in
  the bubblewrap sandbox guests already run in (`sandbox.js`, design/53):
  the program's folder read-only, its own environment built with `uv` from
  its lock file, an empty home, no SSH keys, no model keys, CPU, memory and
  time limits through its systemd scope. Started on first call, stopped
  after a quiet while.
- **Models, from inside the sandbox**: through Chattering's key proxy
  (design/53: the program holds placeholders, never keys), and for private
  programs optionally through a local model gateway backed by Pi, so they
  can use your sign-ins (subscriptions).
- **Keys, limits, budgets** are checked by Chattering's gateway before a
  request reaches a program: per key a rate and a monthly spend, per
  program a monthly spend (design/72's budgets, for programs).

## On the internet

- **Here**: Tailscale Funnel on lambda, pointed at a separate listener that
  serves only program addresses — never the Chattering app, its API or its
  sign-in page. Nothing else becomes public.
- **Elsewhere**: the downloaded folder on any server (a VPS, Fly.io, Cloud
  Run, a company's machines).
- **A public program must**: be billed to an API key, not a personal
  subscription; have a rate limit per key and per address and a monthly
  budget; cap input size; declare which of its tools act on the world
  (send, write, pay) — a public program with such a tool needs an explicit,
  per-tool yes, because anyone's input can steer it (prompt injection);
  choose what its log keeps (values, to judge; or sizes only) and for how
  long.

## Judging calls from elsewhere

Chattering *pulls* an external deployment's calls: *Connect a deployment*
takes its address and admin key, then reads `/_functai/calls` every little
while into its log folder (`remote/<deployment>/…`), where the index reads
them like any writer's. Pull, not push: the server needs no route to a home
machine behind Tailscale, and Chattering being off loses nothing (it reads
from where it stopped). Ratings stay in Chattering's log.

## Versions, models, money

- A version is the saved folder's hash: instruction, steps, code, tools,
  examples. **The model is not part of it** (FunctAI's rule), so the same
  version can run on your subscription here and on an API key elsewhere.
  Changing the model is checked like changing the prompt: the answer key on
  the new model before it goes live.
- Personal subscriptions (ChatGPT, Claude plans) serve only you and your
  household's private calls. Anything public, or downloaded, names an API
  key account. FunctAI already refuses to switch to a paid key on its own.

## Phases (each useful alone)

1. **FunctAI serve**: the contract, the Python server, the TypeScript
   server for one-step programs, the download layout (Dockerfile, README,
   `.env.example`, answer key). In the FunctAI repository.
2. **Chattering: one-step programs** — New, Edit, Try, Publish, private
   hosting with keys, Download.
3. **Programs with code** (Python): starter file, map of steps, live tree
   of steps, publish with verify, sandboxed hosting.
4. **Connect a deployment**: external call logs, judged here.
5. **On the internet**: the Funnel listener, limits, budgets, tool
   declarations, log retention.
6. Later: TypeScript programs with code, *Deploy to…* providers, MCP.

## Decisions for Maxime

- **D1 — The server belongs to FunctAI** (recommended), so every host runs
  the same thing. It means work in the FunctAI repository first.
- **D2 — Code programs in Python first** (recommended): FunctAI saves code
  only in Python today.
- **D3 — Public from lambda through Funnel, program addresses only**
  (recommended for household scale), plus download for anything that must
  stay up when the house is offline. Or: public only through download.
- **D4 — Public means an API key**, never your subscription. Hard rule.
- **D5 — Calls from elsewhere are pulled** by Chattering (recommended).
- **D6 — Tools that act on the world need a per-tool yes before a program
  goes public** (recommended).
