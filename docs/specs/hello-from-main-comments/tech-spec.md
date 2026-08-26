# Hello from Main Comments and File-backed Local Action Tech Spec

状态：`DRAFT/REVIEW_REQUIRED`。当前 slice 是 MVP 首次 Tutorial Run 的 setup、typed validation feedback/success、Ready/Approval、两张关联 PR 的 completion/final link 与 production-shaped file-backed Local Action；已完成 Card update flow 不在范围。本 spec 不表示 feature 已实现。

## Source, Current State, and Shape

产品 source 是 `CONTEXT.md`、`docs/product-design.md` 的 170-177、218-237、239-255、272-280、安全/恢复/验收，以及 ADR 0001-0004。当前已有单一 `src/core/reconciler.ts`、`GithubPlatform`/`GitWorkspace`、`RealGitWorkspace`、in-memory Local adapter、Octokit REST/GraphQL replay、Action/CLI/watchdog 与真实 Git tests；没有 Comment capability、file-backed state/harness。`LocalGithubPlatform` 当前硬编码 Alice/source PR 1/title-length PR number/caller topology，必须移除。

一个 Core/Reconciler 继续是唯一 lifecycle owner。每 turn 重读 provider facts 和真实 Git readback，至多执行一个 effect。真实 bare Git/`RealGitWorkspace` 是 refs、objects、tree/blob、Card/README bytes、merge parents 和 DAG 的唯一 oracle；Local state 只保存 provider semantics，且只投影已 readback 的 Git OID。

稳定设计细节见 `docs/design/file-backed-local-action.md`，一致性矩阵见 `docs/design/file-backed-local-action-consistency.md`。

## Comment Semantic Contract

`actionKey = runIdentity + targetPullRequestNumber + slot`，其中 run identity 绑定 source PR 与 immutable contributor `github_id`。phase/body 是 mutable payload，不进 key。slots 恰为：Contribution PR `source-status`（`setup -> validation-feedback -> validation-success -> completion` update/supersede）；Integration PR `integration-status`（`ready-guidance -> completion` update/supersede）。两张 PR 各自仍有独立的 completion obligation。

Comment fact 最少包含 numeric comment ID、非 null `user`、owner principal、从 controlled marker 解析的 action key、exact body，以及可选 `updated_at` diagnostic/coherence value。owner principal 是 stable provider actor ID canonical decimal string + exact actor type（`Bot`/`User` 或 provider exact enum）。trusted composition 配置 expected principal 为 lossless canonical decimal string ID 与 exact provider actor type；ID 必须满足正十进制语法，expected principal unavailable 时在 mutation 前 fail closed。本 slice 选择最小 transport/parser 策略：fetch JSON materialize 的 GitHub `int64` 若不是 `Number.isSafeInteger` 就拒绝，绝不把 rounded JavaScript number 转成 ID；raw JSON token parser 不属于本计划，未来引入需另行复审。`performed_via_github_app.id` 是 App ID，永不等同 comment user ID；login/App slug 仅 diagnostic/display，marker 只发现 key，永不证明 ownership。

PATCH 前 adapter 必须 GET comment ID，并确认 observed ID、principal、key 与 Core mutation intent 使用的 last observed exact owned body 仍一致；current body 意外变化时返回 stale/ambiguous，不能 overwrite。只有 current exact body 等于 Core-observed body 才授权 intended update。PATCH 后 GET/list readback 必须证明 principal、key 和 exact intended body；mismatch 是 stale/unknown，无 rollback，后续 reconcile/manual resolution 处理。这是 pre-read coherence，不是 GitHub atomic CAS。missing/malformed `updated_at` alone does not block when required identity/body facts are complete；changed value 不是 mutation precondition，也不是单独 stale proof。repository-wide production workflow concurrency 仍必须存在。Local snapshot 的内部版本不得伪称为 GitHub `updated_at`。

| Payload | Required typed inputs |
| --- | --- |
| setup | source PR, Integration branch/PR, responsibilities, current rebase guidance; no final conflict answer. |
| validation | source head OID, affected path/field, Core-owned codes. |
| ready | original contributor, Integration PR, candidate head/Card blob, Approval confirms Card only. |
| completion | target PR and `PublishedCardTarget`. |

Core owns pure validation categories: author-or-fork, ref-or-path, change-scope, identity-or-metadata, card-grammar-or-template, card-safety, integration-base-or-ancestry, and valid. Invalid produces feedback/update and blocks Contribution merge; new head recomputes; valid produces success. Renderer only escapes/encodes typed payloads.

## Published Card Target

Completion intent contains a typed `PublishedCardTarget`, never a raw URL: trusted repository web base URL, trusted owner/repo, published `main` commit OID, validated Card path, expected Card blob OID, and source PR number. Before deriving it, final-main Git readback must prove that `path` at `publishedMainOid` has exactly the expected blob OID and bytes.

The renderer deterministically derives, from that target, a commit-pinned Card permalink `<trustedWebBase>/<owner>/<repo>/blob/<publishedMainOid>/<encodedCardPath>` and source trace `<trustedWebBase>/<owner>/<repo>/pull/<sourcePrNumber>`. `trustedWebBase` supports GHES and is validated as trusted repository configuration, not inferred from contributor input; `owner`, `repo`, OID, path and number are validated before rendering. Invalid base/path/OID, percent-encoding ambiguity, or blob/readback mismatch fail closed. Behavior tests compare the typed target and derived URLs as structured outputs, not comment-body substrings.

## Completion Ordering and Local Durability

Final-main validation closes only Git publication. It cannot return `quiescent` while either `integration-status/completion` or `source-status/completion` is absent/stale. One target failure leaves only that obligation; no retry re-merges.

`openLocalActionRun({ dir, realGit, seed, event })` owns isolated state/events/bare repos. Each canonical test orchestrator owns an in-memory `EffectRecord[]` or recorder callback and shares it with every fresh Local platform instance opened within that test process. Canonical tests use one writer per isolated directory; an optional exclusive test guard may immediately reject accidental same-directory double-open, but has no persistent recovery semantics. Fresh recovery closes and discards the platform, then reopens from directory. `state.json` is the test-only versioned semantic provider snapshot and fails closed when corrupt or an unknown version.

Mutation persistence is temp-file write plus atomic rename to `state.json`. The in-memory recorder records attempted/completed create/update/no-op/wrong-target semantic effects only while its test orchestrator survives; it is not persisted, recovery state, or a crash-gap protocol. Response-loss tests mutate state atomically, inject the lost response, reopen fresh, and prove state plus provider/Git readback yields no-op/already-applied. Recorder assertions cover only calls observed by the surviving test orchestrator.

## Provider Dependency Map and Review Routing

| Capability | Stable official source | L3 contract | L5 boundary | API review |
| --- | --- | --- | --- | --- |
| Issue comments, actor, `updated_at`, App fields | https://docs.github.com/en/rest/issues/comments | exact list/GET/POST/PATCH replay and mapping | actor/permission/UI/notification semantics | Required: API-specific reviewer before implementation authorization. |
| Link pagination | https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api | transport preserves lowercased raw headers; adapter parses raw `link` as `terminal`/`next(URL)`/`malformed`, with bounded requests | live ordering/eventual changes | Required. |
| Ready mutation | https://docs.github.com/en/graphql/reference/mutations#markpullrequestreadyforreview | existing exact GraphQL replay | permission/event semantics | Required. |
| Webhook wakeups | https://docs.github.com/en/webhooks/about-webhooks and webhook events/permissions docs | wake is not fact source; L4 schedules duplicates/loss | delivery/retry/signature/permissions | Required L5 reviewer/canary. |

For comments, absent Link/next is terminal even for a full page; response length never implies continuation. Present malformed Link, unparseable/non-progressing/wrong-target next, conflicting relation, request/page budget exhaustion, or conflicting duplicate comment ID is incomplete and authorizes no mutation. Exact duplicate identity/body can be deduplicated; sorting overlap is tolerated only through identity-consistent dedup then readback. REST transport preserves raw lowercased `link`, `retry-after`, and rate-limit headers. REST endpoints are GET/POST `/repos/{owner}/{repo}/issues/{number}/comments`, PATCH/GET `/repos/{owner}/{repo}/issues/comments/{id}`. GraphQL ready remains separate; REST `draft:false` is forbidden.

Comment operation status/payload contract is exact: list/read/PATCH require `200`; create requires `201`; any other 2xx or malformed/wrong-target payload is incomplete/unknown. `401/403` are auth/permission, `404` is phase-specific not-visible/not-found, `410` is gone/terminal or policy, `422` is validation/spam/policy, `429` and rate-limit responses are retryable with preserved `Retry-After`/reset metadata, and `5xx`/transport failures are unknown/retry with metadata preserved. Other statuses, including `409`, are never success.

POST has no idempotency key. After an ambiguous POST, bounded list/readback accepts exactly one matching owned key/body as `alreadyApplied`; zero visible matches is `unknownOutcome/await` with bounded backoff and no immediate repeat POST in that operation lifecycle; multiple/conflicting matches fail closed/manual recovery. There is no automatic delete/repair and no exactly-once or provider duplicate-free claim. Lost PATCH follows readback and yields stale/unknown on mismatch. Local atomic state proves only Local behavior, not provider duplicate-free semantics.

## Rejection, Baseline, and Implementation Constraints

`vercel-labs/emulate` is rejected: no dependency, sync bridge, REST Git oracle, REST-ready replacement or local fallback to `api.github.com`. See stable emulator research.

Current baseline at this revision is green: `npm test -- --run` is 109/109 and `npm run verify:pre-canary` passes. This is only the old baseline, not evidence that Comment/file-backed work exists. One prior 5000ms timeout at `test/local/git-scenario.test.ts:167` is a historical flake/regression risk, not a current blocker. If it recurs, implementation should stabilize runtime/timeout without weakening exact assertions and rerun the same full commands.

Implementation must replace behavior-oracle `toContain` assertions in `test/local/git-scenario.test.ts` with exact bytes/typed parser/tree/blob/parents checks under Test IDs G-G1, G-G2 and G-G3; substring checks remain permitted only for renderer-local structural tests.
