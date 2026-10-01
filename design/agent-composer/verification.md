# Verification and completion record

**October 1, 2026 · steps 1–3 only**

## Delivered

- **Experience map:** 32 feature families; 19 concrete findings/risks, each with code anchors and an implementation/test obligation.
- **Reproducible inventory:** 165 production files searched, 60 call/picker text-match candidates; selected controlling paths in 25 evidence files recorded with SHA-256 hashes. This does not mean every line in 165 files was read.
- **Representative-agent study:** Pi, Codex, Claude Code/Claude Agent, OpenCode, Gemini CLI, Antigravity and Aider. Additional named products are screened or explicitly left on the expansion backlog; no twenty-agent compatibility claim.
- **Primary-source record:** 24 numbered references covering 26 URLs, with fetch time, redirect destination, status and content fingerprint in `source-checks.json`. A 200 response is not itself proof of a claim; relevant text was separately inspected. The DeepSeek landing page is a “Page moved” response and is paired with its upstream repository.
- **Interaction specification:** independent composers, destination/account/session identity, acknowledged settings, queue/approval/recovery semantics, transfer manifest, accessibility, branding and incremental rollout.
- **Interactive prototype:** two simultaneously mounted boxes, seven illustrative agent descriptors, model/setting changes, command suggestion isolation, handoff preview/failure, attachment incompatibility, account restrictions, queue/stop behavior and recovery states.

## Checks actually run

```sh
python3 design/agent-composer/inventory.py
python3 design/agent-composer/check-sources.py
node --check design/agent-composer/app.mjs
node --check design/agent-composer/model.mjs
node --check design/agent-composer/markdown.mjs
node --experimental-strip-types -e "import('./design/agent-composer/contract.ts')"
node --test design/agent-composer/model.test.mjs \
  design/agent-composer/markdown.test.mjs \
  design/agent-composer/audit-observations.test.mjs \
  design/agent-composer/browser-test.mjs
```

**Result: 24 tests passed, 0 failed, 0 skipped.**

Interpretation matters:

- 19 tests exercise the **simulated design state model**.
- 3 tests check safe report rendering.
- 1 browser walkthrough exercises the **prototype**, not the production Chattering application.
- 1 characterization test imports the existing pure Codex run module with stub dependencies and **reproduces F03**, the lost queued brief. It passes because that defect is present. It is not a release acceptance test and must be inverted/promoted when the defect is fixed.

The proposed TypeScript contract loads under Node's type stripping. **No semantic TypeScript compiler check was performed**; `tsc` was not present at the checked project binary paths. The contract is a design specimen, not installed production code.

## Browser observations

An isolated Chromium profile and a local static server were used. No connection to the user's browser profile or running Chattering service was required. The temporary profile/server were removed/stopped by the test.

- Viewport widths 1440, 1280, 390 and 320 pixels.
- Paper, night and monochrome appearances.
- Both command suggestion boxes remain independent; choosing a suggestion inserts text without executing it.
- Unknown slash command does not turn into an ordinary prompt.
- Synthetic IME composition event does not submit on Ctrl+Enter.
- Failed handoff retains source/draft; summary requires explicit consent.
- Switching the shared destination makes the other box require review; a box aimed at a separate new conversation does not change.
- Different descriptor shapes: no reasoning control, multiple model roles, unsupported native approvals.
- Restricted account blocks sending; uncertain delivery and disconnection do not auto-resubmit.
- Stopping holds queued work rather than launching it.
- Escape restores focus to the invoking composer.
- No page-level horizontal overflow at 390 or 320 pixels; picker fits the narrow viewport.
- Reduced-motion media setting recognized.
- Local design report loads; no uncaught browser exceptions and no external network requests by the prototype.

Machine-readable observations are in `browser-results.json`. Screenshots visually inspected:

- `preview-desktop.png`
- `preview-phone-ink.png`
- `preview-handoff.png`

`preview-night.png` was also captured for inspection. This is not a screen-reader certification, contrast audit, actual e-ink hardware test, full touch-device test or 200%-zoom certification. Those remain T24 release gates.

## Explicitly not tested or changed

- No native prompt/inference was submitted; no subscription credit was spent on agent probes.
- No credentials, private conversation bodies or working files were sent to a research site.
- No CLI installed or updated; only help/version checks for installed tools and public documentation fetches.
- No production handoff, native import fidelity, remote recovery, OS sandbox or account-entitlement test.
- No production logic changed by this pass. The new folder and the follow-up notice in design/87 are design/research artifacts. Existing uncommitted production work was left alone.
- No service restart or commit.
- The previous full-suite count from the earlier conversation was not reused as proof of this design. No new full production-suite run was needed or claimed here.

## What “complete” means here

Steps 1–3 are complete as an audit, source-backed comparison and inspectable design. The findings deliberately expose unfinished implementation work. Steps 4 onward must close the common-dispatch/identity/queue gaps and pass the native adapter and handoff gates before this can be presented as a real integrated composer.
