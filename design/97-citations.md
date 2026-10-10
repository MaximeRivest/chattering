# 97 — Citations: numbered references become paper cards

## The ask (2026-10-10)

> can we improve the ui / ux a lot for the science / citation search format
> and make the like have a sort of tooltip showing the information about
> that cited element and make sure all chattering agents use a proper format
> of response so we can do nice presentation?

Agents now search ~200 million papers (the Scholars Reading List API) and
answer with `[n]` markers and a list of DOIs at the end. Read as text, a
reader sees "[38]" and, far below, "10.1056/nejmoa2032183": nothing says
what the paper is, and nothing says when the DOI is wrong. The answer that
prompted this had already cited a DOI matching no paper.

## The format (one contract, written by agents, read by the renderer)

```markdown
Semaglutide gave about 15% weight loss [1]; tirzepatide about 20% [2][3].

## References
- [1] https://doi.org/10.1056/nejmoa2032183 — Wilding 2021, NEJM
```

- A number right after the claim; several as `[2][3]`, `[2, 3]` or `[2–4]`.
- One line per number, starting `[n]` (`[^n]`, `[n]:` and list markers too),
  holding a DOI (bare, `doi:` or doi.org link), an OpenAlex W-number or link,
  or a PMCID. Several numbers may share a line, one number may hold several
  papers: the older answers wrote `[1] 10.x [2] 10.y` in one paragraph and
  they render the same.
- The words after the identifier are a label, shown only when the record
  cannot be had. Titles come from the database, never from the agent.

Chosen because it reads well with no renderer at all (terminal, GitHub,
copied into notes), is what models already write, and is unambiguous: a
number becomes a button only when the same message defines it with an
identifier, so `[0]` in prose or `arr[1]` in code is never touched.
Rejected: markdown footnotes (`[^1]`, accepted but not asked for: the
renderer here and many others do not draw them); reference-style link
definitions (`[1]: url`, invisible once rendered, so the list vanishes
outside Chattering); inline links on every marker (long, and a paper cited
five times repeats its DOI five times).

Where agents learn it: the global instruction files (`~/.pi/agent/AGENTS.md`,
`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`) and the `scholars-search` skill
(`~/Projects/scholarsreadinglist/search/skill`). Chattering does not inject
it into every system prompt: those files already reach Pi, Claude Code and
Codex, in and out of Chattering, and a second copy would cost every
conversation the tokens twice. Prompt modes that remove the project context
(general-assistant, jacob, the single-job modes) do not get it.

## What a reader sees

- **In the text**: each number is a small pill in the link colour; a run
  like `[2][3][4]` is one pill "2–4". The word before it and the punctuation
  after it never wrap away from it. A number whose paper does not exist or
  was retracted is red with a "!", before anything is opened.
- **The card**: hover with a mouse previews it; a click, a tap or Enter pins
  it; Escape, × or a click elsewhere closes it, and the focus goes back to
  the number. One paper: badges (Review, Preprint, Retracted…), title linked
  to the publisher, authors (three, then "et al. (14 authors)"), year ·
  journal · times cited · free to read, the summary clipped to four lines
  with "Show the whole summary", then Publisher page · PDF · Read it
  simplified (ScienceMadeReadable, when it can open the paper) · OpenAlex,
  and "Go to reference n in the list". A group lists its papers without
  summaries. Under 600 px wide the card is a sheet from the bottom edge.
- **The reference list** becomes a numbered bibliography: title, badges,
  authors — year · journal. A problem strikes the title and says why.
- Any doi.org or openalex.org link in a message previews the same card.
- E-ink: no tints or shadows; edges and badges in ink; problems are bold.

## Where the facts come from (papers.js, GET /api/papers?ids=…)

1. The paper database, `/works/{ref}` (`CHATTERING_PAPERS_API`; the public
   address by default, 60 requests a minute; lambda's service is set to
   `http://127.0.0.1:8810` in `os/machines`).
2. A DOI the database lacks: the DOI registry (`doi.org/api/handles`), which
   alone can say "this DOI does not exist". Asked before Crossref, so a
   made-up DOI never costs a Crossref request.
3. A real DOI: Crossref, for title, authors, journal, year and retraction
   notices. Its public pool takes one request at a time; requests are
   queued and spaced, and a refusal leaves "the DOI is real" for an hour.

Answers: `found` (with `source`), `registered` (real DOI, no details),
`missing` (for a DOI: the registry has no such DOI; for a W-number or
PMCID: not in the database, which is not proof of anything), `error`
(asked again when the card is opened), `invalid`. Kept on disk in the cache
folder (`papers-cache.json`): found 30 days, registered 7, missing 1;
errors never. The route is open to guests: it returns public records only.

The database misses some real papers (Huang et al.'s 2020 Lancet paper on
the first COVID-19 patients was absent on the day this was built); step 3 is why such a
reference still gets a full card instead of a false alarm.

## Limits

- DOIs, OpenAlex ids and PMCIDs only; a PubMed id or a bare URL stays a link.
- The card shows what the records say, not whether the paper supports the
  sentence it is attached to.
- Messages longer than the markdown limit render as plain text, without
  citations (as without any other formatting).
- Looking a paper up sends its identifier to the paper database, and for
  DOIs it lacks, to doi.org and Crossref.

Tests: `test/citations.test.js` (format, rendering, lookups with a fake
network), `test/citations-app.test.js` (the real page in Chromium: list,
card, group, hover, Escape).
