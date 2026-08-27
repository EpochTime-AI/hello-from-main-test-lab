import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  createGitRunner,
  createGitSandbox,
  RealGitWorkspace,
} from "../../src/adapters/git.js";
import { createOctokitGithubPlatform } from "../../src/adapters/octokit.js";
import { oid, type RepositoryFacts } from "../../src/core/model.js";
import { createReconciler } from "../../src/core/reconciler.js";
import {
  bindProductionSetup,
  runTrustedAction,
  serializeActionOutput,
} from "../../src/entry/action-runtime.js";
import { createCliComposition } from "../../src/entry/cli.js";
import type { GitWorkspace } from "../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../src/ports/github-platform.js";
import { renderSetupComment } from "../../src/render/comment.js";
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

  test("serializes only allowlisted action outcome fields", () => {
    const output = serializeActionOutput({
      kind: "terminal",
      reason: "capabilityUnavailable",
      setupDiagnostic: "not-a-diagnostic",
      detail: "token-like-secret-value",
      token: "token-like-secret-value",
      nested: { body: "token-like-secret-value" },
    });
    expect(output).toBe(
      '{"kind":"terminal","reason":"capabilityUnavailable"}\n',
    );
    expect(output).not.toContain("token-like-secret-value");
  });

  test("omits hostile diagnostic envelope fields and malformed setup diagnostics", () => {
    const output = serializeActionOutput({
      kind: "hello-from-main-diagnostic",
      stage: "token-like-stage-value",
      effect: "https://example.test/private",
      outcome: "quiescent",
      reason: "capabilityUnavailable",
      setupDiagnostic: "setupPermitAbsent",
    });
    expect(output).toBe(
      '{"kind":"hello-from-main-diagnostic","outcome":"quiescent","reason":"capabilityUnavailable"}\n',
    );
    expect(output).not.toContain("token-like-stage-value");
    expect(output).not.toContain("https://example.test/private");
    expect(output).not.toContain("setupPermitAbsent");
  });

  test("keeps a valid setup terminal diagnostic only in terminal capability-unavailable output", () => {
    expect(
      serializeActionOutput({
        kind: "hello-from-main-diagnostic",
        stage: "pre-composition",
        effect: "ensureComment",
        outcome: "terminal",
        reason: "capabilityUnavailable",
        setupDiagnostic: "setupPermitAbsent",
      }),
    ).toBe(
      '{"kind":"hello-from-main-diagnostic","stage":"pre-composition","effect":"ensureComment","outcome":"terminal","reason":"capabilityUnavailable","setupDiagnostic":"setupPermitAbsent"}\n',
    );
    expect(
      serializeActionOutput({
        kind: "quiescent",
        setupDiagnostic: "setupPermitAbsent",
      }),
    ).toBe('{"kind":"quiescent"}\n');
  });

  test("routes production Integration publication through Git and preserves Octokit Contribution merges", async () => {
    const contributionHead = oid("contribution-head");
    const integrationHead = oid("integration-head");
    const main = oid("main-base");
    const recordIntegrationPublication = vi.fn();
    const octokit = {
      mergePullRequest: vi.fn(async (request) =>
        request.kind === "contribution"
          ? { kind: "contributionMerged" as const, headOid: contributionHead }
          : {
              kind: "integrationRejected" as const,
              reason: "gateUnsupported" as const,
            },
      ),
      recordIntegrationPublication,
    } as unknown as GithubPlatform;
    const workspace = {
      publishIntegrationMerge: vi.fn(async () => ({
        kind: "integrationMerged" as const,
        mainOid: oid("published-main"),
      })),
    } as unknown as import("../../src/adapters/git.js").RealGitWorkspace;
    const platform = bindProductionSetup(
      octokit,
      {
        remote: "origin",
        branch: "feature/card-alice-source-1",
        sourcePullRequestNumber: 1,
        sourceLogin: "alice",
        commentOwner: { actorId: "42", actorType: "Bot" },
      },
      workspace,
    );

    await expect(
      platform.mergePullRequest({
        kind: "contribution",
        pullRequestNumber: 1,
        expectedHeadOid: contributionHead,
      }),
    ).resolves.toEqual({
      kind: "contributionMerged",
      headOid: contributionHead,
    });
    await expect(
      platform.mergePullRequest({
        kind: "integration",
        pullRequestNumber: 2,
        expectedHeadOid: integrationHead,
        observedBaseOid: main,
        baseCurrentGate: "required",
      }),
    ).resolves.toEqual({
      kind: "integrationMerged",
      mainOid: oid("published-main"),
    });
    expect(octokit.mergePullRequest).toHaveBeenCalledTimes(1);
    expect(workspace.publishIntegrationMerge).toHaveBeenCalledWith(
      {
        kind: "integration",
        pullRequestNumber: 2,
        expectedHeadOid: integrationHead,
        observedBaseOid: main,
        baseCurrentGate: "required",
      },
      undefined,
    );
    expect(recordIntegrationPublication).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "integration" }),
      expect.objectContaining({ kind: "integrationMerged" }),
    );
  });

  test("does not add setup authority when production setup is bound to a non-Octokit platform", async () => {
    const octokit = {
      createIntegrationBranch: vi.fn(),
      ensureComment: vi.fn(async () => ({
        kind: "capabilityUnavailable" as const,
      })),
    } as unknown as GithubPlatform;
    const workspace = {
      createIntegrationBranchWithProjectShell: vi.fn(async (input) => ({
        branch: {
          name: "feature/card-alice-source-1",
          headOid: oid("shell-commit"),
          provenance: "observed" as const,
        },
        establishedByCurrentOperation: true as const,
        ...(input.setupOperationNonce
          ? { setupOperationNonce: input.setupOperationNonce }
          : {}),
      })),
    } as unknown as import("../../src/adapters/git.js").RealGitWorkspace;
    const platform = bindProductionSetup(
      octokit,
      {
        remote: "origin",
        branch: "feature/card-alice-source-1",
        sourcePullRequestNumber: 1,
        sourceLogin: "alice",
        commentOwner: { actorId: "42", actorType: "Bot" },
      },
      workspace,
    );
    expect(
      (platform as Record<string, unknown>).recordSetupProjectShell,
    ).toBeUndefined();
    await expect(
      platform.ensureComment({
        targetPullRequestNumber: 1,
        slot: "source-status",
        actionKey: "run=source:1:42;target=1;slot=source-status",
        phase: "setup",
        body: "safe test body",
      }),
    ).resolves.toMatchObject({
      kind: "capabilityUnavailable",
      setupDiagnostic: "setupAuthorityBridgeMissing",
    });
  });

  test("creates the live-shaped setup comment through the raw production setup bridge", async () => {
    const sandbox = await createGitSandbox();
    const bare = join(sandbox.root, "upstream.git");
    const checkout = join(sandbox.root, "checkout");
    const branch = "feature/card-c-w-xiaohei-source-5";
    try {
      await sandbox.runner.run(["init", "--bare", bare], { cwd: sandbox.root });
      await sandbox.runner.run(["clone", bare, checkout], {
        cwd: sandbox.root,
      });
      const runner = createGitRunner({ root: sandbox.root });
      await runner.run(["config", "user.name", "Test Bot"], { cwd: checkout });
      await runner.run(["config", "user.email", "bot@example.test"], {
        cwd: checkout,
      });
      await runner.run(["switch", "-c", "main"], { cwd: checkout });
      await writeFile(join(checkout, "README.md"), "# Hello from Main\n");
      await runner.run(["add", "README.md"], { cwd: checkout });
      await runner.run(["commit", "-m", "Initial main"], { cwd: checkout });
      await runner.run(["push", "origin", "main"], { cwd: checkout });
      const main = oid(
        (
          await runner.run(["rev-parse", "origin/main"], { cwd: checkout })
        ).stdout.trim(),
      );
      const source = {
        number: 5,
        kind: "contribution" as const,
        headOid: oid("ab035077c853768b8d54b855c79f3bb15fed71f8"),
        baseOid: main,
        baseRef: "main",
        headRef: "add/c-w-xiaohei",
        draft: false,
        authorLogin: "c-w-xiaohei",
        authorGithubId: "88074703",
        headRepositoryOwnerLogin: "c-w-xiaohei",
        headRepositoryIsFork: true,
        observedOid: oid("ab035077c853768b8d54b855c79f3bb15fed71f8"),
        provenance: "provider" as const,
      };
      const facts = {
        main: {
          status: "ready" as const,
          value: { oid: main, cardManifests: [] },
        },
        sourcePullRequest: { status: "ready" as const, value: source },
        integrationBranch: { status: "absent" as const },
        integrationPullRequest: { status: "absent" as const },
        candidate: { status: "absent" as const },
        eligibility: {
          checks: { status: "pending" as const },
          reviews: { status: "pending" as const },
          mergeability: { status: "pending" as const },
          baseCurrent: { status: "pending" as const },
        },
        confirmations: [],
        trustedCommentOwner: { actorId: "41898282", actorType: "Bot" as const },
      };
      let posts = 0;
      let comment: Record<string, unknown> | undefined;
      const raw = createOctokitGithubPlatform({
        owner: "EpochTime-AI",
        repo: "hello-from-main-test-lab",
        replay: true,
        initialFacts: facts,
        expectedCommentOwner: { actorId: "41898282", actorType: "Bot" },
        transport: {
          rest: async (request) => {
            if (request.method === "POST" && request.path.endsWith("/pulls"))
              return {
                status: 201,
                data: {
                  number: 6,
                  draft: true,
                  head: { sha: "shell", ref: branch },
                  base: { sha: main, ref: "main" },
                },
              };
            if (request.method === "PATCH" && request.path.endsWith("/pulls/5"))
              return {
                status: 200,
                data: {
                  number: 5,
                  draft: false,
                  user: { login: "c-w-xiaohei", id: 88074703 },
                  head: {
                    sha: source.headOid,
                    ref: "add/c-w-xiaohei",
                    repo: { owner: { login: "c-w-xiaohei" }, fork: true },
                  },
                  base: { sha: "shell", ref: branch },
                },
              };
            if (request.method === "GET")
              return request.path.endsWith("/issues/comments/1")
                ? { status: 200, data: comment }
                : { status: 200, data: comment ? [comment] : [] };
            if (
              request.method === "POST" &&
              request.path.endsWith("/issues/5/comments")
            ) {
              posts += 1;
              comment = {
                id: 1,
                body: request.parameters?.body,
                user: { id: 41898282, type: "Bot" },
                issue_url:
                  "https://api.github.com/repos/EpochTime-AI/hello-from-main-test-lab/issues/5",
              };
              return { status: 201, data: comment };
            }
            throw new Error(`unexpected ${request.method} ${request.path}`);
          },
          graphql: async () => ({ data: {} }),
        },
      });
      const github = bindProductionSetup(
        raw,
        {
          remote: "origin",
          branch,
          sourcePullRequestNumber: 5,
          sourceLogin: "c-w-xiaohei",
          commentOwner: { actorId: "41898282", actorType: "Bot" },
        },
        new RealGitWorkspace(runner, checkout, "origin", branch),
      );
      const shell = await github.createIntegrationBranch({
        name: branch,
        fromMainOid: main,
        cardPath: "people/c-w-xiaohei.md",
        cardBytes: new TextEncoder().encode(
          "---\ngithub: c-w-xiaohei\ngithub_id: 88074703\nsource_pr: 5\n---\n",
        ),
      });
      expect(shell).toMatchObject({
        kind: "succeeded",
        value: { setupEstablishedByCurrentOperation: true },
      });
      await github.createIntegrationPullRequest({
        branchName: branch,
        title: "Integration Card",
      });
      const retarget = await github.updatePullRequestBase({
        pullRequestNumber: 5,
        integrationBranchName: branch,
      });
      expect(retarget).toMatchObject({
        kind: "succeeded",
        value: { baseOid: "shell", baseRef: branch },
      });
      const hydrated = await raw.observeRepository();
      expect(hydrated.value?.sourcePullRequest.value).toMatchObject({
        baseOid: main,
        baseRef: "main",
        authorGithubId: "88074703",
      });
      const rendered = renderSetupComment({
        runIdentity: "source:5:88074703",
        sourcePullRequestNumber: 5,
        integrationBranchName: branch,
        integrationPullRequestNumber: 6,
        rebaseCommand: `git rebase upstream/${branch}`,
      });
      expect(rendered.actionKey).toBe(
        "run=source:5:88074703;target=5;slot=source-status",
      );
      const setupIntent = { ...rendered, targetPullRequestNumber: 5 };
      await expect(
        github.ensureComment({ ...setupIntent, actionKey: "not-a-key" }),
      ).resolves.toMatchObject({
        kind: "capabilityUnavailable",
        setupDiagnostic: "setupPermitActionKeyInvalid",
      });
      await expect(
        github.ensureComment({
          ...setupIntent,
          actionKey: "run=source:5:other;target=5;slot=source-status",
        }),
      ).resolves.toMatchObject({
        kind: "capabilityUnavailable",
        setupDiagnostic: "setupPermitRunIdentityMismatch",
      });
      await expect(
        github.ensureComment({
          ...setupIntent,
          targetPullRequestNumber: 6,
          actionKey: "run=source:5:88074703;target=6;slot=source-status",
        }),
      ).resolves.toMatchObject({
        kind: "capabilityUnavailable",
        setupDiagnostic: "setupPermitTargetMismatch",
      });
      await expect(
        github.ensureComment({
          ...setupIntent,
          slot: "integration-status",
          actionKey: "run=source:5:88074703;target=5;slot=integration-status",
        }),
      ).resolves.toMatchObject({
        kind: "capabilityUnavailable",
        setupDiagnostic: "setupPermitSlotMismatch",
      });
      await expect(
        github.ensureComment({ ...setupIntent, phase: "ready-guidance" }),
      ).resolves.toEqual({ kind: "capabilityUnavailable" });
      await expect(
        github.ensureComment({ ...rendered, targetPullRequestNumber: 5 }),
      ).resolves.toMatchObject({
        kind: "created",
      });
      expect(posts).toBe(1);
      await expect(github.ensureComment(setupIntent)).resolves.toMatchObject({
        kind: "noOp",
      });

      const rejectedBranch = "feature/card-c-w-xiaohei-source-6";
      const rejected = bindProductionSetup(
        raw,
        {
          remote: "origin",
          branch: rejectedBranch,
          sourcePullRequestNumber: 5,
          sourceLogin: "wrong-login",
          commentOwner: { actorId: "41898282", actorType: "Bot" },
        },
        new RealGitWorkspace(runner, checkout, "origin", rejectedBranch),
      );
      await expect(
        rejected.createIntegrationBranch({
          name: rejectedBranch,
          fromMainOid: main,
          cardPath: "people/c-w-xiaohei.md",
          cardBytes: new TextEncoder().encode(
            "---\ngithub: c-w-xiaohei\ngithub_id: 88074703\nsource_pr: 5\n---\n",
          ),
        }),
      ).resolves.toMatchObject({
        kind: "alreadyApplied",
        value: { branch: { name: rejectedBranch } },
      });
    } finally {
      await sandbox.dispose();
    }
  });

  test("reconciles the live-shaped setup through four production effects", async () => {
    const sandbox = await createGitSandbox();
    const bare = join(sandbox.root, "upstream.git");
    const checkout = join(sandbox.root, "checkout");
    const branch = "feature/card-c-w-xiaohei-source-5";
    try {
      await sandbox.runner.run(["init", "--bare", bare], { cwd: sandbox.root });
      await sandbox.runner.run(["clone", bare, checkout], {
        cwd: sandbox.root,
      });
      const runner = createGitRunner({ root: sandbox.root });
      await runner.run(["config", "user.name", "Test Bot"], { cwd: checkout });
      await runner.run(["config", "user.email", "bot@example.test"], {
        cwd: checkout,
      });
      await runner.run(["switch", "-c", "main"], { cwd: checkout });
      await writeFile(join(checkout, "README.md"), "# Hello from Main\n");
      await runner.run(["add", "README.md"], { cwd: checkout });
      await runner.run(["commit", "-m", "Initial main"], { cwd: checkout });
      await runner.run(["push", "origin", "main"], { cwd: checkout });
      const main = oid(
        (
          await runner.run(["rev-parse", "origin/main"], { cwd: checkout })
        ).stdout.trim(),
      );
      const cardBytes = new TextEncoder().encode(
        "---\ngithub: c-w-xiaohei\ngithub_id: 88074703\navatar: https://avatars.githubusercontent.com/u/88074703?v=4\nsource_pr: 5\n---\n\n# c-w-xiaohei\n\n最近在折腾：Git metadata\n\n> Project source metadata\n",
      );
      let integrationCreated = false;
      let retargeted = false;
      let posts = 0;
      let comment: Record<string, unknown> | undefined;
      const source = (integrationHead?: string) => ({
        number: 5,
        kind: "contribution" as const,
        headOid: oid("ab035077c853768b8d54b855c79f3bb15fed71f8"),
        baseOid: retargeted && integrationHead ? oid(integrationHead) : main,
        baseRef: retargeted ? branch : "main",
        headRef: "add/c-w-xiaohei",
        draft: false,
        authorLogin: "c-w-xiaohei",
        authorGithubId: "88074703",
        headRepositoryOwnerLogin: "c-w-xiaohei",
        headRepositoryIsFork: true,
        changedFiles: [
          {
            path: "people/c-w-xiaohei.md",
            blobOid: oid("source-card"),
            bytes: cardBytes,
          },
        ],
        changedFilesComplete: true,
        observedOid: oid("ab035077c853768b8d54b855c79f3bb15fed71f8"),
        provenance: "provider" as const,
      });
      const facts = async (): Promise<RepositoryFacts> => {
        const integrationHead = await runner
          .run(["rev-parse", `origin/${branch}`], { cwd: checkout })
          .then((result) => result.stdout.trim())
          .catch(() => undefined);
        return {
          main: { status: "ready", value: { oid: main, cardManifests: [] } },
          sourcePullRequest: {
            status: "ready",
            value: source(integrationHead),
          },
          integrationBranch: integrationHead
            ? {
                status: "ready",
                value: {
                  name: branch,
                  headOid: oid(integrationHead),
                  provenance: "provider",
                },
              }
            : { status: "absent" },
          integrationPullRequest:
            integrationCreated && integrationHead
              ? {
                  status: "ready",
                  value: {
                    number: 6,
                    kind: "integration",
                    headOid: oid(integrationHead),
                    baseOid: main,
                    draft: true,
                    observedOid: oid(integrationHead),
                    provenance: "provider",
                  },
                }
              : { status: "absent" },
          candidate: { status: "absent" },
          ...(retargeted
            ? {
                sourceHeadBasedOnIntegration: { status: "incomplete" as const },
              }
            : {}),
          eligibility: {
            checks: { status: "pending" },
            reviews: { status: "pending" },
            mergeability: { status: "pending" },
            baseCurrent: { status: "pending" },
          },
          confirmations: [],
          comments: [],
          trustedCommentOwner: { actorId: "41898282", actorType: "Bot" },
        };
      };
      const raw = createOctokitGithubPlatform({
        owner: "EpochTime-AI",
        repo: "hello-from-main-test-lab",
        replay: true,
        initialFacts: await facts(),
        expectedCommentOwner: { actorId: "41898282", actorType: "Bot" },
        transport: {
          rest: async (request) => {
            if (request.method === "POST" && request.path.endsWith("/pulls")) {
              integrationCreated = true;
              return {
                status: 201,
                data: {
                  number: 6,
                  draft: true,
                  head: { sha: "ignored", ref: branch },
                  base: { sha: main, ref: "main" },
                },
              };
            }
            if (
              request.method === "PATCH" &&
              request.path.endsWith("/pulls/5")
            ) {
              retargeted = true;
              return {
                status: 200,
                data: {
                  number: 5,
                  draft: false,
                  head: { sha: "ignored" },
                  base: { sha: "ignored", ref: branch },
                },
              };
            }
            if (request.method === "GET")
              return request.path.endsWith("/issues/comments/1")
                ? { status: 200, data: comment }
                : { status: 200, data: comment ? [comment] : [] };
            if (
              request.method === "POST" &&
              request.path.endsWith("/issues/5/comments")
            ) {
              posts += 1;
              comment = {
                id: 1,
                body: request.parameters?.body,
                user: { id: 41898282, type: "Bot" },
                issue_url:
                  "https://api.github.com/repos/EpochTime-AI/hello-from-main-test-lab/issues/5",
              };
              return { status: 201, data: comment };
            }
            throw new Error(`unexpected ${request.method} ${request.path}`);
          },
          graphql: async () => ({ data: {} }),
        },
      });
      const bound = bindProductionSetup(
        raw,
        {
          remote: "origin",
          branch,
          sourcePullRequestNumber: 5,
          sourceLogin: "c-w-xiaohei",
          commentOwner: { actorId: "41898282", actorType: "Bot" },
        },
        new RealGitWorkspace(runner, checkout, "origin", branch),
      );
      const effects: string[] = [];
      const commentIntents: Array<Parameters<typeof bound.ensureComment>[0]> =
        [];
      const github = {
        ...bound,
        observeRepository: async () => ({
          status: "ready" as const,
          value: await facts(),
        }),
        createIntegrationBranch: async (
          ...args: Parameters<typeof bound.createIntegrationBranch>
        ) => {
          effects.push("createBranch");
          return bound.createIntegrationBranch(...args);
        },
        createIntegrationPullRequest: async (
          ...args: Parameters<typeof bound.createIntegrationPullRequest>
        ) => {
          effects.push("createIntegrationPr");
          return bound.createIntegrationPullRequest(...args);
        },
        updatePullRequestBase: async (
          ...args: Parameters<typeof bound.updatePullRequestBase>
        ) => {
          effects.push("retarget");
          return bound.updatePullRequestBase(...args);
        },
        ensureComment: async (
          ...args: Parameters<typeof bound.ensureComment>
        ) => {
          effects.push("ensureComment");
          commentIntents.push(args[0]);
          return bound.ensureComment(...args);
        },
      };
      const diagnostics: unknown[] = [];
      const outcome = await createReconciler({
        github,
        git: new RealGitWorkspace(runner, checkout, "origin", branch),
        candidatePolicy: testCandidatePolicy,
      }).reconcile({
        budget: { maxEffects: 5 },
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(effects).toEqual([
        "createBranch",
        "createIntegrationPr",
        "retarget",
        "ensureComment",
      ]);
      expect(posts).toBe(1);
      expect(commentIntents).toEqual([
        expect.objectContaining({
          targetPullRequestNumber: 5,
          slot: "source-status",
          phase: "setup",
          actionKey: "run=source:5:88074703;target=5;slot=source-status",
        }),
      ]);
      expect(outcome).toEqual({
        kind: "awaitingExternalFact",
        reason: "incomplete",
      });
      expect(diagnostics).toEqual([{ turn: 5, outcome }]);
      expect(String(comment?.body)).toContain(
        "run%3Dsource%3A5%3A88074703%3Btarget%3D5%3Bslot%3Dsource-status",
      );
    } finally {
      await sandbox.dispose();
    }
  });

  test("does not leak a rejected setup grant diagnostic to a later permit absence", async () => {
    const facts: RepositoryFacts = {
      main: { status: "absent" },
      sourcePullRequest: {
        status: "ready",
        value: {
          number: 5,
          kind: "contribution",
          headOid: oid("source"),
          baseOid: oid("main"),
          draft: false,
          authorLogin: "c-w-xiaohei",
          authorGithubId: "88074703",
          observedOid: oid("source"),
          provenance: "provider",
        },
      },
      integrationBranch: { status: "absent" },
      integrationPullRequest: { status: "absent" },
      candidate: { status: "absent" },
      eligibility: {
        checks: { status: "pending" },
        reviews: { status: "pending" },
        mergeability: { status: "pending" },
        baseCurrent: { status: "pending" },
      },
      confirmations: [],
    };
    const raw = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      initialFacts: facts,
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async (request) => {
          if (request.method === "GET") return { status: 200, data: [] };
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const github = bindProductionSetup(
      raw,
      {
        remote: "origin",
        branch: "feature/card-c-w-xiaohei-source-5",
        sourcePullRequestNumber: 5,
        sourceLogin: "c-w-xiaohei",
        commentOwner: { actorId: "42", actorType: "Bot" },
      },
      {
        createIntegrationBranchWithProjectShell: async () => ({
          branch: {
            name: "feature/card-c-w-xiaohei-source-5",
            headOid: oid("shell"),
            provenance: "observed" as const,
          },
          establishedByCurrentOperation: true as const,
        }),
      } as unknown as RealGitWorkspace,
    );
    const rejectedSetup = await github.createIntegrationBranch({
      name: "feature/card-c-w-xiaohei-source-5",
      fromMainOid: oid("main"),
      cardPath: "people/c-w-xiaohei.md",
      cardBytes: new TextEncoder().encode("shell"),
    });
    expect(rejectedSetup).toMatchObject({ kind: "alreadyApplied" });
    const intent = {
      targetPullRequestNumber: 5,
      slot: "source-status" as const,
      actionKey: "run=source:5:88074703;target=5;slot=source-status",
      phase: "setup" as const,
      body: "safe test body",
    };
    await expect(github.ensureComment(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
      setupDiagnostic: "setupGrantNonceMismatch",
    });
    await expect(github.ensureComment(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
      setupDiagnostic: "setupPermitAbsent",
    });
    await expect(
      github.ensureComment({ ...intent, phase: "ready-guidance" }),
    ).resolves.toEqual({ kind: "capabilityUnavailable" });
    await github.createIntegrationBranch({
      name: "feature/card-c-w-xiaohei-source-5",
      fromMainOid: oid("main"),
      cardPath: "people/c-w-xiaohei.md",
      cardBytes: new TextEncoder().encode("shell"),
    });
    await expect(
      github.ensureComment({
        ...intent,
        actionKey: "run=source:6:88074703;target=6;slot=source-status",
        targetPullRequestNumber: 6,
      }),
    ).resolves.toMatchObject({
      kind: "capabilityUnavailable",
      setupDiagnostic: "setupPermitAbsent",
    });
    await expect(github.ensureComment(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
      setupDiagnostic: "setupPermitAbsent",
    });
  });

  test("clears a pending setup diagnostic when setup creation throws", async () => {
    const raw = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      initialFacts: {
        main: { status: "absent" },
        sourcePullRequest: {
          status: "ready",
          value: {
            number: 5,
            kind: "contribution",
            headOid: oid("source"),
            baseOid: oid("main"),
            draft: false,
            authorLogin: "c-w-xiaohei",
            authorGithubId: "88074703",
            observedOid: oid("source"),
            provenance: "provider",
          },
        },
        integrationBranch: { status: "absent" },
        integrationPullRequest: { status: "absent" },
        candidate: { status: "absent" },
        eligibility: {
          checks: { status: "pending" },
          reviews: { status: "pending" },
          mergeability: { status: "pending" },
          baseCurrent: { status: "pending" },
        },
        confirmations: [],
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async () => ({ status: 200, data: [] }),
        graphql: async () => ({ data: {} }),
      },
    });
    const github = bindProductionSetup(
      raw,
      {
        remote: "origin",
        branch: "feature/card-c-w-xiaohei-source-5",
        sourcePullRequestNumber: 5,
        sourceLogin: "c-w-xiaohei",
        commentOwner: { actorId: "42", actorType: "Bot" },
      },
      {
        createIntegrationBranchWithProjectShell: async () => {
          throw new Error("private failure");
        },
      } as unknown as RealGitWorkspace,
    );
    await expect(
      github.createIntegrationBranch({
        name: "feature/card-c-w-xiaohei-source-5",
        fromMainOid: oid("main"),
        cardPath: "people/c-w-xiaohei.md",
        cardBytes: new TextEncoder().encode("shell"),
      }),
    ).resolves.toMatchObject({ kind: "retryableTransport" });
    await expect(
      github.ensureComment({
        targetPullRequestNumber: 5,
        slot: "source-status",
        actionKey: "run=source:5:88074703;target=5;slot=source-status",
        phase: "setup",
        body: "safe test body",
      }),
    ).resolves.toMatchObject({
      kind: "capabilityUnavailable",
      setupDiagnostic: "setupPermitAbsent",
    });
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
