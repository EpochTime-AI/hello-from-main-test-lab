import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createLocalGithubPlatform,
  openLocalActionRun,
} from "../../src/adapters/local-github.js";
import type { CommentIntent, RepositoryFacts } from "../../src/core/model.js";
import { oid } from "../../src/core/model.js";

function facts(): RepositoryFacts {
  return {
    comments: [],
    trustedCommentOwner: { actorId: "42", actorType: "Bot" },
    main: {
      status: "ready",
      provenance: "modeled",
      value: { oid: oid("main-1"), cardManifests: [] },
    },
    sourcePullRequest: {
      status: "ready",
      provenance: "modeled",
      value: {
        number: 1,
        kind: "contribution",
        headOid: oid("source-1"),
        baseOid: oid("main-1"),
        draft: false,
        observedOid: oid("source-1"),
        provenance: "modeled",
      },
    },
    integrationBranch: {
      status: "ready",
      provenance: "modeled",
      value: {
        name: "integration",
        headOid: oid("target-1"),
        provenance: "modeled",
      },
    },
    integrationPullRequest: { status: "absent", provenance: "modeled" },
    candidate: { status: "absent", provenance: "modeled" },
    eligibility: {
      checks: { status: "ready", provenance: "modeled", value: [] },
      reviews: { status: "ready", provenance: "modeled", value: [] },
      mergeability: {
        status: "ready",
        provenance: "modeled",
        value: "mergeable",
      },
      baseCurrent: { status: "ready", provenance: "modeled", value: true },
    },
    confirmations: [],
  };
}

describe("LocalGithubPlatform", () => {
  test("persists semantic setup state and reconstructs it without topology", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const stateFile = join(dir, "state.json");
      const initialFacts = facts();
      const initialSource = initialFacts.sourcePullRequest.value;
      if (!initialSource) throw new Error("source fact is required");
      const workspace = {
        readWorkspace: async () => ({
          status: "ready" as const,
          value: { status: "ready" as const },
        }),
      };
      const first = createLocalGithubPlatform({
        facts: {
          ...initialFacts,
          integrationBranch: { status: "absent", provenance: "modeled" },
          sourcePullRequest: {
            ...initialFacts.sourcePullRequest,
            value: {
              ...initialSource,
              authorLogin: "zoe",
              authorGithubId: "42",
              headRef: "add/zoe",
            },
          },
        },
        workspace,
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });

      const branch = await first.createIntegrationBranch({
        name: "feature/card-zoe-source-17",
        fromMainOid: "main-1",
        cardPath: "people/zoe.md",
        cardBytes: new TextEncoder().encode("shell"),
      });
      const pullRequest = await first.createIntegrationPullRequest({
        branchName: "feature/card-zoe-source-17",
        title: "Any title",
      });
      const snapshot = JSON.parse(await readFile(stateFile, "utf8")) as {
        version: number;
      };

      expect(branch.kind).toBe("succeeded");
      expect(pullRequest.kind).toBe("succeeded");
      expect(snapshot.version).toBe(1);

      const second = createLocalGithubPlatform({
        facts: facts(),
        workspace,
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });
      const observed = await second.observeRepository();
      expect(observed.value?.integrationBranch.value?.name).toBe(
        "feature/card-zoe-source-17",
      );
      expect(observed.value?.integrationPullRequest.value?.number).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails closed for corrupt, truncated, or unknown snapshots without resetting them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const stateFile = join(dir, "state.json");
      for (const snapshot of ['{"version":999}', '{"version":1']) {
        await writeFile(stateFile, snapshot);
        expect(() =>
          createLocalGithubPlatform({
            facts: facts(),
            workspace: {
              readWorkspace: async () => ({ status: "ready" as const }),
            },
            refs: { contribution: "source", integration: "integration" },
            stateFile,
          }),
        ).toThrow();
        expect(await readFile(stateFile, "utf8")).toBe(snapshot);
      }
      await writeFile(stateFile, "not-json");
      expect(() =>
        createLocalGithubPlatform({
          facts: facts(),
          workspace: {
            readWorkspace: async () => ({ status: "ready" as const }),
          },
          refs: { contribution: "source", integration: "integration" },
          stateFile,
        }),
      ).toThrow("corrupt");
      expect(await readFile(stateFile, "utf8")).toBe("not-json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed v1 semantic fields and preserves the original snapshot bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const stateFile = join(dir, "state.json");
      const platform = createLocalGithubPlatform({
        facts: facts(),
        workspace: {
          readWorkspace: async () => ({ status: "ready" as const }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });
      await platform.observeRepository();
      const original = await readFile(stateFile);
      const snapshot = JSON.parse(original.toString("utf8")) as {
        version: number;
        facts: Record<string, unknown>;
        nextPullRequestNumber?: unknown;
      };
      snapshot.facts.main = {
        ...(snapshot.facts.main as Record<string, unknown>),
        value: {
          oid: "",
          cardManifests: [],
        },
      };
      await writeFile(stateFile, JSON.stringify(snapshot));
      const malformed = await readFile(stateFile);

      expect(() =>
        createLocalGithubPlatform({
          facts: facts(),
          workspace: {
            readWorkspace: async () => ({ status: "ready" as const }),
          },
          refs: { contribution: "source", integration: "integration" },
          stateFile,
        }),
      ).toThrow("invalid Local state snapshot");
      expect(await readFile(stateFile)).toEqual(malformed);
      expect(malformed).not.toEqual(original);

      snapshot.facts.main = {
        ...(snapshot.facts.main as Record<string, unknown>),
        value: {
          oid: "main-1",
          readmeBytes: { __localBytes: "%%%" },
          cardManifests: [],
        },
      };
      await writeFile(stateFile, JSON.stringify(snapshot));
      const malformedBytes = await readFile(stateFile);
      expect(() =>
        createLocalGithubPlatform({
          facts: facts(),
          workspace: {
            readWorkspace: async () => ({ status: "ready" as const }),
          },
          refs: { contribution: "source", integration: "integration" },
          stateFile,
        }),
      ).toThrow("invalid Local state snapshot");
      expect(await readFile(stateFile)).toEqual(malformedBytes);

      snapshot.facts.main = {
        ...(snapshot.facts.main as Record<string, unknown>),
        value: {
          oid: "main-1",
          cardManifests: [],
        },
      };
      snapshot.nextPullRequestNumber = 99;
      await writeFile(stateFile, JSON.stringify(snapshot));
      const malformedCounter = await readFile(stateFile);
      expect(() =>
        createLocalGithubPlatform({
          facts: facts(),
          workspace: {
            readWorkspace: async () => ({ status: "ready" as const }),
          },
          refs: { contribution: "source", integration: "integration" },
          stateFile,
        }),
      ).toThrow("invalid Local state snapshot");
      expect(await readFile(stateFile)).toEqual(malformedCounter);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensures an exact owned comment and converges after a fresh reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const seedFacts = facts();
      seedFacts.trustedCommentOwner = { actorId: "42", actorType: "Bot" };
      seedFacts.comments = [];
      const stateFile = join(dir, "state.json");
      const intent: CommentIntent = {
        targetPullRequestNumber: 1,
        slot: "source-status",
        actionKey: "run=source-1;target=1;slot=source-status",
        phase: "setup",
        body: "exact body",
      };
      const options = {
        facts: seedFacts,
        workspace: {
          readWorkspace: async () => ({ status: "ready" as const }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      };
      const first = createLocalGithubPlatform(options);
      const created = await first.ensureComment?.(intent);
      expect(created?.kind).toBe("created");

      const second = createLocalGithubPlatform(options);
      expect(await second.ensureComment?.(intent)).toMatchObject({
        kind: "noOp",
        comment: { targetPullRequestNumber: 1, body: "exact body" },
      });
      const updated = await second.ensureComment?.({
        ...intent,
        body: "new exact body",
      });
      expect(updated).toMatchObject({ kind: "updated" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recovers one persisted comment after a lost response without recorder recovery", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const seedFacts = facts();
      seedFacts.trustedCommentOwner = { actorId: "42", actorType: "Bot" };
      seedFacts.comments = [];
      const effects: import("../../src/adapters/local-github.js").LocalEffectRecord[] =
        [];
      const stateFile = join(dir, "state.json");
      const intent: CommentIntent = {
        targetPullRequestNumber: 1,
        slot: "source-status",
        actionKey: "lost-response",
        phase: "setup",
        body: "persisted before response loss",
      };
      const first = createLocalGithubPlatform({
        facts: seedFacts,
        workspace: {
          readWorkspace: async () => ({ status: "ready" as const }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
        afterPersistBeforeReturn: () => {
          return { kind: "unknownOutcome", detail: "response lost" };
        },
        onEffect: (effect) => effects.push(effect),
      });
      await expect(first.ensureComment?.(intent)).resolves.toEqual({
        kind: "unknownOutcome",
        detail: "response lost",
      });

      const fresh = createLocalGithubPlatform({
        facts: seedFacts,
        workspace: {
          readWorkspace: async () => ({ status: "ready" as const }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
        onEffect: (effect) => effects.push(effect),
      });
      await expect(fresh.ensureComment?.(intent)).resolves.toMatchObject({
        kind: "noOp",
      });
      const recovered = JSON.parse(await readFile(stateFile, "utf8")) as {
        facts: { comments?: unknown[] };
      };
      expect(recovered.facts.comments).toHaveLength(1);
      expect(effects.map((effect) => effect.kind)).toEqual(["create", "noOp"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records cross-instance comment effects and rejects ambiguity or wrong targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const seedFacts = facts();
      seedFacts.trustedCommentOwner = { actorId: "42", actorType: "Bot" };
      seedFacts.comments = [];
      const effects: import("../../src/adapters/local-github.js").LocalEffectRecord[] =
        [];
      const stateFile = join(dir, "state.json");
      const base = {
        facts: seedFacts,
        workspace: {
          readWorkspace: async () => ({ status: "ready" as const }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
        onEffect: (
          record: import("../../src/adapters/local-github.js").LocalEffectRecord,
        ) => effects.push(record),
      };
      const intent: CommentIntent = {
        targetPullRequestNumber: 1,
        slot: "source-status",
        actionKey: "stable-key",
        phase: "setup",
        body: "body",
      };
      await createLocalGithubPlatform(base).ensureComment?.(intent);
      await createLocalGithubPlatform(base).ensureComment?.(intent);
      const wrongTarget = await createLocalGithubPlatform(base).ensureComment?.(
        {
          ...intent,
          targetPullRequestNumber: 404,
        },
      );
      expect(wrongTarget).toEqual({
        kind: "notVisibleYet",
        detail: "comment target is not a Local PR",
      });
      const wrongSlot = await createLocalGithubPlatform(base).ensureComment?.({
        ...intent,
        slot: "integration-status",
        targetPullRequestNumber: 1,
      });
      expect(wrongSlot).toEqual({
        kind: "notVisibleYet",
        detail: "comment target is not a Local PR",
      });
      const current = JSON.parse(await readFile(stateFile, "utf8")) as {
        facts: Record<string, unknown>;
      };
      current.facts.comments = [
        ...(current.facts.comments as unknown[]),
        {
          id: 2,
          user: { id: "42", actorType: "Bot" },
          ownerPrincipal: { actorId: "42", actorType: "Bot" },
          actionKey: "stable-key",
          body: "body",
          targetPullRequestNumber: 1,
        },
      ];
      await writeFile(stateFile, JSON.stringify(current));
      expect(
        await createLocalGithubPlatform(base).ensureComment?.(intent),
      ).toEqual({
        kind: "ambiguousOwnership",
      });
      expect(effects.map((record) => record.kind)).toEqual([
        "create",
        "noOp",
        "wrongTarget",
        "wrongTarget",
        "wrongTarget",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("opens a production-shaped local action run with an isolated snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const mergeNoFastForward = vi.fn(async () => ({
        mergeCommitOid: oid("merge-custom"),
        parents: [oid("target-1"), oid("source-1")],
      }));
      const run = await openLocalActionRun({
        dir,
        realGit: {
          workspace: {
            readWorkspace: async () => ({ status: "ready" as const }),
            mergeNoFastForward,
          },
          refs: {
            contribution: "fork/custom-source",
            integration: "upstream/custom-integration",
          },
        },
        seed: {
          facts: facts(),
          actionContext: {
            repository: "example/custom-repository",
            ref: "refs/heads/trusted-release",
            sha: "custom-sha",
            eventPath: "custom-event.json",
          },
        },
        event: { kind: "wake" },
      });
      expect(run.composition.context).toMatchObject({
        repository: "example/custom-repository",
        ref: "refs/heads/trusted-release",
        sha: "custom-sha",
      });
      await expect(
        run.platform.mergePullRequest({
          kind: "contribution",
          pullRequestNumber: 1,
          expectedHeadOid: oid("source-1"),
        }),
      ).resolves.toMatchObject({ kind: "contributionMerged" });
      expect(mergeNoFastForward).toHaveBeenCalledWith({
        sourceRef: "fork/custom-source",
        expectedTargetOid: oid("target-1"),
        message: "Merge contribution PR #1",
      });
      await run.close();
      const snapshot = JSON.parse(
        await readFile(join(dir, "state.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(snapshot.version).toBe(1);
      expect(snapshot).not.toHaveProperty("nextPullRequestNumber");
      expect(snapshot).not.toHaveProperty("nextCommentId");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects inconsistent candidate projection without changing state.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    try {
      const stateFile = join(dir, "state.json");
      const before = createLocalGithubPlatform({
        facts: facts(),
        workspace: {
          readWorkspace: async () => ({ status: "ready" as const }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });
      await before.observeRepository();
      const original = await readFile(stateFile);
      const candidate = {
        observedOid: oid("candidate-observed"),
        provenance: "observed" as const,
        integrationHeadOid: oid("candidate-fact"),
        cardPath: "people/example.md",
        cardBlobOid: oid("card-1"),
        readmeBlobOid: oid("readme-1"),
      };
      const platform = createLocalGithubPlatform({
        facts: facts(),
        workspace: {
          readWorkspace: async () => ({
            status: "ready" as const,
            value: {
              status: "ready" as const,
              integrationHeadOid: oid("candidate-workspace"),
              candidate,
            },
          }),
        },
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });
      await expect(platform.observeRepository()).rejects.toThrow(
        "Git workspace projection is inconsistent",
      );
      expect(await readFile(stateFile)).toEqual(original);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("preserves modeled provider facts and delegates merge to real Git workspace", async () => {
    const mergeNoFastForward = vi.fn(async () => ({
      mergeCommitOid: oid("merge-1"),
      parents: [oid("target-1"), oid("source-1")],
    }));
    const platform = createLocalGithubPlatform({
      facts: facts(),
      workspace: {
        readWorkspace: async () => ({
          status: "ready",
          value: { status: "ready", integrationHeadOid: oid("target-1") },
        }),
        writeIntegrationCandidate: async () => ({
          kind: "succeeded",
          value: { status: "ready" },
        }),
        readFinalMainPostconditions: async () => ({ status: "pending" }),
        mergeNoFastForward,
      },
      refs: { contribution: "source", integration: "integration" },
      mergeTarget: "contribution",
    });

    const observed = await platform.observeRepository();
    expect(observed.provenance).toBe("modeled");
    expect(observed.value?.main.provenance).toBe("modeled");
    const result = await platform.mergePullRequest({
      kind: "contribution",
      pullRequestNumber: 1,
      expectedHeadOid: oid("source-1"),
    });

    expect(result).toEqual({
      kind: "contributionMerged",
      headOid: oid("merge-1"),
    });
    expect(mergeNoFastForward).toHaveBeenCalledWith({
      sourceRef: "source",
      expectedTargetOid: oid("target-1"),
      message: "Merge contribution PR #1",
    });
  });

  test("recovers setup anchors after platform reconstruction from state.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hello-from-main-local-"));
    const stateFile = join(dir, "state.json");
    try {
      const first = createLocalGithubPlatform({
        facts: {
          ...facts(),
          integrationBranch: { status: "absent", provenance: "modeled" },
        },
        workspace: {
          readWorkspace: async () => ({
            status: "ready",
            value: { status: "ready" },
          }),
        } as never,
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });
      await first.createIntegrationBranch({
        name: "feature/card-alice-source-1",
        fromMainOid: "target-1",
      });
      await first.createIntegrationPullRequest({
        branchName: "feature/card-alice-source-1",
        title: "Integration Card",
      });

      const second = createLocalGithubPlatform({
        facts: {
          ...facts(),
          integrationBranch: { status: "absent", provenance: "modeled" },
          integrationPullRequest: { status: "absent", provenance: "modeled" },
        },
        workspace: {
          readWorkspace: async () => ({
            status: "ready",
            value: { status: "ready" },
          }),
        } as never,
        refs: { contribution: "source", integration: "integration" },
        stateFile,
      });
      const observed = await second.observeRepository();

      expect(observed.value?.integrationBranch.value?.name).toBe(
        "feature/card-alice-source-1",
      );
      expect(observed.value?.integrationPullRequest.value?.kind).toBe(
        "integration",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("records Integration PR merged, closed, and merge-commit facts", async () => {
    const initial = facts();
    initial.integrationPullRequest = {
      status: "ready",
      provenance: "modeled",
      value: {
        number: 2,
        kind: "integration",
        headOid: oid("target-1"),
        baseOid: oid("main-1"),
        draft: false,
        observedOid: oid("target-1"),
        provenance: "modeled",
      },
    };
    const platform = createLocalGithubPlatform({
      facts: initial,
      workspace: {
        readWorkspace: async () => ({
          status: "ready",
          value: { status: "ready" },
        }),
        writeIntegrationCandidate: async () => ({
          kind: "succeeded",
          value: { status: "ready" },
        }),
        readFinalMainPostconditions: async () => ({ status: "pending" }),
        mergeNoFastForward: async () => ({
          mergeCommitOid: oid("published"),
          parents: [],
        }),
      },
      refs: { contribution: "source", integration: "integration" },
    });
    await platform.mergePullRequest({
      kind: "integration",
      pullRequestNumber: 2,
      expectedHeadOid: oid("target-1"),
      observedBaseOid: oid("main-1"),
      baseCurrentGate: "required",
    });
    expect(
      (await platform.observeRepository()).value?.integrationPullRequest.value,
    ).toMatchObject({
      merged: true,
      closed: true,
      mergeCommitOid: oid("published"),
    });
  });

  test("records only a current contributor Approval and exact candidate checks", async () => {
    const initial = facts();
    initial.integrationPullRequest = {
      status: "ready",
      provenance: "modeled",
      value: {
        number: 2,
        kind: "integration",
        headOid: oid("candidate-1"),
        baseOid: oid("main-1"),
        draft: false,
        observedOid: oid("candidate-1"),
        provenance: "modeled",
      },
    };
    initial.candidate = {
      status: "ready",
      provenance: "modeled",
      value: {
        observedOid: oid("candidate-1"),
        provenance: "modeled",
        integrationHeadOid: oid("candidate-1"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card-1"),
        readmeBlobOid: oid("readme-1"),
      },
    };
    initial.integrationBranch = {
      status: "ready",
      provenance: "modeled",
      value: {
        name: "integration",
        headOid: oid("candidate-1"),
        provenance: "modeled",
      },
    };
    const source = initial.sourcePullRequest.value;
    if (!source) throw new Error("source fact is required");
    initial.sourcePullRequest = {
      ...initial.sourcePullRequest,
      value: {
        ...source,
        authorLogin: "alice",
        authorGithubId: "7",
        headRepositoryOwnerLogin: "alice",
        headRepositoryIsFork: true,
        changedFiles: [
          {
            path: "people/alice.md",
            blobOid: oid("source-card"),
            bytes: new Uint8Array(),
          },
        ],
        changedFilesComplete: true,
      },
    };
    const platform = createLocalGithubPlatform({
      facts: initial,
      workspace: {
        readWorkspace: async () => ({
          status: "ready",
          value: { status: "ready", integrationHeadOid: oid("candidate-1") },
        }),
      } as never,
      refs: { contribution: "source", integration: "integration" },
    });

    expect(() => platform.fixture.recordChecksCompleted(oid("stale"))).toThrow(
      "current candidate",
    );
    platform.fixture.recordChecksCompleted(oid("candidate-1"));
    platform.fixture.recordContributorApproval({
      actorLogin: "alice",
      sourcePrNumber: 1,
      integrationPrNumber: 2,
      candidateOid: oid("candidate-1"),
    });
    const observed = await platform.observeRepository();
    expect(observed.value?.eligibility.checks.value?.[0]?.prHeadOid).toBe(
      oid("candidate-1"),
    );
    expect(observed.value?.confirmations[0]).toMatchObject({
      reviewedCommitOid: oid("candidate-1"),
      githubId: "7",
    });
  });
});
