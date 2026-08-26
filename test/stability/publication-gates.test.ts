import { describe, expect, test, vi } from "vitest";
import { gitBlobOid, oid } from "../../src/core/model.js";
import { createReconciler } from "../../src/core/reconciler.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import {
  readyWorkspace,
  stabilityFacts,
  testCandidatePolicy,
} from "../fixtures/stability.js";

function publishableFacts() {
  const facts = stabilityFacts();
  const source = facts.sourcePullRequest.value;
  const integration = facts.integrationPullRequest.value;
  if (!source || !integration)
    throw new Error("stability fixture is incomplete");
  const cardBlobOid = gitBlobOid(facts.acceptedCard?.bytes ?? new Uint8Array());
  facts.sourcePullRequest.value = {
    ...source,
    headOid: oid("integration-1"),
    observedOid: oid("integration-1"),
  };
  facts.candidate = {
    status: "ready",
    provenance: "modeled",
    value: {
      integrationHeadOid: oid("integration-1"),
      mainOid: oid("main-1"),
      cardPath: "people/alice.md",
      cardBlobOid,
      readmeBlobOid: oid("readme-1"),
      retainedCommitOids: [oid("integration-1")],
      requiredParentOids: [],
      observedOid: oid("integration-1"),
      provenance: "modeled",
    },
  };
  facts.integrationPullRequest.value = {
    ...integration,
    draft: false,
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
      cardBlobOid,
    },
  ];
  facts.eligibility.checks.value = [
    {
      pullRequestNumber: 2,
      prHeadOid: oid("integration-1"),
      state: "success",
      observedOid: oid("integration-1"),
      provenance: "modeled",
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
  return facts;
}

function platform(facts: ReturnType<typeof publishableFacts>) {
  const mergePullRequest = vi.fn(async () => ({
    kind: "integrationMerged" as const,
    mainOid: oid("main-2"),
  }));
  return {
    mergePullRequest,
    value: {
      observeRepository: async () => ({
        status: "ready" as const,
        provenance: "modeled" as const,
        value: facts,
      }),
      mergePullRequest,
    } as unknown as GithubPlatform,
  };
}

const workspace: GitWorkspace = {
  readWorkspace: readyWorkspace,
  writeIntegrationCandidate: async () => ({
    kind: "succeeded",
    value: { status: "ready" },
  }),
  readFinalMainPostconditions: async () => ({ status: "pending" }),
};

describe("L4 publisher gates", () => {
  test.each(["changesRequested", "dismissed"] as const)(
    "does not publish a domain-confirmed Card while provider review is %s",
    async (state) => {
      const facts = publishableFacts();
      facts.eligibility.reviews.value = [
        {
          pullRequestNumber: 2,
          prHeadOid: oid("integration-1"),
          reviewerLogin: "maintainer",
          state,
          reviewedCommitOid: oid("integration-1"),
          observedOid: oid("integration-1"),
          provenance: "modeled",
        },
      ];
      const github = platform(facts);

      const outcome = await createReconciler({
        candidatePolicy: testCandidatePolicy,
        github: github.value,
        git: workspace,
      }).reconcile({
        budget: { maxEffects: 1 },
      });

      expect(outcome).toEqual({ kind: "quiescent" });
      expect(github.mergePullRequest).not.toHaveBeenCalled();
    },
  );

  test("does not publish when its confirmation no longer matches the current Card blob", async () => {
    const facts = publishableFacts();
    const [confirmation] = facts.confirmations;
    if (!confirmation) throw new Error("stability confirmation is required");
    facts.confirmations = [
      { ...confirmation, cardBlobOid: oid("old-card-blob") },
    ];
    const github = platform(facts);

    const outcome = await createReconciler({
      candidatePolicy: testCandidatePolicy,
      github: github.value,
      git: workspace,
    }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(outcome).toEqual({ kind: "quiescent" });
    expect(github.mergePullRequest).not.toHaveBeenCalled();
  });

  test("does not publish an old ready candidate after the Integration head changes", async () => {
    const facts = publishableFacts();
    const integration = facts.integrationPullRequest.value;
    if (!integration) throw new Error("stability Integration PR is required");
    facts.integrationPullRequest.value = {
      ...integration,
      headOid: oid("integration-2"),
      observedOid: oid("integration-2"),
    };
    const github = platform(facts);

    const outcome = await createReconciler({
      candidatePolicy: testCandidatePolicy,
      github: github.value,
      git: workspace,
    }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(outcome).toEqual({ kind: "retryable", reason: "stalePrecondition" });
    expect(github.mergePullRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "integration" }),
    );
  });

  test("returns retryable when a base-current provider gate rejects publication", async () => {
    const facts = publishableFacts();
    const github = platform(facts);
    github.mergePullRequest.mockImplementation(
      async () =>
        ({
          kind: "integrationRejected",
          reason: "gateRejected",
        }) as unknown as {
          kind: "integrationMerged";
          mainOid: ReturnType<typeof oid>;
        },
    );

    await expect(
      createReconciler({
        github: github.value,
        git: workspace,
        candidatePolicy: testCandidatePolicy,
      }).reconcile({
        budget: { maxEffects: 1 },
      }),
    ).resolves.toEqual({ kind: "retryable", reason: "stalePrecondition" });
  });
});
