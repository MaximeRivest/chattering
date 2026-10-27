# Working on Chattering

- **Files and programs, as whom (design/106).** The server serves several
  people, each possibly on their own computer account. Work on someone's
  files or programs goes through an actor: `actorOf(identity)` (what a
  requester does, done as them), `actorForPath(p)` (work that belongs to a
  path's owner, like git), `actor.op('name', …)` (an operation in
  `person-ops.js`; add one when none fits). Never `fs`/`child_process`
  directly on a path a person names. The hub's own records (its index,
  notes, settings, caches) may be touched directly, marked
  `// hub-own: <why>`.
- `test/disk-ratchet.test.js` enforces this: the count of direct touches
  per place may only go down (`node scripts/disk-ratchet.js` explains).
  Do not raise it with `--accept` to make a test pass.
- New routes are classified in `policy.js` (`ROUTES`, and `ACCOUNT_ROUTES`
  for people on their own account). `test/accounts-e2e.test.js` runs them
  as a real second account.
