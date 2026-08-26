import {
  access,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    const parent = await mkdtemp(join(tmpdir(), "hello-from-main-auth-test-"));
    const sibling = join(parent, "keep.txt");
    const helperPath = join(parent, "git-askpass.sh");
    await writeFile(sibling, "keep");
    await writeFile(helperPath, "helper");
    const auth = createGitAuthenticationEnv({
      helperPath,
      token: "secret-token",
    });
    expect(auth.env).toMatchObject({
      GIT_ASKPASS: helperPath,
      GIT_TERMINAL_PROMPT: "0",
      HELLO_FROM_MAIN_GIT_TOKEN: "secret-token",
    });
    expect(["push", "origin", "main"]).not.toContain("secret-token");
    await auth.dispose();
    await auth.dispose();
    await expect(access(sibling)).resolves.toBeUndefined();
    await expect(access(helperPath)).resolves.toBeUndefined();
    await expect(access(parent)).resolves.toBeUndefined();
    await rm(parent, { recursive: true, force: true });
  });

  test("writes a private askpass helper outside the requested workspace and removes it", async () => {
    const root = "/tmp/hello-from-main-auth-install";
    const auth = await installGitAuthentication({
      root,
      token: "secret-token",
    });
    const helperPath = auth.env.GIT_ASKPASS;
    if (!helperPath) throw new Error("askpass path is required");
    const helper = await readFile(helperPath, "utf8");
    expect(helper).not.toContain("secret-token");
    expect(helperPath.startsWith(`${tmpdir()}/hello-from-main-git-auth-`)).toBe(
      true,
    );
    expect(await stat(dirname(helperPath))).toMatchObject({
      mode: expect.any(Number),
    });
    expect((await stat(dirname(helperPath))).mode & 0o777).toBe(0o700);
    await expect(access(join(root, "git-askpass.sh"))).rejects.toBeDefined();
    await auth.dispose();
    await expect(access(helperPath)).rejects.toBeDefined();
    await auth.dispose();
  });

  test("removes its temporary directory when installation fails", async () => {
    const before = await readdir(tmpdir());
    await expect(installGitAuthentication({ token: "" })).rejects.toThrow(
      "Git authentication token is required",
    );
    const after = await readdir(tmpdir());
    expect(
      after.filter(
        (entry) =>
          entry.startsWith("hello-from-main-git-auth-") &&
          !before.includes(entry),
      ),
    ).toEqual([]);
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
