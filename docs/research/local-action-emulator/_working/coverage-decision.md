# Coverage Decision: Local Action GitHub Emulator

## 当前已覆盖范围

- `vercel-labs/emulate` pinned source covers route registration, Store resources, comments, PRs, reviews, checks, REST Git Data, merge modeling, webhooks, persistence adapters, CLI lifecycle, GraphQL absence, and smart Git/SSH absence.
- Current Hello from Main source covers the real Action transport, Octokit adapter, Local semantic double, real Git workspace, canonical local scenario, and deterministic stability harness.
- Official GitHub and Git protocol references define the provider semantics that the emulator would need to approximate.

## 仍然存在的盲区

- Upstream installation did not complete because package downloads timed out/reset, so live comment CRUD, embedded two-process persistence, endpoint capture, webhook delivery, and Git protocol probes remain runtime-unknown.
- No second stateful emulator was assessed.

## 这些盲区是否会改变结论

They do not change the decision about replacing the canonical provider-facing local Action path. Source-confirmed absence of Git smart transport, automatic synchronization with real bare Git, and GitHub GraphQL independently prevents replacement. The runtime unknowns do block any positive recommendation to adopt `emulate` even as an optional REST fixture.

## 是否需要补第二批目标

No. The user asked whether this selected library can support the proposed refactor, not for a general emulator comparison. A second emulator cannot change the finding that this library is unsuitable. Future consideration of an optional REST fixture must first complete the runnable spike against this exact revision or a newer explicitly reviewed revision.
