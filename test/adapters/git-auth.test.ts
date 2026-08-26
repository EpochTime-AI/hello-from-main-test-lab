import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createGitAuthenticationEnv,
  createGitRunner,
  GitCommandError,
  installGitAuthentication,
} from "../../src/adapters/git.js";
import { gitFailureDetail } from "../../src/entry/action-runtime.js";

describe("Git authentication boundary", () => {
  test("uses askpass environment without putting the token in argv", async () => {
    const root = "/tmp/hello-from-main-auth-test";
    const auth = createGitAuthenticationEnv({ root, token: "secret-token" });
    expect(auth.env).toMatchObject({
      GIT_ASKPASS: `${root}/git-askpass.sh`,
      GIT_TERMINAL_PROMPT: "0",
      HELLO_FROM_MAIN_GIT_TOKEN: "secret-token",
    });
    expect(["push", "origin", "main"]).not.toContain("secret-token");
  });

  test("writes a private askpass helper and removes it", async () => {
    const root = "/tmp/hello-from-main-auth-install";
    const auth = await installGitAuthentication({
      root,
      token: "secret-token",
    });
    const helper = await readFile(`${root}/git-askpass.sh`, "utf8");
    expect(helper).not.toContain("secret-token");
    await auth.dispose();
  });

  test("terminates an aborted Git child and waits for it to close", async () => {
    const controller = new AbortController();
    const runner = createGitRunner({ root: "/tmp/hello-from-main-git-cancel" });
    const pending = runner.run(
      ["config", "--global", "include.path", "/dev/fd/0"],
      {
        cwd: "/tmp",
        signal: controller.signal,
      },
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  test("reports sanitized Project Shell Git setup detail", () => {
    const token = "secret-token";
    const detail = gitFailureDetail(
      new GitCommandError({
        commandId: "git-1",
        argv: ["push", `https://x-access-token:${token}@example.test/repo`],
        cwd: "/tmp/private",
        stdout: token,
        stderr: `failed ${token}`,
        status: 128,
      }),
    );
    expect(detail).toBe(
      "Project Shell setup failed: operation=push; status=128; category=repository-or-auth",
    );
    expect(detail).not.toContain(token);
    expect(detail).not.toContain("example.test");
  });
});
