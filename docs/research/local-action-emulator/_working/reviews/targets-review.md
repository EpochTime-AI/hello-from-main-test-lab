# Targets Review: Local Action GitHub Emulator

## Status

`DONE`

## Scope

This is a targeted rerun of the `targets.md` gate. It checks only previous blockers `TGT-01` through `TGT-07` and direct regressions in the revised target artifact. It uses the original brief, the `targets.md` gate criteria, and the artifact contract. It directly checked the revised local source paths, current Action/Octokit/Git seams, the upstream source at commit `d0219d05818adca4c12bb76ec79a7562c1766a3d` in `/tmp/opencode/hello-main-emulate-spike`, and the official provider reference URLs listed by the artifact.

README-only evidence remains excluded. This review assesses whether the selected targets and evidence plan are sufficient for deep-dive; it does not claim that the emulator has or lacks Git smart transport, persistence, GraphQL compatibility, or automatic synchronization. Those claims are correctly deferred to the mandatory executable/source evidence plan.

## Findings

| ID | Result | Finding | Evidence and gate impact |
| --- | --- | --- | --- |
| TGT-01 | resolved | The revised artifact now defines an executable smart-transport and synchronization matrix with both directions, restart, source scan, process ownership, temporary Git topology, exact probes, OID readbacks, failure capture, and the required three-valued result. | `targets.md:37-48` requires `git ls-remote`, clone, fetch, push, smart HTTP probes, SSH probing, API mutations, real bare-repository readback, process logs, exit codes, and before/after OIDs. It separately requires API-to-Git, real-Git-to-emulator, and restart checks. This directly answers the brief’s exact Git question without treating API Git Data as Git CLI evidence. |
| TGT-02 | resolved | Source-of-truth ownership and bridge obligations are now explicit required deep-dive outputs. | `targets.md:50-62` requires ownership and synchronization results for refs, commits, trees/blobs, PR head/base, merges, final main, and non-Git comments/reviews/checks. It requires a concrete bridge operation with source, destination, trigger, failure, and readback when synchronization is absent. |
| TGT-03 | resolved | Endpoint integration is now tied to both the current adapter and the actual Action composition transport, with exact URL and no-fallback assertions. | `targets.md:76-90` requires running `OctokitGithubPlatform` and the real Action transport against the emulator, classifying the required change as composition-root configuration, runtime change, adapter fork, or emulator fork, and asserting REST/GraphQL URLs and no `api.github.com` fallback. This is necessary because `src/entry/action-runtime.ts:253-303` hardcodes both hosts while `src/adapters/octokit.ts:43-46` exposes the injected transport seam. |
| TGT-04 | resolved | Persistence is correctly separated by runtime mode and requires two-process readback for the proposed adoption mode. | `targets.md:64-74` distinguishes programmatic/server, embedded/Next, and CLI modes; explicitly permits `unsupported` for CLI if no persistence option exists; and requires comment CRUD plus PR/ref/commit/tree/blob readback after restart. This matches the upstream split between a new in-memory `Store` per server (`packages/@emulators/core/src/server.ts:24-30`), the standalone persistence adapter (`packages/@emulators/core/src/persistence.ts:4-22`), and the CLI startup path (`packages/emulate/src/commands/start.ts:271-381`). |
| TGT-05 | resolved | Required REST and GraphQL compatibility is now governed by a fixed request inventory and executable adapter-against-emulator checks, including explicit GraphQL absence handling and the intentionally fail-closed Integration merge. | `targets.md:76-90` enumerates current Git Data, PR, retarget, reviews, checks, merges, GraphQL Ready, future comments, and base-current gate behavior. It requires classifying each operation and running the actual adapter, while requiring source proof plus an adapter failure capture for GraphQL absence. This is aligned with `src/adapters/octokit.ts:454-502` and its fail-closed Integration merge at `src/adapters/octokit.ts:93-103`. |
| TGT-06 | resolved | Webhook scope and behavior classification are now explicit enough for deep-dive. | `targets.md:92-94` names the required PR, comment, review, check, and ref events and requires recording automatic state coupling, manual-only dispatch, persistence ordering, retry behavior, duplicate delivery, delivery failure, and wakeup suitability. This is sufficient to prevent treating upstream dispatcher tests or webhook payloads as proof of provider event semantics. |
| TGT-07 | resolved | The revised artifact supplies concrete local paths and an official provider reference set. | `targets.md:12` names the current adapters, entrypoint, ports, and relevant local tests, including `test/runtime/composition.test.ts`, `test/stability/restart-recovery.test.ts`, and `test/stability/unknown-outcome.test.ts`; those paths exist in the current repository. `targets.md:96-108` supplies URLs for the relevant REST, GraphQL, webhook, and Git smart HTTP contracts. Traceability is sufficient for deep-dive. |

## Direct Regression Check

No direct regressions found in the revised artifact.

- The selected target set remains relevant and source-backed; no README-only target entered deep-dive.
- Primary and supporting evidence remain distinguished in `targets.md:9-13`.
- Unknowns remain explicit, including GraphQL, Git smart transport, persistence, endpoint/runtime fit, webhook coupling, and ownership.
- The artifact preserves the valid scope boundary that this is a feasibility assessment of the user-selected candidate, not a broad emulator bake-off (`targets.md:24-26`).
- Unsupported behavior is allowed as a result, but it must be recorded explicitly (`targets.md:33-35`). This does not weaken the decision criteria because the brief permits rejection when the required bridge or fidelity is absent.

## Required Next Handling

Proceed to deep-dive using the mandatory matrices in `targets.md`. Preserve the following boundaries in the downstream evidence:

1. Do not infer real Git synchronization from REST Git Data objects, response URL fields, README claims, or API ref mutations.
2. Record the exact command, process, endpoint, response, exit code, OID, and cleanup evidence for each smart-transport direction.
3. Keep `synchronized`, `not synchronized`, and `unknown` as separate outcomes and do not silently convert unsupported probes into negative claims.
4. Run the proposed adoption runtime mode through the two-process persistence test and the actual Action/Octokit endpoint test before recommending replacement.

These are deep-dive execution requirements, not blockers in the target-selection artifact.

## Gate Decision

`DONE`: `targets.md` is sufficiently complete and traceable to enter deep-dive. Previous blockers `TGT-01` through `TGT-07` are resolved at the evidence-plan level, and no direct regression was found. This decision authorizes deep-dive only; it does not authorize a conclusion about `vercel-labs/emulate` or about automatic synchronization with real Git remotes before the required executable/source evidence is collected.
