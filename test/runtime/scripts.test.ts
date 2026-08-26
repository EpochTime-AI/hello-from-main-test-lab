import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";

const runWorkflowCheck = promisify(execFile);
const repository = new URL("../..", import.meta.url);

async function checkWorkflows(...args: string[]) {
  return runWorkflowCheck("node", ["tools/check-workflows.mjs", ...args], {
    cwd: repository,
  });
}

describe("verification scripts", () => {
  test("exposes local, adapter, build, dist, and pre-canary gates", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };
    for (const name of [
      "verify:local",
      "verify:adapters",
      "build",
      "check:dist",
      "verify:pre-canary",
    ]) {
      expect(packageJson.scripts?.[name]).toEqual(expect.any(String));
    }
  });

  test("built trusted Action artifact invokes the production Core entry", async () => {
    const run = promisify(execFile);
    await run("node", ["tools/build.mjs"], {
      cwd: new URL("../..", import.meta.url),
    });
    const result = await run("node", ["tools/dist/index.js"], {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        GITHUB_REF: "refs/heads/main",
        DEFAULT_BRANCH: "main",
        HELLO_FROM_MAIN_TRUSTED_SOURCE_REF: "refs/heads/main",
        HELLO_FROM_MAIN_TEST_MODE: "1",
        NODE_ENV: "production",
      },
    });
    expect(result.stdout).toContain('"kind":"retryable"');
  });

  test("trusted controller workflows invoke the checked-out built Action", async () => {
    for (const file of ["controller.yml", "watchdog.yml"]) {
      const workflow = await readFile(
        new URL(`../../.github/workflows/${file}`, import.meta.url),
        "utf8",
      );
      expect(workflow).toContain(
        "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      );
      expect(workflow).toContain("uses: ./");
      expect(workflow).toContain("HELLO_FROM_MAIN_COMMENT_OWNER_ID");
      expect(workflow).toContain("HELLO_FROM_MAIN_COMMENT_OWNER_TYPE");
      expect(workflow).toContain("vars.HELLO_FROM_MAIN_COMMENT_OWNER_ID");
      expect(workflow).toContain("vars.HELLO_FROM_MAIN_COMMENT_OWNER_TYPE");
    }
  });

  test("controller uses only the trusted target-event checkout boundary", async () => {
    const workflow = await readFile(
      new URL("../../.github/workflows/controller.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toContain("pull_request:\n");
    expect(workflow).toContain("ref: refs/heads/main");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).not.toContain("github.event.pull_request.head");
  });

  test("rejects malformed workflow indentation", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "hello-from-main-workflow-"),
    );
    try {
      const workflow = await readFile(
        new URL("../../.github/workflows/controller.yml", import.meta.url),
        "utf8",
      );
      await writeFile(
        join(directory, "controller.yml"),
        workflow.replace(
          "          HELLO_FROM_MAIN_SOURCE_PR_NUMBER",
          "         HELLO_FROM_MAIN_SOURCE_PR_NUMBER",
        ),
      );

      await expect(
        checkWorkflows(
          "--workflows-dir",
          directory,
          "--action",
          new URL("../../action.yml", import.meta.url).pathname,
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/YAML|indent/i),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects unsupported action metadata keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hello-from-main-action-"));
    const action = join(directory, "action.yml");
    try {
      const metadata = await readFile(
        new URL("../../action.yml", import.meta.url),
        "utf8",
      );
      await writeFile(action, `${metadata}\npermissions:\n  contents: write\n`);

      await expect(
        checkWorkflows(
          "--workflows-dir",
          new URL("../../.github/workflows", import.meta.url).pathname,
          "--action",
          action,
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringMatching(/unsupported.*permissions|metadata/i),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("validates the checked-in workflows and Action metadata", async () => {
    await expect(checkWorkflows()).resolves.toBeDefined();
  });
});
