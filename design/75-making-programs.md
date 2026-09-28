# 75 — Making AI programs, and giving them an address

Status: built 2026-09-28. Extends design/74 (AI programs: see and judge,
live), whose "Hosting for a company" section this is the first, household
step of.

## The job

*When a small task a model could do comes up again and again, let me turn
it into a dependable little service in a few minutes, call it from
anywhere, and see whether it is getting it right.*

What people use today: a script with a prompt pasted in, an automation
tool's "ChatGPT" step, a custom GPT, or copying into a chat window. None of
them says whether the answers are right, and changing the prompt is a
guess. Chattering already had the second half (every answer seen, judged,
sampled, versions compared); this adds the start (making a program) and the
end (calling it from outside).

Who and how:
- **The owner, from their own things**: a git hook ("a commit title for
  this diff"), a phone shortcut (a voice note → a to-do list), a home
  automation ("is there a person at the door in this description?").
- **The family, without code**: "check my French sentence", made from one
  sentence, used from its form on a phone.
- **Agents**: a repeatable classification step, made or called with
  `chattering program …` instead of a prompt improvised each time.
- **Later, a team**: the company hub of design/74.

## What was built

### Making one (AI programs → New program, `#program-new`)
1. **Say it.** What it should do, and a few examples (what goes in → what
   should come out).
2. **The draft.** A Chattering program, `program_draft`, writes FunctAI's
   definition from that: a name, the instruction, the inputs, the answers
   and their kinds (text, number, whole number, yes/no, list, one of a few
   answers), and the examples rewritten in the program's own inputs. It is
   told not to copy the examples into the instruction: they become tests,
   and a test it was handed the answer to proves nothing. Everything is
   shown as fields to edit; nothing exists yet. "Start from a blank
   program" skips the draft.
3. **Make it.** Its folder is written (below), and it answers each example
   once. An answer equal to the expected one (text ignoring case and the
   space around it) is judged right; a different one is judged wrong with
   the expected answer as its correction, except free text: other words can
   be as right, so it waits for a person, the expected answer kept with the
   call (`caller.expected`) and shown when the example is opened. So the
   answer key starts with the examples.

### A made program's page: two more tabs
- **Edit.** The definition on the left, saved as you type (700 ms after the
  last change) to its folder; what is live does not change. A bar says
  where things stand: not published / the draft is what is live / live is
  v2, the draft differs — with **Publish**. On the right:
  - **Try it**: a form from its inputs; the answer written as it comes;
    ✓ right / ✗ wrong with "what should it have said?" (the allowed answers
    as buttons). Judged tries join its answer key.
  - **Test the draft**: every example whose right answer is known *for the
    draft's inputs and answers*, run on the draft (three at a time),
    as dots filling, then "7 of 10 right · 2 in other words · 1 wrong" and
    each miss (expected / it said). Free-text answers that differ count as
    "in other words", never as wrong. The last result is kept per version,
    so the draft's score sits beside the live version's. These calls are an
    evaluation in the log: they do not count as its use.
  Pending edits are saved before a try, a test or a publish.
- **Endpoint.** Live version and when it was published; take it offline;
  its address with a copy button; keys (label, prefix, who made it, last
  used, calls; revoke); a new key shown once; curl, Python and JavaScript
  snippets filled in with its inputs; the versions published, each can be
  made live again.
- The title shows **● live v2** or **draft**; the list and the right panel
  mark live programs; a made program never called opens on Edit.

### Where it lives
```
<project>/programs/<name>/program.json   FunctAI's definition (contract/functions.md,
                                         "A definition"): the file people and agents edit
<project>/programs/<name>/functai.json   FunctAI's saved program made from it:
                                         functai.load(folder) in Python or TypeScript
```
Not in a project: `<Chattering data>/programs/made/<name>/`. The folder is
the draft. An edit made outside (an agent, git) is read the next time the
page or a call looks, and `functai.json` is written again from it. Publishing
copies both files to `<data>/programs/published/<name>/<version>/`, and the
address answers with that copy only. The registry (which programs were made
here, what is live, what was published, the last tests, the keys' hashes) is
`<data>/programs/registry.json` (0600). Every made program's module is
`programs`; a name is unique on an install, and it is the address, so it
cannot change (make a new program for a new name).

Versions are named v1, v2… by when each first appeared, in the log or by
being published, whichever came first: the same names on the page, in the
endpoint's answers and in its description.

### The address: `/programs/<name>`
- **POST** its inputs as a JSON object →
  `{"result": <the answer>, "outputs": {…}, "version": "v2", "call": "<log id>"}`.
- With `Accept: text/event-stream`: `started`, `text {field, answer, text}`
  as it is written, `retry {reason}`, then `done {…the same body…}` or
  `error {error, code, status}`.
- **GET** → what it takes and gives, as JSON Schema (`input`, `output`,
  `answer`, `version`), for agents and automation tools. In a browser
  (Accept: text/html), signed in: a form, the answer written as it comes
  (`program-form.js`).
- Refused before any model is called: an input that is not one of its
  inputs, a missing or mistyped one (every problem listed, `400`,
  `code: bad-inputs`), a body that is not JSON, over 256 KiB (`413`).
  A reply that is none of its answers even when asked again: `422` with
  FunctAI's reason and code. Model paused: `503`. Budget used up: `402`.
  Too many calls: `429` with `Retry-After`.
- Who may call:
  - **a key** (`Authorization: Bearer chp_…`): 24 random bytes, shown once,
    kept as a SHA-256 hash; it opens that one program, nothing else (it is
    checked before sign-in, and no other route accepts it). A key that opens
    nothing counts as a failed sign-in, behind the same limiter. At most 60
    calls a minute and 4 at once per key. Its calls are for the person who
    made it: their usage (`chatteringPerson` on the usage record, read by
    usageanalytics.js) and their monthly budget (design/72). A key whose
    person was removed, disabled or is a guest opens nothing.
  - **a signed-in person of the household** (the form, `chattering program
    call`), with the same limits per person. Never a guest.
  Calls are logged with `caller: {kind: "endpoint", user, key: <label>}` and
  show in Examples, live, "from its endpoint (key “git hook”)".

### The API behind the pages (all `member`; a program in a project also needs the right to act on it)
`POST /api/programs/draft {request, examples}` · `POST /api/programs/create
{definition, project, examples}` · `GET|PUT /api/programs/made` (everything
the tabs show / save the draft) · `POST /api/programs/try {name, inputs}`
(NDJSON) · `POST /api/programs/test {name}` (NDJSON) · `POST
/api/programs/publish|rollback|unpublish` · `POST /api/programs/keys {name,
label}` · `POST /api/programs/keys/revoke {name, id}` (the key's maker or the
owner tier).

### The command line (for agents)
`chattering program` (the list) · `program show NAME` · `program create FILE
[--project P]` (a definition as JSON) · `program try NAME '{…}'` · `program
test NAME` · `program publish NAME` · `program call NAME '{…}'`. Changing a
program: edit its `program.json`.

## Trade-offs, stated

- **Who pays.** Calls go through Pi on this machine's sign-in (a ChatGPT or
  Claude plan). For the household that is how everything here runs; letting
  people outside it call a program on a personal plan very likely breaks the
  plan's terms. So keys are made by, and count for, people of the household
  only. Opening programs to others needs an API-key account first
  (design/74, "Who pays").
- **Where it answers.** Wherever this Chattering does: on lambda, the
  private Tailscale network. A public website cannot call it, and no CORS
  headers are sent, so a web page on another site cannot either.
- **Speed.** Each call starts `pi -p` (about 0.2 s measured) before the
  model's own wait (1–2 s). Right for automations; slow for a keystroke.
- **Only one-call programs.** Programs with code of their own or tools stay
  in Python or TypeScript; there is no sandbox to run them here yet.
- **The model is not part of a program.** Every made program runs on
  settings → model, like Chattering's own; changing that model changes every
  program's answers without a new version (FunctAI does not count the model
  in a version).
- **Exact matching.** The test and the creation examples count an answer as
  right only when it equals the expected one; free text that differs is
  "in other words", to be read.
- **Editing by hand.** `program.json` is the source; `functai.json` is
  rewritten from it when Chattering next reads it. A hand edit to
  `functai.json` alone is overwritten.
- **Not built yet:** deleting a program (take it offline; its folder is
  yours to remove), renaming, a per-program model, worked examples in the
  prompt (improving from the answer key, design/74's loop), an audit of who
  published what beyond `published[].by`.

## Verified

- `test/programs-deploy.test.js`: definitions checked and normalized (every
  shape FunctAI reads, notes in shapes); a caller's inputs checked with
  every problem at once, optional inputs; the kinds as shapes; the folder's
  two files and broken files named; publishing copies (a later edit changes
  nothing callers get), rollback, offline, a restart; keys shown once and
  stored as hashes, one program each, revoked at once; the per-key limits;
  the description as JSON Schema.
- `test/ai-programs.test.js`: a made program runs from its definition,
  logged under `programs`, with the version its saved file has, and
  `functai.load` of that file gives the same version; one FunctAI cannot
  lay out is refused before it exists.
- `test/programs-make-app.test.js`: the real app and server with a fake Pi —
  saying it with two examples, the draft, choosing the project, making it
  (the folder in the project; the examples judged, one right, one wrong),
  editing (saved to both files), trying and judging, testing (2 of 3), publishing (v2),
  a key, calls as JSON, as a stream, refused (bad inputs, not JSON, a wrong
  key, none of its answers) with no model called for the first three, the
  live copy answering after the draft changed, usage for a person, the form
  in a browser, the command line (list, show, create, try, publish, call),
  and a revoked key opening nothing.
- A real `program_draft` call on `openai-codex/gpt-6-astra`: "which of my
  family members is an email for" became `email_recipient(email_text) →
  one of Maxime, Jacob, Lilly` with both examples mapped; after the
  instruction said so, the examples were stated as a rule rather than
  copied into it.
