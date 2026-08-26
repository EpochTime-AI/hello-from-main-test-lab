import { describe, expect, test, vi } from "vitest";
import { createReconciler } from "../../src/core/reconciler.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import {
  candidateRecorder,
  readyWorkspace,
  stabilityFacts,
} from "../fixtures/stability.js";

describe("L4 current-fact recovery", () => {
  test("accepts the Contributor PR before it writes the candidate exposed for Ready", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("stability source is required");
    facts.sourcePullRequest.value = { ...source, merged: false, closed: false };
    const candidate = candidateRecorder();
    const mergePullRequest = vi.fn(async () => ({
      kind: "contributionMerged" as const,
      headOid: facts.integrationBranch.value?.headOid,
    }));
    const github = {
      observeRepository: async () => ({
        status: "ready" as const,
        provenance: "modeled" as const,
        value: facts,
      }),
      mergePullRequest,
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: readyWorkspace,
      writeIntegrationCandidate: candidate.write,
      readFinalMainPostconditions: async () => ({ status: "pending" }),
    };

    await createReconciler({ github, git }).reconcile({
      budget: { maxEffects: 1 },
    });

    expect(mergePullRequest).toHaveBeenCalledOnce();
    expect(candidate.writes).toEqual([]);
  });
});
