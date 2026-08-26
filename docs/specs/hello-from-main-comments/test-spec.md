# Hello from Main Comments and File-backed Local Action Test Spec

状态：`DRAFT/REVIEW_REQUIRED`。本规格覆盖未实现的 Comment/file-backed slice；当前 green baseline 不等于 feature 已实现。

## Oracles

Bare Git/`RealGitWorkspace` is sole Git oracle: exact ref, tree path set, blob bytes/OID, parsed Card, README marker boundary, parent ordering and DAG. Local projection mismatch is fail closed. Comment behavior compares typed intent/fact/`PublishedCardTarget`/derived URLs, never body substrings. Renderer tests may verify structure/escaping only.

## Explicit Test Matrix

| ID | Scope | Required assertion / owned test paths |
| --- | --- | --- |
| C-S1 | setup | source-status target/key/payload/readback/no duplicate; `test/unit/core/**`. |
| C-V1 | validation invalid partitions | all typed codes, head/path binding, merge blocked; `test/unit/core/**`. |
| C-V2 | validation success/repair | same slot update, new head recompute; `test/unit/core/**`. |
| C-R1 | Ready | contributor/Integration PR/candidate head/blob/Approval scope; `test/unit/core/**`. |
| C-C1 | completion priority | final Git validation is not quiescent until both obligations; no remerge; `test/unit/core/**`. |
| C-C2 | two completion targets/link | independent source/integration failure; same `PublishedCardTarget`, typed derived Card/source URLs; `test/unit/core/**`. |
| C-I1 | key/phase | slots and mutable phase/body update rules; `test/unit/core/**`. |
| C-I2 | owner spoofing | marker user, null `user`, positive canonical decimal actor ID/type mismatch, same login/different ID, same ID/wrong type, unsafe numeric ID, missing/unavailable expected Bot principal, `User` marker spoof, duplicate owned, cross-run; `performed_via_github_app.id`/login/App slug never decide ownership; `test/unit/core/**`. |
| C-I3 | coherence | pre-read compares ID/principal/key/exact Core-observed body; intended update is authorized only when current exact body equals that observation; unexpected body/principal/key change is stale/ambiguous; post-read mismatch is stale/unknown with no rollback; missing/malformed `updated_at` alone is allowed; `test/unit/core/**`. |
| C-L1 | invalid permalink target | untrusted web base, owner/repo/OID/path/blob/source PR invalid or mismatch fails closed; `test/unit/**`. |
| C-R2 | renderer | typed payload, safe URL encoding, escaping/control chars; `test/unit/**`. |
| A-H1 | local open/wake/close | state, test-owned in-memory recorder, real Git shell/ref, setup comment; `test/local/**`. |
| A-H2 | fresh reconstruction | close/discard/reopen, version/OID reload, duplicate no-op; `test/local/**`. |
| A-H3 | event ingress | push/check/review fixture files use production-shaped composition; `test/local/**`. |
| A-H4 | isolation | separate dirs/repos/state and one writer per canonical directory; each test orchestrator owns its recorder; `test/local/**`. |
| A-G1 | projection mismatch | snapshot OID/ref/tree/blob/parent mismatch blocks lifecycle; `test/local/**`. |
| A-S1 | snapshot valid/reopen | valid versioned state reloads after close/discard/reopen and converges duplicate work to no-op; `test/local/**`. |
| A-S2 | snapshot corrupt/version | corrupt, truncated, or unknown snapshot version fails closed with no reset; `test/local/**`. |
| A-E1 | in-memory recorder | a shared test-owned `EffectRecord[]`/callback sees attempted/completed create, expected updates/no-ops, and wrong-target calls across fresh platform reopen in one test process; it has no persistence, recovery, or crash-gap assertions; `test/local/**`. |
| A-R1 | response loss | atomic state mutation followed by lost response; fresh reopen/readback is no-op/already-applied; `test/local/**`. |
| O-S1 | raw-header Link pagination | transport exposes raw lowercased `link`, `retry-after`, and rate-limit headers; adapter parses `terminal`/`next(URL)`/`malformed`, follows only validated forward links within request/page budget; absent Link on a full page is terminal; no response-length inference; malformed, prev/last-only, wrong/non-progressing/cyclic/conflicting Link and budget exhaustion are incomplete with no mutation; `test/adapters/octokit.test.ts`. |
| O-S2 | list identity and lossless principal | exact list `200` payload; non-null `user`; canonical positive decimal actor ID/type; this slice rejects unsafe JavaScript numeric IDs above `Number.isSafeInteger` rather than rounding them; expected principal unavailable/mismatch fails closed; controlled-marker key, exact body, optional `updated_at`; null user, same login/different ID, same ID/wrong type, `User` marker spoof, App metadata mismatch, exact duplicate dedup, conflicting duplicate incomplete; `performed_via_github_app.id` never proves ownership; `test/adapters/octokit.test.ts`. |
| O-S3 | exact create/readback/statuses | POST exact path/body and `201` target-comment schema, then read/list `200` exact intent/body; list/read/PATCH wrong 2xx and create wrong 2xx are not success; malformed/wrong-target payload unknown; explicit 401/403/404/410/422/429/5xx/transport mappings with retained retry metadata; `test/adapters/octokit.test.ts`. |
| O-S4 | patch coherence/readback | GET `200` compares ID/principal/key/exact last Core-observed body before PATCH; unexpected interleaving body change is stale/ambiguous and no overwrite; PATCH exact path/body requires `200`, then GET/list exact readback; mismatch stale/unknown with no rollback; missing/malformed `updated_at` alone allowed; `test/adapters/octokit.test.ts`. |
| O-S5 | conditional response-loss convergence | no idempotency key; lost POST before response, delayed visibility, exact one-match readback=`alreadyApplied`, zero visible=`unknownOutcome/await` with bounded backoff and no immediate repeat POST in same lifecycle, multiple/conflicting match=fail closed/manual recovery; lost PATCH requires readback and stale/unknown mismatch; no automatic delete/repair; Local atomic-state evidence is not provider duplicate-free proof; `test/adapters/octokit.test.ts`. |
| O-R1 | GraphQL ready | existing exact mutation/post-read retained; `test/adapters/octokit.test.ts`. |
| O-E1 | emulator exclusion | no emulator transport/fixture; Local/replay/real Git remain; `test/adapters/**`. |
| F-O1 | ordering/wakeups | deterministic duplicate/missed/reordered, one effect; `test/stability/**`. |
| F-C1 | source completion fault | published Git immutable; source-only retry; `test/stability/**`. |
| F-C2 | integration completion fault | published Git immutable; integration-only retry; `test/stability/**`. |
| F-C3 | stale/permission/loss | no remerge and typed recovery; `test/stability/**`. |
| F-R1 | response-loss/reopen | state reload plus provider/Git readback converges without duplicate semantic effect; `test/stability/**`. |
| F-S1 | snapshot failures | corrupt/unknown version fails closed; `test/stability/**`. |
| G-G1 | conflict oracle | replace stage `toContain` with exact stage bytes/path/rebase identity; `test/local/git-scenario.test.ts`. |
| G-G2 | candidate/final bytes | exact Card/README bytes, parser/marker/tree/blob assertions; `test/local/git-scenario.test.ts`. |
| G-G3 | DAG oracle | bare ref, merge parent ordering, ancestry/OIDs exact; `test/local/git-scenario.test.ts`. |
| L5-1 | actor/UI/notifications | skipped: Maintainer disposable repo/fork/App capture. |
| L5-2 | webhook delivery | skipped: Maintainer disposable workflow/delivery capture. |
| L5-3 | ready/Approval permissions | skipped: contributor/App disposable evidence. |
| L5-4 | base-current gate | skipped: ruleset/check disposable evidence. |
| L5-5 | cleanup | skipped: resource deletion/leftover capture. |
| L5-6 | bundle revision | skipped: trusted bundle/ref capture. |

L3 pagination: runtime transport preserves raw lowercased headers and adapter parses official `Link rel="next"` into `terminal`/`next(URL)`/`malformed`, following validated links only within a bounded request/page budget. Absent Link is terminal regardless of page length; no response-length inference. A malformed/nonprogressing/wrong-target/cyclic Link, budget exhaustion or conflicting duplicate blocks create/PATCH. Comment success is exact (`200` list/read/PATCH, `201` create) with schema validation; wrong 2xx or malformed/wrong-target payload is unknown. `Retry-After` and rate-limit headers are preserved for 429/rate/5xx/transport classifications. `updated_at` is optional diagnostic/coherence evidence: missing or malformed values alone do not block complete required identity/body facts, and a changed value is handled by stale/unknown post-read reconcile. Local snapshot version is not a GitHub timestamp.

Current baseline: `npm test -- --run` 109/109 and `npm run verify:pre-canary` green on this revision, but neither covers this unimplemented slice. Historical 5000ms timeout is a regression risk; rerun same commands after implementation and stabilize without weakening G-G assertions if it recurs. L5 has no current command.
