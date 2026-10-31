# 109 · What each plan still allows

*2026-10-31. Modules: `plan-limits.js` (pools, windows, a model's state),
`plan-limits-read.js` (each provider's reply read as windows),
`plan-limits-live.js` (limit headers, agents' own events, refusals),
`plan-limits-worker.js` (reads a person's sign-ins, as them),
`plan-limits-store.js` (the hub's record and history),
`plan-limits-estimate.js` (calibration, pace, who used it),
`plan-limits-service.js` (who reads what when, views),
`extensions/plan-limits.ts` (what each Pi reply says),
`plan-limits-ui.js` and `plan-limits.css` (the picker, the composer line,
settings → plans), `person-ops.js` (`plan.read`), `server.js`
(`/api/plan-limits`, `/history`, `/observe`, `planReserveRefusal`,
`planNotice`, `frogPlanLimits`), `agent-recovery.js` (kind `limit`),
`keyproxy-worker.js`, `push*.js` (kind `plan`). Tests: `plan-limits`
(every parser against a recorded real reply), `plan-limits-service`,
`plan-limits-server` (the real server and worker), `plan-limits-extension`,
`plan-limits-browser`, `accounts-e2e` (read as a real second account).*

## The problem, plainly

Maxime has several subscriptions: two Claude plans (Max 20× and a Team
seat), ChatGPT Pro, an OpenRouter key with a monthly budget, Antigravity.
Each limits use in windows (five hours, a week, a week for one model
family, a month's money) that reset at their own times. Chattering showed
none of it, except one Codex number in the composer. The frog said "plan
usage limits are not readable here". Work stopped by a limit was not
resumed. Background work (titles, memory) could spend the last of a plan
while a person needed it.

The numbers exist. Each provider says them, to its own sign-in, without a
model call; and every reply of a subscription carries some of them in its
headers.

## What an expert builds

1. **The unit is the pool: one subscription account at one provider.**
   Claude Max is one pool whether Pi's `anthropic`, Pi's `claude-code` or
   Claude Code itself sends the request, and whether Maxime or Lilly
   (signed in to the same account) asks. A pool's key is a hash of the
   provider's own account id (`claude:` organisation and account,
   `chatgpt:` account, `openrouter:` key, `antigravity:` subject): no id or
   address in Chattering's records, and two ways to one account meet.
2. **A pool has windows; a window says which models it covers** (all of
   the plan, a model family by name, or named models). A model's state is
   its tightest window. A kind of limit nobody has seen yet still becomes a
   window, named by its words (Claude's reply describes itself).
3. **Numbers are the providers' own, each with where it came from and
   when**: `read` (asked), `live` (the last reply's headers), `error` (a
   refused reply). A window past its reset with nothing newer is "reset,
   not read since", never 0%. What Chattering reckons (pace, a reply's
   share, who used it) is marked *estimate* wherever it shows.
4. **Read as the person whose sign-in it is** (design/106). A short-lived
   process of theirs (`plan.read` through their actor) reads their
   sign-ins and answers with pool keys, plans and numbers, never a token.
5. **Renew a login only through its owner.** Pi's sign-ins are renewed by
   Pi's own code (`ModelRuntime.getAuth`, under Pi's lock). Claude Code's
   are read only; an expired one is renewed by Claude Code itself
   (`claude -p /usage`: no model call, 0 tokens, nothing saved, the
   person's hooks and plug-ins not loaded), at most every 30 minutes and
   only while someone looks. Antigravity's is read only, when still valid.
6. **Read when it matters, cheaply.** When someone looks (at most every
   90 s), while a pool is in use (every 10 min), at once after a refusal,
   just after a limit's reset, otherwise every 6 hours (which also keeps
   each reader checked). One question per pool, not per way to it.
   Failures back off (1, 2, 5, 15, 60 min; a refused sign-in 30 min).
7. **Listen for free.** Every Pi run Chattering starts (web runs, delegated
   work, its own model calls) loads `extensions/plan-limits.ts`: Pi's
   `after_provider_response` gives each reply's status and headers, and
   only the limit headers go to the hub, plus a refused reply's message.
   The key proxy reads the same headers for guests and people on the
   owner's models. Codex's `account/rateLimits/updated` comes in through
   the run's events, and Claude Code's `rate_limit_event` would the same
   way (its in-box driver, `harness/claude-code.js`, is not wired to the
   server yet). A conversation file that grows (an agent in a terminal)
   marks its pool in use.
8. **Act on it.** Background work waits while its plan has less than the
   reserve left (15% by default, settings → plans). A run stopped by a
   limit waits for the reset and resumes (with "resume automatically" on).
   Delegating to a model whose plan is spent is refused with when it is
   back; a nearly full one is said. The picker offers the other Claude
   plan when one is short. People who asked are told when a limit is
   reached or over.

### Rejected, with the reason

- *Refreshing Claude Code's or Antigravity's logins here.* A refresh
  rotates the refresh token: the program that owns the login is signed
  out. Antigravity would also mean using its OAuth client as if Chattering
  were it.
- *Parsing the text of `claude -p /usage`.* A screen for people; the JSON
  endpoint it reads is the same data with a stable shape. The command is
  used only to have Claude Code renew its own login.
- *Asking a model "how much is left".* It costs the very thing it counts.
- *Polling on a fixed timer for everyone.* Requests nobody reads; the
  cadence above follows looking, use and resets.
- *A reader inside Pi's core.* Pi's contributing rules keep its core
  minimal and extension-first, and its issues must be written by a person.
  Only the hook's gap is a core matter: `after_provider_response` does not
  say which request a response answers (compaction and routed requests use
  another model than `ctx.model`). That change is prepared (below); the
  readers stay in Chattering, written so they could move.
- *Moving limited models down the picker's list.* Keyboard order would
  change under the person's fingers; they are struck through and marked
  "back 15:30" in place.
- *Announcing a limit from a refusal's words.* The words start a read; the
  read decides. No "limit reached… limit over" from a misread error.

## The providers

Every parser was written against a real reply, kept with its ids replaced
in `test/fixtures/plan-limits/`. A reply in another shape is refused
(`ShapeError`), and the reader is marked "stopped working" with the date,
rather than read as zeros.

| Provider | Asked | Live | Model-specific | Verified |
|---|---|---|---|---|
| Claude (Max, Pro, Team) | `GET api.anthropic.com/api/oauth/usage` (+ `/profile` once, for a Pi login) | `anthropic-ratelimit-unified-*` (5 h and 7 d as fractions; refusals with their claim) | the `limits` list's `scope.model` (Fable) | 2026-10-31, both of Maxime's plans |
| ChatGPT (Pi's `openai-codex`) | `GET chatgpt.com/backend-api/wham/usage` | `x-codex-*` (limits by name, percent) | `model_usage` (a model not served now) | 2026-10-31 |
| Codex (its own login) | app-server `account/rateLimits/read` | `account/rateLimits/updated` | `rateLimitsByLimitId` | 2026-10-31 |
| OpenRouter | `GET /api/v1/key`, `/api/v1/credits` | — | free models' daily requests | 2026-10-31 |
| Antigravity | `loadCodeAssist`, `fetchAvailableModels` (per model `quotaInfo`) | — | per model, levels of one model share an allowance | shape from a recorded reply; its saved login was expired, not read live |
| xAI, Kimi | nothing to ask | refusals only | — | named "tells its limits only when a reply is refused" |

Google writes protobuf as JSON: a zero is left out, so a model with a
reset time and no `remainingFraction` has nothing left. Claude's headers
are fractions, its usage reply percents.

## What a person sees

- **The model picker**: a strip of the plans behind the listed models
  (each whole-plan window: a bar, its share, its reset), a dot on a
  provider short of room, and on each model short of room its mark ("86%",
  "back 15:30", struck through when spent). A short Claude plan with
  another that has room offers "the same model on … has room · use it".
- **The composer's usage line**: for a plan, "Claude Max 20×: 35% of the
  5-hour · resets in 2 h · a reply here ≈ 0.8%" instead of an API price
  nobody pays; the tooltip lists every window and where each number came
  from.
- **Settings → plans**: each plan, each window with its bar, reset, source
  and the last week's line; the pace; what 1% costs in API-priced use;
  who used the window; extra usage or credits; sign-ins that could not be
  read and why; readers that stopped working; the reserve.
- **The frog**: `plan_limits` gives all of it in words it can say.
- **Notifications**: "a plan's usage limit is reached, or over", off on
  every device until turned on (settings → notifications), and a note in
  the page at once.

### Who sees what

| Person | Sees |
|---|---|
| Owner tier | this server's plans in full; who used each window by name |
| Household on this server's account | the same plans (the owner's other Claude logins hidden, as in the picker); themselves and "others" |
| Someone on their own account and models | their own plans in full (shared with others when they share the account); themselves and "others" |
| Guests, people on the owner's models | whether each model answers and when it is back; no numbers |

## Estimates

- **Calibration**: percent of a window per dollar of API-priced use, per
  pool and window, as the window's rise over each whole instance against
  the use the usage index saw in it, pooled (ratio estimator), shown from
  3 instances and 10 points of rise, with its spread. Chained over an
  instance, the providers' whole-percent rounding telescopes to one point.
  Use Chattering did not see (claude.ai in a browser, another computer)
  only adds rise: the estimate errs high, the safe side for "will it fit".
- **Pace**: the last three hours' rise per hour; "full around 14:40" when
  that comes before the reset.
- **Who used it**: the usage index's calls of the window by person (only
  the window's models for a model's own window); "outside Chattering" is
  the rest once calibrated.
- **A reply here**: the median API price of the conversation's last
  replies times the calibration.

## The upstream change

`~/Projects/pi` worktree `/mnt/fast/chattering/pi-after-provider-response`,
branch `after-provider-response-model` (one commit on `origin/main`,
not pushed): `after_provider_response` carries `provider` and `model`, as
`provider_stream_event` does; types, docs, the test harness and a test.
Pi's gate wants an issue in the contributor's own words before a PR. The
extension already prefers those fields when present.

The owner's Claude Code provider extension
(`~/.pi/agent/extensions/claude-code-fable-5`, outside this repository)
now calls Pi's `onResponse` after its fetch, as Pi's own providers do, so
its replies' headers are seen. Lilly's copy does not have it until it is
re-synced.

## Trade-offs, stated

- Claude's and Google's usage addresses are not documented APIs. They can
  change; the reader then says it stopped working.
- Matching a limit to models is by name ("Fable" in `claude-fable-5-1`).
- Live headers come only from runs that pass through Chattering or its key
  proxy; a terminal's use is seen at the next read.
- Codex limits with a name of their own apply to the whole plan in the
  picker unless Codex also marks the model unavailable.
- Antigravity is read only while its saved login is valid.
- The reply's `ctx.model` is taken as the request's until Pi says it.
- The "a reply here" share appears only after weeks of history.
- Reading costs a few requests to each provider while someone looks.

## Where things stand (2026-10-31)

Built and tested as above. Not built: a Pi terminal command (`/limits`);
readers for xAI, Kimi and GitHub Copilot (no sign-in here to verify
against); Claude Code's CLI transport in the provider extension (the API
transport is the default).
