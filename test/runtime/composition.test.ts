import { describe, expect, test, vi } from "vitest";
import { createCliComposition } from "../../src/entry/cli.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import { testCandidatePolicy } from "../fixtures/stability.js";

describe("runtime composition", () => {
  test("uses the single reconciler composition path", async () => {
    const github = {} as GithubPlatform;
    const git = {} as GitWorkspace;
    const composition = createCliComposition({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    });
    const result = await composition.run({ maxEffects: 0 });
    expect(result.kind).toBe("budgetExhausted");
    expect(vi.isMockFunction(composition.run)).toBe(false);
  });

  test("fails closed when the candidate policy is absent", () => {
    expect(() =>
      createCliComposition({
        github: {} as GithubPlatform,
        git: {} as GitWorkspace,
      }),
    ).toThrow("candidate policy is required");
  });
});
