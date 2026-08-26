import { describe, expect, test } from "vitest";
import type {
  CandidateWrite,
  Confirmation,
  ContributionMergeRequest,
  ContributionMergeResult,
  IntegrationMergeRequest,
  IntegrationMergeResult,
  Observation,
  Oid,
  OperationResultCategory,
  ReconcileOutcome,
} from "../../src/core/model.js";
import { oid } from "../../src/core/model.js";

const main = oid("main-oid");
const integration = oid("integration-oid");
const cardBlob = oid("card-blob");

describe("public model contracts", () => {
  test("keeps observations and dependent facts bound to their observed OIDs", () => {
    const pullRequest: Observation<{ headOid: Oid; baseOid: Oid }> = {
      status: "ready",
      observedOid: integration,
      value: { headOid: integration, baseOid: main },
    };
    const check: Observation<{ prHeadOid: Oid; state: "success" }> = {
      status: "ready",
      observedOid: integration,
      value: { prHeadOid: integration, state: "success" },
    };

    expect(pullRequest.value?.headOid).toBe(check.value?.prHeadOid);
    expect(pullRequest.observedOid).toBe(integration);
  });

  test("exposes Card-blob Confirmation independently from provider eligibility", () => {
    const confirmation: Confirmation = {
      kind: "domainConfirmation",
      contributorLogin: "c-w-xiaohei",
      githubId: "12345678",
      sourcePrNumber: 184,
      integrationPrNumber: 185,
      reviewedCommitOid: integration,
      cardPath: "people/c-w-xiaohei.md",
      cardBlobOid: cardBlob,
    };

    expect(confirmation.cardBlobOid).toBe(cardBlob);
    expect(confirmation).not.toHaveProperty("providerEligibility");
  });

  test("requires CandidateWrite manifest and accepted-history postconditions", () => {
    const candidate: CandidateWrite = {
      input: {
        observedMainOid: main,
        expectedIntegrationHeadOid: integration,
        cardPath: "people/c-w-xiaohei.md",
        cardBytes: new Uint8Array([35]),
        readmeBytes: new Uint8Array([82]),
        preserveConfirmedCardBlobOid: cardBlob,
      },
      postconditions: {
        cardManifest: {
          path: "people/c-w-xiaohei.md",
          blobOid: cardBlob,
          githubId: "12345678",
          sourcePrNumber: 184,
        },
        readmeBlobOid: oid("readme-blob"),
        history: {
          retainCommitOids: [oid("contributor-commit")],
          requiredParentOids: [integration],
        },
      },
    };

    expect(candidate.postconditions.cardManifest.path).toBe(
      candidate.input.cardPath,
    );
    expect(candidate.postconditions.history.retainCommitOids).toHaveLength(1);
  });

  test("keeps contribution and integration merge requests discriminated", () => {
    const contribution: ContributionMergeRequest = {
      kind: "contribution",
      pullRequestNumber: 184,
      expectedHeadOid: integration,
    };
    const publication: IntegrationMergeRequest = {
      kind: "integration",
      pullRequestNumber: 185,
      expectedHeadOid: integration,
      observedBaseOid: main,
      baseCurrentGate: "required",
    };

    expect(contribution.kind).toBe("contribution");
    expect(publication.observedBaseOid).toBe(main);
    expect(publication).not.toHaveProperty("expectedBaseOid");
  });

  test("keeps merge results and operation failures operation-specific", () => {
    const contributionResult: ContributionMergeResult = {
      kind: "contributionRejected",
      reason: "stalePrecondition",
    };
    const integrationResult: IntegrationMergeResult = {
      kind: "integrationRejected",
      reason: "baseMoved",
    };
    const categories: OperationResultCategory[] = [
      "permissionDenied",
      "rateLimited",
      "notVisibleYet",
      "notFound",
      "stalePrecondition",
      "policyRejected",
      "retryableTransport",
      "unknownOutcome",
      "alreadyApplied",
    ];

    expect(contributionResult.kind).toBe("contributionRejected");
    expect(integrationResult.reason).toBe("baseMoved");
    expect(categories).toContain("alreadyApplied");
    expect(categories).not.toContain("baseMoved");
  });

  test("names bounded reconcile outcomes without conflating external waiting and retry", () => {
    const outcomes: ReconcileOutcome[] = [
      { kind: "quiescent" },
      { kind: "awaitingExternalFact", reason: "awaitingApproval" },
      { kind: "retryable", reason: "retryableTransport" },
      { kind: "budgetExhausted", effects: 2 },
      { kind: "terminal", reason: "policyRejected" },
    ];

    expect(new Set(outcomes.map((outcome) => outcome.kind)).size).toBe(5);
  });
});
