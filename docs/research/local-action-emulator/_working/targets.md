# Research Targets: Local Action GitHub Emulator

## Selection Criteria

Targets must directly answer emulator behavior, integration shape, or the current repository fit. Source code and executable behavior are primary evidence. Documentation and official GitHub API semantics are supporting evidence.

## Selected Targets

| Target | Evidence type | Primary evidence | Supporting evidence | Selection reason | Unknowns to resolve |
| --- | --- | --- | --- | --- | --- |
| `vercel-labs/emulate` GitHub emulator | readable source + executable package | repository source, route registry, persistence implementation, package metadata, local runtime spike | upstream README/issues/releases | Only identified candidate with stateful GitHub resource mutations and file persistence | API coverage, GraphQL, webhook coupling, Git smart transport, persistence semantics, maintenance/runtime fit |
| Current Hello from Main provider/test architecture | readable local source | `src/adapters/local-github.ts`, `src/adapters/octokit.ts`, `src/adapters/git.ts`, `src/entry/action-runtime.ts`, `src/entry/action.ts`, `src/ports/github-platform.ts`, `src/ports/git-workspace.ts`, `test/local/git-scenario.test.ts`, `test/adapters/octokit.test.ts`, `test/adapters/local-github.test.ts`, `test/runtime/composition.test.ts`, `test/stability/restart-recovery.test.ts`, `test/stability/unknown-outcome.test.ts` | current Tech/Test Spec and reports | Determines actual replace/delete/add surface and prevents generic recommendations | duplicated provider state, endpoint configurability, Git/provider synchronization ownership |
| GitHub provider semantics used by the feature | official API contract | official REST/GraphQL/webhook/Git transport documentation relevant to current operations | current adapter request paths | Defines what compatibility means and prevents emulator marketing claims from becoming provider claims | which behaviors necessarily remain L5-only |

## Excluded Candidates

| Candidate | Reason excluded from deep-dive |
| --- | --- |
| Nock, Polly, WireMock, Hoverfly, `@octokit/fixtures` | Useful replay tools but do not by default maintain GitHub domain state after mutations; they remain comparison context only. |
| Probot test harness | Injects webhook events but is not a stateful GitHub API implementation. |
| `act` | Runs Actions workflows but does not emulate GitHub resource state or API semantics. |
| Comment-from-file marketplace Actions | Deliver Markdown bodies but do not answer local provider-state fidelity or production adapter testing. |

## Coverage Rationale

The decision is not a broad emulator bake-off. It is a source-level feasibility assessment of the user-selected `vercel-labs/emulate` against this repository. The selected targets cover the third-party implementation, the consumer architecture, and the provider contract it purports to emulate. A second emulator target is only required if `emulate` is unusable and another stateful candidate can materially change the recommendation.

## Evidence Plan

- Clone/download `vercel-labs/emulate` into `/tmp/opencode/hello-main-emulate-spike`.
- Inspect package manifests, route registration, state model, persistence, webhooks, comments, PRs, reviews, checks, refs, Git Data, GraphQL, and server startup.
- Run the smallest supported server/test API and verify comment CRUD/readback and restart persistence.
- Exercise PR/review/check/ref behavior and endpoint/base URL integration through the current production adapter/runtime seams; source-only evidence is accepted only for a demonstrably absent route or protocol endpoint.
- Execute the mandatory smart-transport, persistence, endpoint, request-inventory, webhook, and ownership matrices below. Unsupported behavior is a valid result but must be recorded explicitly.
- Map results to current Hello from Main modules and proposed Test Spec layers.

## Mandatory Smart Git Transport Matrix

The spike owns a temporary emulator process, a temporary bare repository, an ordinary clone, process logs, API captures, and cleanup under `/tmp/opencode/hello-main-emulate-spike`. It must record commands, exit codes, URLs, response bodies/headers where safe, and before/after OIDs.

| Direction | Setup and operation | Required probes | Required assertions |
| --- | --- | --- | --- |
| Git client -> emulator | Start the proposed emulator mode, use every advertised clone/HTML/SSH URL for a seeded repository | `git ls-remote`, `git clone`, then commit and `git push`; probe smart HTTP `info/refs?service=git-upload-pack`, `git-upload-pack`, `git-receive-pack`, and any advertised SSH endpoint | Whether the server implements upload-pack/receive-pack or SSH; whether push changes emulator refs, PR head SHA, commits, trees, and blobs; exact failure if unsupported |
| Emulator Git Data API -> Git client | Seed a real temporary bare repository/clone and separately mutate emulator refs/commits/trees/blobs through REST | `git fetch`, `git ls-remote`, object/read-tree inspection against the real bare remote and any emulator URL | Whether API mutations become real Git objects/refs visible to Git; no conclusion may infer synchronization from URL-shaped response fields |
| Real bare Git -> emulator API | Push a new commit to the temporary bare remote without calling emulator APIs | Read emulator branch/ref, commit/tree/blob, source PR head, Integration PR head | Whether emulator state changes automatically; if not, identify the exact narrow bridge inputs/outputs needed |
| Restart | Stop all server processes after mutations, start a fresh process | Repeat API and Git probes | Which state survives and whether Git/API identity remains coherent |

A source scan must independently search route/server/process code for `git-upload-pack`, `git-receive-pack`, smart HTTP content types, SSH serving, Git subprocess invocation, and filesystem repository storage. The final result for each direction is exactly `synchronized`, `not synchronized`, or `unknown`.

## Mandatory Source-of-Truth Ownership Matrix

The deep-dive report must fill this table from runtime evidence. “Bridge required” is insufficient without the concrete operation that copies a value, its source, destination, trigger, and failure/readback behavior.

| Fact/resource | Emulator API owner | Real Git owner | Automatic synchronization result | Required bridge if absent | Canonical test oracle |
| --- | --- | --- | --- | --- | --- |
| refs/branch heads | to determine | bare remote refs | synchronized / not synchronized / unknown | concrete trigger and readback | to determine |
| commits and parents | to determine | Git object database | synchronized / not synchronized / unknown | concrete trigger and readback | to determine |
| trees/blobs | to determine | Git object database | synchronized / not synchronized / unknown | concrete trigger and readback | to determine |
| source/Integration PR head/base | to determine | provider projection of refs | synchronized / not synchronized / unknown | concrete trigger and readback | to determine |
| merge result and merge commit | to determine | real no-ff commit/ref | synchronized / not synchronized / unknown | concrete trigger and readback | to determine |
| final `main` Card/README/DAG | to determine | real Git | synchronized / not synchronized / unknown | concrete trigger and readback | to determine |
| comments/reviews/checks | emulator collections | not Git-backed | n/a | none or event bridge | to determine |

## Mandatory Persistence Matrix

Persistence claims are split by runtime mode; one mode cannot stand in for another.

| Mode | Required evidence |
| --- | --- |
| Programmatic core/server API | Determine whether a persistence adapter can be attached. If yes, run process A, create and update a comment plus PR/ref/object state, stop it, start process B with the same file, and read all state back. |
| Embedded/Next adapter | Inspect and, if runnable without unrelated framework setup, execute its load/save lifecycle and two-instance restart behavior. Record atomicity/concurrency semantics. |
| CLI `emulate start` | Run two separate CLI processes against an explicitly configured shared state file. If CLI has no persistence option, record `unsupported`; the existence of `filePersistence` elsewhere is not evidence for CLI persistence. |

The proposed adoption mode must pass the two-process comment CRUD, PR, ref, commit/tree/blob readback. Otherwise adoption must include a concrete wrapper or be rejected.

## Mandatory Action Endpoint And Request Inventory

Run the current `OctokitGithubPlatform` and the real Action composition transport against the emulator. Record whether endpoint/auth configuration requires only composition-root configuration, a production runtime change, an adapter fork, or an emulator fork. Assert exact REST and GraphQL URLs and prove replay/emulator mode has no fallback to `api.github.com`.

Every current provider operation must be classified as `compatible and exercised`, `implemented but semantically incompatible`, `not implemented`, or `not exercised`. The inventory includes:

- main and Integration refs; recursive trees; blobs; commit and parent readback;
- PR list and exact PR read; changed files; base retarget; Draft Integration PR creation;
- reviews and check runs with pagination/current-head identity;
- Contribution merge and merge-result/current-main readback;
- GraphQL `markPullRequestReadyForReview`;
- future product-required issue comment list/create/update/readback;
- intentionally fail-closed Integration merge/base-current gate.

For GraphQL absence, prove route absence from source and run the actual adapter operation to capture the failure. README route tables are not sufficient.

## Mandatory Webhook Matrix

Exercise or source-classify source PR opened/synchronize/edited/closed, Integration PR creation/ready/merged, issue comment create/update, review submitted/dismissed, checks queued/completed, and ref create/update. For each event record whether it is automatically generated by the corresponding state mutation, manually dispatchable only, delivered after persistence, retried after failure, and suitable only as a wakeup. Delivery failure and duplicate delivery must be included.

## Official Provider Reference Set

- REST issue comments: https://docs.github.com/en/rest/issues/comments
- REST pull requests: https://docs.github.com/en/rest/pulls/pulls
- REST reviews: https://docs.github.com/en/rest/pulls/reviews
- REST check runs: https://docs.github.com/en/rest/checks/runs
- REST Git refs: https://docs.github.com/en/rest/git/refs
- REST Git commits: https://docs.github.com/en/rest/git/commits
- REST Git trees: https://docs.github.com/en/rest/git/trees
- REST Git blobs: https://docs.github.com/en/rest/git/blobs
- GraphQL `markPullRequestReadyForReview`: https://docs.github.com/en/graphql/reference/mutations#markpullrequestreadyforreview
- Webhook events and payloads: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- Git smart HTTP protocol: https://git-scm.com/docs/http-protocol
