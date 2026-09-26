# 72 · Team: company sign-in, walls per person, cost per person

*2026-09-26. `oidc.js`, settings `sso`, `isolation`, `budgets`; users.js
(`sso` link, expiring sessions, `isWalled`); usage index v3 (`person`);
settings → team; usage → by person. Tests `sso`, `usageanalytics`,
`users`. Step 4 of the market-readiness work; design/46 deferred these.*

## Company sign-in

OpenID Connect, authorization code with PKCE, a one-time state bound to a
nonce and a verifier (ten minutes), the code exchanged server to server
(client secret by HTTP Basic, or none for a public client), the ID token's
signature checked against the issuer's published keys (RS256/384/512,
PS256/384, ES256/384, EdDSA; never `none`; keys refetched once when the
provider rotates), then issuer, audience (and `azp`), expiry, issue time
and nonce. Any conforming provider: Google Workspace, Entra ID, Okta, Auth0,
Keycloak, Authentik.

- **Who comes in:** when email domains are listed, a *verified* email in one
  of them (or Google's `hd`); otherwise whoever the provider signs in.
- **Who they are here:** a person is linked by issuer + subject (never by
  email, which can change hands). The first sign-in creates the person when
  *make a person at first sign-in* is on; otherwise only linked people get
  in. Disabled stays disabled.
- **Role:** when admin groups are set, each sign-in brings the role in line
  with the `groups` claim; the owner is never demoted.
- **Session:** a credential that ends after the configured hours (default
  12); the provider is asked again after that.
- The redirect is `PUBLIC_URL/auth/sso/callback` (shown in settings → team
  to register at the provider); `next` is only ever a path of this site.

## Walls per person

`isolation: 'per-person'`: everyone below the administrators is *walled*,
exactly as guests are (design/53): nothing is theirs to see unless a rule
shares it; only the guest route allowlist (policy.js) answers them; their
runs start in a bubblewrap sandbox with their own agent folder, only the
project, and the owner's model subscriptions through the key proxy (never a
key inside). The flag rides on the request's copy of the person, never on
the roster, so switching modes back is instant. Household mode is
unchanged.

## Cost per person

A model call belongs to the person whose message it answers: the usage
parser follows the conversation tree from each `chattering-author` entry.
A message without one (typed in a terminal, older history) counts as *not
attributed*; background work as *background*. The dashboard shows cost by
person and filters by person.

**Limits:** per person per calendar month, in the dashboard's estimated
dollars at API prices; a default for everyone and one per person; none for
the owner. At the limit, starting a run or a new conversation is refused
before any model is asked, with the amounts and when it renews. Each person
sees their own standing in `GET /api/settings` (`budget`).

## Trade-offs, stated

- **Limits count estimated value, not invoices.** A subscription's calls
  count at their API-price value; the limit is a brake, not accounting.
- **A limit is checked when a run starts**, not mid-run: one long run can
  pass it.
- **Walls per person run code only on Linux with bubblewrap**; elsewhere
  walled people read and write, and are told why they cannot run.
- **Walled people lose what guests lose** (design/69): notebooks, change
  reviews, file history, records search, voice, AI commands, until each
  checks the project.
- **No SCIM directory sync.** People leave by being disabled here (or by
  losing access at the provider, which ends their next sign-in; an existing
  session lasts its hours). Group membership is read at sign-in only.
- **No audit export.** Sign-ins are logged (design/56); actions carry their
  author in the conversations; a single audit trail is not built.
- **One server process** still serves everyone (design/46): fine for a team,
  not for hundreds of concurrent people.
