import { describe, expect, test } from "vitest";
import { type FinalMainPostconditions, oid } from "../../src/core/model.js";
import { createReconciler } from "../../src/core/reconciler.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import {
  candidateRecorder,
  readyWorkspace,
  stabilityFacts,
  testCandidatePolicy,
} from "../fixtures/stability.js";
import { FaultScheduler } from "./fault-scheduler.js";

describe("L4 restart from current facts", () => {
  test("does not repeat an accepted merge after its response is lost and a watchdog restart observes the new head", async () => {
    const facts = stabilityFacts();
    const candidate = candidateRecorder();
    const scheduler = new FaultScheduler([
      { mutation: "mergeContribution", phase: "after", kind: "responseLost" },
    ]);
    let merges = 0;
    const source = facts.sourcePullRequest.value;
    const branch = facts.integrationBranch.value;
    if (!source || !branch) throw new Error("stability fixture is incomplete");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: false };
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        provenance: "modeled" as const,
        value: facts,
      }),
      mergePullRequest: async () =>
        scheduler.mutate("mergeContribution", async () => {
          merges += 1;
          facts.sourcePullRequest.value = {
            ...source,
            headOid: branch.headOid,
            merged: true,
            closed: true,
            mergeCommitOid: branch.headOid,
            mergeParentOids: [branch.headOid, source.headOid],
          };
          return {
            kind: "contributionMerged" as const,
            headOid: branch.headOid,
          };
        }),
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: readyWorkspace,
      writeIntegrationCandidate: candidate.write,
      readFinalMainPostconditions: async () => ({ status: "pending" }),
    };

    await expect(
      createReconciler({
        github,
        git,
        candidatePolicy: testCandidatePolicy,
      }).reconcile({
        budget: { maxEffects: 1 },
      }),
    ).resolves.toEqual({ kind: "retryable", reason: "unknownOutcome" });
    await createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(merges).toBe(1);
    expect(candidate.writes).toHaveLength(1);
  });

  test("is quiescent after restart when a merged Integration PR matches final main", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    const main = facts.main.value;
    if (!source || !integration || !main)
      throw new Error("fixture is incomplete");
    facts.integrationPullRequest.value = {
      ...integration,
      merged: true,
      closed: true,
      mergeCommitOid: oid("published"),
      mergeParentOids: [oid("candidate-1"), oid("main-1")],
    };
    facts.main.value = {
      ...main,
      oid: oid("published"),
      cardManifests: [
        {
          path: "people/alice.md",
          blobOid: oid("card"),
          githubId: "7",
          sourcePrNumber: 1,
        },
      ],
    };
    let merges = 0;
    await expect(
      createReconciler({
        github: {
          observeRepository: async () => ({ status: "ready", value: facts }),
          mergePullRequest: async () => {
            merges += 1;
            return { kind: "integrationRejected", reason: "unknownOutcome" };
          },
        } as unknown as GithubPlatform,
        git: {
          readWorkspace: readyWorkspace,
          readFinalMainPostconditions: async (
            expected: FinalMainPostconditions,
          ) => ({
            status: "ready",
            value: expected,
          }),
        } as unknown as GitWorkspace,
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "quiescent" });
    expect(merges).toBe(0);
  });

  test("does not trust self-consistent provider parents over independent anchors", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    const main = facts.main.value;
    if (!source || !integration || !main)
      throw new Error("fixture is incomplete");
    facts.sourcePullRequest.value = {
      ...source,
      merged: true,
      closed: true,
      mergeCommitOid: oid("source-merge"),
      mergeParentOids: [oid("wrong-a"), oid("wrong-b")],
    };
    facts.integrationPullRequest.value = {
      ...integration,
      merged: true,
      closed: true,
      mergeCommitOid: oid("published"),
      mergeParentOids: [oid("wrong-c"), oid("wrong-d")],
    };
    facts.main.value = {
      ...main,
      oid: oid("published"),
      cardManifests: [
        {
          path: "people/alice.md",
          blobOid: oid("card"),
          githubId: "7",
          sourcePrNumber: 1,
        },
      ],
    };
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
      } as unknown as GithubPlatform,
      git: {
        readWorkspace: readyWorkspace,
        readFinalMainPostconditions: async (
          expected: FinalMainPostconditions,
        ) => ({
          status: "ready",
          value: {
            ...expected,
            contributionMergeParentOids: [oid("wrong-a"), oid("wrong-b")],
            integrationMergeParentOids: [oid("wrong-c"), oid("wrong-d")],
          },
        }),
      } as unknown as GitWorkspace,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });
    expect(result).toEqual({ kind: "terminal", reason: "policyRejected" });
  });

  test("awaits when independent publication anchors are missing", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    const main = facts.main.value;
    if (!source || !integration || !main)
      throw new Error("fixture is incomplete");
    facts.sourcePullRequest.value = {
      ...source,
      merged: true,
      closed: true,
      mergeCommitOid: oid("source-merge"),
    };
    facts.integrationPullRequest.value = {
      ...integration,
      merged: true,
      closed: true,
      mergeCommitOid: oid("published"),
    };
    facts.main.value = {
      ...main,
      oid: oid("published"),
      cardManifests: [
        {
          path: "people/alice.md",
          blobOid: oid("card"),
          githubId: "7",
          sourcePrNumber: 1,
        },
      ],
    };
    delete facts.protocolAnchors;
    await expect(
      createReconciler({
        github: {
          observeRepository: async () => ({ status: "ready", value: facts }),
        } as unknown as GithubPlatform,
        git: { readWorkspace: readyWorkspace } as unknown as GitWorkspace,
        candidatePolicy: testCandidatePolicy,
      }).reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({ kind: "awaitingExternalFact", reason: "incomplete" });
  });
});
