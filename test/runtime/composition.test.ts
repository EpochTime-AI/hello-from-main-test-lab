import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runTrustedAction } from "../../src/entry/action-runtime.js";
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

  test("disposes authentication when repository identity setup fails", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "hello-from-main-runtime-"));
    const eventPath = join(workspace, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        ref: "refs/heads/main",
        after: "test",
        repository: { full_name: "local/verification", default_branch: "main" },
      }),
    );
    const before = await readdir(tmpdir());
    try {
      vi.stubEnv("DEFAULT_BRANCH", "main");
      vi.stubEnv("GITHUB_TOKEN", "sanitized-test-token");
      vi.stubEnv("HELLO_FROM_MAIN_WORKSPACE", workspace);
      vi.stubEnv("GITHUB_REPOSITORY", "local/verification");
      vi.stubEnv("GITHUB_EVENT_PATH", eventPath);
      vi.stubEnv("GITHUB_REF", "refs/heads/main");
      vi.stubEnv("HELLO_FROM_MAIN_TRUSTED_SOURCE_REF", "refs/heads/main");
      vi.stubEnv("GITHUB_SHA", "test");
      vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
      vi.stubEnv("HELLO_FROM_MAIN_SOURCE_PR_NUMBER", "1");
      vi.stubEnv("HELLO_FROM_MAIN_SOURCE_LOGIN", "alice");
      vi.stubEnv("HELLO_FROM_MAIN_COMMENT_OWNER_ID", "42");
      vi.stubEnv("HELLO_FROM_MAIN_COMMENT_OWNER_TYPE", "Bot");
      vi.stubEnv("GITHUB_API_URL", "https://api.github.com");
      vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("lookup failed")),
      );
      await expect(runTrustedAction()).rejects.toThrow(
        "trusted repository identity is unavailable",
      );
      const after = await readdir(tmpdir());
      expect(
        after.filter(
          (entry) =>
            entry.startsWith("hello-from-main-git-auth-") &&
            !before.includes(entry),
        ),
      ).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
