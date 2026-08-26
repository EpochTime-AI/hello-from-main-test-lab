import { describe, expect, test } from "vitest";
import type {
  ContributionMergeRequest,
  ContributionMergeResult,
  IntegrationMergeRequest,
  IntegrationMergeResult,
} from "../../../src/core/model.js";
import { oid } from "../../../src/core/model.js";
import {
  createReconciler,
  validateFinalMain,
  validateIntake,
} from "../../../src/core/reconciler.js";
import type { GitWorkspace } from "../../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../../src/ports/github-platform.js";
import {
  readyWorkspace,
  stabilityFacts,
  testCandidatePolicy,
} from "../../fixtures/stability.js";

async function mergePullRequest(
  request: ContributionMergeRequest,
): Promise<ContributionMergeResult>;
async function mergePullRequest(
  request: IntegrationMergeRequest,
): Promise<IntegrationMergeResult>;
async function mergePullRequest(
  request: ContributionMergeRequest | IntegrationMergeRequest,
): Promise<ContributionMergeResult | IntegrationMergeResult> {
  return request.kind === "contribution"
    ? { kind: "contributionRejected", reason: "unknownOutcome" }
    : { kind: "integrationRejected", reason: "unknownOutcome" };
}

describe("production reconciler boundary", () => {
  test("binds both semantic dependencies and returns a bounded outcome", async () => {
    const github: GithubPlatform = {
      observeRepository: async () => ({ status: "incomplete" }),
      createIntegrationBranch: async () => ({ kind: "notVisibleYet" }),
      createIntegrationPullRequest: async () => ({ kind: "notVisibleYet" }),
      updatePullRequestBase: async () => ({ kind: "notVisibleYet" }),
      markPullRequestReadyForReview: async () => ({
        kind: "blocked",
        reason: "notVisibleYet",
      }),
      ensureComment: async () => ({ kind: "notVisibleYet" }),
      mergePullRequest,
    };
    const git: GitWorkspace = {
      readWorkspace: async () => ({ status: "incomplete" }),
      writeIntegrationCandidate: async () => ({ kind: "retryableTransport" }),
      readFinalMainPostconditions: async () => ({ status: "pending" }),
    };

    const result = await createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(result).toEqual({
      kind: "awaitingExternalFact",
      reason: "incomplete",
    });
  });

  test("renders an independent Project Shell from the trusted source identity", async () => {
    const facts = stabilityFacts();
    facts.integrationBranch = { status: "absent", provenance: "modeled" };
    facts.integrationPullRequest = { status: "absent", provenance: "modeled" };
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: false };
    let shell: Uint8Array | undefined;
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({
          status: "ready" as const,
          value: facts,
        }),
        createIntegrationBranch: async (input: { cardBytes?: Uint8Array }) => {
          shell = input.cardBytes;
          return { kind: "succeeded" as const, value: {} };
        },
      } as unknown as GithubPlatform,
      git: { readWorkspace: readySetupWorkspace } as unknown as GitWorkspace,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(result).toEqual({ kind: "budgetExhausted", effects: 1 });
    const text = new TextDecoder().decode(shell);
    expect(text).not.toBe(
      new TextDecoder().decode(source.changedFiles?.[0]?.bytes),
    );
    expect(text).toContain("github: alice");
    expect(text).toContain("github_id: 7");
    expect(text).toContain("source_pr: 1");
    expect(text).toContain("# Project shell");
  });

  test("does not mutate when current facts are incomplete", async () => {
    let writes = 0;
    const github = {
      observeRepository: async () => ({ status: "incomplete" as const }),
    } as GithubPlatform;
    const git = {
      readWorkspace: async () => ({ status: "incomplete" as const }),
      writeIntegrationCandidate: async () => {
        writes += 1;
        return { status: "incomplete" as const };
      },
      readFinalMainPostconditions: async () => ({ status: "pending" }),
    } as unknown as GitWorkspace;

    const result = await createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({
      budget: { maxEffects: 3 },
    });

    expect(result).toEqual({
      kind: "awaitingExternalFact",
      reason: "incomplete",
    });
    expect(writes).toBe(0);
  });

  test("bounds a hung repository observation and starts no mutation", async () => {
    let mutations = 0;
    const started = Date.now();
    const result = await createReconciler({
      github: {
        observeRepository: async () => new Promise(() => undefined),
        createIntegrationBranch: async () => {
          mutations += 1;
          return { kind: "succeeded", value: {} };
        },
      } as unknown as GithubPlatform,
      git: {} as GitWorkspace,
    }).reconcile({ budget: { maxEffects: 1, deadlineMs: Date.now() + 30 } });
    expect(result).toEqual({ kind: "retryable", reason: "retryableTransport" });
    expect(mutations).toBe(0);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test("bounds a hung candidate write and does not begin another mutation", async () => {
    const facts = stabilityFacts();
    let writes = 0;
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
      } as GithubPlatform,
      git: {
        readWorkspace: readyWorkspace,
        writeIntegrationCandidate: async () => {
          writes += 1;
          return new Promise(() => undefined);
        },
      } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 2, deadlineMs: Date.now() + 30 } });
    expect(result).toEqual({ kind: "retryable", reason: "unknownOutcome" });
    expect(writes).toBe(1);
  });

  test("bounds final-main readback after a completed Integration merge", async () => {
    const facts = stabilityFacts();
    const integration = facts.integrationPullRequest.value;
    if (!integration) throw new Error("integration required");
    facts.integrationPullRequest.value = { ...integration, draft: false };
    facts.candidate = {
      status: "ready",
      value: {
        observedOid: oid("integration-1"),
        provenance: "modeled",
        integrationHeadOid: oid("integration-1"),
        mainOid: oid("main-1"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
        readmeBlobOid: oid("readme"),
        retainedCommitOids: [oid("integration-1")],
        requiredParentOids: [],
      },
    };
    facts.confirmations = [
      {
        kind: "domainConfirmation",
        contributorLogin: "alice",
        githubId: "7",
        sourcePrNumber: 1,
        integrationPrNumber: 2,
        reviewedCommitOid: oid("integration-1"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
      },
    ];
    facts.eligibility.reviews.value = [
      {
        pullRequestNumber: 2,
        prHeadOid: oid("integration-1"),
        reviewerLogin: "alice",
        state: "approved",
        reviewedCommitOid: oid("integration-1"),
        observedOid: oid("integration-1"),
        provenance: "modeled",
      },
    ];
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
        mergePullRequest: async () => ({
          kind: "integrationMerged",
          mainOid: oid("merged"),
        }),
      } as unknown as GithubPlatform,
      git: {
        readWorkspace: readyWorkspace,
        readFinalMainPostconditions: async () => new Promise(() => undefined),
      } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1, deadlineMs: Date.now() + 30 } });
    expect(result).toEqual({ kind: "retryable", reason: "unknownOutcome" });
  });

  test("validates final main content and history postconditions", () => {
    const expected = {
      mainOid: oid("main"),
      cardManifest: {
        path: "people/alice.md",
        blobOid: oid("card"),
        githubId: "7",
        sourcePrNumber: 10,
      },
      readmeBytes: new Uint8Array([1, 2]),
      retainedCommitOids: [oid("contributor")],
      requiredParentOids: [oid("integration")],
      sourceMergeCommitOid: oid("source-merge"),
      integrationMergeCommitOid: oid("integration-merge"),
      contributionMergeParentOids: [oid("integration"), oid("contributor")],
      integrationMergeParentOids: [oid("main"), oid("candidate")],
    };

    expect(validateFinalMain(expected, expected)).toBe(true);
    expect(
      validateFinalMain(
        { ...expected, readmeBytes: new Uint8Array([1]) },
        expected,
      ),
    ).toBe(false);
    expect(
      validateFinalMain({ ...expected, retainedCommitOids: [] }, expected),
    ).toBe(false);
  });

  test("requires exact two merge identities and parent topology", () => {
    const expected = {
      mainOid: oid("integration-merge"),
      cardManifest: {
        path: "people/alice.md",
        blobOid: oid("card"),
        githubId: "7",
        sourcePrNumber: 1,
      },
      readmeBytes: new Uint8Array([1]),
      retainedCommitOids: [oid("source-merge"), oid("integration-merge")],
      requiredParentOids: [],
      sourceMergeCommitOid: oid("source-merge"),
      integrationMergeCommitOid: oid("integration-merge"),
      contributionMergeParentOids: [oid("shell"), oid("contributor")],
      integrationMergeParentOids: [oid("main"), oid("candidate")],
    };
    expect(validateFinalMain(expected, expected)).toBe(true);
    expect(
      validateFinalMain(
        { ...expected, integrationMergeCommitOid: oid("source-merge") },
        expected,
      ),
    ).toBe(false);
    expect(
      validateFinalMain(
        {
          ...expected,
          integrationMergeParentOids: [oid("main"), oid("wrong")],
        },
        expected,
      ),
    ).toBe(false);
  });

  test("merges a retargeted open Contribution exactly once even when its head equals the Integration head", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required for this test");
    facts.sourcePullRequest.value = {
      ...source,
      headOid: oid("integration-1"),
      merged: false,
      closed: false,
    };
    facts.sourceHeadBasedOnIntegration = {
      status: "ready",
      provenance: "modeled",
      value: {
        integrationHeadOid: oid("integration-1"),
        sourceHeadOid: oid("integration-1"),
        isAncestor: true,
        observedOid: oid("integration-1"),
        provenance: "modeled",
      },
    };
    let merges = 0;
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        value: facts,
      }),
      mergePullRequest: async (
        request: ContributionMergeRequest | IntegrationMergeRequest,
      ) => {
        if (request.kind === "contribution") merges += 1;
        return request.kind === "contribution"
          ? { kind: "contributionMerged" as const, headOid: oid("merged-1") }
          : {
              kind: "integrationRejected" as const,
              reason: "gateUnsupported" as const,
            };
      },
    } as GithubPlatform;
    const git = {
      readWorkspace: async () => ({
        status: "ready" as const,
        value: {
          status: "ready" as const,
          integrationHeadOid: oid("integration-1"),
          retainedCommitOids: [oid("integration-1")],
          requiredParentOids: [],
        },
      }),
    } as unknown as GitWorkspace;

    await createReconciler({ github, git }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(merges).toBe(1);
  });

  test("blocks a retargeted source head that does not contain the Integration head", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: false };
    facts.sourceHeadBasedOnIntegration = {
      status: "ready",
      provenance: "provider",
      value: {
        integrationHeadOid: oid("integration-1"),
        sourceHeadOid: source.headOid,
        isAncestor: false,
        observedOid: source.headOid,
        provenance: "provider",
      },
    };
    let merges = 0;
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({
          status: "ready" as const,
          value: facts,
        }),
        mergePullRequest: async () => {
          merges += 1;
          return {
            kind: "contributionMerged" as const,
            headOid: oid("merged"),
          };
        },
      } as unknown as GithubPlatform,
      git: { readWorkspace: readyWorkspace } as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(validateIntake(facts, testCandidatePolicy)).toMatchObject({
      kind: "invalid",
      issues: [{ category: "integration-base-or-ancestry" }],
    });
    expect(merges).toBe(0);
    expect(result).toEqual({ kind: "terminal", reason: "policyRejected" });
  });

  test("awaits an unavailable source ancestry fact before validation or merge", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: false };
    facts.sourceHeadBasedOnIntegration = {
      status: "incomplete",
      provenance: "provider",
    };
    let merges = 0;
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({
          status: "ready" as const,
          value: facts,
        }),
        mergePullRequest: async () => {
          merges += 1;
          return {
            kind: "contributionMerged" as const,
            headOid: oid("merged"),
          };
        },
      } as unknown as GithubPlatform,
      git: { readWorkspace: readyWorkspace } as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(merges).toBe(0);
    expect(result).toEqual({
      kind: "awaitingExternalFact",
      reason: "incomplete",
    });
  });

  test("rejects a candidate write whose readback does not satisfy its manifest postconditions", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required for this test");
    facts.sourcePullRequest.value = { ...source, merged: true, closed: true };
    let writes = 0;
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        value: facts,
      }),
    } as GithubPlatform;
    const git = {
      readWorkspace: async () => ({
        status: "ready" as const,
        value: {
          status: "ready" as const,
          integrationHeadOid: oid("integration-1"),
          retainedCommitOids: [oid("integration-1")],
          requiredParentOids: [],
        },
      }),
      writeIntegrationCandidate: async () => {
        writes += 1;
        return {
          kind: "succeeded" as const,
          value: {
            status: "ready" as const,
            integrationHeadOid: oid("candidate-1"),
            candidate: {
              observedOid: oid("candidate-1"),
              provenance: "observed" as const,
              integrationHeadOid: oid("candidate-1"),
              cardPath: "people/alice.md",
              cardBlobOid: oid("wrong-card"),
              readmeBlobOid: oid("wrong-readme"),
              retainedCommitOids: [],
              requiredParentOids: [],
            },
            retainedCommitOids: [],
          },
        };
      },
      readFinalMainPostconditions: async () => ({
        status: "incomplete" as const,
      }),
    } as unknown as GitWorkspace;

    const result = await createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(writes).toBe(1);
    expect(result).toEqual({ kind: "retryable", reason: "stalePrecondition" });
  });

  test.each([
    ["staleLease", { kind: "retryable", reason: "stalePrecondition" }],
    ["staleMain", { kind: "retryable", reason: "stalePrecondition" }],
    ["policyPostcondition", { kind: "terminal", reason: "policyRejected" }],
    ["retryableTransport", { kind: "retryable", reason: "retryableTransport" }],
    ["unknownOutcome", { kind: "retryable", reason: "unknownOutcome" }],
  ] as const)(
    "maps candidate write %s without throwing",
    async (kind, expected) => {
      const facts = stabilityFacts();
      const result = await createReconciler({
        github: {
          observeRepository: async () => ({ status: "ready", value: facts }),
        } as GithubPlatform,
        git: {
          readWorkspace: readyWorkspace,
          writeIntegrationCandidate: async () => ({ kind }),
        } as unknown as GitWorkspace,
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } });
      expect(result).toEqual(expected);
    },
  );

  test("renders every published Card with the accepted current Card from provider facts", async () => {
    const facts = stabilityFacts();
    const card = (
      login: string,
      id: string,
      sourcePr: number,
      nickname: string,
    ) =>
      new TextEncoder().encode(
        `---\ngithub: ${login}\ngithub_id: ${id}\navatar: https://avatars.githubusercontent.com/u/${id}?v=4\nsource_pr: ${sourcePr}\n---\n\n# ${nickname}\n\n最近在折腾：Git\n\n> Hi\n`,
      );
    const alice = facts.acceptedCard;
    if (!alice) throw new Error("accepted Card is required");
    const main = facts.main.value;
    if (!main) throw new Error("main is required");
    facts.main.value = {
      ...main,
      cardManifests: [
        {
          path: "people/bob.md",
          blobOid: oid("bob"),
          githubId: "8",
          sourcePrNumber: 3,
        },
        {
          path: "people/carol.md",
          blobOid: oid("carol"),
          githubId: "9",
          sourcePrNumber: 4,
        },
      ],
      cardPayloads: [
        {
          path: "people/bob.md",
          blobOid: oid("bob"),
          githubId: "8",
          sourcePrNumber: 3,
          bytes: card("bob", "8", 3, "Bob"),
        },
        {
          path: "people/carol.md",
          blobOid: oid("carol"),
          githubId: "9",
          sourcePrNumber: 4,
          bytes: card("carol", "9", 4, "Carol"),
        },
      ],
    };
    let write: import("../../../src/core/model.js").CandidateWrite | undefined;
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
      } as GithubPlatform,
      git: {
        readWorkspace: async () => ({
          status: "ready",
          value: {
            status: "ready",
            integrationHeadOid: oid("integration-1"),
            retainedCommitOids: [oid("integration-1")],
            requiredParentOids: [],
          },
        }),
        writeIntegrationCandidate: async (
          candidate: import("../../../src/core/model.js").CandidateWrite,
        ) => {
          write = candidate;
          return { kind: "retryableTransport" };
        },
      } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(result).toEqual({
      kind: "retryable",
      reason: "retryableTransport",
    });
    expect(new TextDecoder().decode(write?.input.readmeBytes)).toBe(
      "# Hello\n<!-- cards:start -->\nAlice\nBob\nCarol\n<!-- cards:end -->\n",
    );
  });

  test.each(["notVisibleYet", "readFailed", "incomplete", "pending"] as const)(
    "does not create setup resources while branch observation is %s",
    async (status) => {
      const facts = stabilityFacts();
      facts.integrationBranch = { status, provenance: "modeled" };
      let creates = 0;
      const github = {
        observeRepository: async () => ({
          status: "ready" as const,
          value: facts,
        }),
        createIntegrationBranch: async () => {
          creates += 1;
          return { kind: "succeeded" as const, value: {} };
        },
      } as unknown as GithubPlatform;
      const git = {
        readWorkspace: async () => ({
          status: "ready" as const,
          value: { status: "ready" as const },
        }),
      } as unknown as GitWorkspace;
      await createReconciler({ github, git }).reconcile({
        budget: { maxEffects: 1 },
      });
      expect(creates).toBe(0);
    },
  );

  test("discovers the branch anchor from an existing Integration PR instead of creating a duplicate", async () => {
    const facts = stabilityFacts();
    facts.integrationBranch = { status: "absent", provenance: "modeled" };
    const integration = facts.integrationPullRequest.value;
    if (!integration) throw new Error("integration PR is required");
    facts.integrationPullRequest.value = {
      ...integration,
      headRef: "feature/card-alice-source-1",
    };
    let branchCreates = 0;
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        value: facts,
      }),
      createIntegrationBranch: async () => {
        branchCreates += 1;
        return { kind: "succeeded" as const, value: {} };
      },
    } as unknown as GithubPlatform;
    const git = {
      readWorkspace: async () => readySetupWorkspace(),
    } as unknown as GitWorkspace;

    const result = await createReconciler({ github, git }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(branchCreates).toBe(0);
    expect(result).not.toEqual({ kind: "terminal", reason: "notFound" });
  });

  test.each([
    ["readFailed", { kind: "retryable", reason: "retryableTransport" }],
    [
      "notVisibleYet",
      { kind: "awaitingExternalFact", reason: "notVisibleYet" },
    ],
    ["pending", { kind: "awaitingExternalFact", reason: "pending" }],
    ["incomplete", { kind: "awaitingExternalFact", reason: "incomplete" }],
    ["conclusiveFailure", { kind: "terminal", reason: "notFound" }],
  ] as const)(
    "does not create an Integration PR while its observation is %s",
    async (status, expected) => {
      const facts = stabilityFacts();
      facts.integrationPullRequest = { status, provenance: "modeled" };
      let creates = 0;
      const github = {
        observeRepository: async () => ({
          status: "ready" as const,
          value: facts,
        }),
        createIntegrationPullRequest: async () => {
          creates += 1;
          return { kind: "succeeded" as const, value: {} };
        },
      } as unknown as GithubPlatform;
      const git = {
        readWorkspace: async () => readySetupWorkspace(),
      } as unknown as GitWorkspace;

      const result = await createReconciler({ github, git }).reconcile({
        budget: { maxEffects: 1 },
      });

      expect(creates).toBe(0);
      expect(result).toEqual(expected);
    },
  );

  test("fails closed before candidate write when policy is absent", async () => {
    const facts = stabilityFacts();
    let writes = 0;
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        value: facts,
      }),
    } as unknown as GithubPlatform;
    const git = {
      readWorkspace: async () => ({
        status: "ready" as const,
        value: {
          status: "ready" as const,
          integrationHeadOid: oid("integration-1"),
          retainedCommitOids: [oid("integration-1")],
          requiredParentOids: [],
        },
      }),
      writeIntegrationCandidate: async () => {
        writes += 1;
        return { status: "ready" as const };
      },
    } as unknown as GitWorkspace;
    await createReconciler({ github, git }).reconcile({
      budget: { maxEffects: 1 },
    });
    expect(writes).toBe(0);
  });

  test("maps a candidate write exception that reaches the write effect to an unknown retryable outcome", async () => {
    const facts = stabilityFacts();
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        value: facts,
      }),
    } as GithubPlatform;
    const git = {
      readWorkspace: async () => ({
        status: "ready" as const,
        value: {
          status: "ready" as const,
          integrationHeadOid: oid("integration-1"),
          retainedCommitOids: [oid("integration-1")],
          requiredParentOids: [],
        },
      }),
      writeIntegrationCandidate: async () => {
        throw new Error("push failed");
      },
    } as unknown as GitWorkspace;
    const result = await createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });
    expect(result).toEqual({ kind: "retryable", reason: "unknownOutcome" });
  });

  test("requires a nonempty exact contributor approval", async () => {
    const facts = stabilityFacts();
    facts.candidate = {
      status: "ready",
      provenance: "modeled",
      value: {
        observedOid: oid("integration-1"),
        provenance: "modeled",
        integrationHeadOid: oid("integration-1"),
        mainOid: oid("main-1"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
        readmeBlobOid: oid("readme"),
        retainedCommitOids: [oid("integration-1")],
        requiredParentOids: [],
      },
    };
    facts.confirmations = [
      {
        kind: "domainConfirmation",
        contributorLogin: "alice",
        githubId: "7",
        sourcePrNumber: 1,
        integrationPrNumber: 2,
        reviewedCommitOid: oid("integration-1"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
      },
    ];
    facts.eligibility.reviews = {
      status: "ready",
      provenance: "modeled",
      value: [],
    };
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({
          status: "ready" as const,
          value: facts,
        }),
      } as GithubPlatform,
      git: {
        readWorkspace: async () => ({
          status: "ready" as const,
          value: {
            status: "ready" as const,
            integrationHeadOid: oid("integration-1"),
            retainedCommitOids: [oid("integration-1")],
            requiredParentOids: [],
          },
        }),
      } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });
    expect(result).not.toEqual({ kind: "quiescent" });
  });

  test.each([
    ["wrong author", { authorLogin: "bob" }],
    ["non-fork", { headRepositoryIsFork: false }],
    ["wrong branch", { headRef: "add/bob" }],
    [
      "wrong path",
      {
        changedFiles: [
          {
            path: "people/bob.md",
            blobOid: oid("card"),
            bytes: new Uint8Array(),
          },
        ],
      },
    ],
    [
      "extra files",
      {
        changedFiles: [
          {
            path: "people/alice.md",
            blobOid: oid("card"),
            bytes: new Uint8Array(),
          },
          { path: "README.md", blobOid: oid("extra"), bytes: new Uint8Array() },
        ],
      },
    ],
  ])("rejects intake with %s before setup", async (_name, patch) => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = {
      ...source,
      ...patch,
      merged: false,
      closed: false,
    };
    let effects = 0;
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
        createIntegrationBranch: async () => {
          effects += 1;
          return { kind: "succeeded", value: {} };
        },
      } as unknown as GithubPlatform,
      git: { readWorkspace: readySetupWorkspace } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });
    expect(result).toEqual({ kind: "terminal", reason: "policyRejected" });
    expect(effects).toBe(0);
  });

  test("rejects a published or concurrently active github identity before setup", async () => {
    for (const identities of [
      { publishedGithubIds: ["7"] },
      { activeGithubIds: ["7"] },
    ]) {
      const facts = stabilityFacts();
      const source = facts.sourcePullRequest.value;
      if (!source) throw new Error("source is required");
      facts.sourcePullRequest.value = {
        ...source,
        merged: false,
        closed: false,
      };
      Object.assign(facts, identities);
      const result = await createReconciler({
        github: {
          observeRepository: async () => ({ status: "ready", value: facts }),
        } as GithubPlatform,
        git: { readWorkspace: readySetupWorkspace } as unknown as GitWorkspace,
      }).reconcile({ budget: { maxEffects: 1 } });
      expect(result).toEqual({ kind: "terminal", reason: "policyRejected" });
    }
  });

  test("treats a closed unmerged Contribution as terminal without publishing", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: true };
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
      } as GithubPlatform,
      git: { readWorkspace: readySetupWorkspace } as unknown as GitWorkspace,
    }).reconcile({ budget: { maxEffects: 1 } });
    expect(result).toEqual({ kind: "terminal", reason: "policyRejected" });
  });

  test("requires confirmation login and reviewed commit to bind the current candidate", async () => {
    const facts = stabilityFacts();
    const integration = facts.integrationPullRequest.value;
    if (!integration) throw new Error("integration is required");
    facts.integrationPullRequest.value = { ...integration, draft: false };
    facts.candidate = {
      status: "ready",
      provenance: "modeled",
      value: {
        observedOid: oid("integration-1"),
        provenance: "modeled",
        integrationHeadOid: oid("integration-1"),
        mainOid: oid("main-1"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
        readmeBlobOid: oid("readme"),
        retainedCommitOids: [oid("integration-1")],
        requiredParentOids: [],
      },
    };
    facts.confirmations = [
      {
        kind: "domainConfirmation",
        contributorLogin: "mallory",
        githubId: "7",
        sourcePrNumber: 1,
        integrationPrNumber: 2,
        reviewedCommitOid: oid("old"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
      },
    ];
    facts.eligibility.reviews = {
      status: "ready",
      provenance: "modeled",
      value: [
        {
          pullRequestNumber: 2,
          prHeadOid: oid("integration-1"),
          reviewerLogin: "alice",
          state: "approved",
          reviewedCommitOid: oid("integration-1"),
          observedOid: oid("integration-1"),
          provenance: "modeled",
        },
      ],
    };
    let merges = 0;
    await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
        mergePullRequest: async () => {
          merges += 1;
          return { kind: "integrationRejected", reason: "gateUnsupported" };
        },
      } as unknown as GithubPlatform,
      git: { readWorkspace: readyWorkspace } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });
    expect(merges).toBe(0);
  });
});

function readySetupWorkspace() {
  return {
    status: "ready" as const,
    value: {
      status: "ready" as const,
      integrationHeadOid: oid("integration-1"),
    },
  };
}
