# Research Brief: Local Action GitHub Emulator

## Background

Hello from Main currently uses one production Core/Reconciler, a production Octokit adapter, a real Git workspace, an in-process `LocalGithubPlatform`, injected HTTP replay, and deterministic fault tests. Bot PR comment behavior is required by `docs/product-design.md` but is not implemented. The current Local platform already models PR, branch, review, checks, merge, and protocol topology, creating pressure to become a hand-written GitHub emulator.

## Technical Decision

Determine whether `vercel-labs/emulate` can replace the provider-facing portion of the canonical local Action development path, while retaining real bare Git repositories and deterministic fault tests. The decision must distinguish a stateful GitHub API emulator from a real Git server and explicitly determine whether emulator refs, commits, trees, and PR head/base state synchronize automatically with actual `git clone/fetch/push` remotes.

## Deliverables

- `docs/research/local-action-emulator/final-report.md`: formal recommendation, evidence boundary, adoption or rejection conditions, and migration implications.
- Necessary source/runtime evidence under `docs/research/local-action-emulator/evidence/`.
- Revised `tmp/techspec.md` and `tmp/testspec.md` following the DevKit Feature Dev planning contract.
- Independent research, code-design, technical feasibility, completeness, and library-specific review evidence under workflow-owned working paths.

## Fixed Questions

1. Which GitHub REST/GraphQL resources used by Hello from Main are implemented, partially implemented, or absent?
2. Are issue comments stateful across POST/PATCH/GET, and does file persistence survive process restart?
3. Are PR reviews, checks, refs, commits, trees, blobs, branch updates, draft-ready transitions, PR retarget, and merges behaviorally supported?
4. Can current `OctokitRequestTransport` target the emulator without production adapter forks or network fallback?
5. Does the emulator emit or accept realistic webhooks, and what event/state coupling is automatic?
6. Does it expose a Git smart HTTP/SSH server or otherwise synchronize with real bare Git remotes? If not, what exact bridge would be required and who owns each source of truth?
7. Can response loss, duplicate wakeups, delayed visibility, pagination, permission failures, and restart be tested, or must deterministic fakes remain?
8. What third-party lifecycle, persistence, cleanup, Node/runtime, package maturity, and security risks affect adoption?
9. Which existing Local/replay tests can be replaced, which must remain, and what is the smallest architecture that avoids a second state machine?
10. Which product requirements, especially Bot setup/validation/ready/completion comments, become testable through the proposed path?

## Decision Criteria

- Production-path fidelity: the real Action runtime and Octokit adapter run unchanged apart from endpoint/auth configuration.
- Stateful correctness: mutations affect subsequent reads and survive restart.
- Git truthfulness: the design never presents emulator Git Data state as proof of real Git CLI behavior.
- Coverage: required provider resources are supported or can fail closed through a narrow, maintainable bridge.
- Determinism: tests remain isolated, bounded, cleanup-safe, and suitable for CI.
- Complexity reduction: adoption deletes or materially shrinks hand-modeled provider topology rather than adding another permanent layer beside it.
- Security: no contributor content is executed and no real credentials or shared repositories are required.

## Scope

Included: emulator source, package/runtime behavior, local spike, GitHub API compatibility relevant to current ports, persistence/webhooks, current repository architecture, and spec/test-plan changes.

Excluded: implementing the refactor, implementing Bot comments, choosing the production base-current gate, or claiming real GitHub provider behavior.

## Artifact Root

`docs/research/local-action-emulator/`

## Deep-answer Standard

The final report must state `adopt`, `adopt conditionally`, or `reject`; explain whether Git synchronization is automatic with direct source and runtime evidence; define the exact retained/replaced test layers; identify any bridge as a concrete runtime/test mechanism rather than an abstract manager; and state explicit stop conditions that would prevent implementation.
