import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createGitRunner,
  GitCommandError,
  RealGitWorkspace,
} from "../../src/adapters/git.js";
import {
  type LocalEffectRecord,
  openLocalActionRun,
} from "../../src/adapters/local-github.js";
import { gitBlobOid, oid, type RepositoryFacts } from "../../src/core/model.js";
import { productionCandidatePolicy } from "../../src/entry/policy.js";
import { parseCard } from "../../src/render/card.js";
import { renderCompletionComment } from "../../src/render/comment.js";
import {
  createGoodFirstConflictScenario,
  resolvedAliceCardBytes,
} from "../../src/scenarios/good-first-conflict.js";

describe("real local Git scenario", () => {
  test("keeps Git argv isolated and rejects shell-shaped input", async () => {
    const runner = createGitRunner({ root: "/tmp/hello-from-main-test" });

    await expect(
      runner.run(["--version; touch injected"], { cwd: "/tmp" }),
    ).rejects.toBeInstanceOf(GitCommandError);
  });

  test("creates and exposes a meaningful real add/add conflict", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const conflict = await scenario.contributor.rebaseAndInspectConflict();

      expect(conflict.path).toBe("people/alice.md");
      expect(new TextEncoder().encode(conflict.stages[2])).toEqual(
        new TextEncoder().encode(
          "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Project shell\n\n最近在折腾：Git metadata\n\n> Project source metadata",
        ),
      );
      const stagedBytes = new TextEncoder().encode(conflict.stages[3]);
      expect(stagedBytes).toEqual(resolvedAliceCardBytes.slice(0, -1));
      const stagedCard = parseCard(new Uint8Array([...stagedBytes, 10]), {
        path: conflict.path,
        policy: productionCandidatePolicy.card,
      });
      expect(stagedCard).toMatchObject({ ok: true });
      if (!stagedCard.ok) throw new Error(stagedCard.error.reason);
      expect(stagedCard.card).toMatchObject({
        metadata: { githubId: "7", sourcePr: 1 },
        contributor: { nickname: "Alice", exploring: "TypeScript / Git" },
      });
      const conflictStages = await createGitRunner({ root: scenario.root }).run(
        ["ls-files", "--stage", "--", conflict.path],
        { cwd: scenario.contributorPath },
      );
      expect(conflictStages.stdout).toBe(
        `100644 ${gitBlobOid(new TextEncoder().encode(`${conflict.stages[2]}\n`))} 2\tpeople/alice.md\n100644 ${gitBlobOid(resolvedAliceCardBytes)} 3\tpeople/alice.md\n`,
      );
      expect(conflict.rebaseHead).not.toBe("");
    } finally {
      await scenario.dispose();
    }
  });

  test("reads final main bytes and DAG facts from the remote after a real no-ff merge", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const workspace = scenario.botWorkspace;
      const runner = createGitRunner({ root: scenario.root });
      await runner.run(
        ["switch", "-C", "feature/card-alice-source-1", "origin/main"],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        ["push", "--force", "origin", "HEAD:feature/card-alice-source-1"],
        { cwd: scenario.integrationPath },
      );
      const before = await workspace.readWorkspace();
      const integrationHead = before.value?.integrationHeadOid;
      if (!integrationHead) throw new Error("integration head is required");
      expect(before.value?.candidate).toBeUndefined();
      const candidate = await workspace.writeIntegrationCandidate({
        // These are the expected immutable tree objects, not placeholders.
        input: {
          observedMainOid: oid(
            (
              await runner.run(["rev-parse", "origin/main"], {
                cwd: scenario.integrationPath,
              })
            ).stdout.trim(),
          ),
          expectedIntegrationHeadOid: integrationHead,
          cardPath: "people/alice.md",
          cardBytes: new TextEncoder().encode(
            "---\ngithub_id: 7\nsource_pr: 1\n---\n\n# Candidate Card\n",
          ),
          readmeBytes: new TextEncoder().encode(
            "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
          ),
        },
        postconditions: {
          cardManifest: {
            path: "people/alice.md",
            blobOid: gitBlobOid(
              new TextEncoder().encode(
                "---\ngithub_id: 7\nsource_pr: 1\n---\n\n# Candidate Card\n",
              ),
            ),
            githubId: "7",
            sourcePrNumber: 1,
          },
          readmeBlobOid: gitBlobOid(
            new TextEncoder().encode(
              "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
            ),
          ),
          history: {
            retainCommitOids: [integrationHead],
            requiredParentOids: [integrationHead],
          },
        },
      });
      const candidateHead =
        candidate.kind === "succeeded" || candidate.kind === "alreadyApplied"
          ? candidate.value.integrationHeadOid
          : undefined;
      const candidateFact =
        candidate.kind === "succeeded" || candidate.kind === "alreadyApplied"
          ? candidate.value.candidate
          : undefined;
      if (!candidateHead || !candidateFact)
        throw new Error("candidate is required");
      const restartedWorkspace = new RealGitWorkspace(
        runner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      );
      const restarted = await restartedWorkspace.readWorkspace();
      const integrationTreePaths = (
        await runner.run(["ls-tree", "-r", "--name-only", candidateHead], {
          cwd: scenario.integrationPath,
        })
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(integrationTreePaths).toEqual(["README.md", "people/alice.md"]);
      expect(integrationTreePaths).not.toContain(
        ".hello-from-main/candidate.json",
      );
      const candidateCommit = await runner.run(
        ["show", "-s", "--format=%B", candidateHead],
        { cwd: scenario.integrationPath },
      );
      expect(candidateCommit.stdout).toContain(
        `Hello-From-Main-Main-Oid: ${candidateFact.mainOid}`,
      );
      expect(candidateCommit.stdout).toContain(
        "Hello-From-Main-Card-Path: people/alice.md",
      );
      expect(restarted.value?.candidate?.retainedCommitOids).toEqual(
        candidateFact.retainedCommitOids,
      );
      expect(restarted.value?.candidate?.requiredParentOids).toEqual(
        candidateFact.requiredParentOids,
      );
      await runner.run(["switch", "main"], { cwd: scenario.integrationPath });
      const mainWorkspace = new RealGitWorkspace(
        runner,
        scenario.integrationPath,
        "origin",
        "main",
      );
      const published = await mainWorkspace.mergeNoFastForward({
        sourceRef: candidateHead,
        expectedTargetOid: oid(
          await (async () => {
            return (
              await runner.run(["rev-parse", "origin/main"], {
                cwd: scenario.integrationPath,
              })
            ).stdout.trim();
          })(),
        ),
        message: "Merge integration PR #2",
      });
      const final = await mainWorkspace.readFinalMainPostconditions({
        mainOid: published.mergeCommitOid,
        cardManifest: {
          path: "people/alice.md",
          blobOid: candidateFact.cardBlobOid,
          githubId: "7",
          sourcePrNumber: 1,
        },
        readmeBytes: new TextEncoder().encode(
          "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
        ),
        retainedCommitOids: [integrationHead],
        requiredParentOids: [candidateHead],
      });
      expect(final.value?.mainOid).toBe(published.mergeCommitOid);
      expect(final.value?.cardManifest.blobOid).toBe(candidateFact.cardBlobOid);
      expect(new TextDecoder().decode(final.value?.readmeBytes)).toBe(
        "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
      );
      expect(new Set(final.value?.retainedCommitOids)).toEqual(
        new Set([published.mergeCommitOid, ...published.parents]),
      );
      expect(final.value?.retainedCommitOids).toHaveLength(3);
      expect(final.value?.requiredParentOids).toEqual(published.parents);
      const finalTreePaths = (
        await runner.run(["ls-tree", "-r", "--name-only", "origin/main"], {
          cwd: scenario.integrationPath,
        })
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(finalTreePaths).toEqual(["README.md", "people/alice.md"]);
    } finally {
      await scenario.dispose();
    }
  });

  test("runs the canonical contributor, candidate, confirmation, publication, and restart path through public boundaries", async () => {
    const scenario = await createGoodFirstConflictScenario();
    try {
      const setupRunner = createGitRunner({ root: scenario.root });
      const setupMainOid = oid(
        (
          await setupRunner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const setupSourceOid = oid(
        (
          await setupRunner.run(["rev-parse", "origin/add/alice"], {
            cwd: scenario.contributorPath,
          })
        ).stdout.trim(),
      );
      const setupSource = {
        number: 1,
        kind: "contribution" as const,
        headOid: setupSourceOid,
        baseOid: setupMainOid,
        headRef: "add/alice",
        baseRef: "main",
        draft: false,
        authorLogin: "alice",
        authorGithubId: "7",
        headRepositoryOwnerLogin: "alice",
        headRepositoryIsFork: true,
        changedFiles: [
          {
            path: "people/alice.md",
            blobOid: gitBlobOid(resolvedAliceCardBytes),
            bytes: resolvedAliceCardBytes,
          },
        ],
        changedFilesComplete: true,
        observedOid: setupSourceOid,
        provenance: "modeled" as const,
      };
      // The Local Action begins with only provider facts available at intake.
      // Setup, candidate, eligibility, confirmation, and publication facts are
      // produced by Core, fixture events, and Git readback below.
      const setupFacts = {
        trustedCommentOwner: { actorId: "42", actorType: "Bot" },
        trustedRepository: {
          webBaseUrl: "https://github.com",
          owner: "local",
          repo: "verification",
        },
        main: {
          status: "ready",
          provenance: "modeled",
          value: {
            oid: setupMainOid,
            readmeBytes: new TextEncoder().encode(
              "# Hello from Main\n\n<!-- cards:start -->\n<!-- cards:end -->\n",
            ),
            cardManifests: [],
            cardPayloads: [],
          },
        },
        sourcePullRequest: {
          status: "ready",
          provenance: "modeled",
          value: setupSource,
        },
        integrationBranch: { status: "absent" },
        integrationPullRequest: { status: "absent" },
        candidate: { status: "absent" },
        eligibility: {
          checks: { status: "pending" },
          reviews: { status: "pending" },
          mergeability: { status: "pending" },
          baseCurrent: { status: "pending" },
        },
        confirmations: [],
      } satisfies RepositoryFacts;
      const mainPath = `${scenario.root}/publisher`;
      await setupRunner.run(["clone", scenario.upstream, mainPath], {
        cwd: scenario.root,
      });
      await setupRunner.run(["switch", "main"], { cwd: mainPath });
      const mainWorkspace = new RealGitWorkspace(
        setupRunner,
        mainPath,
        "origin",
        "main",
      );
      const realGit = {
        workspace: scenario.botWorkspace,
        integrationWorkspace: mainWorkspace,
        refs: {
          contribution: "contributor/add/alice",
          integration: "origin/feature/card-alice-source-1",
        },
      };
      const effects: LocalEffectRecord[] = [];
      let loseCompletionResponse = false;
      const seed = {
        facts: setupFacts,
        actionContext: {
          eventName: "workflow_dispatch",
          repository: "local/verification",
          ref: "refs/heads/main",
          sha: "local-main",
          eventPath: "local-event.json",
        },
        onEffect: (effect: LocalEffectRecord) => effects.push(effect),
        afterPersistBeforeReturn: (intent: { phase: string }) => {
          if (!loseCompletionResponse || intent.phase !== "completion")
            return undefined;
          loseCompletionResponse = false;
          return { kind: "unknownOutcome" as const, detail: "response lost" };
        },
      };
      const wake = async (
        event: Parameters<typeof openLocalActionRun>[0]["event"] = {
          kind: "wake",
        },
        maxEffects = 1,
      ) => {
        const run = await openLocalActionRun({
          dir: scenario.root,
          realGit,
          seed,
          event,
        });
        try {
          return await run.wake({ maxEffects });
        } finally {
          await run.close();
        }
      };
      const observe = async () => {
        const run = await openLocalActionRun({
          dir: scenario.root,
          realGit,
          seed,
          event: { kind: "wake" },
        });
        try {
          return await run.platform.observeRepository();
        } catch (error) {
          throw new Error(
            `Local observation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await run.close();
        }
      };
      await wake({ kind: "wake" }, 4);
      await wake({ kind: "wake" }, 0);
      await wake({ kind: "wake" }, 0);
      const setupReadback = await observe();
      const setupBranch = setupReadback.value?.integrationBranch.value;
      const setupIntegration =
        setupReadback.value?.integrationPullRequest.value;
      if (!setupBranch || !setupIntegration)
        throw new Error("Core setup did not converge");
      expect(setupBranch.headOid).not.toBe(setupMainOid);
      expect(
        (
          await setupRunner.run(
            ["show", `${setupBranch.headOid}:people/alice.md`],
            {
              cwd: scenario.integrationPath,
            },
          )
        ).stdout,
      ).toBe(
        "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Project shell\n\n最近在折腾：Git metadata\n\n> Project source metadata\n",
      );
      expect(setupReadback.value?.sourcePullRequest.value?.baseOid).toBe(
        setupBranch.headOid,
      );
      const conflict = await scenario.contributor.rebaseAndInspectConflict();
      const resolvedCard = new TextEncoder().encode(
        conflict.stages[3]
          .replace("# Project shell", "# Alice")
          .replace("最近在折腾：Git metadata", "最近在折腾：TypeScript / Git")
          .replace(
            "> Project source metadata",
            "> I am learning to resolve a real conflict.",
          ),
      );
      const resolvedCardWithLf = new Uint8Array([...resolvedCard, 10]);
      await scenario.contributor.resolveCard(resolvedCardWithLf);
      await scenario.contributor.continueRebase();
      await scenario.contributor.pushForceWithLease();

      const runner = createGitRunner({ root: scenario.root });
      const sourceHead = oid(
        (
          await runner.run(["rev-parse", "HEAD"], {
            cwd: scenario.contributorPath,
          })
        ).stdout.trim(),
      );
      const cardBytes = new TextEncoder().encode(
        (
          await runner.run(["show", `HEAD:people/alice.md`], {
            cwd: scenario.contributorPath,
          })
        ).stdout,
      );
      // The same fixture-owned platform observes the external Git action.
      await wake(
        {
          kind: "push",
          actorLogin: "alice",
          sourcePrNumber: 1,
          headOid: sourceHead,
          cardBytes,
        },
        8,
      );
      await wake({ kind: "wake" }, 8);
      await wake({ kind: "wake" }, 8);
      await wake({ kind: "wake" }, 8);
      const candidate = (await observe()).value?.candidate.value;
      if (!candidate) throw new Error("candidate readback is required");
      await wake();
      expect((await observe()).value?.integrationPullRequest.value?.draft).toBe(
        false,
      );
      await wake({
        kind: "checksCompleted",
        candidateOid: candidate.integrationHeadOid,
      });
      await wake({
        kind: "approval",
        actorLogin: "alice",
        sourcePrNumber: 1,
        integrationPrNumber: setupIntegration.number,
        candidateOid: candidate.integrationHeadOid,
      });
      loseCompletionResponse = true;
      const publicationOutcomes = [
        await wake({ kind: "wake" }, 1),
        await wake({ kind: "wake" }, 1),
        await wake({ kind: "wake" }, 1),
        await wake({ kind: "wake" }, 1),
      ];
      expect(publicationOutcomes.at(-1)).toEqual({ kind: "quiescent" });

      const finalMain = (await observe()).value?.main.value;
      if (!finalMain?.readmeBytes) throw new Error("final README is required");
      const final = await mainWorkspace.readFinalMainPostconditions({
        mainOid: oid(
          (
            await runner.run(["rev-parse", "origin/main"], { cwd: mainPath })
          ).stdout.trim(),
        ),
        cardManifest: {
          path: "people/alice.md",
          blobOid: candidate.cardBlobOid,
          githubId: "7",
          sourcePrNumber: 1,
        },
        readmeBytes: finalMain.readmeBytes,
        retainedCommitOids: [sourceHead, setupBranch.headOid],
        requiredParentOids: [candidate.integrationHeadOid],
      });
      expect(final.value?.cardManifest.blobOid).toBe(candidate.cardBlobOid);
      const finalCard = parseCard(cardBytes, {
        path: "people/alice.md",
        policy: productionCandidatePolicy.card,
      });
      if (!finalCard.ok) throw new Error(finalCard.error.reason);
      const expectedReadme = `# Hello from Main\n\n<!-- cards:start -->\n${productionCandidatePolicy.renderRegion([finalCard.card])}\n<!-- cards:end -->\n`;
      expect(new TextDecoder().decode(final.value?.readmeBytes)).toBe(
        expectedReadme,
      );
      expect(final.value?.cardBytes).toEqual(cardBytes);
      const exactReachable = (
        await runner.run(["rev-list", "origin/main"], { cwd: mainPath })
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(new Set(final.value?.retainedCommitOids)).toEqual(
        new Set(exactReachable),
      );
      expect(final.value?.retainedCommitOids).toHaveLength(
        exactReachable.length,
      );
      expect(final.value?.requiredParentOids).toEqual([
        setupMainOid,
        candidate.integrationHeadOid,
      ]);
      const mergeCommits = (
        await runner.run(["log", "--merges", "--format=%H", "origin/main"], {
          cwd: mainPath,
        })
      ).stdout
        .split("\n")
        .filter(Boolean);
      expect(mergeCommits).toHaveLength(2);
      const integrationParents = (
        await runner.run(["rev-list", "--parents", "-n", "1", "origin/main"], {
          cwd: mainPath,
        })
      ).stdout
        .trim()
        .split(" ");
      expect(integrationParents.slice(1)).toEqual([
        setupMainOid,
        candidate.integrationHeadOid,
      ]);
      const contributionMerge = mergeCommits[1];
      if (!contributionMerge) throw new Error("Contribution merge is required");
      const contributionParents = (
        await runner.run(
          ["rev-list", "--parents", "-n", "1", contributionMerge],
          {
            cwd: mainPath,
          },
        )
      ).stdout
        .trim()
        .split(" ");
      expect(contributionParents.slice(1)).toEqual([
        setupBranch.headOid,
        sourceHead,
      ]);
      const mainTreePaths = (
        await runner.run(["ls-tree", "-r", "--name-only", "origin/main"], {
          cwd: mainPath,
        })
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(mainTreePaths).toEqual(["README.md", "people/alice.md"]);
      const restartedObserved = await observe();
      expect(restartedObserved.value?.main.value?.cardManifests).toHaveLength(
        1,
      );
      expect(await wake({ kind: "wake" }, 8)).toEqual({ kind: "quiescent" });
      const publishedMainOid = final.value?.mainOid;
      if (!publishedMainOid) throw new Error("published main OID is required");
      const target = {
        webBaseUrl: "https://github.com",
        owner: "local",
        repo: "verification",
        publishedMainOid,
        cardPath: "people/alice.md",
        expectedCardBlobOid: candidate.cardBlobOid,
        sourcePullRequestNumber: 1,
      };
      const expectedComments = [
        renderCompletionComment({
          runIdentity: "source:1:7",
          targetPullRequestNumber: 1,
          slot: "source-status",
          target,
        }),
        renderCompletionComment({
          runIdentity: "source:1:7",
          targetPullRequestNumber: setupIntegration.number,
          slot: "integration-status",
          target,
        }),
      ];
      const reopened = await openLocalActionRun({
        dir: scenario.root,
        realGit,
        seed,
        event: { kind: "wake" },
      });
      try {
        await expect(reopened.wake()).resolves.toEqual({ kind: "quiescent" });
        for (const comment of expectedComments) {
          await expect(
            reopened.platform.ensureComment({
              targetPullRequestNumber:
                comment.slot === "source-status" ? 1 : setupIntegration.number,
              slot: comment.slot,
              actionKey: comment.actionKey,
              phase: comment.phase,
              body: comment.body,
            }),
          ).resolves.toMatchObject({
            kind: "noOp",
            comment: { body: comment.body },
          });
        }
      } finally {
        await reopened.close();
      }
      const persisted = JSON.parse(
        await readFile(`${scenario.root}/state.json`, "utf8"),
      ) as { facts: { comments?: Array<Record<string, unknown>> } };
      expect(persisted.facts).not.toHaveProperty("commentsRequired");
      expect(persisted.facts.comments).toHaveLength(2);
      expect(persisted.facts.comments).toEqual(
        expectedComments.map((comment) =>
          expect.objectContaining({
            targetPullRequestNumber:
              comment.slot === "source-status" ? 1 : setupIntegration.number,
            actionKey: comment.actionKey,
            body: comment.body,
            ownerPrincipal: { actorId: "42", actorType: "Bot" },
            user: { id: "42", actorType: "Bot" },
          }),
        ),
      );
      const completionEffects = effects.filter((effect) =>
        expectedComments.some(
          (comment) => comment.actionKey === effect.actionKey,
        ),
      );
      expect(completionEffects.map((effect) => effect.kind)).toEqual([
        "create",
        "update",
        "create",
        "update",
        "update",
        "noOp",
        "noOp",
      ]);
      expect(
        completionEffects.filter((effect) => effect.kind === "create"),
      ).toHaveLength(2);
    } finally {
      await scenario.dispose();
    }
  }, 15_000);
});
