# File-backed Local Action Cross-spec Consistency

状态：`DRAFT/REVIEW_REQUIRED`。此矩阵将产品、当前实现、Tech/Test 规划绑定；不表示规格已获批准。

| 产品规则 | 当前代码事实 | Tech 规则 | Test IDs | Verdict |
| --- | --- | --- | --- | --- |
| setup: shell、Integration PR、retarget 与 rebase 指引 | `reconciler.ts` 已 setup/retarget；无 comment port | `source-status/setup` 绑定 source PR、branch、Integration PR、责任与安全 rebase 指引 | C-S1, A-H1 | Planned gap, executable contract fixed。 |
| validation: 具体反馈或成功 | `validIntake` 为 boolean，无 result/comment | pure typed validation categories；`source-status` update | C-V1, C-V2, A-H3 | Planned gap, result owner fixed。 |
| Ready/Approval | existing candidate/GraphQL ready/Confirmation binding | `integration-status/ready-guidance` 绑定 contributor/head/blob与 Approval scope | C-R1, A-H3, O-R1, L5-3 | Existing lifecycle; comment gap planned。 |
| completion/final link on both PRs | terminal path currently quiescent after Git validation | terminal Git close before two independent completion obligations and typed permalink | C-C1, C-C2, C-L1, F-C1, F-C2, F-C3 | Required Core ordering repair。 |
| one Core effect order | `createReconciler` bounded one effect loop | no second lifecycle; final quiescence after completion only | C-C1, F-O1 | Required refactor, ownership fixed。 |
| Comment identity/owner | no capability | key = run + target + slot; phase mutable; numeric comment ID, non-null `user`, lossless canonical decimal actor ID + exact type trusted principal, controlled-marker key and exact body; login/App metadata diagnostic only; `updated_at` diagnostic only | C-I1, C-I2, C-I3, O-S2, O-S4 | Planned gap; unavailable expected principal fails closed before mutation。 |
| identity one-run | current facts include github IDs | validation checks active/published immutable ID | C-V1, C-V2 | Existing partial behavior; typed feedback planned。 |
| final main | `RealGitWorkspace.readFinalMainPostconditions` exists | bare Git closes publication before completion and validates PublishedCardTarget | C-C1, C-C2, A-G1, G-G2, G-G3 | Existing oracle retained。 |
| snapshot/test recorder | Local uses caller topology/in-memory | test-only versioned state uses temp write plus atomic rename; test-owned shared in-memory recorder observes same-process calls only | A-S1, A-S2, A-E1, A-R1, F-R1, F-S1 | Planned gap, restart convergence uses state/provider/Git readback without recorder persistence。 |
| single writer | no lock | isolated canonical directories and one writer; optional immediate test guard has no durable semantics | A-H4, F-O1 | Planned gap, test discipline fixed; duplicate handling remains scheduler/readback behavior。 |
| Git oracle | RealGitWorkspace + local scenario | Local projection only after Git readback; exact OID/tree/blob/parent checks | A-G1, G-G1, G-G2, G-G3 | Direction consistent; assertions strengthened。 |
| emulate rejection | no dependency | reject dependency/sync/REST Git oracle/REST ready fallback | O-E1 | Consistent and approved-with-notes。 |
| GitHub comment REST contract | no capability; current transport loses raw headers | lowercased raw headers; Link `terminal`/`next(URL)`/`malformed` with bounded requests and no length inference; exact 200/201 operation statuses and payload schemas; explicit error/retry metadata; conditional response-loss convergence only | O-S1, O-S2, O-S3, O-S4, O-S5 | Planned gap; API re-review required before implementation authorization。 |
| L5 provider facts | no canary scaffold/script | explicit skipped gate for actor/permission/UI/webhook/GraphQL/base gate | L5-1, L5-2, L5-3, L5-4, L5-5, L5-6 | Blocked pending disposable provider scaffold/evidence。 |
