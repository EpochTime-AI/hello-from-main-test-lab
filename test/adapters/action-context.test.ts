import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createTrustedActionContext } from "../../src/adapters/action-context.js";

describe("trusted Action context", () => {
  test("rejects malformed and default-branch-mismatched event files", async () => {
    const root = join(tmpdir(), `hello-action-${Date.now()}`);
    await mkdir(root, { recursive: true });
    const eventPath = join(root, "event.json");
    await writeFile(eventPath, JSON.stringify({ ref: "refs/heads/feature" }));

    await expect(
      createTrustedActionContext({
        env: {
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_REPOSITORY: "acme/hello",
          GITHUB_REF: "refs/heads/feature",
          HELLO_FROM_MAIN_TRUSTED_SOURCE_REF: "refs/heads/feature",
          GITHUB_SHA: "sha-1",
        },
        defaultBranch: "main",
      }),
    ).rejects.toThrow("trusted default branch");
  });

  test("accepts a target PR event checked out from trusted main and preserves only passive source facts", async () => {
    const root = join(tmpdir(), `hello-action-${Date.now()}-pr`);
    await mkdir(root, { recursive: true });
    const eventPath = join(root, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        action: "opened",
        ref: "refs/pull/12/merge",
        repository: { full_name: "acme/hello", default_branch: "main" },
        pull_request: {
          number: 12,
          user: { login: "alice" },
          head: { ref: "add/alice", repo: { full_name: "alice/hello" } },
          base: { ref: "main", repo: { full_name: "acme/hello" } },
        },
      }),
    );

    await expect(
      createTrustedActionContext({
        env: {
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "pull_request_target",
          GITHUB_REPOSITORY: "acme/hello",
          GITHUB_REF: "refs/heads/main",
          HELLO_FROM_MAIN_TRUSTED_SOURCE_REF: "refs/heads/main",
          GITHUB_SHA: "trusted-main-sha",
        },
        defaultBranch: "main",
      }),
    ).resolves.toMatchObject({
      ref: "refs/heads/main",
      sourcePullRequest: {
        number: 12,
        authorLogin: "alice",
        headRef: "add/alice",
        baseRef: "main",
      },
    });
  });

  test("rejects a PR event whose base is not the trusted repository", async () => {
    const root = join(tmpdir(), `hello-action-${Date.now()}-bad-base`);
    await mkdir(root, { recursive: true });
    const eventPath = join(root, "event.json");
    await writeFile(
      eventPath,
      JSON.stringify({
        repository: { full_name: "acme/hello", default_branch: "main" },
        pull_request: {
          number: 12,
          head: { ref: "add/alice", repo: { full_name: "alice/hello" } },
          base: { ref: "main", repo: { full_name: "evil/hello" } },
        },
      }),
    );

    await expect(
      createTrustedActionContext({
        env: {
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "pull_request_target",
          GITHUB_REPOSITORY: "acme/hello",
          GITHUB_REF: "refs/heads/main",
          HELLO_FROM_MAIN_TRUSTED_SOURCE_REF: "refs/heads/main",
          GITHUB_SHA: "trusted-main-sha",
        },
        defaultBranch: "main",
      }),
    ).rejects.toThrow("base repository");
  });
});
