import { access, readFile, writeFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createGitRunner,
  GitCommandError,
  type GitRunner,
  installGitAuthentication,
  parseExactRemoteRef,
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

function projectShellBytes(): Uint8Array {
  return new TextEncoder().encode(
    "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Project shell\n\n最近在折腾：Git metadata\n\n> Project source metadata\n",
  );
}

describe("real local Git scenario", () => {
  test.each([
    [
      "exact",
      `${"a".repeat(40)}\trefs/heads/feature/card-alice-source-1\n`,
      true,
    ],
    ["wrong ref", `${"a".repeat(40)}\trefs/heads/other\n`, false],
    [
      "multiple",
      "a".repeat(40) +
        "\trefs/heads/feature/card-alice-source-1\n" +
        "b".repeat(40) +
        "\trefs/heads/feature/card-alice-source-1",
      false,
    ],
    [
      "malformed oid",
      `${"A".repeat(40)}\trefs/heads/feature/card-alice-source-1\n`,
      false,
    ],
    [
      "extra field",
      `${"a".repeat(40)}\trefs/heads/feature/card-alice-source-1\textra\n`,
      false,
    ],
  ] as const)(
    "strictly parses %s ls-remote output",
    (_name, output, accepted) => {
      const actual = parseExactRemoteRef(
        output,
        "refs/heads/feature/card-alice-source-1",
      );
      expect(Boolean(actual)).toBe(accepted);
    },
  );
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

  test("marks a Project Shell only after its exact proposed commit is read back from the bare remote", async () => {
    const scenario = await createGoodFirstConflictScenario();
    try {
      const runner = createGitRunner({ root: scenario.root });
      const main = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const result =
        await scenario.botWorkspace.createIntegrationBranchWithProjectShell({
          name: "feature/card-alice-source-1",
          fromMainOid: main,
          cardPath: "people/alice.md",
          cardBytes: new TextEncoder().encode(
            "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Project shell\n\n最近在折腾：Git metadata\n\n> Project source metadata\n",
          ),
          setupOperationNonce: "test-nonce",
        });
      const remote = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      expect(
        "establishedByCurrentOperation" in result &&
          result.establishedByCurrentOperation,
      ).toBe(true);
      expect(result.branch.headOid).toBe(remote);
      const proof =
        "setupProjectShellProof" in result
          ? result.setupProjectShellProof
          : undefined;
      expect(proof).toBeDefined();
      expect(Object.isFrozen(proof)).toBe(true);
      expect(proof?.operationNonce).toBe("test-nonce");
      expect(proof?.branchName).toBe("feature/card-alice-source-1");
      expect(proof?.branchHeadOid).toBe(remote);
      expect(() => {
        if (proof)
          (proof as { branchHeadOid: string }).branchHeadOid = oid("forged");
      }).toThrow();
      expect(
        (
          await runner.run(["show", "-s", "--format=%B", remote], {
            cwd: scenario.integrationPath,
          })
        ).stdout,
      ).toContain("Hello-From-Main-Setup-Nonce: test-nonce");
    } finally {
      await scenario.dispose();
    }
  });

  test("does not mark a preexisting exact Project Shell as this operation", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const main = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const result =
        await scenario.botWorkspace.createIntegrationBranchWithProjectShell({
          name: "feature/card-alice-source-1",
          fromMainOid: main,
          cardPath: "people/alice.md",
          cardBytes: new TextEncoder().encode(
            "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Project shell\n\n最近在折腾：Git metadata\n\n> Project source metadata\n",
          ),
          setupOperationNonce: "new-nonce",
        });
      expect("establishedByCurrentOperation" in result).toBe(false);
      expect("setupOperationNonce" in result).toBe(false);
    } finally {
      await scenario.dispose();
    }
  });

  test("recovers a response-lost Project Shell push only after exact remote readback", async () => {
    const scenario = await createGoodFirstConflictScenario();
    try {
      const base = createGitRunner({ root: scenario.root });
      let loseResponse = true;
      const workspace = new RealGitWorkspace(
        {
          run: async (argv, options) => {
            const result = await base.run(argv, options);
            if (loseResponse && argv[0] === "push") {
              loseResponse = false;
              throw new GitCommandError({
                ...result,
                status: 1,
                stderr: "lost",
              });
            }
            return result;
          },
        },
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      );
      const main = oid(
        (
          await base.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const result = await workspace.createIntegrationBranchWithProjectShell({
        name: "feature/card-alice-source-1",
        fromMainOid: main,
        cardPath: "people/alice.md",
        cardBytes: projectShellBytes(),
        setupOperationNonce: "response-lost-nonce",
      });
      expect(
        "establishedByCurrentOperation" in result &&
          result.establishedByCurrentOperation,
      ).toBe(true);
    } finally {
      await scenario.dispose();
    }
  });

  test("does not mark a concurrent bare-remote winner", async () => {
    const scenario = await createGoodFirstConflictScenario();
    try {
      const base = createGitRunner({ root: scenario.root });
      let replaceRemote = true;
      const workspace = new RealGitWorkspace(
        {
          run: async (argv, options) => {
            const result = await base.run(argv, options);
            if (replaceRemote && argv[0] === "push") {
              replaceRemote = false;
              const main = (
                await base.run(["rev-parse", "refs/heads/main"], {
                  cwd: scenario.upstream,
                })
              ).stdout.trim();
              await base.run(
                ["update-ref", "refs/heads/feature/card-alice-source-1", main],
                { cwd: scenario.upstream },
              );
              throw new GitCommandError({
                ...result,
                status: 1,
                stderr: "lost",
              });
            }
            return result;
          },
        },
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      );
      const main = oid(
        (
          await base.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      await expect(
        workspace.createIntegrationBranchWithProjectShell({
          name: "feature/card-alice-source-1",
          fromMainOid: main,
          cardPath: "people/alice.md",
          cardBytes: projectShellBytes(),
          setupOperationNonce: "concurrent-nonce",
        }),
      ).rejects.toThrow("lost");
    } finally {
      await scenario.dispose();
    }
  });

  test("binds local ancestry to the exact fetched contributor head", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const integration = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      await scenario.contributor.rebaseAndInspectConflict();
      await scenario.contributor.resolveCard(resolvedAliceCardBytes);
      await scenario.contributor.continueRebase();
      await scenario.contributor.pushForceWithLease();
      const source = oid(
        (
          await runner.run(["rev-parse", "HEAD"], {
            cwd: scenario.contributorPath,
          })
        ).stdout.trim(),
      );
      await expect(
        scenario.botWorkspace.isAncestor(
          integration,
          "contributor/add/alice",
          source,
        ),
      ).resolves.toEqual({ isAncestor: true, sourceHeadOid: source });
      await expect(
        scenario.botWorkspace.isAncestor(
          integration,
          "contributor/add/alice",
          oid("wrong-source"),
        ),
      ).resolves.toMatchObject({ isAncestor: false, sourceHeadOid: source });
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

  test("publishes an Integration merge with an explicit main lease and exact parents and tree", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      const result = await scenario.botWorkspace.publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });

      expect(result).toEqual({
        kind: "integrationMerged",
        mainOid: expect.any(String),
      });
      if (result.kind !== "integrationMerged")
        throw new Error("Integration publication is required");
      const remoteMain = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const parents = (
        await runner.run(["rev-list", "--parents", "-n", "1", remoteMain], {
          cwd: scenario.integrationPath,
        })
      ).stdout
        .trim()
        .split(" ")
        .slice(1)
        .map(oid);
      expect(remoteMain).toBe(result.mainOid);
      expect(parents).toEqual([observedBaseOid, expectedHeadOid]);
      await expect(
        runner.run(
          [
            "diff",
            "--exit-code",
            `${remoteMain}^{tree}`,
            `${expectedHeadOid}^{tree}`,
          ],
          {
            cwd: scenario.integrationPath,
          },
        ),
      ).resolves.toBeDefined();
    } finally {
      await scenario.dispose();
    }
  });

  test("rejects a stale Integration main lease without moving main", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      const writerPath = `${scenario.root}/stale-main-writer`;
      await runner.run(["clone", scenario.upstream, writerPath], {
        cwd: scenario.root,
      });
      let advanced = false;
      const racingRunner: GitRunner = {
        async run(argv, options) {
          if (
            !advanced &&
            argv[0] === "push" &&
            argv.some((arg) => arg.includes("refs/heads/main"))
          ) {
            advanced = true;
            await runner.run(["switch", "main"], { cwd: writerPath });
            await runner.run(
              ["commit", "--allow-empty", "--message", "Advance main"],
              {
                cwd: writerPath,
              },
            );
            await runner.run(["push", "origin", "HEAD:main"], {
              cwd: writerPath,
            });
          }
          return runner.run(argv, options);
        },
      };
      const result = await new RealGitWorkspace(
        racingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });

      const remoteMain = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      expect(result).toEqual({
        kind: "integrationRejected",
        reason: "baseMoved",
      });
      expect(remoteMain).not.toBe(observedBaseOid);
      expect(remoteMain).not.toBe(expectedHeadOid);
    } finally {
      await scenario.dispose();
    }
  });

  test("atomically rejects a moved Integration candidate without moving main", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            {
              cwd: scenario.integrationPath,
            },
          )
        ).stdout.trim(),
      );
      const writerPath = `${scenario.root}/candidate-race-writer`;
      await runner.run(["clone", scenario.upstream, writerPath], {
        cwd: scenario.root,
      });
      let moved = false;
      const racingRunner: GitRunner = {
        async run(argv, options) {
          if (!moved && argv[0] === "push" && argv.includes("--atomic")) {
            moved = true;
            await runner.run(["switch", "feature/card-alice-source-1"], {
              cwd: writerPath,
            });
            await runner.run(
              ["commit", "--allow-empty", "--message", "Move candidate"],
              {
                cwd: writerPath,
              },
            );
            await runner.run(
              ["push", "origin", "HEAD:feature/card-alice-source-1"],
              {
                cwd: writerPath,
              },
            );
          }
          return runner.run(argv, options);
        },
      };
      const result = await new RealGitWorkspace(
        racingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });
      const remoteMain = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const remoteCandidate = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            {
              cwd: scenario.integrationPath,
            },
          )
        ).stdout.trim(),
      );
      expect(result).toEqual({
        kind: "integrationRejected",
        reason: "stalePrecondition",
      });
      expect(remoteMain).toBe(observedBaseOid);
      expect(remoteCandidate).not.toBe(expectedHeadOid);
    } finally {
      await scenario.dispose();
    }
  });

  test("atomically rejects a candidate moved backward without restoring it", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      const writerPath = `${scenario.root}/candidate-backward-writer`;
      await runner.run(["clone", scenario.upstream, writerPath], {
        cwd: scenario.root,
      });
      let moved = false;
      const racingRunner: GitRunner = {
        async run(argv, options) {
          if (!moved && argv[0] === "push" && argv.includes("--atomic")) {
            moved = true;
            await runner.run(
              [
                "push",
                `--force-with-lease=refs/heads/feature/card-alice-source-1:${expectedHeadOid}`,
                "origin",
                `${observedBaseOid}:refs/heads/feature/card-alice-source-1`,
              ],
              { cwd: writerPath },
            );
          }
          return runner.run(argv, options);
        },
      };
      const result = await new RealGitWorkspace(
        racingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });
      const remoteMain = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const remoteCandidate = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      expect(result).toEqual({
        kind: "integrationRejected",
        reason: "stalePrecondition",
      });
      expect(remoteMain).toBe(observedBaseOid);
      expect(remoteCandidate).toBe(observedBaseOid);
    } finally {
      await scenario.dispose();
    }
  });

  test("recognizes an exact published Integration merge from a fresh workspace", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            {
              cwd: scenario.integrationPath,
            },
          )
        ).stdout.trim(),
      );
      const request = {
        kind: "integration" as const,
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required" as const,
      };
      const first =
        await scenario.botWorkspace.publishIntegrationMerge(request);
      if (first.kind !== "integrationMerged")
        throw new Error("publication is required");
      const replay = await new RealGitWorkspace(
        runner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge(request);
      expect(replay).toEqual({
        kind: "integrationAlreadyApplied",
        mainOid: first.mainOid,
      });
    } finally {
      await scenario.dispose();
    }
  });

  test("returns the concurrent exact winner OID after its own atomic push loses", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      const winnerPath = `${scenario.root}/concurrent-winner`;
      await runner.run(["clone", scenario.upstream, winnerPath], {
        cwd: scenario.root,
      });
      let published = false;
      let winnerOid: ReturnType<typeof oid> | undefined;
      const racingRunner: GitRunner = {
        async run(argv, options) {
          if (!published && argv[0] === "push" && argv.includes("--atomic")) {
            published = true;
            await runner.run(["switch", "-C", "main", observedBaseOid], {
              cwd: winnerPath,
            });
            await runner.run(
              ["merge", "--no-ff", "--no-edit", expectedHeadOid],
              {
                cwd: winnerPath,
                env: {
                  GIT_AUTHOR_DATE: "2026-08-27T00:00:00Z",
                  GIT_COMMITTER_DATE: "2026-08-27T00:00:00Z",
                },
              },
            );
            winnerOid = oid(
              (
                await runner.run(["rev-parse", "HEAD"], { cwd: winnerPath })
              ).stdout.trim(),
            );
            await runner.run(
              [
                "push",
                "--porcelain",
                "--atomic",
                `--force-with-lease=refs/heads/main:${observedBaseOid}`,
                `--force-with-lease=refs/heads/feature/card-alice-source-1:${expectedHeadOid}`,
                "origin",
                `${winnerOid}:refs/heads/main`,
                `${expectedHeadOid}:refs/heads/feature/card-alice-source-1`,
              ],
              { cwd: winnerPath },
            );
          }
          return runner.run(argv, options);
        },
      };
      const result = await new RealGitWorkspace(
        racingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });
      if (!winnerOid) throw new Error("concurrent winner is required");
      expect(result).toEqual({
        kind: "integrationAlreadyApplied",
        mainOid: winnerOid,
      });
    } finally {
      await scenario.dispose();
    }
  });

  test("recovers a response-lost Integration publication from exact remote readback", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      let loseResponse = true;
      const responseLosingRunner: GitRunner = {
        async run(argv, options) {
          const result = await runner.run(argv, options);
          if (
            loseResponse &&
            argv[0] === "push" &&
            argv.some((arg) => arg.includes("refs/heads/main"))
          ) {
            loseResponse = false;
            throw new Error("response lost after accepted push");
          }
          return result;
        },
      };
      const result = await new RealGitWorkspace(
        responseLosingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });

      expect(result).toEqual({
        kind: "integrationAlreadyApplied",
        mainOid: expect.any(String),
        publicationEstablishedByCurrentOperation: true,
      });
    } finally {
      await scenario.dispose();
    }
  });

  test("recognizes an applied Integration merge after main advances before response recovery", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const observedBaseOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const expectedHeadOid = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      const writerPath = `${scenario.root}/wrong-main-writer`;
      await runner.run(["clone", scenario.upstream, writerPath], {
        cwd: scenario.root,
      });
      let loseResponse = true;
      const responseLosingRunner: GitRunner = {
        async run(argv, options) {
          const result = await runner.run(argv, options);
          if (
            loseResponse &&
            argv[0] === "push" &&
            argv.some((arg) => arg.includes("refs/heads/main"))
          ) {
            loseResponse = false;
            await runner.run(["switch", "main"], { cwd: writerPath });
            await runner.run(["fetch", "origin", "main"], { cwd: writerPath });
            await runner.run(["switch", "-C", "main", "origin/main"], {
              cwd: writerPath,
            });
            await runner.run(
              [
                "commit",
                "--allow-empty",
                "--message",
                "Advance after publication",
              ],
              {
                cwd: writerPath,
              },
            );
            await runner.run(["push", "origin", "HEAD:main"], {
              cwd: writerPath,
            });
            throw new Error("response lost after a different remote result");
          }
          return result;
        },
      };
      const result = await new RealGitWorkspace(
        responseLosingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });

      expect(result).toEqual({
        kind: "integrationAlreadyApplied",
        mainOid: expect.any(String),
        publicationEstablishedByCurrentOperation: true,
      });
      if (result.kind !== "integrationAlreadyApplied")
        throw new Error("publication recovery is required");
      const replay = await new RealGitWorkspace(
        runner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).publishIntegrationMerge({
        kind: "integration",
        pullRequestNumber: 2,
        observedBaseOid,
        expectedHeadOid,
        baseCurrentGate: "required",
      });
      expect(replay).toEqual({
        kind: "integrationAlreadyApplied",
        mainOid: result.mainOid,
      });
    } finally {
      await scenario.dispose();
    }
  });

  test("writes, restarts from, and recovers an H2-refreshed candidate without another write", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const integrationHead = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      await runner.run(["switch", "main"], { cwd: scenario.integrationPath });
      await runner.run(
        ["commit", "--allow-empty", "--message", "Advance main"],
        {
          cwd: scenario.integrationPath,
        },
      );
      await runner.run(["push", "origin", "HEAD:main"], {
        cwd: scenario.integrationPath,
      });
      const mainOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const cardBytes = new TextEncoder().encode(
        "---\ngithub_id: 7\nsource_pr: 1\n---\n\n# Candidate Card\n",
      );
      const readmeBytes = new TextEncoder().encode(
        "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
      );
      const write = {
        input: {
          observedMainOid: mainOid,
          expectedIntegrationHeadOid: integrationHead,
          cardPath: "people/alice.md",
          cardBytes,
          readmeBytes,
        },
        postconditions: {
          cardManifest: {
            path: "people/alice.md",
            blobOid: gitBlobOid(cardBytes),
            githubId: "7",
            sourcePrNumber: 1,
          },
          readmeBlobOid: gitBlobOid(readmeBytes),
          history: {
            retainCommitOids: [integrationHead],
            requiredParentOids: [integrationHead],
          },
        },
      };
      const result =
        await scenario.botWorkspace.writeIntegrationCandidate(write);
      expect(result.kind).toBe("succeeded");
      if (result.kind !== "succeeded") throw new Error("candidate is required");
      const candidateHead = result.value.integrationHeadOid;
      if (!candidateHead) throw new Error("candidate head is required");
      const parents = (
        await runner.run(["rev-list", "--parents", "-n", "1", candidateHead], {
          cwd: scenario.integrationPath,
        })
      ).stdout
        .trim()
        .split(" ")
        .slice(1)
        .map(oid);
      expect(parents).toHaveLength(1);
      expect(parents[0]).not.toBe(integrationHead);
      const message = await runner.run(
        ["show", "-s", "--format=%B", candidateHead],
        {
          cwd: scenario.integrationPath,
        },
      );
      expect(message.stdout).toContain(
        `Hello-From-Main-Required-Parent-Oids: ${parents[0]}`,
      );
      const restarted = await new RealGitWorkspace(
        runner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).readWorkspace();
      expect(restarted.value?.candidate).toMatchObject({
        observedOid: candidateHead,
        mainOid,
        requiredParentOids: parents,
      });
      const legacyMessage = message.stdout.replace(
        `Hello-From-Main-Required-Parent-Oids: ${parents[0]}`,
        `Hello-From-Main-Required-Parent-Oids: ${integrationHead}`,
      );
      await runner.run(
        ["commit", "--amend", "--no-edit", "--message", legacyMessage],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      const legacyRestart = await new RealGitWorkspace(
        runner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).readWorkspace();
      expect(legacyRestart.value?.candidate).toMatchObject({ mainOid });

      // The legacy shape never bypasses tree/blob bindings.
      await runner.run(
        [
          "commit",
          "--amend",
          "--no-edit",
          "--message",
          legacyMessage.replace(
            `Hello-From-Main-Card-Blob-Oid: ${gitBlobOid(cardBytes)}`,
            "Hello-From-Main-Card-Blob-Oid: wrong-card-blob",
          ),
        ],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();

      // All trailer parents must be the pre-refresh Integration ancestor, not
      // merely any retained ancestor such as main.
      await runner.run(
        [
          "commit",
          "--amend",
          "--no-edit",
          "--message",
          legacyMessage.replace(
            `Hello-From-Main-Required-Parent-Oids: ${integrationHead}`,
            `Hello-From-Main-Required-Parent-Oids: ${mainOid}`,
          ),
        ],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();

      const arbitraryRetainedAncestor = oid(
        (
          await runner.run(["rev-list", "--max-parents=0", integrationHead], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      await runner.run(
        [
          "commit",
          "--amend",
          "--no-edit",
          "--message",
          legacyMessage.replace(
            `Hello-From-Main-Required-Parent-Oids: ${integrationHead}`,
            `Hello-From-Main-Required-Parent-Oids: ${arbitraryRetainedAncestor}`,
          ),
        ],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();

      // The H2 refresh tuple is ordered: integration first, current main second.
      await runner.run(["switch", "-C", "reversed-refresh", mainOid], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["merge", "--no-ff", "--no-edit", integrationHead], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        ["switch", "-C", "feature/card-alice-source-1", "reversed-refresh"],
        { cwd: scenario.integrationPath },
      );
      await writeFile(`${scenario.integrationPath}/people/alice.md`, cardBytes);
      await writeFile(`${scenario.integrationPath}/README.md`, readmeBytes);
      await runner.run(["add", "--", "people/alice.md", "README.md"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        [
          "commit",
          "--message",
          "Build candidate Card",
          "--message",
          legacyMessage,
        ],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();

      // A candidate is never a merge commit, even when its tree and trailers
      // otherwise look like the known H2 shape.
      await runner.run(["switch", "-c", "unexpected-parent"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        ["commit", "--allow-empty", "--message", "Unexpected parent"],
        { cwd: scenario.integrationPath },
      );
      await runner.run(["switch", "feature/card-alice-source-1"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["merge", "--no-ff", "--no-edit", "unexpected-parent"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        ["commit", "--amend", "--no-edit", "--message", legacyMessage],
        { cwd: scenario.integrationPath },
      );
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();
    } finally {
      await scenario.dispose();
    }
  });

  test("refreshes a legacy candidate with unchanged rendered files without contaminating its checkout", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const auth = await installGitAuthentication({
        root: scenario.integrationPath,
        token: "sanitized-test-token",
      });
      try {
        const runner = createGitRunner({ root: scenario.root, env: auth.env });
        const workspace = new RealGitWorkspace(
          runner,
          scenario.integrationPath,
          "origin",
          "feature/card-alice-source-1",
        );
        const integrationHead = oid(
          (
            await runner.run(
              ["rev-parse", "origin/feature/card-alice-source-1"],
              { cwd: scenario.integrationPath },
            )
          ).stdout.trim(),
        );
        const cardBytes = new TextEncoder().encode(
          (
            await runner.run(["show", `${integrationHead}:people/alice.md`], {
              cwd: scenario.integrationPath,
            })
          ).stdout,
        );
        const readmeBytes = new TextEncoder().encode(
          (
            await runner.run(["show", `${integrationHead}:README.md`], {
              cwd: scenario.integrationPath,
            })
          ).stdout,
        );
        const write = (
          mainOid: ReturnType<typeof oid>,
          head: ReturnType<typeof oid>,
        ) => ({
          input: {
            observedMainOid: mainOid,
            expectedIntegrationHeadOid: head,
            cardPath: "people/alice.md",
            cardBytes,
            readmeBytes,
          },
          postconditions: {
            cardManifest: {
              path: "people/alice.md",
              blobOid: gitBlobOid(cardBytes),
              githubId: "7",
              sourcePrNumber: 1,
            },
            readmeBlobOid: gitBlobOid(readmeBytes),
            history: {
              retainCommitOids: [integrationHead],
              requiredParentOids: [integrationHead],
            },
          },
        });
        const advanceMain = async (message: string, contents: string) => {
          await runner.run(["switch", "main"], {
            cwd: scenario.integrationPath,
          });
          await writeFile(
            `${scenario.integrationPath}/source-only.txt`,
            contents,
          );
          await runner.run(["add", "--", "source-only.txt"], {
            cwd: scenario.integrationPath,
          });
          await runner.run(["commit", "--message", message], {
            cwd: scenario.integrationPath,
          });
          await runner.run(["push", "origin", "HEAD:main"], {
            cwd: scenario.integrationPath,
          });
          return oid(
            (
              await runner.run(["rev-parse", "origin/main"], {
                cwd: scenario.integrationPath,
              })
            ).stdout.trim(),
          );
        };

        const firstMain = await advanceMain("Advance main source", "one\n");
        const initial = await workspace.writeIntegrationCandidate(
          write(firstMain, integrationHead),
        );
        expect(initial.kind).toBe("succeeded");
        if (initial.kind !== "succeeded")
          throw new Error("candidate is required");
        const legacyCandidate = initial.value.integrationHeadOid;
        if (!legacyCandidate) throw new Error("candidate head is required");
        const firstRefresh = oid(
          (
            await runner.run(["rev-parse", "HEAD^"], {
              cwd: scenario.integrationPath,
            })
          ).stdout.trim(),
        );
        const legacyMessage = (
          await runner.run(["show", "-s", "--format=%B", legacyCandidate], {
            cwd: scenario.integrationPath,
          })
        ).stdout.replace(
          `Hello-From-Main-Required-Parent-Oids: ${firstRefresh}`,
          `Hello-From-Main-Required-Parent-Oids: ${integrationHead}`,
        );
        await runner.run(
          [
            "commit",
            "--amend",
            "--allow-empty",
            "--no-edit",
            "--message",
            legacyMessage,
          ],
          { cwd: scenario.integrationPath },
        );
        await runner.run(
          [
            "push",
            "--force-with-lease",
            "origin",
            "HEAD:feature/card-alice-source-1",
          ],
          { cwd: scenario.integrationPath },
        );
        const legacyHead = oid(
          (
            await runner.run(
              ["rev-parse", "origin/feature/card-alice-source-1"],
              { cwd: scenario.integrationPath },
            )
          ).stdout.trim(),
        );
        const currentMain = await advanceMain(
          "Advance main source again",
          "two\n",
        );

        const refreshed = await workspace.writeIntegrationCandidate(
          write(currentMain, legacyHead),
        );
        expect(refreshed.kind).toBe("succeeded");
        if (refreshed.kind !== "succeeded")
          throw new Error("candidate is required");
        const candidateHead = refreshed.value.integrationHeadOid;
        if (!candidateHead) throw new Error("candidate head is required");
        const candidateParents = (
          await runner.run(
            ["rev-list", "--parents", "-n", "1", candidateHead],
            {
              cwd: scenario.integrationPath,
            },
          )
        ).stdout
          .trim()
          .split(" ")
          .slice(1)
          .map(oid);
        expect(candidateParents).toHaveLength(1);
        const [refreshCommit] = candidateParents;
        if (!refreshCommit) throw new Error("refresh commit is required");
        const refreshParents = (
          await runner.run(
            ["rev-list", "--parents", "-n", "1", refreshCommit],
            { cwd: scenario.integrationPath },
          )
        ).stdout
          .trim()
          .split(" ")
          .slice(1)
          .map(oid);
        expect(refreshParents).toEqual([legacyHead, currentMain]);
        expect(
          (
            await runner.run(
              [
                "diff-tree",
                "--no-commit-id",
                "--name-only",
                "-r",
                refreshCommit,
                candidateHead,
              ],
              {
                cwd: scenario.integrationPath,
              },
            )
          ).stdout,
        ).toBe("");
        expect(
          await runner.run(["status", "--porcelain"], {
            cwd: scenario.integrationPath,
          }),
        ).toMatchObject({ stdout: "" });
        await expect(
          access(`${scenario.integrationPath}/git-askpass.sh`),
        ).rejects.toBeDefined();
        expect(refreshed.value.candidate?.mainOid).toBe(currentMain);
        expect(
          (
            await new RealGitWorkspace(
              runner,
              scenario.integrationPath,
              "origin",
              "feature/card-alice-source-1",
            ).readWorkspace()
          ).value?.candidate?.integrationHeadOid,
        ).toBe(candidateHead);
        const repeated = await workspace.writeIntegrationCandidate(
          write(currentMain, candidateHead),
        );
        expect(repeated).toMatchObject({
          kind: "alreadyApplied",
          value: { integrationHeadOid: candidateHead },
        });
      } finally {
        await auth.dispose();
      }
    } finally {
      await scenario.dispose();
    }
  });

  test("recognizes an H2 candidate after its lease-push response is lost", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const before = await scenario.botWorkspace.readWorkspace();
      const integrationHead = before.value?.integrationHeadOid;
      if (!integrationHead) throw new Error("integration head is required");
      await runner.run(["switch", "main"], { cwd: scenario.integrationPath });
      await runner.run(
        ["commit", "--allow-empty", "--message", "Advance main"],
        { cwd: scenario.integrationPath },
      );
      await runner.run(["push", "origin", "HEAD:main"], {
        cwd: scenario.integrationPath,
      });
      const mainOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      let loseResponse = true;
      const responseLosingRunner: GitRunner = {
        async run(argv, options) {
          const result = await runner.run(argv, options);
          if (loseResponse && argv[0] === "push") {
            loseResponse = false;
            throw new Error("response lost after push");
          }
          return result;
        },
      };
      const cardBytes = new TextEncoder().encode(
        "---\ngithub_id: 7\nsource_pr: 1\n---\n\n# Candidate Card\n",
      );
      const readmeBytes = new TextEncoder().encode(
        "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
      );
      const result = await new RealGitWorkspace(
        responseLosingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).writeIntegrationCandidate({
        input: {
          observedMainOid: mainOid,
          expectedIntegrationHeadOid: integrationHead,
          cardPath: "people/alice.md",
          cardBytes,
          readmeBytes,
        },
        postconditions: {
          cardManifest: {
            path: "people/alice.md",
            blobOid: gitBlobOid(cardBytes),
            githubId: "7",
            sourcePrNumber: 1,
          },
          readmeBlobOid: gitBlobOid(readmeBytes),
          history: {
            retainCommitOids: [integrationHead],
            requiredParentOids: [integrationHead],
          },
        },
      });
      expect(result.kind).toBe("alreadyApplied");
      if (result.kind !== "alreadyApplied")
        throw new Error("candidate should be recovered");
      expect(result.value.candidate?.mainOid).toBe(mainOid);
      expect(
        oid(
          (
            await runner.run(
              ["rev-parse", "origin/feature/card-alice-source-1"],
              { cwd: scenario.integrationPath },
            )
          ).stdout.trim(),
        ),
      ).toBe(result.value.integrationHeadOid);
    } finally {
      await scenario.dispose();
    }
  });

  test("recognizes a legacy H2 candidate after its lease-push response is lost", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      const before = await scenario.botWorkspace.readWorkspace();
      const integrationHead = before.value?.integrationHeadOid;
      if (!integrationHead) throw new Error("integration head is required");
      await runner.run(["switch", "main"], { cwd: scenario.integrationPath });
      await runner.run(
        ["commit", "--allow-empty", "--message", "Advance main"],
        { cwd: scenario.integrationPath },
      );
      await runner.run(["push", "origin", "HEAD:main"], {
        cwd: scenario.integrationPath,
      });
      const mainOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      let loseResponse = true;
      const responseLosingRunner: GitRunner = {
        async run(argv, options) {
          const result = await runner.run(argv, options);
          if (loseResponse && argv[0] === "push") {
            loseResponse = false;
            const message = await runner.run(
              ["show", "-s", "--format=%B", "HEAD"],
              { cwd: scenario.integrationPath },
            );
            const parent = oid(
              (
                await runner.run(["rev-parse", "HEAD^"], {
                  cwd: scenario.integrationPath,
                })
              ).stdout.trim(),
            );
            await runner.run(
              [
                "commit",
                "--amend",
                "--no-edit",
                "--message",
                message.stdout.replace(
                  `Hello-From-Main-Required-Parent-Oids: ${parent}`,
                  `Hello-From-Main-Required-Parent-Oids: ${integrationHead}`,
                ),
              ],
              { cwd: scenario.integrationPath },
            );
            await runner.run(
              [
                "push",
                "--force-with-lease",
                "origin",
                "HEAD:feature/card-alice-source-1",
              ],
              { cwd: scenario.integrationPath },
            );
            throw new Error("response lost after push");
          }
          return result;
        },
      };
      const cardBytes = new TextEncoder().encode(
        "---\ngithub_id: 7\nsource_pr: 1\n---\n\n# Candidate Card\n",
      );
      const readmeBytes = new TextEncoder().encode(
        "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
      );
      const result = await new RealGitWorkspace(
        responseLosingRunner,
        scenario.integrationPath,
        "origin",
        "feature/card-alice-source-1",
      ).writeIntegrationCandidate({
        input: {
          observedMainOid: mainOid,
          expectedIntegrationHeadOid: integrationHead,
          cardPath: "people/alice.md",
          cardBytes,
          readmeBytes,
        },
        postconditions: {
          cardManifest: {
            path: "people/alice.md",
            blobOid: gitBlobOid(cardBytes),
            githubId: "7",
            sourcePrNumber: 1,
          },
          readmeBlobOid: gitBlobOid(readmeBytes),
          history: {
            retainCommitOids: [integrationHead],
            requiredParentOids: [integrationHead],
          },
        },
      });
      expect(result.kind).toBe("alreadyApplied");
      if (result.kind !== "alreadyApplied")
        throw new Error("legacy candidate should be recovered");
      expect(result.value.candidate?.mainOid).toBe(mainOid);
    } finally {
      await scenario.dispose();
    }
  });

  test("rejects candidates that add, alter, or remove unrelated tree entries", async () => {
    const scenario = await createGoodFirstConflictScenario({
      prebuiltIntegration: true,
    });
    try {
      const runner = createGitRunner({ root: scenario.root });
      await runner.run(["switch", "feature/card-alice-source-1"], {
        cwd: scenario.integrationPath,
      });
      await writeFile(`${scenario.integrationPath}/stable.txt`, "stable\n");
      await runner.run(["add", "--", "stable.txt"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["commit", "--message", "Add stable file"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["push", "origin", "HEAD:feature/card-alice-source-1"], {
        cwd: scenario.integrationPath,
      });
      const integrationHead = oid(
        (
          await runner.run(
            ["rev-parse", "origin/feature/card-alice-source-1"],
            { cwd: scenario.integrationPath },
          )
        ).stdout.trim(),
      );
      const mainOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const cardBytes = new TextEncoder().encode(
        "---\ngithub_id: 7\nsource_pr: 1\n---\n\n# Candidate Card\n",
      );
      const readmeBytes = new TextEncoder().encode(
        "# Hello from Main\n\n<!-- cards:start -->\nAlice\n<!-- cards:end -->\n",
      );
      const result = await scenario.botWorkspace.writeIntegrationCandidate({
        input: {
          observedMainOid: mainOid,
          expectedIntegrationHeadOid: integrationHead,
          cardPath: "people/alice.md",
          cardBytes,
          readmeBytes,
        },
        postconditions: {
          cardManifest: {
            path: "people/alice.md",
            blobOid: gitBlobOid(cardBytes),
            githubId: "7",
            sourcePrNumber: 1,
          },
          readmeBlobOid: gitBlobOid(readmeBytes),
          history: {
            retainCommitOids: [integrationHead],
            requiredParentOids: [integrationHead],
          },
        },
      });
      if (result.kind !== "succeeded") throw new Error("candidate is required");
      const candidateHead = result.value.integrationHeadOid;
      if (!candidateHead) throw new Error("candidate head is required");
      await writeFile(
        `${scenario.integrationPath}/unexpected.txt`,
        "unexpected\n",
      );
      await runner.run(["add", "--", "unexpected.txt"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["commit", "--amend", "--no-edit"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();
      await runner.run(
        ["switch", "-C", "feature/card-alice-source-1", candidateHead],
        { cwd: scenario.integrationPath },
      );
      await writeFile(`${scenario.integrationPath}/stable.txt`, "altered\n");
      await runner.run(["add", "--", "stable.txt"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["commit", "--amend", "--no-edit"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();
      await runner.run(
        ["switch", "-C", "feature/card-alice-source-1", candidateHead],
        { cwd: scenario.integrationPath },
      );
      await runner.run(["rm", "--", "stable.txt"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(["commit", "--amend", "--no-edit"], {
        cwd: scenario.integrationPath,
      });
      await runner.run(
        [
          "push",
          "--force-with-lease",
          "origin",
          "HEAD:feature/card-alice-source-1",
        ],
        { cwd: scenario.integrationPath },
      );
      expect(
        (
          await new RealGitWorkspace(
            runner,
            scenario.integrationPath,
            "origin",
            "feature/card-alice-source-1",
          ).readWorkspace()
        ).value?.candidate,
      ).toBeUndefined();
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
