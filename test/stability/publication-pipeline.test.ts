import { describe, expect, test, vi } from "vitest";
import { createOctokitGithubPlatform } from "../../src/adapters/octokit.js";
import { gitBlobOid, oid } from "../../src/core/model.js";
import { createReconciler } from "../../src/core/reconciler.js";
import { bindProductionSetup } from "../../src/entry/action-runtime.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import {
  renderReadyComment,
  renderValidationComment,
} from "../../src/render/comment.js";
import { stabilityFacts, testCandidatePolicy } from "../fixtures/stability.js";

function readyFacts() {
  const facts = stabilityFacts();
  const source = facts.sourcePullRequest.value;
  const integration = facts.integrationPullRequest.value;
  const card = facts.acceptedCard;
  if (!source || !integration || !card)
    throw new Error("fixture is incomplete");
  const cardBlobOid = gitBlobOid(card.bytes);
  facts.sourcePullRequest.value = {
    ...source,
    headOid: integration.headOid,
    observedOid: integration.headOid,
    mergeCommitOid: oid("source-merge"),
    mergeParentOids: [oid("integration-base"), integration.headOid],
  };
  facts.integrationPullRequest.value = { ...integration, draft: false };
  facts.candidate = {
    status: "ready",
    provenance: "modeled",
    value: {
      integrationHeadOid: integration.headOid,
      mainOid: oid("main-1"),
      cardPath: card.path,
      cardBlobOid,
      readmeBlobOid: oid("readme-1"),
      retainedCommitOids: [integration.headOid],
      requiredParentOids: [],
      observedOid: integration.headOid,
      provenance: "modeled",
    },
  };
  facts.confirmations = [
    {
      kind: "domainConfirmation",
      contributorLogin: "alice",
      githubId: card.githubId,
      sourcePrNumber: card.sourcePrNumber,
      integrationPrNumber: integration.number,
      reviewedCommitOid: integration.headOid,
      cardPath: card.path,
      cardBlobOid,
    },
  ];
  facts.eligibility.checks.value = [
    {
      pullRequestNumber: integration.number,
      prHeadOid: integration.headOid,
      state: "success",
      observedOid: integration.headOid,
      provenance: "modeled",
    },
  ];
  facts.eligibility.reviews.value = [
    {
      pullRequestNumber: integration.number,
      prHeadOid: integration.headOid,
      reviewerLogin: "alice",
      state: "approved",
      reviewedCommitOid: integration.headOid,
      observedOid: integration.headOid,
      provenance: "modeled",
    },
  ];
  return facts;
}

function platform(facts: ReturnType<typeof readyFacts>) {
  const mergePullRequest = vi.fn(async () => ({
    kind: "integrationMerged" as const,
    mainOid: oid("main-merged"),
  }));
  return {
    mergePullRequest,
    github: {
      observeRepository: async () => ({
        status: "ready" as const,
        provenance: "modeled" as const,
        value: facts,
      }),
      mergePullRequest,
    } as unknown as GithubPlatform,
  };
}

function workspace(input: {
  write?: ReturnType<typeof vi.fn>;
  final?: ReturnType<typeof vi.fn>;
  candidate?: NonNullable<ReturnType<typeof readyFacts>["candidate"]["value"]>;
}): GitWorkspace {
  return {
    readWorkspace: async () => ({
      status: "ready",
      value: {
        status: "ready",
        integrationHeadOid: oid("integration-1"),
        ...(input.candidate ? { candidate: input.candidate } : {}),
        retainedCommitOids: [oid("integration-1")],
        requiredParentOids: [],
      },
    }),
    writeIntegrationCandidate:
      input.write ??
      (async () => ({
        kind: "succeeded" as const,
        value: { status: "ready" as const },
      })),
    readFinalMainPostconditions:
      input.final ?? (async () => ({ status: "pending" as const })),
  };
}

function markIntegrationPublished(facts: ReturnType<typeof readyFacts>) {
  const integration = facts.integrationPullRequest.value;
  const main = facts.main.value;
  const card = facts.acceptedCard;
  if (!integration || !main || !card) throw new Error("fixture is incomplete");
  const published = oid("0123456789abcdef0123456789abcdef01234567");
  facts.integrationPullRequest.value = {
    ...integration,
    merged: true,
    closed: true,
    mergeCommitOid: published,
    mergeParentOids: [oid("main-1"), integration.headOid],
  };
  facts.main.value = {
    ...main,
    oid: published,
    cardManifests: [
      {
        path: card.path,
        blobOid: gitBlobOid(card.bytes),
        githubId: card.githubId,
        sourcePrNumber: card.sourcePrNumber,
      },
    ],
  };
}

describe("L4 H2 and final publication pipeline", () => {
  test("refreshes H2 with the confirmed Card blob when main moved after Confirmation", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    const main = facts.main.value;
    if (!main) throw new Error("fixture main is required");
    facts.main.value = { ...main, oid: oid("main-2") };
    const writes = vi.fn(async () => ({ status: "ready" as const }));
    const local = platform(facts);

    await createReconciler({
      github: local.github,
      git: workspace({ write: writes, candidate }),
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(writes).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          observedMainOid: oid("main-2"),
          preserveConfirmedCardBlobOid: facts.confirmations[0]?.cardBlobOid,
        }),
      }),
    );
    expect(local.mergePullRequest).not.toHaveBeenCalled();
  });

  test("continues to a fresh provider observation after Git publication", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    const local = platform(facts);
    const final = vi.fn(async () => ({ status: "pending" as const }));

    await expect(
      createReconciler({
        github: local.github,
        git: workspace({ final, candidate }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "budgetExhausted", effects: 1 });
    expect(final).not.toHaveBeenCalled();
  });

  test("does not emit completion until a fresh observation proves the exact Integration PR merge", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    const local = platform(facts);
    const observeRepository = vi.fn(async () => ({
      status: "ready" as const,
      provenance: "modeled" as const,
      value: facts,
    }));
    const final = vi.fn(async (expected) => ({
      status: "ready" as const,
      value: { ...expected, cardBytes: facts.acceptedCard?.bytes },
    }));

    await expect(
      createReconciler({
        github: {
          ...local.github,
          observeRepository,
          mergePullRequest: (async () => {
            markIntegrationPublished(facts);
            return {
              kind: "integrationMerged" as const,
              mainOid: oid("main-merged"),
            };
          }) as unknown as GithubPlatform["mergePullRequest"],
        },
        git: workspace({ final, candidate }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 2 } }),
    ).resolves.toEqual({ kind: "quiescent" });
    expect(observeRepository).toHaveBeenCalledTimes(2);
    expect(final).toHaveBeenCalledOnce();
  });

  test("binds concrete Octokit permits to current publication across fresh observations", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    facts.trustedRepository = {
      webBaseUrl: "https://github.com",
      owner: "acme",
      repo: "hello",
    };
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    if (!source || !integration)
      throw new Error("fixture pull requests are required");
    const runIdentity = "source:1:7";
    const validation = renderValidationComment({
      runIdentity,
      sourcePullRequestNumber: source.number,
      sourceHeadOid: source.headOid,
      result: { kind: "valid", headOid: source.headOid },
    });
    const ready = renderReadyComment({
      runIdentity,
      originalContributor: "alice",
      integrationPullRequestNumber: integration.number,
      candidateHeadOid: integration.headOid,
      cardPath: candidate.cardPath,
      cardBlobOid: candidate.cardBlobOid,
    });
    facts.comments = [validation, ready].map((comment, id) => ({
      id: id + 10,
      user: { id: "42", actorType: "Bot" as const },
      ownerPrincipal: { actorId: "42", actorType: "Bot" as const },
      actionKey: comment.actionKey,
      body: comment.body,
      targetPullRequestNumber:
        comment.slot === "source-status" ? source.number : integration.number,
    }));
    const lifecycleComments = facts.comments;
    const comments: Array<{
      id: number;
      body: string;
      targetPullRequestNumber: number;
    }> = [];
    const intents: string[] = [];
    const commentResults: string[] = [];
    let observations = 0;
    let posts = 0;
    const octokit = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      initialFacts: facts,
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      webBaseUrl: "https://github.com",
      transport: {
        rest: async (request) => {
          const target = Number(/issues\/(\d+)/u.exec(request.path)?.[1]);
          if (request.method === "GET" && request.path.includes("/comments/")) {
            const comment = comments.find((item) =>
              request.path.endsWith(`/${item.id}`),
            );
            if (!comment) throw new Error("missing comment readback");
            return {
              status: 200,
              data: {
                ...comment,
                user: { id: 42, type: "Bot" },
                issue_url: `https://api.github.com/repos/acme/hello/issues/${comment.targetPullRequestNumber}`,
              },
            };
          }
          if (request.method === "GET") return { status: 200, data: [] };
          posts += 1;
          const comment = {
            id: posts,
            body: String(request.parameters?.body),
            targetPullRequestNumber: target,
          };
          comments.push(comment);
          return {
            status: 201,
            data: {
              ...comment,
              user: { id: 42, type: "Bot" },
              issue_url: `https://api.github.com/repos/acme/hello/issues/${target}`,
            },
          };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const github = bindProductionSetup(
      {
        ...octokit,
        ensureComment: async (intent) => {
          intents.push(
            `${intent.targetPullRequestNumber}:${intent.slot}:${intent.phase}`,
          );
          const result = await octokit.ensureComment(intent);
          commentResults.push(result.kind);
          return result;
        },
        observeRepository: async () => {
          observations += 1;
          const observed = await octokit.observeRepository();
          if (observed.value)
            observed.value.comments = [
              ...(observations === 1 ? lifecycleComments : []),
              ...comments.map((comment) => ({
                ...comment,
                user: { id: "42", actorType: "Bot" as const },
                ownerPrincipal: { actorId: "42", actorType: "Bot" as const },
                actionKey: decodeURIComponent(
                  /key=([^ ]+)/u.exec(comment.body)?.[1] ?? "",
                ),
              })),
            ];
          return observed;
        },
      },
      {
        remote: "origin",
        branch: "feature/card-alice-source-1",
        sourcePullRequestNumber: 1,
        sourceLogin: "alice",
        commentOwner: { actorId: "42", actorType: "Bot" },
      },
      {
        publishIntegrationMerge: async () => {
          markIntegrationPublished(facts);
          return {
            kind: "integrationMerged" as const,
            mainOid: oid("main-merged"),
          };
        },
      } as never,
    );
    const final = vi.fn(async (expected) => ({
      status: "ready" as const,
      value: { ...expected, cardBytes: facts.acceptedCard?.bytes },
    }));
    const diagnostics: unknown[] = [];
    const outcome = await createReconciler({
      github,
      git: workspace({ final, candidate }),
      candidatePolicy: testCandidatePolicy,
    }).reconcile({
      budget: { maxEffects: 4 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    expect(
      outcome,
      JSON.stringify({ diagnostics, intents, commentResults }),
    ).toEqual({
      kind: "quiescent",
    });
    expect(observations).toBe(4);
    expect(final).toHaveBeenCalledTimes(3);
    expect(posts).toBe(2);
  });

  test("awaits instead of publishing when candidate history readback is missing", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    const {
      retainedCommitOids: _retained,
      requiredParentOids: _parents,
      ...withoutHistory
    } = candidate;
    facts.candidate.value = withoutHistory;
    const local = platform(facts);

    await expect(
      createReconciler({
        github: local.github,
        git: workspace({ candidate: withoutHistory }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "awaitingExternalFact", reason: "incomplete" });
    expect(local.mergePullRequest).not.toHaveBeenCalled();
  });

  test("fails closed when fresh final main does not match the required Card and history", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    markIntegrationPublished(facts);
    const local = platform(facts);
    const final = vi.fn(async () => ({
      status: "ready" as const,
      value: {
        mainOid: facts.main.value?.oid ?? oid("main-merged"),
        cardManifest: {
          path: "people/alice.md",
          blobOid: oid("wrong-card"),
          githubId: "7",
          sourcePrNumber: 1,
        },
        readmeBytes: new TextEncoder().encode("README\n"),
        retainedCommitOids: [],
        requiredParentOids: [],
      },
    }));

    await expect(
      createReconciler({
        github: local.github,
        git: workspace({ final, candidate }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "terminal", reason: "policyRejected" });
  });

  test("retries when main advances after provider observation but before final Git readback", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    markIntegrationPublished(facts);
    const local = platform(facts);
    const final = vi.fn(async (expected) => ({
      status: "ready" as const,
      value: { ...expected, mainOid: oid("newer-main") },
    }));

    await expect(
      createReconciler({
        github: local.github,
        git: workspace({ final, candidate }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "retryable", reason: "stalePrecondition" });
  });

  test("fails closed when the same main OID has corrupt final semantics", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    if (!candidate) throw new Error("candidate is required");
    markIntegrationPublished(facts);
    const local = platform(facts);
    const final = vi.fn(async (expected) => ({
      status: "ready" as const,
      value: {
        ...expected,
        cardManifest: { ...expected.cardManifest, blobOid: oid("wrong-card") },
      },
    }));

    await expect(
      createReconciler({
        github: local.github,
        git: workspace({ final, candidate }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "terminal", reason: "policyRejected" });
  });

  test("returns quiescent only after final main Card, README, and history readback match", async () => {
    const facts = readyFacts();
    const candidate = facts.candidate.value;
    const card = facts.acceptedCard;
    if (!candidate || !card) throw new Error("fixture candidate is required");
    markIntegrationPublished(facts);
    const local = platform(facts);
    const final = vi.fn(
      async (expected: {
        mainOid: ReturnType<typeof oid>;
        retainedCommitOids: readonly ReturnType<typeof oid>[];
        requiredParentOids: readonly ReturnType<typeof oid>[];
        sourceMergeCommitOid?: ReturnType<typeof oid>;
        integrationMergeCommitOid?: ReturnType<typeof oid>;
        contributionMergeParentOids?: readonly ReturnType<typeof oid>[];
        integrationMergeParentOids?: readonly ReturnType<typeof oid>[];
      }) => ({
        status: "ready" as const,
        value: {
          mainOid: expected.mainOid,
          cardManifest: {
            path: card.path,
            blobOid: candidate.cardBlobOid,
            githubId: card.githubId,
            sourcePrNumber: card.sourcePrNumber,
          },
          readmeBytes: card.readmeBytes ?? new Uint8Array(),
          retainedCommitOids: expected.retainedCommitOids,
          requiredParentOids: expected.requiredParentOids,
          ...(expected.sourceMergeCommitOid
            ? { sourceMergeCommitOid: expected.sourceMergeCommitOid }
            : {}),
          ...(expected.integrationMergeCommitOid
            ? { integrationMergeCommitOid: expected.integrationMergeCommitOid }
            : {}),
          ...(expected.contributionMergeParentOids
            ? {
                contributionMergeParentOids:
                  expected.contributionMergeParentOids,
              }
            : {}),
          ...(expected.integrationMergeParentOids
            ? {
                integrationMergeParentOids: expected.integrationMergeParentOids,
              }
            : {}),
        },
      }),
    );

    await expect(
      createReconciler({
        github: local.github,
        git: workspace({ final, candidate }),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "quiescent" });
  });
});
