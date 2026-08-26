# Local Action GitHub Emulator 调研报告

## 核心答案

**结论：拒绝将 `vercel-labs/emulate` 作为 canonical provider-facing local Action path 的替代品。**

`vercel-labs/emulate` 的源码显示，它通过独立的 `Store` 图对许多 GitHub REST 资源提供有状态的建模，包括 issue comments、pull requests、reviews、checks、refs、commits、trees、blobs 和 merge 结果。这使它具备成为局部 REST 状态测试 fixture 的潜力，但不等于它实现了真实 GitHub provider 的事实源或 Git 行为。

Hello from Main 的 canonical local Action 路径要求实际 Git 工作区和 bare repository 对 Project Shell、贡献者 rebase、no-fast-forward merge、最终 Card/README 字节以及 DAG 后置条件负责。`emulate` 的 refs、commits、trees、blobs、PR head/base 和 merge commits 属于另一套 Store 图。源码中没有 Git smart HTTP 或 SSH 服务、Git 子进程、repository/object storage、remote watcher 或 importer，因此两套图不会自动合并。它也没有当前所需的 GitHub GraphQL `markPullRequestReadyForReview` mutation，CLI 没有持久化选项。

因此，REST 资源数量或 URL 形状不能弥补 canonical 事实源缺失。任何把 emulator Git Data 当作真实 `git clone/fetch/push` 结果、把 Store merge 当作真实 Git merge，或以 REST `draft:false` 替代 GraphQL ready-for-review 的方案，都不符合本项目的生产路径保真度和 Git truthfulness 要求。

## 推荐方案

采用最小的保守架构，不在 canonical local Action 路径中引入 `emulate`：

- 保留一个 `Core/Reconciler`，继续通过 `OctokitGithubPlatform` 表达 provider-facing 行为。
- 保留 `RealGitWorkspace` 和临时 bare Git repository，使实际 refs、objects、merge DAG、最终文件字节以及重启后的 Git 后置条件只有一个权威来源。
- 保留注入式 `OctokitRequestTransport`，继续用确定性 replay/fault harness 覆盖响应丢失、重复唤醒、延迟可见性、权限错误、分页、未知结果和重启恢复。
- 保留现有 `LocalGithubPlatform` 作为语义测试 double；若后续需要减少其中的 REST 拓扑手工建模，只能在已有真实 Git 与确定性故障边界不变的前提下，逐项替换经过证明的局部 happy-path 测试。
- 不构建一个长期存在的 emulator-to-Git 双向同步层，也不把 emulator 作为 canonical Action composition 的 provider。

### 可选 REST fixture 的处理

当前**不推荐也不采纳**可选的 REST-only comment fixture。它仍被以下运行时证据阻塞：

- issue comment 的 POST/PATCH/GET/list CRUD 尚未在可运行服务上验证；
- 两进程共享状态下的 comment、PR、ref、commit/tree/blob 读回尚未验证；
- 当前 Action transport 对 emulator 的 REST URL、GraphQL URL、错误分类和无 fallback 行为尚未捕获验证；
- webhook 交付、失败、重复和重启后的实际行为尚未运行验证。

即使未来全部通过，这类 fixture 也只能覆盖 REST 状态观察，不能替换真实 Git、确定性 fault tests、真实 merge/DAG 断言或 L5 边界。若采用，必须是一个窄化、显式配置、非 canonical 的 HTTP smoke/contract fixture：Git 事实由测试 fixture 从真实 bare remote 读取，REST Store 只接收明确的一次性投影；每次关键操作后分别读取两边并在不一致时失败。该投影不是同步系统，也不能把 REST 写入反向解释为 Git 成功。

## 关键判断链

### REST 有状态不等于 provider-facing 事实一致

源码中的 GitHub plugin 注册了 comments、pulls、reviews、checks 和 Git Data REST 路由。comments 会写入 `gh.comments`，PR/ref/object 会写入 `GitHubStore` 集合，merge 会创建 Store 内的 commit 并移动 Store 内的 branch。这说明它不是单纯的静态 response replay，而是对许多 REST 资源提供独立的状态图。

但当前 Action 的关键观察不是“某个 API 请求是否返回了形状相似的 JSON”，而是 provider 资源是否反映实际 Git 对象：adapter 需要根据真实 refs、commit parents、tree/blob 内容、PR head 和 changed files 做判断，canonical scenario 还需要验证 rebase、no-fast-forward merge、bare remote readback 和最终 DAG。`emulate` 的 REST Git Data 不写入真实 object database，也不读取 bare remote；因此即使其后续 GET 能读到先前的 Store mutation，也不能成为这些断言的 oracle。

主要证据：`_working/projects/vercel-emulate.md:46-63, 77-88, 129-140`；运行时证据缓存 `evidence/emulate-runtime.md:38-51, 57-65`。

### Git 与 emulator Store 是两个不可自动收敛的图

Smart Git transport matrix 的关键结果是源码确认的负结论：在检查范围内没有 `git-upload-pack`、`git-receive-pack`、Git smart HTTP media type、SSH listener、Git subprocess、bare repository storage、remote watcher 或 importer。`helpers.ts` 生成的 `git_url`、`ssh_url`、`clone_url` 只是 URL-shaped metadata，不是可用的 Git 服务。

因此各方向都不能假定同步：

- Git client 对 emulator 的 `ls-remote/clone/fetch/push` 不会自然变成 emulator refs、PR head 或 Store objects；
- emulator REST 创建的 refs、commits、trees、blobs 不会自然变成真实 Git objects 或 bare refs；
- 对真实 bare remote 的 push 不会自动更新 emulator API；
- emulator 重启后的 Store snapshot，即使在 embedded adapter 中恢复，也不包含真实 Git identity。

实际 Git 协议探测未能执行，因为上游依赖安装失败；上述内容是源码确认的“没有实现”，不是把未运行的协议测试写成失败结果。运行时矩阵中的 Git client、REST Git Data readback、real bare push visibility 和 Git/API restart identity 均保持 `unknown`，而源码层同步分类为 `not synchronized`。

主要证据：`evidence/emulate-runtime.md:22-51, 53-65`；`_working/projects/vercel-emulate.md:129-140, 184-196`。

### GraphQL ready mutation 是独立的硬缺口

当前 `OctokitGithubPlatform` 使用 GitHub GraphQL `markPullRequestReadyForReview`。`emulate` 在 GitHub/core/CLI 检查范围内没有 `/graphql` 路由、GraphQL executor 或 GraphQL import。通用 REST PATCH `draft:false` 不能自动等价于当前 mutation：它不提供同一 GraphQL contract，也不产生当前需要的 `ready_for_review` 事件语义。

即使 REST 端点可以被配置到本地 emulator，ready-for-review 仍不能被跳过、静默降级为 PATCH，或 fallback 到 `api.github.com`。这单独足以阻止其替换完整的 provider-facing local Action path。

同时，当前生产 Action transport 在 `src/entry/action-runtime.ts:253-303` 中把 REST 和 GraphQL host 写为 `https://api.github.com`。因此即便只做 REST-only fixture，也需要 composition/runtime 变更以注入两个明确的本地端点；不能把它描述为只增加一个环境变量即可完成的接入，更不能在本地模式下保留隐式真实 GitHub fallback。

主要证据：`_working/projects/vercel-emulate.md:90-100`；`evidence/emulate-runtime.md:38-51, 65`。

### CLI 持久化不能满足 canonical 测试生命周期

`createServer()` 每次创建新的 Store；CLI `emulate start` 的公开选项没有 state/persistence file，信号退出时还会 reset store。YAML/JSON seed 是启动输入，不是 mutation 后 snapshot 的持久化。因此 CLI 两进程共享状态属于源码确认的 unsupported。

Next/Nuxt adapter 虽然存在 snapshot load/save 路径，但这不是当前 Node Action canonical composition 的 CLI 能力，也没有把 Store 与真实 Git 连接起来。其 `filePersistence` 是整文件覆盖写入，没有 atomic rename、锁、fsync；保存错误在 mutation response 返回后处理，webhook subscription/delivery 也不在 Store snapshot 中。由于依赖安装失败，embedded adapter 的两进程 comment/PR/ref/object 读回没有运行验证，不能把源码路径扩大成 runtime persistence 保证。

结论是：它既不能提供 canonical CLI restart oracle，也不能提供可替代真实 Git 的持久事实源。可选 fixture 若未来采用，必须把持久化能力限定为已完成运行验证的测试辅助能力，而不是基础设施承诺。

主要证据：`evidence/emulate-runtime.md:24-36, 53-60`；`_working/projects/vercel-emulate.md:65-75, 150-161`。

### webhook 只能是唤醒信号，不能成为事实源

源码显示，部分 Store mutations 会在状态写入后 dispatch webhook，例如 PR opened/closed、comment created/edited、review submitted/dismissed、check completed 和 ref create/update。但该 dispatcher 没有 retry/redelivery；失败被记录并吞掉，delivery/subscription 也不进入 Store snapshot。source PR synchronize、Integration PR ready 和 check queued 等当前需要的事件没有完整的自动 mutation coupling。

所以即使未来运行服务确认这些事件能发送，它们也只能作为 wakeup signal。核心状态必须由 Action 重新观察，并由真实 Git 和确定性 fault tests 验证。emulator webhook 不能替换重复、漏投、乱序、响应丢失和未知结果测试。

主要证据：`_working/projects/vercel-emulate.md:102-127`。

## 方案取舍

| 方案 | 判断 | 决策含义 |
| --- | --- | --- |
| 用 `emulate` 替换 canonical provider-facing local Action path | **拒绝** | 独立 Store 图、无 smart Git/SSH、无真实 Git 自动同步、无 GraphQL ready mutation、无 CLI persistence；无法同时满足 Git truthfulness、生产路径保真度和当前协议需求。 |
| 在 canonical path 中增加 emulator-to-Git 双向同步层 | **拒绝** | 会引入第二套 provider/Git 状态机和新的 source-of-truth 冲突；需要处理 refs、objects、PR heads、merge、失败回滚和重启一致性，复杂度超过被删除的手工模型。 |
| 仅把 `emulate` 用作 REST-only comment/HTTP fixture | **当前不采纳，未来有条件再评估** | 必须先完成可运行 CRUD、两进程 persistence、准确端点/no-fallback、cleanup 和 request inventory 证明；即便通过，也只覆盖 REST 状态，不覆盖真实 Git、GraphQL ready、L5 或确定性 fault 行为。 |
| 继续使用当前 Local/replay/real-Git 分层 | **采用** | 一个 Core/Reconciler 保持不变；真实 Git 负责 Git oracle，Local double 负责语义测试，replay/fault harness 负责可控异常，Octokit adapter 负责 provider request/mapping contract。 |

## 落地建议与规格含义

以下技术边界限定后续实现与测试的允许范围。

### 技术规格应明确

- 将 `vercel-labs/emulate` 的决策记录为 `reject`，限定为“拒绝替换 canonical provider-facing local Action path”，而不是泛化为“该库不具备任何测试价值”。
- 把 `RealGitWorkspace`、真实临时 bare repository 和真实 Git postconditions 标为 Project Shell、贡献者 rebase、no-fast-forward merge、最终 Card/README 与 DAG 的 canonical oracle。
- 把 emulator REST Git Data 明确标为独立 Store projection，不得作为真实 refs、objects、changed files、merge commit 或最终 main 的证明。
- 禁止设计 background/bidirectional sync manager。若以后需要 REST fixture，只允许 test-fixture-owned、一次性、方向明确、带 Git readback 的 projection，并明确 projection failure 不得让 canonical Git 流程成功。
- 为本地 REST fixture 接入定义独立的 REST base URL 和 GraphQL base URL；本地模式必须 fail closed，任何 `api.github.com` fallback 都是设计错误。
- 保持 GraphQL `markPullRequestReadyForReview` 为独立 capability；不能用 PATCH `draft:false`、缺失事件或人工 webhook 注入冒充该 capability。
- 不把 `emulate` CLI 的 seed 文件描述为 restart persistence。任何 persistence claim 必须绑定具体 embedded mode、共享文件、保存失败策略、并发写者策略和两进程读回证明。

### 测试规格应明确

- 完整保留 `test/local/git-scenario.test.ts`，包括 add/add conflict、rebase、push、no-fast-forward merge、bare remote readback、Card/README bytes、parent ancestry 和 restart。
- 完整保留 `test/stability/fault-scheduler.test.ts`、`unknown-outcome.test.ts`、`restart-recovery.test.ts`、`publication-pipeline.test.ts` 和 `publication-gates.test.ts`；emulator 不承担响应丢失、重复/漏/乱序唤醒、未知结果、真实 Git timing 或 fail-closed Integration base-current gate。
- 保留 `test/adapters/octokit.test.ts` 的 exact request、mapping、GraphQL 和 fail-closed 断言。未来若 REST fixture 通过独立 gate，只能新增少量 HTTP smoke/contract tests，不能删除这些 adapter tests。
- `test/adapters/local-github.test.ts` 只能在逐项 REST contract 已被运行验证后，缩减纯 REST topology modeling；Git delegation 和真实 Git 断言不得删除。
- 任何可选 REST fixture 测试都必须记录 exact request URL、禁止 fallback、comment idempotent CRUD/readback、明确 cleanup，以及 fixture projection 前后真实 bare Git OID。REST-only 通过不能替代 Git oracle。
- Bot setup/validation/ready/completion comments 的产品行为仍需在 `GithubPlatform` port、Octokit adapter 和 deterministic test seam 中单独实现与验证；不能因为 emulator 有 comment routes 就宣称这些产品需求已变为可测试或已实现。

### 明确的停止条件

后续任何可选采用工作在以下任一条件成立时停止：

1. 测试用 emulator REST Git Data 断言真实 Git CLI 结果。
2. 用 REST `draft:false` 替代或跳过 GraphQL ready-for-review，或在本地模式向真实 GitHub fallback。
3. wrapper 演变为 background/bidirectional synchronization layer。
4. 无法用同一状态文件证明 comment、PR、ref、commit、tree、blob 的两进程读回，并给出保存失败与并发写策略。
5. 删除真实 bare-remote/DAG 断言或确定性 fault/restart 测试，以 REST Store 等价为理由。

## 证据边界

本结论的高置信部分来自固定 revision `d0219d05818adca4c12bb76ec79a7562c1766a3d`（`v0.10.0`）的源码和当前仓库源码：

- REST route/Store 形态、Git Data 的独立对象模型、webhook dispatch 结构、GraphQL 路由缺失、smart Git/SSH/真实 repository 实现缺失，以及 CLI persistence option 缺失均有源码路径或可复现 source scan 支撑。
- 当前仓库的 adapter GraphQL mutation、literal GitHub hosts、RealGitWorkspace composition 和真实 Git scenario 定义了替换所必须满足的 provider-facing 与 Git oracle 边界。
- `vercel-labs/emulate` 的确显示出许多 REST resource 的有状态源码模型；这不是 live server behavior 的声明。

上游安装未完成，原因是 registry 下载反复超时或 reset，checkout 中没有可运行的 `node_modules` 或构建产物。因此以下事项不能声称已通过运行时验证：

- live issue-comment POST/PATCH/GET/list CRUD；
- embedded 两进程 persistence；
- 当前 `OctokitGithubPlatform`/Action transport 对 emulator 的实际 endpoint capture、404、错误映射或 no-fallback capture；
- webhook HTTP delivery、重试/重复行为；
- `git ls-remote`、clone/fetch/push 以及 smart HTTP/SSH probes。

这些未知项不改变 canonical replacement 的拒绝结论，因为 Git smart transport、自动 real-Git synchronization、GitHub GraphQL route 和 CLI persistence 的缺失已经由源码独立确认。但它们阻止任何“可选 REST fixture 已经可用”或“runtime compatibility 已验证”的正面结论。相关证据路径为 `docs/research/local-action-emulator/evidence/emulate-runtime.md`、`docs/research/local-action-emulator/_working/projects/vercel-emulate.md`。

## 反证、风险与未知项

唯一可能改变“是否可作为可选 REST-only fixture”的证据，是在明确 revision 上完成可运行的 comment CRUD、两进程 persistence、精确 endpoint/no-fallback capture、cleanup 和 request inventory，并证明其不会改变真实 Git 与 fault-test 事实源。该证据不能改变“不能替换 canonical path”的结论，除非上游新增并实际实现 smart Git/SSH、真实 repository synchronization 和当前 GraphQL mutation；在当前 revision 上没有这类实现证据。

即使未来上游扩展能力，仍需重新验证：Store snapshot 的原子性和并发语义、webhook 交付可靠性、Node/pnpm 生命周期、临时端口和进程清理，以及 wrapper 的安全隔离。任何新能力只能通过新的 source/runtime gate 进入测试规格，不应由当前报告推断。
