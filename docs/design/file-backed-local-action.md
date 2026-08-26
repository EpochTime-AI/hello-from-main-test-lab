# File-backed Local Action Design

状态：`DRAFT/REVIEW_REQUIRED`。本设计固定 Phase 0 的最小机制，不授权实现。

## 决策与边界

Hello from Main 保留一个 `Core/Reconciler`、一个 `GithubPlatform` seam、一个 `GitWorkspace` seam；真实 bare Git 与 `RealGitWorkspace` 是 refs、objects、trees、blobs、merge parents、Card/README bytes 和 DAG 的唯一 Git oracle。Comment 是产品 effect，不是日志。file-backed `LocalGithubPlatform` 是 test-only semantic provider，不是 GitHub server、产品数据库或 Git object model。

`vercel-labs/emulate` 不进入 canonical path，也不建立同步桥。其独立 Store Git Data 不同步真实 Git、没有 smart Git/SSH、没有当前 GraphQL ready mutation，也没有 CLI persistence；live comment CRUD/persistence probes 仍未知。依据为 `docs/research/local-action-emulator/final-report.md` 与 `docs/research/local-action-emulator/evidence/emulate-runtime.md`。

## Comment Contract

### 稳定 identity 与 slots

`actionKey = runIdentity + targetPullRequestNumber + slot`。`runIdentity` 绑定 source PR number 与 immutable contributor `github_id`；`slot` 是稳定位置，**phase 不是 key 的组成部分，而是可更新 payload**。最小 slot 方案如下：

| Target | Slot | Phase 演进 | 行为 |
| --- | --- | --- | --- |
| Contribution PR | `source-status` | `setup -> validation-feedback -> validation-success -> completion` | 同一 Bot-owned comment 原地 update；后一个 phase supersede 前一个状态。setup 不保留独立历史，评论始终展示当前下一步、当前检查结果或完成结果。 |
| Integration PR | `integration-status` | `ready-guidance -> completion` | Ready 指引在发布后由 completion update 取代。 |

body-only 变化更新同一个 slot。target 改变必然是不同 key。任何 user-authored same-key marker、多个 owned matches、owner 缺失或不匹配、分页不完整、stale observed coherence 或 readback 不一致，均 fail closed；不得任选、覆盖或新建第二条以“修复”歧义。

### 可信 owner 与 payload

marker 只承载 key/slot/phase 以便发现，绝不证明 ownership。每个 Comment fact 必须从 provider 返回非 null `user`、stable actor ID 与 exact actor type（`Bot`/`User` 或 provider exact enum）。trusted composition 配置 expected principal 为 lossless canonical decimal string ID 与 exact provider actor type；ID 必须匹配正十进制语法（`^[1-9][0-9]*$`），缺失配置或无法验证时在 mutation 前 fail closed。semantic boundary 统一使用 canonical decimal string。本 slice 选择最小 transport/parser 策略：若 fetch JSON 将 GitHub `int64` materialize 为 JavaScript `number`，只接受 `Number.isSafeInteger` 的值并拒绝更大的 ID；绝不把 rounded number 转成 ID。若未来改为 raw JSON token parser，必须另行复审，不是本计划的隐含实现。`performed_via_github_app.id` 是 App ID，永不与 comment `user.id` 等同；login、App slug/name 只是可选 diagnostic/display facts，不是 ownership match。缺 principal、numeric ID/type 不匹配或多个 owned matches 均不是 owned。Core 只消费 typed owner match 结果。

每个 typed intent 的 renderer payload：

| Slot/phase | 必须绑定的 typed 输入 |
| --- | --- |
| `source-status/setup` | source PR、Integration branch、Integration PR、双方责任、当前 rebase command/branch；不得提供可复制的最终 conflict 答案。 |
| `source-status/validation-feedback` | source PR、source head OID、validation result codes、受影响 path/field；没有未转义 contributor 内容。 |
| `source-status/validation-success` | source PR、validated source head OID、`valid` result。 |
| `integration-status/ready-guidance` | original contributor、Integration PR、candidate head、Card path/blob、Approval 仅确认 Card 而非 README/merge 权限。 |
| `source-status/completion` 与 `integration-status/completion` | respective target PR、published main OID、Card path/blob、source PR、canonical final Card link。 |

文案、语言和 Markdown 编码只属于纯 renderer；上述结构是 Core decision 和测试 oracle。

### Published Card Target 与 comment stale carrier

completion payload 使用 typed `PublishedCardTarget`，而不是 raw URL：trusted repository web base URL、trusted owner/repo、published main commit OID、validated Card path、expected Card blob OID 和 source PR number。final-main readback 必须先证明该 path 在 published OID 的 blob OID/bytes 精确匹配，Core 才能创建 completion intent。renderer 从 trusted base 派生 commit-pinned Card URL `<webBase>/<owner>/<repo>/blob/<mainOid>/<encodedPath>` 与 source trace URL `<webBase>/<owner>/<repo>/pull/<sourcePr>`；这支持 GHES，禁止硬编码 github.com 或从不可信输入拼 URL。任何 base/path/OID/encoding/blob mismatch 均 fail closed。

provider Comment fact 最少包含 numeric comment ID、owner principal、从 controlled marker 解析的 action key、exact body，以及可选的 `updated_at` diagnostic/coherence value。PATCH 前必须 GET comment ID，并确认 observed ID、principal、key 和 exact body 仍等于 Core 形成 mutation intent 时观察到的 owned fact；current body 若意外不同，必须返回 stale/ambiguous，绝不直接覆盖。只有 current exact body 等于该 Core-observed body 时才授权 intended phase/body update。PATCH 后 GET/list readback 必须验证 principal、key 与 exact intended body；mismatch 是 stale/unknown，不能 rollback，交给后续 reconcile/manual recovery。`updated_at` 缺失或 malformed 本身不阻断所需 identity/body facts 完整的操作；changed value 既不是 mutation precondition，也不是 stale 的单独证明。此为诚实的 pre-read coherence + PATCH + post-read validation，不是 provider atomic CAS；竞争通过 post-read/reconcile 与 workflow concurrency 收敛，不作安全写入或恢复旧 body 的 claim。Local snapshot 可有内部版本以支持其自身状态，不映射为 GitHub `updated_at`。

### REST transport、pagination 与 response loss

L3 REST transport 必须保留 response body 与 raw response headers，header names 统一 lower-case，至少包括 `link`、`retry-after`、`x-ratelimit-limit`、`x-ratelimit-remaining`、`x-ratelimit-reset` 及其他 provider headers；comment list adapter 将 raw `link` 解析为有区分的 `terminal`（无 `Link` header）、`next(URL)` 或 `malformed`，只跟随验证过的 `rel="next"` URL。请求总数/page budget 有界；next URL 必须与目标 repository/issue-comments endpoint 相容并前进，非 progress、冲突 relation、重复循环和 budget exhaustion 都是 incomplete，后续不得 create/PATCH。没有 `Link` 时即使当前 page 满载也 terminal；绝不从 response length 推断 pagination。

Issue Comment 成功状态严格按 operation 验证：list/read/PATCH 仅 `200`，create 仅 `201`。成功 payload 必须符合该 operation 的 schema：list 是 comment object array，read/create/PATCH 是目标 comment object，且 required ID、非 null user、lossless actor principal、controlled key、string body 和 target/comment identity 完整；wrong target、null/malformed required field 或其他 2xx 都是 incomplete/unknown，不是 success。`401/403` 映射 auth/permission；`404` 按 operation phase 映射 not visible/not found；`410` 映射 gone/terminal 或明确 policy classification；`422` 映射 validation/spam/policy；`429` 和明确 rate-limit response 映射 retryable rate-limit，并保留 `Retry-After`/reset metadata；`5xx` 与 transport failure 映射 unknown/retry，并保留可用 retry metadata。未列出的 status（包括 `409`）不得当作成功，按 operation-safe unknown/terminal policy 处理。

POST 没有 idempotency key，也没有 GitHub conditional-create 或 exactly-once/duplicate-free 证明。ambiguous POST（包括 response loss）只能进入同一 operation lifecycle 的 bounded list/readback：exactly one matching owned key/body 为 `alreadyApplied`；zero visible match 为 `unknownOutcome/await`，使用 bounded backoff/watchdog reconcile，且该 lifecycle 内 **MUST NOT** 立即重复 POST；multiple or conflicting matches fail closed/manual recovery。不得自动 delete/repair ambiguous comments。lost PATCH 也必须 readback；mismatch 为 stale/unknown，不 rollback。Local atomic `state.json`/provider readback 仅证明 Local semantic behavior，不证明 GitHub provider duplicate-free semantics；Local response-loss tests 不得替代 O-S5 provider replay evidence。

### Validation result

Core 是 typed validation result 的 owner，纯函数从 current intake/Card facts 派生，renderer 不反推领域状态。结果为产品类别和一个或多个 codes，而非预先冻结最终 DTO：

- `intake-author-or-fork`: author、fork owner、fork flag 不匹配。
- `intake-ref-or-path`: `add/<login>`、expected card path、source/base binding 不匹配。
- `change-scope`: 非单文件或 changed-files enumeration 不完整。
- `identity-or-metadata`: immutable `github_id`、login、avatar、`source_pr` 与可信 provider facts 不匹配，或已发布/active identity 冲突。
- `card-grammar-or-template`: UTF-8/LF、固定结构、必填字段、template text、空字段错误。
- `card-safety`: conflict markers、links/images/HTML、control characters、额外 syntax 或 policy-forbidden text。
- `integration-base-or-ancestry`: source 未基于 expected Integration head，或 Git ancestry/readback 不成立。
- `valid`: 所有可观察规则通过。

每个 invalid result 阻止 Contribution merge，但允许同一 `source-status` slot 更新具体反馈；修复 push 后新的 head 必须重新计算，不可复用旧 success。

## Core Ordering

Reconciler 继续每 turn 重读 current facts 和 Git readback，选择至多一个 effect。正常优先级是 setup topology、source-status setup、validation status、Contribution merge、candidate write/readback、GraphQL ready、integration-status ready、Approval/publication。最终 Integration merge 后，final-main validation 只关闭 Git publication obligation：若 final main 已证明，Core 必须先派生任何缺失/过期的 `integration-status/completion` 或 `source-status/completion`，并且在两个 completion obligations 都 readback 已满足前不得返回 `quiescent`。一次仅处理一个 target；一个 target 成功、另一个失败时，后续 turn 只追补失败 target，绝不再次 merge。comment unknown/readback failure 返回 retry/await；permission/ownership ambiguity fail closed；不存在“已发布即 quiescent”的捷径。

## File-backed Local Harness

测试专用接口采用最小形态：

```ts
openLocalActionRun({ dir, realGit, seed, event }): LocalActionRun
```

它在 canonical test 的 isolated `dir` 中打开并加载/创建 Local semantic snapshot，读取外部 event fixture，并为一次 wakeup 组装与 production 相同的 Action/CLI composition、candidate policy、Core 和 `RealGitWorkspace`；仅 provider 为 file-backed Local adapter。canonical tests 一目录一 writer。可选的 exclusive test guard 可以在意外同目录 double-open 时立即失败，但不持久化、不恢复、也不是产品机制。`run.wake()` 只运行一次 bounded composition，`run.close()` 结束该 test run。fresh-process test 必须 close、丢弃旧 `LocalActionRun`/platform，再重新 `openLocalActionRun`。state directory 只包含 `state.json`、event fixtures as needed 与 real-Git fixtures，并在 `finally` 删除整个 isolated root；不得以 caller-owned topology object 重建状态。

Local adapter 必须移除当前硬编码：不得使用 `alice`、source PR `1`、title length PR number、固定 Card path/bytes 或 caller topology。source identity、Card path/bytes、branch/ref、owner、PR number allocator 和 current facts都来自 typed seed/event/facts；Git mutation/readback仍由真实 workspace 负责。

## Snapshot and Test Recorder

`state.json` 是 test-only、versioned Local provider semantic snapshot。它是 semantic recovery 的唯一 Local persistence source；snapshot 损坏、空/截断 JSON 或未知 schema version 必须 typed fail-closed，绝不 silent reset。Mutation persistence 仅为写入 temp state file 后 atomic rename 到 `state.json`。

每个 canonical test orchestrator 创建一个 test-owned in-memory `EffectRecord[]` 或 recorder callback，并将它共享给该 test process 内所有 fresh `LocalGithubPlatform` instances。它记录 create/update/no-op/wrong-target 的 attempted/completed semantic effects，供同一测试内跨 platform reopen 的调用断言。它不持久化、不参与 recovery、不是 process exit 后所需状态，也没有 crash-gap semantics。

Response-loss proof follows one path: mutate semantic state with the temp-file write plus atomic rename, inject the lost response, then open a fresh process. State reload plus provider/Git readback must yield no-op/already-applied. Duplicate effects and concurrent wakeups are exercised by the deterministic scheduler and provider readback, not a cross-process persistence protocol.

## Deletion Test

| Mechanism | Delete/keep | Where complexity would reappear | Rationale |
| --- | --- | --- | --- |
| Three comment slots and separate source completion | **Deleted** | Core completion ordering and canonical comment callers/tests | Two sticky slots retain validation history by updating `source-status` to completion and still require independent source/Integration completion effects. |
| Snapshot last-operation metadata and recovery marker | **Deleted** | Local test provider only | Fresh state plus provider/Git readback establishes already-applied; Core and production seams do not need a transaction protocol. |
| Flush-to-disk and syscall crash-boundary protocol | **Deleted** | No required layer | Atomic rename supplies the required test persistence boundary; required behavior does not depend on storage-device crash guarantees. |
| Persisted effect file, recorder atomicity/corruption/cleanup, and recorder-based recovery | **Deleted** | Test orchestrator only | A shared in-memory recorder supplies same-process call evidence; `state.json` plus provider/Git readback supplies all restart and response-loss proof. |
| Persistent cross-process lock ownership lifecycle | **Deleted** | No required layer | Canonical tests isolate directories and use one writer; scheduler/readback cover duplicate effects. |
| Optional same-directory exclusive test guard | Keep, optional | Test harness only | It detects accidental double-open immediately without durable ownership or recovery semantics. |
| Versioned semantic snapshot and atomic rename | Keep | Local test provider only | Required for fresh-restart state reload and response-loss convergence. |
| Shared in-memory attempted/completed effect recorder | Keep | Test orchestrator only | Required only for same-process create/update/no-op/wrong-target call assertions across fresh platform instances. |
| Pre-read coherence, PATCH, and post-read validation | Keep | GithubPlatform and Octokit adapter | Required honest stale handling without claiming CAS. |
| Typed PublishedCardTarget and real Git readback | Keep | Core, GithubPlatform, GitWorkspace, canonical callers/tests | Required target ownership and real Git truth for both completion comments. |

## Operation Ownership

| 操作 | Mutation owner | Fact oracle/readback | Local projection 与恢复 |
| --- | --- | --- | --- |
| Project Shell/ref | `RealGitWorkspace`；Local adapter 只编排 semantic setup | bare ref/tree/blob | snapshot 可保存已读回 branch anchor/OID，不生成 Git object。 |
| Integration PR topology、retarget、comments | `GithubPlatform` adapter | provider facts/readback | Local models PR/comment state；Octokit REST/GraphQL reads real provider。 |
| reviews/checks | provider；Local fixture 仅注入 external facts | provider/fixture facts bound to PR head | Local 不伪造 Git success。 |
| Contribution/Integration merge | semantic `GithubPlatform`; Local delegates actual merge to real workspace | bare Git merge/readback；production provider merge | Local records provider merged fact only after delegated readback。 |
| candidate write | `GitWorkspace` | bare ref/tree/blob/parents | Local may project observed candidate OIDs only。 |
| final-main validation | `GitWorkspace` | bare `main`, tree, blobs, parents | no Local Git substitute; it only triggers completion intent。 |

## GitHub Dependency Map

| Capability | Official source | Provider contract | Current seam/test | Boundary / reviewer |
| --- | --- | --- | --- |
| list PR issue comments | https://docs.github.com/en/rest/issues/comments | `GET /repos/{owner}/{repo}/issues/{issue_number}/comments?page=&per_page=`; actor/updated_at/App fields | `OctokitRequestTransport.rest`, L3 replay | API-specific review required; live pagination/actor semantics L5。 |
| pagination | https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api | raw lowercased `link` is parsed as `terminal`/`next(URL)`/`malformed`; bounded requests, no response-length inference | `OctokitRequestTransport.rest`, L3 replay | malformed/nonprogressing/wrong-target/budget exhausted incomplete; API review required。 |
| create comment | https://docs.github.com/en/rest/issues/comments | REST `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`, exact `201` target payload, then readback | exact replay + GET readback | 401/403/404/410/422/429/5xx/transport classifications with retry metadata; no idempotency key。 |
| update/readback | https://docs.github.com/en/rest/issues/comments | PATCH/GET `/issues/comments/{comment_id}` | exact replay + stale/readback | pre/post compare required; live permission/UI L5。 |
| ready | https://docs.github.com/en/graphql/reference/mutations#markpullrequestreadyforreview | GraphQL `markPullRequestReadyForReview` | existing GraphQL replay | REST PATCH forbidden; API review required。 |
| wakeups | https://docs.github.com/en/webhooks/about-webhooks | wakeups are not facts | L4 scheduler | delivery/permissions L5 and API review required。 |

GitHub REST/GraphQL API-specific review is required before implementation authorization because actor/pagination/stale/readback affect correctness. Current injected transport is L3 seam; numeric actor ID/type mapping, permission, UI, notifications and webhook delivery remain L5 live semantics.

## Non-goals

No DB, queue, generic HTTP client, generic comment CRUD in Core, GitHub emulator/server, bidirectional sync, candidate ref, second Reconciler or `vercel-labs/emulate` adoption.
