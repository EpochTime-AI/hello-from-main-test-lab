import { describe, expect, test } from "vitest";
import { createReconciler } from "../../src/core/reconciler.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import { readyWorkspace, stabilityFacts } from "../fixtures/stability.js";
import { FaultScheduler } from "./fault-scheduler.js";

describe("L4 unknown mutation outcomes", () => {
  test("returns a bounded retry after a response is lost after the Contribution merge mutation", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("stability source is required");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: false };
    const scheduler = new FaultScheduler([
      { mutation: "mergeContribution", phase: "after", kind: "responseLost" },
    ]);
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        provenance: "modeled" as const,
        value: facts,
      }),
      mergePullRequest: async () =>
        scheduler.mutate("mergeContribution", async () => ({
          kind: "contributionMerged" as const,
          headOid: facts.integrationBranch.value?.headOid,
        })),
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: readyWorkspace,
      writeIntegrationCandidate: async () => ({
        kind: "succeeded" as const,
        value: { status: "ready" as const },
      }),
      readFinalMainPostconditions: async () => ({ status: "pending" }),
    };

    await expect(
      createReconciler({ github, git }).reconcile({
        budget: { maxEffects: 1 },
      }),
    ).resolves.toEqual({ kind: "retryable", reason: "unknownOutcome" });
    expect(scheduler.effects).toEqual([
      "before:mergeContribution",
      "after:mergeContribution",
    ]);
  });
});
