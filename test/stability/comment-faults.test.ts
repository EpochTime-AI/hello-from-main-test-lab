import { describe, expect, test } from "vitest";
import {
  type CommentFact,
  type CommentIntent,
  type FinalMainPostconditions,
  gitBlobOid,
  oid,
} from "../../src/core/model.js";
import { createReconciler } from "../../src/core/reconciler.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import { stabilityFacts, testCandidatePolicy } from "../fixtures/stability.js";
import { FaultScheduler } from "./fault-scheduler.js";

function publishedFacts() {
  const facts = stabilityFacts();
  const source = facts.sourcePullRequest.value;
  const integration = facts.integrationPullRequest.value;
  const main = facts.main.value;
  const card = facts.acceptedCard;
  if (!source || !integration || !main || !card)
    throw new Error("fixture incomplete");
  const mainOid = oid("0123456789abcdef0123456789abcdef01234567");
  const blobOid = gitBlobOid(card.bytes);
  facts.trustedRepository = {
    webBaseUrl: "https://github.example.test",
    owner: "hello",
    repo: "main",
  };
  facts.sourcePullRequest.value = { ...source, merged: true, closed: true };
  facts.integrationPullRequest.value = {
    ...integration,
    merged: true,
    closed: true,
    mergeCommitOid: mainOid,
    mergeParentOids: [oid("main-1"), integration.headOid],
  };
  facts.main.value = {
    ...main,
    oid: mainOid,
    cardManifests: [
      { path: card.path, blobOid, githubId: "7", sourcePrNumber: 1 },
    ],
  };
  return { facts, card };
}

function finalWorkspace(cardBytes: Uint8Array): GitWorkspace {
  return {
    readWorkspace: async () => ({
      status: "ready",
      value: { status: "ready" },
    }),
    writeIntegrationCandidate: async () => ({ kind: "retryableTransport" }),
    readFinalMainPostconditions: async (expected: FinalMainPostconditions) => ({
      status: "ready",
      value: { ...expected, cardBytes },
    }),
  };
}

function semanticPlatform(input: {
  facts: ReturnType<typeof publishedFacts>["facts"];
  fail?: "source" | "integration" | "unknown" | "stale" | "permission";
}) {
  let failed = false;
  let mergeCalls = 0;
  const attempts: string[] = [];
  const github: GithubPlatform = {
    observeRepository: async () => ({ status: "ready", value: input.facts }),
    ensureComment: async (intent: CommentIntent) => {
      attempts.push(intent.slot);
      const shouldFail =
        !failed &&
        (input.fail === "unknown" ||
          input.fail === "stale" ||
          input.fail === "permission" ||
          (input.fail === "source" && intent.slot === "source-status") ||
          (input.fail === "integration" &&
            intent.slot === "integration-status"));
      if (shouldFail) {
        failed = true;
        if (input.fail === "unknown") {
          input.facts.comments = [
            ...(input.facts.comments ?? []),
            comment(intent, (input.facts.comments?.length ?? 0) + 1),
          ];
        }
        return {
          kind:
            input.fail === "unknown"
              ? "unknownOutcome"
              : input.fail === "stale"
                ? "stale"
                : input.fail === "permission"
                  ? "permissionDenied"
                  : "retryableTransport",
        };
      }
      const existing = input.facts.comments?.find(
        (item) => item.actionKey === intent.actionKey,
      );
      if (existing?.body === intent.body)
        return { kind: "noOp", comment: existing };
      const next =
        existing ?? comment(intent, (input.facts.comments?.length ?? 0) + 1);
      const updated = { ...next, body: intent.body };
      input.facts.comments = existing
        ? (input.facts.comments ?? []).map((item) =>
            item.id === existing.id ? updated : item,
          )
        : [...(input.facts.comments ?? []), updated];
      return { kind: existing ? "updated" : "created", comment: updated };
    },
    createIntegrationBranch: async () => ({ kind: "notVisibleYet" }),
    createIntegrationPullRequest: async () => ({ kind: "notVisibleYet" }),
    updatePullRequestBase: async () => ({ kind: "notVisibleYet" }),
    markPullRequestReadyForReview: async () => ({
      kind: "blocked",
      reason: "notVisibleYet",
    }),
    mergePullRequest: (async () => {
      mergeCalls += 1;
      return {
        kind: "integrationRejected" as const,
        reason: "unknownOutcome" as const,
      };
    }) as unknown as GithubPlatform["mergePullRequest"],
  };
  return { github, attempts, mergeCalls: () => mergeCalls };
}

function comment(intent: CommentIntent, id: number): CommentFact {
  return {
    id,
    user: { id: "42", actorType: "Bot" },
    ownerPrincipal: { actorId: "42", actorType: "Bot" },
    targetPullRequestNumber: intent.targetPullRequestNumber,
    actionKey: intent.actionKey,
    body: intent.body,
  };
}

describe("L4 completion Comment faults", () => {
  test.each(["source", "integration"] as const)(
    "retries only the failed %s completion without re-merging",
    async (failedTarget) => {
      const { facts, card } = publishedFacts();
      const platform = semanticPlatform({ facts, fail: failedTarget });
      const core = createReconciler({
        github: platform.github,
        git: finalWorkspace(card.bytes),
        candidatePolicy: testCandidatePolicy,
      });
      await expect(
        core.reconcile({ budget: { maxEffects: 3 } }),
      ).resolves.toEqual({ kind: "retryable", reason: "retryableTransport" });
      await expect(
        core.reconcile({ budget: { maxEffects: 3 } }),
      ).resolves.toEqual({ kind: "quiescent" });
      expect(platform.attempts).toEqual(
        failedTarget === "source"
          ? ["source-status", "source-status", "integration-status"]
          : ["source-status", "integration-status", "integration-status"],
      );
      expect(platform.mergeCalls()).toBe(0);
    },
  );

  test("F-O1/F-R1 converges duplicate, reordered, and missed wakes after a lost Comment response", async () => {
    const { facts, card } = publishedFacts();
    const platform = semanticPlatform({ facts, fail: "unknown" });
    const core = createReconciler({
      github: platform.github,
      git: finalWorkspace(card.bytes),
      candidatePolicy: testCandidatePolicy,
    });
    const scheduler = new FaultScheduler();
    for (const _wake of scheduler.wakeups(["duplicate", "missed", "reordered"]))
      await core.reconcile({ budget: { maxEffects: 3 } });
    expect(facts.comments).toHaveLength(2);
    expect(new Set(facts.comments?.map((item) => item.actionKey))).toHaveLength(
      2,
    );
    expect(platform.mergeCalls()).toBe(0);
  });

  test.each([
    ["stale", { kind: "retryable", reason: "stalePrecondition" }],
    ["permission", { kind: "terminal", reason: "permissionDenied" }],
  ] as const)(
    "classifies %s Comment failures without re-merging",
    async (failure, expected) => {
      const { facts, card } = publishedFacts();
      const platform = semanticPlatform({ facts, fail: failure });
      await expect(
        createReconciler({
          github: platform.github,
          git: finalWorkspace(card.bytes),
          candidatePolicy: testCandidatePolicy,
        }).reconcile({ budget: { maxEffects: 3 } }),
      ).resolves.toEqual(expected);
      expect(platform.mergeCalls()).toBe(0);
    },
  );
});
