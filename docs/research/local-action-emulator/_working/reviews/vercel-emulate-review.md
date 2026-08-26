# Review: `vercel-labs/emulate`

## Status

`DONE_WITH_CONCERNS`

## Scope

Reran the `projects/<id>.md` gate against the revised `docs/research/local-action-emulator/_working/projects/vercel-emulate.md`.

Directly checked:

- `docs/research/local-action-emulator/_working/brief.md`, including all ten fixed questions, decision criteria, scope, and deep-answer standard.
- `docs/research/local-action-emulator/_working/targets.md`, including all mandatory smart Git, ownership, persistence, endpoint/request, and webhook matrices.
- `docs/research/local-action-emulator/evidence/emulate-runtime.md`.
- Upstream checkout `/tmp/opencode/hello-main-emulate-spike` at commit `d0219d05818adca4c12bb76ec79a7562c1766a3d`.
- Current repository source and tests, including `src/adapters/octokit.ts`, `src/entry/action-runtime.ts`, `src/adapters/git.ts`, `src/adapters/local-github.ts`, `src/ports/github-platform.ts`, and `test/local/git-scenario.test.ts`.
- The `projects/<id>.md` criteria in `references/review/review-gates.md` and formal-report requirements in `references/artifacts/contract.md`.

The report, evidence, source, and spec files were not edited. This file is the rerun review artifact.

## Findings

| ID | Result | Finding | Evidence and gate impact |
| --- | --- | --- | --- |
| REP-01 | resolved | The webhook matrix now covers the required events and explicitly distinguishes `synchronize` and `queued` from supported events. | `vercel-emulate.md:102-127` classifies source/Integration PR opened, synchronize, edited, closed, ready, merged; comment, review, check, and ref events; manual dispatch; persistence ordering; retry/failure/duplicate behavior; and wakeup suitability. The source supports these classifications: `pulls.ts:484-590` dispatches only closed/reopened/edited for PATCH, `checks.ts:415-519` emits `created`, `checks.ts:685-708` emits `rerequested`, and `core/src/webhooks.ts:103-157` has no retry/redelivery. No direct regression found. |
| REP-02 | resolved | The provider-operation inventory now uses the required category vocabulary and separates runtime execution status. | `vercel-emulate.md:42-63` gives one of `implemented but semantically incompatible`, `not implemented`, or `not exercised` for every required operation, with a separate `Runtime evidence` column. The current adapter mapping is independently traceable at `src/adapters/octokit.ts:454-502`, `:635-709`, `:715-843`, and `:846-965`; the upstream route claims match `pulls.ts`, `branches.ts`, `reviews.ts`, and `checks.ts`. No direct regression found. |
| REP-03 | resolved | The source absence scans are now reproducible and distinguish zero-match scans from incidental matches. | `evidence/emulate-runtime.md:38-51` records the pinned commit, exact `rg` commands, scoped paths, exit handling, captured outputs, and interpretation for smart HTTP, SSH, subprocess/repository storage, and GraphQL. Independent reruns at the pinned checkout produced no smart-HTTP or GraphQL matches; SSH/subprocess results were only the documented incidental test, URL-parser, ACL, and portless matches. This is sufficient source evidence for the negative protocol/GraphQL conclusions. |
| REP-04 | resolved with boundary | The endpoint/request matrix now honestly records the runtime exercise as `not exercised`, rather than implying a live capture. | `vercel-emulate.md:90-100` states that neither `OctokitGithubPlatform` nor the Action transport ran, and that there is no actual 404, URL capture, or fallback capture. `evidence/emulate-runtime.md:53-65` repeats this boundary. The source-backed parts remain valid: the current transport hardcodes both hosts at `src/entry/action-runtime.ts:253-303`, the adapter calls GraphQL at `src/adapters/octokit.ts:454-502`, and the upstream scoped scan found no GitHub GraphQL route. The mandatory live endpoint probe was not completed because installation failed, but the omission is disclosed and no runtime result is invented. |
| REP-05 | resolved | The previously broad current-repository citations were tightened. | `vercel-emulate.md:32-38` now cites operation-specific ranges for observation, GraphQL ready, changed files, reviews/checks, tree/blob reads, PR/ref reads, production composition, and transport URLs. The cited ranges correspond to the inspected current source. |

## Decision-Critical Assessment

The revised artifact correctly concludes that source-confirmed absences are sufficient to reject replacement of the canonical provider-facing local Action path, despite the failed installation and absent live CRUD spike:

- The pinned source registers GitHub REST route families at `packages/@emulators/github/src/index.ts:533-577`, but the recorded scans find no smart HTTP upload/receive service, SSH Git server, Git subprocess/repository storage, or GitHub GraphQL route.
- URL-shaped `git_url`, `ssh_url`, and `clone_url` fields at `packages/@emulators/github/src/helpers.ts:272-274` are metadata only. REST refs, commits, trees, and blobs are Store-backed at `branches.ts:683-1085`; the REST merge creates a Store commit and moves Store branch state at `pulls.ts:595-720`.
- The current canonical path keeps real Git authoritative for the Project Shell and final DAG. The production composition uses `RealGitWorkspace` at `src/entry/action-runtime.ts:95-115`, the Project Shell bridge at `:162-200`, and the real Git scenario validates no-fast-forward and bare-remote postconditions at `test/local/git-scenario.test.ts:38-90`.
- The current provider adapter requires `markPullRequestReadyForReview` through GraphQL at `src/adapters/octokit.ts:454-502`. The absent upstream GraphQL route cannot satisfy that operation. The runtime transport also hardcodes `https://api.github.com` at `src/entry/action-runtime.ts:253-303`, so local endpoint targeting would require a runtime/composition change even for REST-only use.

These source-level facts independently establish that emulator Git state does not synchronize automatically with the real bare Git state and that the candidate cannot replace the canonical provider-facing path. A runnable spike is not required to reverse that rejection.

## Evidence Boundary Classification

The failed dependency installation is an **acceptable evidence boundary for the rejection**, not evidence of runtime absence:

- Runtime `unknown`: live issue-comment POST/PATCH/GET, two-process embedded persistence, live smart Git probes, and live Action/Octokit endpoint capture. This is recorded at `evidence/emulate-runtime.md:53-65` and `vercel-emulate.md:65-75`.
- Source-confirmed negative: no smart Git/SSH implementation or real-Git synchronization, no GitHub GraphQL route, and no CLI persistence option. The exact scans and source paths are recorded at `evidence/emulate-runtime.md:22-51`.
- The report makes no current optional-adoption positive claim. Its optional REST-fixture language is explicitly conditional on a later runnable spike, exact endpoint/no-fallback capture, two-process persistence proof, and a maintained wrapper (`vercel-emulate.md:178-182`, `:206-213`).
- Any future optional-adoption recommendation remains blocked until runtime comment CRUD, endpoint capture, and the required persistence behavior are demonstrated. The report also retains the real Git and deterministic fault/restart tests.

The `DONE_WITH_CONCERNS` concern is therefore an **acceptable evidence boundary / nonblocking risk for the canonical rejection**, but a **blocking risk for optional adoption or any positive runtime claim**. It is not a requirement ambiguity and does not block the rejection conclusion.

## Required Next Handling

1. Accept this artifact for the rejection path and carry the runtime boundary into synthesis.
2. Do not claim that issue-comment CRUD, embedded restart persistence, endpoint compatibility, webhook delivery, or smart Git behavior was runtime-confirmed.
3. Do not recommend optional REST-fixture adoption unless a future run completes the live CRUD, two-process persistence, endpoint/no-fallback, and cleanup checks.
4. If the workflow requires the endpoint matrix to be fully executable before any downstream artifact, run the same `projects/<id>.md` gate again after dependencies become available; that is a targeted evidence-boundary follow-up, not a reason to reopen the source-backed rejection.

## Gate Decision

`DONE_WITH_CONCERNS`: the revised `projects/<id>.md` artifact is sufficiently complete and traceable for the next step. REP-01 through REP-05 are resolved or explicitly bounded. The only remaining concern is the failed runtime installation and consequently unexercised CRUD/persistence/endpoint/Git probes. That concern is nonblocking for rejecting canonical replacement, but blocks any optional-adoption positive claim or runtime-confirmed compatibility claim.
