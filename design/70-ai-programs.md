# 70 — AI programs in Chattering (proposal)

Status: proposal, 2026-09-26. Nothing here is built. It depends on FunctAI
(Python 1.0.1 exists; TypeScript is being written) and extends the Program
Atlas mockup (`design/program-atlas.html`, fictional data).

## The idea in one line

An AI program is a first-class thing in Chattering, like a conversation or a
notebook: you can see what it is, every time it ran, say 👍 or 👎, and those
ratings become the data that measures and improves the next version. The same
program can then be called from a notebook, an agent, a keyboard shortcut, or
by a colleague through a company install.

## What FunctAI already gives (read in `~/Projects/functai`, 2026-09-26)

- **A program is a typed function.** `@ai def team(message: str) ->
  Literal[...]`: name, docstring and types are the contract; lmcc writes the
  prompt and reads the reply back through the same template; lm15 sends it.
- **Free inspection.** `fn.render(...)` builds the exact request without
  sending it; `explain()` and `signature_text()` describe the layout.
- **Measurement on plain rows.** `evaluate(fn, rows, expected=...)` gives a
  score with a range and a table with one row per example (prediction, score,
  error, seconds, tokens). `compare(before, after)` pairs the rows: better,
  worse, and a range for the difference.
- **Improvement ladder.** Rules in the docstring, tighter types, examples,
  `fn.opt(trainset=...)` (keeps runs that were right as worked examples),
  `fn.using(lm=...)` for another model, `fn.bake(...)` to train a small model
  with calibrated probabilities and an escalation threshold.
- **A portable unit.** `check` → `save` → `verify` → `load`. The saved folder
  holds `functai.json` (each node's typed field shapes, instruction, examples,
  **signature and request fingerprints**, probes), `code/`, a pinned
  `requirements.lock`, optional `recordings.json`. Keys are never saved.
  `load` runs code, hence `trust=True`.
- **Honest failure.** `Refusal` codes, repairs listed on the prediction,
  `LoginRequired` that never switches to a paid key, `StepLimit`.
- **The gap.** Call history is an in-memory deque of 500 `CallRecord`s
  (`engine.py`): function name, model, lm15 request/response, cache flag,
  error, time. Nothing persists, there is no run id, no parent/child link for
  modules and tool loops, and no link to which version of the program ran.

## Principles

1. **FunctAI defines what a program is; Chattering stores and shows it.** No
   second signature system inside Chattering. Chattering's own 26 model calls
   move to FunctAI TypeScript instead of a Chattering-only wrapper.
2. **rat computes** (design 63). Evaluation, optimization and baking run in
   rat kernels, from small notebooks the person can read and rerun. Chattering
   does not embed a Python evaluator.
3. **Recording is the product, and it is chosen per program:** full content,
   shape only (sizes, timings, tokens, fingerprints), or off.
4. **Every number says how its rows were chosen.** Rated runs are not a random
   sample; a score is only computed on a set drawn for that purpose.
5. **Local first.** The company hub is the same install with more people
   (designs 46, 52, 69), not a second product.

## The one piece to agree now: the run record

This is the only part that blocks everything else, and it belongs in FunctAI
while the TypeScript port is being written, so Python and TypeScript emit the
same thing from day one. A JSON Schema plus fixtures in the FunctAI repository,
checked by both implementations (the lm15-contract pattern).

One record per program call (a module or tool loop produces a tree):

| field | content |
|---|---|
| `run_id`, `parent_run_id`, `root_run_id` | UUIDv7 (time-ordered); a module's inner calls and each tool step are children |
| `program` | qualified name (`module:name`), language, FunctAI version, `signature_fingerprint`, `request_fingerprint`, `saved_version` (hash of the saved folder, when loaded from one), source location (file, notebook path and cell, line) |
| `inputs`, `outputs` | typed JSON per field, shaped by the signature; or `error` `{code, message}` (`Refusal` code, `LoginRequired`, `StepLimit`, provider error) |
| `calls[]` | each model request/response in lm15 canonical JSON (retries and tool steps included), model, provider, usage, duration, `cached`, `repairs`, `probabilities` |
| `caller` | kind (`notebook`, `script`, `conversation`, `agent`, `api`, `shortcut`, `schedule`), user, host, conversation key or notebook path |

**Delivery: an append-only JSONL spool file**, not HTTP from inside the call.
`functai.configure(record=...)` takes a callable or a path; the environment
variable `FUNCTAI_RECORD=<dir>` turns it on, and rat/Chattering set it for the
kernels and workers they start. Chattering tails the spool and indexes it.
Why: no network in the hot path, nothing slows or fails the call, and records
survive a crash or Chattering being closed. Trade-off: the spool is local to
one machine; remote hosts need the sync path of design 52 to bring runs home.

**Why not OpenTelemetry's GenAI conventions as the primary format.** They are
the industry standard for tracing model calls, and Langfuse, Arize Phoenix and
Datadog read them. But capturing message content is still opt-in and marked
experimental there, and they have no place for typed signature fields,
fingerprints or corrections, which are the whole point here. So our record is
primary and an OpenTelemetry exporter is a later add-on for companies that
already run an observability stack.

## Where it appears in Chattering

1. **Right panel → Programs**, beside Files and Artifacts, with the same
   All / Project switch (design 67). One row per program: name, signature on
   one line, runs today, runs waiting for review, current version.
2. **The program page** (main view; the Atlas mockup made real):
   - *Runs* — the input → output table, filterable by caller, model, version,
     user, rating, error, confidence; each row opens the full exchange in the
     existing transcript reader, with 👍 👎 on every row.
   - *Review* — a queue: 👎 without a correction, lowest-confidence runs
     first when probabilities exist, and "draw 20 random runs to rate".
   - *Compare* — versions or models on the same rows, with FunctAI's paired
     numbers (better, worse, range).
   - *Data* — datasets built from ratings and imports, with a fixed learn /
     judge split.
   - *Contract* — signature, instruction, the prompt for any input (`render`,
     free), the `check` report.
   - *Use* — how to call it: Python, TypeScript, HTTP, notebook cell,
     shortcut binding.
   - *Settings* — recording level, retention, who may call and see runs, which
     account pays, budget.
3. **In notebooks.** The strip under the editor (design 41) lists this
   notebook's runs with 👍 👎. Later, each AI call's output gets a footer
   (`team · v3 · gpt-4.1-mini · 0.4 s · 👍 👎 · open`); that needs the run id
   to reach the output renderer through rat and MRMD's output registry
   (design 63), so the strip comes first.
4. **In conversations.** A chip on a tool call that produced runs: "▸ 3 runs
   of team". A Pi extension offers published programs to agents as tools;
   their calls carry the conversation key.
5. **In the inbox** (design 50): "Needs review" for 👎 runs without a
   correction, and a new version waiting for its comparison.
6. **On Chattering's own outputs.** Conversation titles, notes and project
   overviews get a small 👎 / ✎. A manual edit is recorded as a correction:
   renaming a conversation is a labelled row for the title program. The row
   shows it came from an edit, and it can be excluded.
7. **Everywhere else**: the command palette ("Run program…"), `chattering run`
   on the command line, and keyboard shortcuts.

## 👍 and 👎, built from the types

- 👍 means *right for this input*, not *nice*. It makes the output a label.
- 👎 opens a correction form generated from the output type: a choice for
  `Literal`/`Enum`, a toggle for `bool`, a number field, one control per field
  of a dataclass, text for `str`. Optional reason tags (the error kinds of the
  Atlas: invented decision, missing item, wrong scope…) and a note.
- A correction is a labelled row, and FunctAI's `evaluate` and `opt` take
  plain rows, so nothing is converted.
- Ratings are per person. When two people disagree, both are shown, not
  averaged.
- Keyboard review: `j`/`k` move, `1`/`2` rate, `e` edit. Fifty runs should
  take minutes.

## The improvement loop

use → rate → dataset → evaluate → try something → compare → publish → use.

Each step is a button that generates a small notebook, runs it through rat,
and stores the result (the evaluation table as Parquet plus one summary row):

- **Evaluate** the current version on the judge set.
- **Try models** (`using`), with cost per 1,000 calls from the price tables
  Chattering already keeps.
- **Improve from rated runs** (`opt`): 👍 runs become worked examples.
- **Bake** (only for fixed-answer outputs with enough labelled rows): train a
  small model on lambda's GPUs; show the report and the escalation threshold.
- **Publish** only when the comparison's range excludes zero, or with an
  explicit override that is written down.

## Local helpers: the clipboard

- `chattering run fix-grammar --clipboard` reads the clipboard, calls the
  program, writes the answer back, and shows a notification. The previous
  clipboard content is kept so one key undoes it.
- A clipboard program is any program with one text input and one text output
  (or a declared mapping). Examples: fix grammar, translate FR↔EN, notes → a
  polite email, pasted text → a CSV table, redact names.
- **Shortcuts are the operating system's job, declared, not grabbed.** Wayland
  does not let an app take global keys: on this machine the binding goes in
  the desktop repository's Hyprland config; GNOME and KDE use the
  GlobalShortcuts portal; macOS and Windows use the native shell (design 62).
- **Privacy.** Clipboards hold passwords. Clipboard programs record shape
  only by default, refuse inputs that look like secrets (the existing
  redaction rules), and can be pinned to a local model on lambda so the text
  never leaves the house.
- **Speed.** Starting Python costs a second or more before the model is even
  called, which feels broken on a shortcut. Chattering keeps a warm runtime: a
  Node worker for TypeScript programs (the fastest path, and a concrete reason
  FunctAI TypeScript matters), a warm rat kernel for Python ones.

## Hosting for a company

- **A published version is a saved FunctAI folder**, identified by its hash,
  and it must pass `verify` in a fresh environment, replaying recordings taken
  from 👍 runs, before it can be published.
- **Channels** (`dev`, `live`) point at versions. Rollback moves the pointer.
- **Calling**: `POST /api/programs/<name>/run` with a caller token, client
  snippets, the agent tool, shortcuts, notebooks. Every call records who.
- **Who pays** is chosen per program: the owner's account and budget, or the
  caller's own. Personal subscriptions (Claude, ChatGPT plans) must not serve
  other people; that very likely breaks their terms. Shared programs need API
  keys or a company account. FunctAI already refuses to switch keys silently.
- **Isolation.** A saved program is arbitrary code. Each version gets its own
  environment from its lock file and runs in a sandbox (the guest sandbox's
  systemd scopes on Linux, a container on a hub) with CPU, memory, time and
  network limits, never inside Chattering's process. Chattering's own shipped
  programs are the only exception.
- **Permissions.** Viewing runs (which can contain customer data), calling,
  rating and publishing are separate rights on top of the existing roles.
  Every new route goes through the closed-by-default policy (design 69), and
  live updates must be filtered per recipient first (an open todo today).
- **Observability** per program: calls per day, error rate, p50/p95 latency,
  tokens and cost, 👎 rate, and drift (the answer distribution this week
  against last week, the classic early warning for classifiers). Every point
  on a chart opens the runs behind it.
- **Retention**: full content 30 or 90 days, metadata longer, set per program.

Honest sequencing: a hub needs the team identity and storage model that
design 46 deferred and that the project status still lists as open. Hosting
comes last.

## Storage

`node:sqlite`, like `files.db`, `search.db` and `usage.db`, but in
`~/.local/share/chattering/programs.db` plus a `programs-blobs/` folder, **not
in `~/.cache`**: ratings, corrections and datasets are a person's work and
cannot be rebuilt, unlike the other databases, which are derived.

| table | holds |
|---|---|
| `programs` | id, qualified name, project, owner, visibility, recording level, retention |
| `versions` | id, program, saved-folder hash or signature fingerprint, manifest JSON, source (path, notebook, git commit), status (seen, verified, published, retired), verify report |
| `channels` | program, name, version, moved by, when |
| `runs` | run id, parent, root, version, caller kind, user, host, conversation or notebook link, started, duration, model, provider, tokens, estimated cost, status, error code, input / output / exchange blob hashes, max confidence |
| `blobs` | sha256, size, compressed bytes (large inputs such as transcripts are stored once) |
| `feedback` | run, user, rating (+1/−1), correction JSON, reason tags, note, source (click or implicit edit), time; one per user and run |
| `datasets`, `dataset_rows` | name, program; input, expected, origin (feedback, import, manual), split (learn / judge) |
| `evaluations` | version, dataset, metric, score, low, high, Parquet table path, notebook path, time |

Indexes on `runs(program, started)`, `runs(root_run_id)`, `feedback(run)`.
Datasets export to JSONL and Parquet so `dpyr.read` takes them directly.

## Which language

- **A one-call program is data, not code**: instruction, typed input and
  output shapes, template, examples, model settings. All 26 of Chattering's
  own programs are of this kind. lmcc's signatures and adapters already have
  one plain-data form that the Python and TypeScript kernels read identically
  (lmcc `ts/README.md`, kernel 0.8.4). Store such a program as one JSON file:
  Chattering runs it in TypeScript, a Python notebook evaluates and improves
  it, and the improved examples are written back to the same file.
- **Only programs with code of their own** (tools, multi-step modules) belong
  to a language, and are saved as FunctAI folders in that language.
- **TypeScript for running inside Chattering**: same runtime (Node), no
  Python to ship with the desktop installers (design 62), instant start for
  shortcuts. The packages ship JavaScript, so Chattering stays plain JS.
- **Python for measuring and improving**: `evaluate`, dpyr tables and baking
  (torch, GPUs) stay there; they are not worth rebuilding in TypeScript.
- **TypeScript's types disappear when the code runs**, so FunctAI TypeScript
  cannot read `Literal[...]` the way Python does. Shapes must be values (lmcc's
  `t.*` builders, which also give the static type), not annotations alone.
- **Cost**: two FunctAI implementations must agree; they need a shared corpus
  of fixtures, as lm15 and lmcc have.

## Chattering's own 26 programs

Port them to FunctAI TypeScript when it is ready; the signatures are already
listed (Program Atlas). Start with the conversation title: small, frequent,
and it has implicit labels (manual renames). Before switching any of them,
confirm the Claude and ChatGPT subscription logins work through lm15, so no
call quietly moves to a paid key. The speech programs keep their separate
local model.

## Phases (each useful alone)

0. **Run record contract** in FunctAI, Python implementation plus the JSONL
   spool; the TypeScript port adopts it as it is written.
1. **Programs panel and program page**, read from the spool: Runs, Contract,
   👍 👎 with typed corrections, the notebook strip.
2. **Chattering's own programs on FunctAI TypeScript**, title first, with
   implicit corrections.
3. **Datasets, Evaluate, Compare, Try models, Improve** through rat notebooks.
4. **Triggers**: `chattering run`, clipboard shortcuts, the agent tool, HTTP on
   one's own machine.
5. **Company hub**: publish, verify, channels, sandboxed runtimes, permissions,
   budgets, dashboards, baking on GPUs.

## Decisions for Maxime

- **D1 — Recording path.** JSONL spool (recommended) or HTTP to Chattering.
- **D2 — Default recording level.** Recommended: full on your own machine,
  shape only for clipboard programs, chosen explicitly per program on a hub.
- **D3 — Who pays on a hub.** Owner, caller, or per program (recommended).
- **D4 — 👍 means correct.** Recommended yes; no separate "nice" rating.
- **D5 — Notebook footer.** Accept the strip first, the per-output footer
  when rat and MRMD can pass a run id.
- **D6 — Name in the interface.** "Programs", "AI programs" or "Functions".

## What would change this

- A company that already runs Langfuse or Datadog: the OpenTelemetry exporter
  moves up, and Chattering becomes the rating and improvement layer on top.
- FunctAI TypeScript taking longer: phases 0, 1 and 3 work with Python alone;
  only phase 2 and the fast shortcut path wait.
