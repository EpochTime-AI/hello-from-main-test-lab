# `vercel-labs/emulate` And Hello From Main

## Basic Information

- **Target:** `vercel-labs-emulate-local-action`
- **Evidence type:** `SOURCE_REPO`
- **Upstream:** `https://github.com/vercel-labs/emulate`
- **Inspected checkout:** `/tmp/opencode/hello-main-emulate-spike`
- **Exact commit:** `d0219d05818adca4c12bb76ec79a7562c1766a3d` (`v0.10.0`, 2026-08-19)
- **Selection rationale:** the only identified candidate with stateful GitHub-style mutations and a file persistence facility. The central question is whether it can replace the provider-facing canonical local Action path without treating REST Git Data as real Git.
- **Evidence cache:** `docs/research/local-action-emulator/evidence/emulate-runtime.md`

## Core Assessment

**Conclusion: reject as a replacement for the provider-facing canonical local Action path.** It can be useful only as an optional, explicitly non-canonical REST component test fixture after a separate, maintained wrapper is built and validated. It cannot stand in for the current canonical path because it has no Git smart HTTP/SSH service, no automatic bridge to the real bare repositories that carry Hello from Main's required add/add conflict and merge DAG, no GitHub GraphQL endpoint for the current ready-for-review effect, no CLI persistence, and its production Action transport currently hardcodes real GitHub hosts.

The decisive boundary is not REST coverage. The emulator implements many relevant REST resources in one in-memory Store, but its refs, commits, trees, blobs, PR heads, and merge commits are emulator collections. Hello from Main deliberately makes `RealGitWorkspace` and its bare remote authoritative for the Project Shell, contributor rebase, no-fast-forward merges, final Card/README bytes, and DAG postconditions. These are two distinct object graphs. The upstream code contains no transport, subprocess, repository storage, watcher, or importer that could make them one graph.

Runtime claims are bounded by an installation blocker: two `pnpm install --frozen-lockfile` attempts could not complete because registry downloads repeatedly reset/timed out. No built artifacts existed, so neither an emulator server nor CLI process could be started. All claims that require a live process remain explicitly `unknown`; negative Git/GraphQL/CLI-persistence classifications are source-confirmed, not guessed from the README.

## Actual Inspection Paths

### Upstream Primary Evidence

- Package and release/runtime metadata: `package.json`, `packages/emulate/package.json`, `packages/@emulators/core/package.json`, `packages/@emulators/github/package.json`, `CHANGELOG.md`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `LICENSE`.
- Server/state/persistence: `packages/@emulators/core/src/server.ts`, `store.ts`, `persistence.ts`, `webhooks.ts`; `packages/emulate/src/index.ts`, `commands/start.ts`; `packages/@emulators/adapter-next/src/index.ts`; `packages/@emulators/adapter-nuxt/src/index.ts`.
- GitHub registration/data routes: `packages/@emulators/github/src/index.ts`, `store.ts`, `entities.ts`, `git-helpers.ts`, `helpers.ts`, `route-helpers.ts`.
- GitHub endpoint families: `routes/comments.ts`, `pulls.ts`, `reviews.ts`, `checks.ts`, `branches.ts`, `commits.ts`, `webhooks.ts`, `contents.ts`, `issues.ts`.
- Tests: `packages/@emulators/github/src/__tests__/{repos,issues,contents-commits,webhook-installation}.test.ts`; `packages/@emulators/core/src/__tests__/persistence.test.ts`.
- Source scans: all TypeScript/JavaScript sources for `git-upload-pack`, `git-receive-pack`, `application/x-git`, SSH serving, Git process invocation, Git filesystem storage, persistence, and GraphQL routes.

### Hello From Main Fit Evidence

- `src/adapters/octokit.ts:118-282` (provider observation), `:454-502` (GraphQL ready mutation), `:635-709` (changed-files pagination), `:715-843` (reviews/checks pagination), `:846-881` (tree/blob reads), and `:897-965` (PR/ref reads).
- `src/entry/action-runtime.ts:76-121` (production composition), `:162-200` (real-Git Project Shell bridge), and `:253-303` (literal REST/GraphQL transport URLs).
- `src/adapters/local-github.ts`, `src/adapters/git.ts`, `src/ports/github-platform.ts`, `src/entry/watchdog.ts`.
- `test/local/git-scenario.test.ts`, `test/adapters/{local-github,octokit}.test.ts`, `test/runtime/composition.test.ts`, and `test/stability/{fault-scheduler,unknown-outcome,restart-recovery,publication-pipeline,publication-gates}.test.ts`.
- Product requirements: `docs/product-design.md:170-280`.

## Fixed Questions

### 1. REST And GraphQL Resources Used By Hello From Main

Every row uses exactly one required provider-operation category. `Runtime evidence` is deliberately separate: it records whether the current adapter/Action operation was actually executed against a running emulator, not whether source routes exist.

| Required operation | Provider-operation category | Runtime evidence | Evidence and compatibility boundary |
| --- | --- | --- |
| Main/Integration ref read; ref create/update | implemented but semantically incompatible | not exercised | REST routes are in `branches.ts:683-843`, but they mutate Store entities rather than the bare remote read by `RealGitWorkspace`. |
| Recursive tree read | implemented but semantically incompatible | not exercised | `branches.ts:928-1036` reads/writes emulator Store trees, not Git object-database trees. |
| Blob read | implemented but semantically incompatible | not exercised | `branches.ts:1040-1085` reads/writes emulator Store blobs, not bare-remote objects. |
| Commit and parent readback | implemented but semantically incompatible | not exercised | `branches.ts:846-924` and `commits.ts:92-227` model history in the Store. |
| PR list and exact PR read | not exercised | not exercised | Source routes exist at `pulls.ts:304-347,466-482`, but no current adapter request was sent to a running emulator. |
| PR changed files | implemented but semantically incompatible | not exercised | `pulls.ts:748-783` returns synthetic `fileN.ts` entries and generated SHAs, incompatible with `OctokitGithubPlatform.readSourceIntake` (`src/adapters/octokit.ts:635-663`). |
| Contribution PR base retarget | not exercised | not exercised | Source PATCH supports `base` at `pulls.ts:484-592`; adapter operation is `src/adapters/octokit.ts:425-452`, but no live request was made. |
| Draft Integration PR creation | not exercised | not exercised | Source POST accepts `draft` at `pulls.ts:349-463`; adapter operation is `src/adapters/octokit.ts:358-423`, but no live request was made. |
| Reviews with pagination/current-head identity | not exercised | not exercised | Route list/create/read support is `reviews.ts:109-352`; adapter’s identity mapping is `src/adapters/octokit.ts:715-740`. Compatibility was not exercised. |
| Check runs with pagination/current-head identity | implemented but semantically incompatible | not exercised | `checks.ts:415-747` stores caller-provided `head_sha` without linking it to real Git; adapter requires head equality at `src/adapters/octokit.ts:758-792`. |
| Contribution merge and merge-result/current-main readback | implemented but semantically incompatible | not exercised | `pulls.ts:595-720` creates a Store merge commit and moves a Store branch; it does not perform `git merge`/push or update a bare remote. |
| GraphQL `markPullRequestReadyForReview` | not implemented | not exercised | The exact adapter mutation is `src/adapters/octokit.ts:454-502`. The scoped source scan in `evidence/emulate-runtime.md` found no GitHub GraphQL route/import/executor. No live request or 404 was captured. |
| Future issue-comment list/create/update/readback | not exercised | not exercised | REST state routes exist at `comments.ts:88-148,191-215,427-517`, but the current port has no comment operation (`src/ports/github-platform.ts:14-56`) and no runnable HTTP spike tested it. |
| Intentionally fail-closed Integration merge/base-current gate | not implemented | not exercised | The current adapter returns `gateUnsupported` without an ordinary merge call (`src/adapters/octokit.ts:93-103`). Emulator branch protections do not establish the required authoritative base-current CAS. |

**Decision contribution:** REST shape coverage is insufficient for a canonical path because the current adapter derives workflow facts from actual Git object identity and changed files. A route that shares an endpoint name but returns synthetic or independent objects cannot prove those facts.

### 2. Stateful Comments And Restart Persistence

**Fact:** issue comments are inserted into `gh.comments`, returned by issue-scoped and repository-wide list routes, retrieved by ID, and updated by ID (`comments.ts:88-148`, `191-215`, `427-517`). Comment mutations dispatch `issue_comment` events after the Store mutation (`comments.ts:127-148`, `478-517`).

**Fact:** `createServer()` has no persistence parameter and allocates a new Store (`core/src/server.ts:15-31`). The CLI has no persistence/state-file option and resets stores during shutdown (`emulate/src/index.ts:32-68`, `commands/start.ts:253-269`). CLI two-process persistence is therefore **unsupported**.

**Fact:** Next/Nuxt embeddings load and restore a Store snapshot, then queue a save after a mutating request (`adapter-next/src/index.ts:169-290`; `adapter-nuxt/src/index.ts:288-414`). `filePersistence` is overwrite-only `writeFile`, with no lock, temp file, fsync, or atomic rename (`core/src/persistence.ts:9-22`).

**Unknown:** POST/PATCH/GET live behavior and two-process persistence of comment plus PR/ref/commit/tree/blob were not run. Frozen installation did not complete after 120-second and 600-second attempts. The source supports neither a claim that the core/CLI survives restart nor a claim that embedded persistence is atomic/concurrency safe.

**Decision contribution:** the candidate fails the proposed canonical CLI/server mode. An embedded framework adapter would add an otherwise-unneeded Next/Nuxt HTTP host and snapshot lifecycle to a Node Action spike, while still not joining real Git state.

### 3. PR Reviews, Checks, Git Data, Draft/Ready, Retarget, And Merge

**Facts:**

- Reviews support POST/list/get/pending submit/dismiss and webhook dispatch (`reviews.ts:109-352`).
- Checks support create/update and check-run listing by Store ref/SHA (`checks.ts:415-747`).
- REST Git refs, commits, trees, and blobs support creation/read/update within `GitHubStore` (`branches.ts:683-1085`).
- PR creation accepts `draft`, PATCH accepts `base` and `draft`, and merge creates a Store commit/moves Store branch state (`pulls.ts:349-720`).
- No dedicated `ready_for_review` REST route exists. Generic PATCH `draft:false` is not the current GraphQL mutation and emits no `pull_request` `ready_for_review` event because the PATCH dispatch only handles state/title/body changes (`pulls.ts:484-592`).
- PR changed files are synthetic rather than a real diff (`pulls.ts:748-783`).

**Inference:** these resource models can drive focused adapter-level state tests, but their behavioral contract is weaker than Hello from Main's actual operations: it does not enforce actual object reachability for check heads, does not integrate PR head updates with Git push, and does not exercise actual rebase/merge semantics.

### 4. Can The Current Transport Target It Without Forks Or Fallback?

**Fact:** `OctokitGithubPlatform` accepts the narrow injected `OctokitRequestTransport` seam (`src/adapters/octokit.ts:42-66`), so no production adapter fork is structurally necessary.

**Fact:** `createGithubTransport` in the actual Action runtime has literal REST and GraphQL hosts: `https://api.github.com${request.path}` and `https://api.github.com/graphql` (`src/entry/action-runtime.ts:253-303`). No endpoint configuration exists.

**Fact:** replay mode already fails closed at the injected transport boundary (`src/adapters/octokit.ts:982-1006`; `test/adapters/octokit.test.ts:78-98`).

**Inference:** local emulator wiring requires a production runtime/composition-root change to configure a REST base URL and separately a GraphQL base URL. It cannot be only environment configuration without changing `createGithubTransport`. The REST base could be configured to target emulate, but the GraphQL endpoint is source-absent; any fallback to GitHub would be an implementation defect and must be forbidden by a later request-capture test.

**Endpoint exercise status: `not exercised`.** Installation prevented an emulator process, so neither `OctokitGithubPlatform` nor the real Action transport ran against it. There is no actual HTTP 404, URL capture, or fallback capture. The source scan confirms GitHub GraphQL route absence only.

### 5. Webhooks: Automatic State Coupling, Delivery, Retry

This is source classification only; no webhook HTTP delivery was exercised. “Persistence ordering” means the order visible in source, not a demonstrated durable-write guarantee.

| Required event/state mutation | Event classification | Source trigger and persistence ordering | Retry, duplicate, failure, and wakeup suitability |
| --- | --- | --- | --- |
| Source PR opened | automatic | `POST /pulls` inserts issue/PR Store state, then calls `webhooks.dispatch("pull_request", "opened", ...)` (`pulls.ts:383-463`). No standalone-server persistence occurs. | Dispatcher has no retry. Each caller dispatch is a new delivery; failure is recorded then swallowed. Wakeup-only. |
| Source PR synchronize after contributor push | absent | No route or watcher observes a Git client push. The PR PATCH route dispatches only `closed`, `reopened`, or `edited`, never `synchronize` (`pulls.ts:484-592`). | Cannot be automatically or manually produced through a source-PR push pathway. A direct dispatcher caller could synthesize an arbitrary event programmatically, but no REST manual-dispatch route exposes it. Wakeup-only if a fixture injects one. |
| Source PR edited | automatic, partial | PATCH changes title/body and then calls `pull_request/edited`; base-only retarget and `draft` toggle do not take that branch (`pulls.ts:497-592`). Store mutation precedes dispatch call. | No retry; duplicate only from repeated caller mutations/dispatches; failed delivery recorded and swallowed. Wakeup-only. |
| Source PR closed | automatic | PATCH state transition from open to closed updates Store state and calls `pull_request/closed` (`pulls.ts:509-576`). | No retry; duplicate only caller-induced; failure recorded and swallowed. Wakeup-only. |
| Integration PR creation/opened | automatic | Same `POST /pulls` route inserts Store PR then dispatches `pull_request/opened` (`pulls.ts:349-463`). | No retry; duplicates caller-induced; failure recorded and swallowed. Wakeup-only. |
| Integration PR ready | absent | Generic PATCH accepts `draft:false` but does not dispatch `ready_for_review`; GitHub GraphQL mutation is absent (`pulls.ts:528-592`; source scan in evidence cache). | No automatic or REST manual dispatch for ready. Wakeup-only only if an external fixture injects it. |
| Integration PR merged | automatic | PUT merge writes Store merge commit/ref/PR closure, then calls `pull_request/closed` with `merged:true` (`pulls.ts:652-719`). | No retry; duplicates caller-induced; delivery failure recorded and swallowed. It is not tied to a real Git merge. Wakeup-only. |
| Issue comment create | automatic | Comment is inserted and count updated before `issue_comment/created` dispatch (`comments.ts:478-517`). | No retry; duplicates caller-induced; failure recorded and swallowed. Wakeup-only. |
| Issue comment update | automatic | Comment Store row is updated before `issue_comment/edited` dispatch (`comments.ts:107-148`). | No retry; duplicates caller-induced; failure recorded and swallowed. Wakeup-only. |
| Review submitted | automatic | Submitted review is written/updated before `pull_request_review/submitted` dispatch (`reviews.ts:169-219,273-315`). | No retry; duplicates caller-induced; failure recorded and swallowed. Wakeup-only. |
| Review dismissed | automatic | Review state is changed to `DISMISSED` before `pull_request_review/dismissed` dispatch (`reviews.ts:317-352`). | No retry; duplicates caller-induced; failure recorded and swallowed. Wakeup-only. |
| Check queued | absent | Creating a queued check run emits `check_run/created`, not `queued` (`checks.ts:415-519`). Rerequest emits `rerequested`, not `queued` (`checks.ts:685-708`). | No automatic `queued` event and no REST manual route for it. Wakeup-only only if a fixture injects it. |
| Check completed | automatic, fire-and-forget | PATCH writes the Store run and recomputes suite before `void webhooks.dispatch(..., "completed")` on a non-completed to completed transition (`checks.ts:521-634`). | No retry; duplicate only caller-induced. The HTTP response can return before delivery finishes; failure is recorded and swallowed. Wakeup-only. |
| Ref create | automatic | POST ref inserts/updates Store ref/branch before `create` dispatch (`branches.ts:711-762`). | No retry; duplicates caller-induced; failure recorded and swallowed. No real Git push coupling. Wakeup-only. |
| Ref update | automatic | PATCH ref updates Store ref/branch before `push` dispatch (`branches.ts:765-821`). | No retry; duplicates caller-induced; failure recorded and swallowed. No real Git push coupling. Wakeup-only. |
| Manual delivery | manual-only, limited | Hook ping/test endpoints manually dispatch only `ping` and synthetic `push` (`webhooks.ts:251-302`); arbitrary required events have no REST dispatch endpoint. | Same dispatcher behavior; not a redelivery/retry facility. Wakeup-only. |

**Fact:** the dispatcher awaits each fetch internally, records failure/success once, and has no retry/redelivery logic (`core/src/webhooks.ts:103-157`). Hooks and delivery records are in `WebhookDispatcher`, outside Store snapshots (`core/src/webhooks.ts:52-57,160-171`; `adapter-next/src/index.ts:66-81`). Thus no mutation proves delivery after durable persistence: in standalone CLI/server there is no Store persistence, and embedded adapters enqueue snapshots after handler execution while webhook subscription/delivery state is not snapshotted. The source order only proves Store mutation before dispatch invocation.

**Decision contribution:** webhooks are only optional wakeup signals. The implementation cannot test real Git push event coupling, redelivery, durable retries, or the current Action event origin; deterministic duplicate/missed/reordered wakeup tests must remain.

### 6. Smart Git/SSH And Synchronization With Real Bare Git

The required source scan found neither smart HTTP (`git-upload-pack`, `git-receive-pack`, Git media types), SSH server, Git subprocess invocation, repository filesystem storage, remote watcher, nor importer. The URL fields in `helpers.ts:272-274` are generated metadata only.

| Direction | Runtime result | Source classification | Exact reason |
| --- | --- | --- | --- |
| Git client -> emulator (`ls-remote`, clone, fetch, commit, push; smart HTTP/SSH probes) | `unknown` | `not synchronized` | No server route/protocol can advertise or receive Git packs; no SSH daemon exists. |
| Emulator REST Git Data -> real Git client | `unknown` | `not synchronized` | REST writes Store collections only; no bare object/ref write implementation exists. |
| Real bare Git push -> emulator API | `unknown` | `not synchronized` | No remote observation, Git subprocess, filesystem repository store, or event bridge exists. |
| Restart Git/API identity | `unknown` | `not synchronized` | CLI clears Store; embedded snapshot has no real Git relation. |

The blocked runtime command sequence and required follow-up `git ls-remote`, clone/fetch/push, `info/refs`, `git-upload-pack`, and `git-receive-pack` probes are retained in `evidence/emulate-runtime.md`. They remain required if a downstream change claims a new transport capability.

### 7. Can It Test Faults, Timing, Pagination, Permissions, Restart?

**Facts:** lists use page/per-page and Link headers in relevant route families; route helpers perform simplified scopes/permissions; embedded persistence can restore Store snapshots. The server has a fixed in-memory rate counter and basic token maps (`core/src/server.ts:32-90`).

**Facts:** there is no source-level configurable fault scheduler for response loss, duplicate delivery, delayed visibility, or real remote sync. Webhook failures are swallowed after recording a result (`core/src/webhooks.ts:136-156`); retries are absent.

**Inference:** happy-path pagination and selected permission response mapping can be tested against an embedded instance. Response loss after a committed mutation, duplicate/missed/reordered wakeups, delayed visibility, cancellation, restart from independent facts, and all Git timing must remain deterministic fakes plus real local Git tests. Introducing emulator timing would reduce determinism without creating GitHub provider fidelity.

### 8. Lifecycle, Maturity, Persistence, Runtime, And Security

| Dimension | Finding | Adoption impact |
| --- | --- | --- |
| License | Apache-2.0 in root and package manifests. | Compatible for experimentation, subject to project policy. |
| Version/release | `0.10.0`, tagged on inspected HEAD; release workflow packages all service modules through npm OIDC provenance (`.github/workflows/release.yml:53-111`). | Pre-1.0 API stability risk remains. |
| Maintenance signals | CI runs frozen install, build, type check, lint and tests on Node 24 (`.github/workflows/ci.yml:13-39`). Changelog documents active GitHub API expansion in 0.10.0 (`CHANGELOG.md:4-20`). | Positive maintenance signal, not a compatibility guarantee. |
| Runtime/build | pnpm 11 and Node 24 required (`package.json:26-30`); monorepo has 27 workspaces including unrelated providers. | Current Hello from Main Node 24 is compatible, but local install was network-fragile and pulled broad workspace dependencies. |
| Persistence | CLI in-memory; embedding snapshot save is asynchronous whole-file overwrite. `filePersistence` has no atomicity, fsync, lock or corruption distinction. | Unsuitable as a durable test oracle or concurrent process state source. |
| Cleanup | CLI reset/close is signal-based; adapters have no cross-process cleanup/state ownership mechanism. | Temp state and port/process cleanup need external ownership. |
| Webhooks | Best-effort, no retries; dispatcher state not snapshotted. | Not a durable workflow queue. |
| Security | Test data is Store content; source does not execute contributor Git content. But an Action-specific wrapper would have to ensure no fork files are executed and no real credentials/remotes are routed through it. | Must remain isolated from production tokens and real GitHub endpoints. |

### 9. Exact Existing Test Mapping

| Current test/surface | Recommendation | Rationale |
| --- | --- | --- |
| `test/local/git-scenario.test.ts:22-434` | **Retain in full.** | It proves real add/add conflict, rebase, push, no-ff merge, bare remote readback, Card/README bytes, parent ancestry and restart. Emulator cannot replace any of those. |
| `test/adapters/local-github.test.ts:51-275` | **Retain initially; later shrink only its REST-topology modeling after an emulator-backed contract test is proven.** | It documents the current modeled setup/PR/review/merge topology. The Git delegation assertions remain valuable because emulator merges are not real Git. |
| `test/adapters/octokit.test.ts:8-1141` | **Retain exact request/mapping/fail-closed tests. Add, do not replace, a small emulator HTTP smoke subset if adopted optionally.** | The emulator does not prove GitHub semantics and lacks GraphQL; exact transport tests protect paths/payloads/error classification. |
| `test/runtime/composition.test.ts:7-29` and Action fixture mode in `action-runtime.ts:202-250` | **Retain.** | They prove one composition and package/entry seams, which an HTTP emulator does not cover. |
| `test/stability/fault-scheduler.test.ts:4-32` | **Retain.** | Emulator has no deterministic response-loss/duplicate/missed/reordered control. |
| `test/stability/unknown-outcome.test.ts:8-48` and `restart-recovery.test.ts:14-224` | **Retain.** | Needed failure/restart claims exceed Store persistence and retain independent postcondition checks. |
| `test/stability/publication-pipeline.test.ts:117-265`, `publication-gates.test.ts:105-205` | **Retain.** | The Integration merge base-current gate intentionally fails closed and the final-main/DAG oracle is real Git. |
| HTTP replay paths in `test/adapters/octokit.test.ts` | **Retain for faults and GraphQL; potentially shrink only REST happy-path response fixtures covered by a focused emulator smoke test.** | Replacement is conditional on exact REST request recording and a source-backed incompatibility list. |

The smallest safe architecture is therefore not a generic emulator architecture: preserve one Core/Reconciler, `OctokitGithubPlatform`, `RealGitWorkspace`, real temporary bare Git, injected deterministic transport/fault tests, and a narrow optional REST test harness. Do not introduce an emulator bridge into canonical local Action tests.

### 10. Product Comments And Other Requirements Made Testable

**Fact:** the product requires setup explanation comments after creating/retargeting PRs (`docs/product-design.md:170-177`), concrete validation feedback or `Card looks good` (`220-237`), ready-for-review guidance (`241-255`), and completion/final-link comments (`272-280`). These comment behaviors are not implemented in the current `GithubPlatform` port (`src/ports/github-platform.ts:14-56`) or Octokit adapter.

**Inference:** only after a later runnable spike captures comment CRUD, exact endpoint URLs/no fallback, and two-process embedded persistence may a stateful REST emulator be considered for a local HTTP smoke test of comment list/create/update/get idempotency. It cannot prove GitHub permissions, App identity, real `issue_comment` workflow delivery, or interactions with the actual Git topology. The current route support is sufficient only for a conditional local comment-state assertion, not for a production-path claim.

## Source-Of-Truth Ownership Matrix

| Fact/resource | Emulator API owner | Real Git owner | Automatic synchronization result | Required bridge if absent | Canonical test oracle |
| --- | --- | --- | --- | --- | --- |
| refs/branch heads | `gh.refs` / `gh.branches` Store collections | Bare remote refs | not synchronized | **Do not build for canonical tests.** If optional REST smoke data is required: test setup reads `git rev-parse <bare ref>`, creates/updates matching emulator REST ref before Action observation, then reads both REST ref and bare ref after each operation; mismatch fails the test. Trigger is test fixture setup only, never a background sync. | Bare remote `rev-parse`/`ls-remote`; emulator only for REST shape. |
| commits and parents | `gh.commits` Store collection | Git object database | not synchronized | Same fixture-only projection: read actual commit and parent OIDs with Git, POST only a matching emulator commit before REST read. A REST-created commit must never be pushed implicitly; any requested push is an explicit Git command followed by readback. | `git rev-list --parents` on bare remote. |
| trees/blobs | `gh.trees` / `gh.blobs` Store collections | Git object database | not synchronized | Fixture-only import/export is unsafe to call generic synchronization. If needed, enumerate Git tree/blob via Git CLI and seed exact bytes/OIDs; reject REST-created trees/blobs as evidence of real Git. | `git ls-tree`, `git show`, computed Git blob OID. |
| source/Integration PR head/base | `gh.pullRequests` fields | Provider projection of actual refs | not synchronized | Test fixture sets PR head/base after corresponding real refs exist, then reads API and bare refs. On a real Git push, explicit fixture code updates PR head and changed files; it must fail if source PR/base/head does not match Git readback. | Bare ref OIDs plus explicit PR REST read. |
| merge result and merge commit | REST merge creates Store commit and branch update | Real no-ff commit and ref | not synchronized | Canonical flow performs `RealGitWorkspace.mergeNoFastForward`/push first. A fixture may mirror its returned OID into an emulator PR only after bare-remote parent/OID readback. A failed REST mirror must not alter Git or make the test successful. | Real merge commit and parent list from bare remote. |
| final `main` Card/README/DAG | Emulator tree/branch values | Real Git | not synchronized | No emulator bridge for canonical tests. Read final `main` directly through `RealGitWorkspace.readFinalMainPostconditions`; optional emulator projection is display-only and failure does not replace Git readback. | Real Git final-main postconditions. |
| comments/reviews/checks | Emulator collections | Not Git-backed | n/a | None for local REST state. Optional event fixture registers hooks explicitly; hooks are wakeups only and no durable state derives from delivery. | REST readback plus deterministic fake fault tests. |

This table intentionally rejects a vague sync layer. Every hypothetical projection is test-fixture-only, one-directional, trigger-specific, and readback-checked. It is not a viable replacement for current production-style local Action composition.

## Evidence Boundary And Stop Conditions

### Runtime Results

- **Completed:** revision capture; package/source/route/state/persistence/webhook/GraphQL/smart-Git scans; current consumer/test mapping; install/build/test attempts.
- **Blocked:** executable upstream server, CLI, adapter persistence, actual comment CRUD, actual Action endpoint capture, and live smart-Git probes. Registry instability prevented `pnpm install --frozen-lockfile` from completing, and the checkout has no prebuilt `node_modules` or `dist`.
- **Not used:** real GitHub credentials, GitHub API, or external repositories.

### Stop Conditions For Any Future Optional Adoption

1. Stop if the test asserts a real Git CLI outcome from emulator REST Git Data state.
2. Stop if GraphQL ready-for-review is silently replaced by PATCH draft state, skipped, or sent to real GitHub.
3. Stop if a wrapper introduces bidirectional/background synchronization rather than the concrete, one-directional fixture projections above.
4. Stop if two-process embedded persistence cannot demonstrate comment, PR, ref, commit, tree and blob readback with the same state file, including a deliberate save failure and concurrent-writer policy.
5. Stop if captured REST/GraphQL URLs reveal `api.github.com` fallback in local emulator mode.
6. Stop if any test deletes real Git bare-remote/DAG assertions or deterministic fault/restart tests on the theory that REST state is equivalent.

## Contribution To The Research Question

This target supports a narrow claim: `vercel-labs/emulate` offers substantial, stateful GitHub REST surface area that could make future Bot timeline-comment CRUD locally observable. It weakens the proposed adoption decisively for the canonical local Action path: the service has a separate Git Data state model, no smart Git server or real-remote synchronization, absent GitHub GraphQL, and persistence only in embedded adapters with non-atomic whole-file writes. The correct downstream recommendation is rejection for replacement, not an emulator architecture or a production refactor.

## Status

`DONE_WITH_CONCERNS`: the requested deep-dive artifact and reusable evidence cache are written. The report is not self-approved. The independent report review must assess source citations, source/runtime classification boundaries, and whether the blocked executable matrix prevents any broader conclusion.
