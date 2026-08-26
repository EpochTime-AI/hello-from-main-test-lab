import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  createOctokitGithubPlatform,
  type OctokitRequestTransport,
} from "../../src/adapters/octokit.js";
import {
  type CommentIntent,
  oid,
  type RepositoryFacts,
} from "../../src/core/model.js";
import { createGithubTransport } from "../../src/entry/action-runtime.js";
import {
  renderReadyComment,
  renderSetupComment,
  renderValidationComment,
} from "../../src/render/comment.js";

describe("OctokitGithubPlatform", () => {
  test("has no emulator dependency or adapter fallback", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const adapter = await readFile(
      new URL("../../src/adapters/octokit.ts", import.meta.url),
      "utf8",
    );
    expect(JSON.stringify(packageJson.dependencies ?? {})).not.toMatch(
      /emulat/iu,
    );
    expect(JSON.stringify(packageJson.devDependencies ?? {})).not.toMatch(
      /emulat/iu,
    );
    expect(adapter).not.toMatch(/emulat/iu);
  });

  test("creates an issue comment only after this instance establishes its setup milestone", async () => {
    const requests: unknown[] = [];
    const body =
      "<!-- hello-from-main: key=run%3Dsource-7%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const comment = {
      id: 123,
      body,
      user: { id: 42, login: "hello-bot", type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
      updated_at: "2026-08-26T00:00:00Z",
    };
    const transport: OctokitRequestTransport = {
      rest: async (request) => {
        requests.push(request);
        if (
          request.method === "GET" &&
          request.path.endsWith("/issues/7/comments")
        )
          return { status: 200, data: [] };
        if (
          request.method === "POST" &&
          request.path.endsWith("/issues/7/comments")
        )
          return { status: 201, data: comment };
        if (
          request.method === "GET" &&
          request.path.endsWith("/issues/comments/123")
        )
          return { status: 200, data: comment };
        if (request.method === "PATCH" && request.path.endsWith("/pulls/7"))
          return {
            status: 200,
            data: {
              number: 7,
              draft: false,
              head: { sha: "source-head" },
              base: { sha: "base-head", ref: "feature/card-alice-source-7" },
            },
          };
        throw new Error(`unexpected ${request.method} ${request.path}`);
      },
      graphql: async () => ({ data: {} }),
    };
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport,
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });

    const intent: CommentIntent = {
      targetPullRequestNumber: 7,
      slot: "source-status",
      actionKey: "run=source-7;target=7;slot=source-status",
      phase: "setup",
      body,
    };
    await platform.updatePullRequestBase({
      pullRequestNumber: 7,
      integrationBranchName: "feature/card-alice-source-7",
    });
    expect(platform.ensureComment).toBeDefined();
    if (!platform.ensureComment)
      throw new Error("comment capability is required");
    await expect(platform.ensureComment(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(requests).toEqual([
      expect.objectContaining({
        method: "PATCH",
        path: "/repos/acme/hello/pulls/7",
      }),
      expect.objectContaining({
        method: "GET",
        path: "/repos/acme/hello/issues/7/comments",
        parameters: { per_page: 100, page: 1 },
        headers: { "cache-control": "no-cache" },
      }),
    ]);
  });

  test("fails closed across instances after a zero-match setup comment list", async () => {
    const actionKey = "run=source:7:42;target=7;slot=source-status";
    const intent: CommentIntent = {
      targetPullRequestNumber: 7,
      slot: "source-status",
      actionKey,
      phase: "setup",
      body: `<!-- hello-from-main: key=${encodeURIComponent(actionKey)} phase=setup -->\nbody\n`,
    };
    let posts = 0;
    const transport: OctokitRequestTransport = {
      rest: async (request) => {
        if (request.method === "GET")
          return request.path.endsWith("/issues/comments/123")
            ? { status: 200, data: commentTestRecord(intent.body) }
            : { status: 200, data: [] };
        if (request.method === "PATCH")
          return {
            status: 200,
            data: {
              number: 7,
              draft: false,
              head: { sha: "source" },
              base: { sha: "base", ref: "feature/card-alice-source-7" },
            },
          };
        posts += 1;
        return { status: 201, data: commentTestRecord(intent.body) };
      },
      graphql: async () => ({ data: {} }),
    };
    const first = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport,
      initialFacts: sourceCommentFacts(),
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await first.updatePullRequestBase({
      pullRequestNumber: 7,
      integrationBranchName: "feature/card-alice-source-7",
    });
    await expect(first.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "created",
    });
    const second = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport,
      initialFacts: sourceCommentFacts(),
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(second.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(posts).toBe(1);
  });

  test("uses rendered raw canonical keys through create, no-op, and update", async () => {
    const setup = renderSetupComment({
      runIdentity: "source:7:42",
      sourcePullRequestNumber: 7,
      integrationBranchName: "feature/card-alice-source-7",
      integrationPullRequestNumber: 8,
      rebaseCommand: "git rebase upstream/feature/card-alice-source-7",
    });
    const validation = renderValidationComment({
      runIdentity: "source:7:42",
      sourcePullRequestNumber: 7,
      sourceHeadOid: oid("source"),
      result: { kind: "valid", headOid: oid("source") },
    });
    expect(setup.actionKey).toBe("run=source:7:42;target=7;slot=source-status");
    let current: Record<string, unknown> | undefined;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      initialFacts: sourceCommentFacts(),
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async (request) => {
          if (request.method === "GET")
            return request.path.endsWith("/issues/comments/123")
              ? { status: 200, data: current }
              : { status: 200, data: current ? [current] : [] };
          if (request.method === "PATCH" && request.path.endsWith("/pulls/7"))
            return { status: 200, data: retargetedSourcePullRequest() };
          if (request.method === "POST") {
            current = commentTestRecord(setup.body);
            return { status: 201, data: current };
          }
          if (request.method === "PATCH") {
            current = { ...commentTestRecord(validation.body), id: 123 };
            return { status: 200, data: current };
          }
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await platform.updatePullRequestBase({
      pullRequestNumber: 7,
      integrationBranchName: "feature/card-alice-source-7",
    });
    const setupIntent = {
      ...setup,
      targetPullRequestNumber: 7,
    } satisfies CommentIntent;
    const validationIntent = {
      ...validation,
      targetPullRequestNumber: 7,
    } satisfies CommentIntent;
    const created = await platform.ensureComment?.(setupIntent);
    expect(created?.kind).toBe("created");
    await expect(platform.ensureComment?.(setupIntent)).resolves.toMatchObject({
      kind: "noOp",
    });
    await expect(
      platform.ensureComment?.({
        ...validationIntent,
        ...(created?.kind === "created" ? { observed: created.comment } : {}),
      }),
    ).resolves.toMatchObject({ kind: "updated" });
  });

  test("uses a rendered Ready key only after the exact Ready milestone", async () => {
    const ready = renderReadyComment({
      runIdentity: "source:7:42",
      originalContributor: "alice",
      integrationPullRequestNumber: 8,
      candidateHeadOid: oid("candidate"),
      cardPath: "people/alice.md",
      cardBlobOid: oid("card"),
    });
    const integrationFacts = sourceCommentFacts();
    integrationFacts.integrationPullRequest = {
      status: "ready",
      value: {
        number: 8,
        nodeId: "PR_8",
        kind: "integration",
        headOid: oid("candidate"),
        baseOid: oid("main"),
        draft: true,
        observedOid: oid("candidate"),
        provenance: "provider",
      },
    };
    integrationFacts.candidate = {
      status: "ready",
      value: {
        integrationHeadOid: oid("candidate"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
        readmeBlobOid: oid("readme"),
        observedOid: oid("candidate"),
        provenance: "provider",
      },
    };
    let comment: Record<string, unknown> | undefined;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      initialFacts: integrationFacts,
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async (request) => {
          if (request.method === "GET")
            return request.path.endsWith("/pulls/8")
              ? {
                  status: 200,
                  data: {
                    number: 8,
                    draft: false,
                    head: { sha: "candidate" },
                    base: { sha: "main" },
                  },
                }
              : request.path.endsWith("/issues/comments/123")
                ? { status: 200, data: comment }
                : { status: 200, data: comment ? [comment] : [] };
          if (request.method === "POST") {
            comment = {
              ...commentTestRecord(ready.body),
              issue_url: "https://api.github.com/repos/acme/hello/issues/8",
            };
            return { status: 201, data: comment };
          }
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({
          data: {
            markPullRequestReadyForReview: { pullRequest: { id: "PR_8" } },
          },
        }),
      },
    });
    const intent = {
      ...ready,
      targetPullRequestNumber: 8,
    } satisfies CommentIntent;
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    await platform.markPullRequestReadyForReview({
      pullRequestNumber: 8,
      expectedCandidateHeadOid: "candidate",
    });
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "created",
    });
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "noOp",
    });
  });

  test("accepts GitHub's numeric repository Link only after trusted ID binding", async () => {
    const intent = commentTestIntent();
    const comment = commentTestRecord(intent.body);
    let pages = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      repositoryId: 1346747333,
      transport: {
        rest: async (request) => {
          if (request.method === "POST") throw new Error("must not create");
          if (request.path.endsWith("/issues/comments/123"))
            return { status: 200, data: comment };
          if (request.path.includes("repositories/1346747333/"))
            return { status: 200, data: [comment] };
          pages += 1;
          return {
            status: 200,
            data: [],
            headers: {
              link: '<https://api.github.com/repositories/1346747333/issues/7/comments?per_page=100&page=2>; rel="next"',
            },
          };
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "noOp",
    });
    expect(pages).toBe(1);
  });

  test("scopes and consumes a setup create permit by exact action key", async () => {
    const allowedKey = "run=source:7:42;target=7;slot=source-status";
    const allowed: CommentIntent = {
      targetPullRequestNumber: 7,
      slot: "source-status",
      actionKey: allowedKey,
      phase: "setup",
      body: `<!-- hello-from-main: key=${encodeURIComponent(allowedKey)} phase=setup -->\nbody\n`,
    };
    let posts = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      initialFacts: sourceCommentFacts(),
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async (request) => {
          if (request.method === "GET")
            return request.path.endsWith("/issues/comments/123")
              ? { status: 200, data: commentTestRecord(allowed.body) }
              : { status: 200, data: [] };
          if (request.method === "PATCH")
            return {
              status: 200,
              data: {
                number: 7,
                draft: false,
                head: { sha: "source" },
                base: { sha: "base", ref: "feature/card-alice-source-7" },
              },
            };
          posts += 1;
          return { status: 201, data: commentTestRecord(allowed.body) };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await platform.updatePullRequestBase({
      pullRequestNumber: 7,
      integrationBranchName: "feature/card-alice-source-7",
    });
    await expect(
      platform.ensureComment?.({
        ...allowed,
        actionKey: "run=source:8:42;target=7;slot=source-status",
      }),
    ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    await expect(
      platform.ensureComment?.({ ...allowed, targetPullRequestNumber: 8 }),
    ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    await expect(
      platform.ensureComment?.({
        ...allowed,
        slot: "integration-status",
      }),
    ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    await expect(
      platform.ensureComment?.({
        ...allowed,
        phase: "validation-success",
      }),
    ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    await expect(platform.ensureComment?.(allowed)).resolves.toMatchObject({
      kind: "created",
    });
    await expect(platform.ensureComment?.(allowed)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(posts).toBe(1);
  });

  test("atomically reserves one structured permit for concurrent create calls", async () => {
    const intent: CommentIntent = {
      ...commentTestIntent(),
      actionKey: "run=source:7:42;target=7;slot=source-status",
      body: `<!-- hello-from-main: key=${encodeURIComponent("run=source:7:42;target=7;slot=source-status")} phase=setup -->\nbody\n`,
    };
    let releaseReads: (() => void) | undefined;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let lists = 0;
    let posts = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      initialFacts: sourceCommentFacts(),
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async (request) => {
          if (request.method === "GET") {
            if (request.path.endsWith("/issues/7/comments")) {
              lists += 1;
              if (lists === 2) releaseReads?.();
              await readsReleased;
              return { status: 200, data: [] };
            }
            if (request.path.endsWith("/issues/comments/123"))
              return { status: 200, data: commentTestRecord(intent.body) };
          }
          if (request.method === "PATCH")
            return {
              status: 200,
              data: retargetedSourcePullRequest(),
            };
          if (request.method === "POST") {
            posts += 1;
            return { status: 201, data: commentTestRecord(intent.body) };
          }
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await platform.updatePullRequestBase({
      pullRequestNumber: 7,
      integrationBranchName: "feature/card-alice-source-7",
    });
    const results = await Promise.all([
      platform.ensureComment?.(intent),
      platform.ensureComment?.(intent),
    ]);
    expect(results.map((result) => result?.kind).sort()).toEqual([
      "capabilityUnavailable",
      "created",
    ]);
    expect(posts).toBe(1);
  });

  test("does not grant a fresh create permit for an already-ready Integration PR", async () => {
    const facts = sourceCommentFacts();
    facts.integrationPullRequest = {
      status: "ready",
      value: {
        number: 8,
        nodeId: "PR_8",
        kind: "integration",
        headOid: oid("candidate"),
        baseOid: oid("main"),
        draft: false,
        observedOid: oid("candidate"),
        provenance: "provider",
      },
    };
    facts.candidate = {
      status: "ready",
      value: {
        integrationHeadOid: oid("candidate"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("card"),
        readmeBlobOid: oid("readme"),
        observedOid: oid("candidate"),
        provenance: "provider",
      },
    };
    const ready = renderReadyComment({
      runIdentity: "source:7:42",
      originalContributor: "alice",
      integrationPullRequestNumber: 8,
      candidateHeadOid: oid("candidate"),
      cardPath: "people/alice.md",
      cardBlobOid: oid("card"),
    });
    let posts = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      initialFacts: facts,
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      transport: {
        rest: async (request) => {
          if (request.method === "GET") return { status: 200, data: [] };
          posts += 1;
          return { status: 201, data: commentTestRecord(ready.body) };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await expect(
      platform.markPullRequestReadyForReview({
        pullRequestNumber: 8,
        expectedCandidateHeadOid: "candidate",
      }),
    ).resolves.toMatchObject({ kind: "alreadyReadyAtExpectedCandidate" });
    await expect(
      platform.ensureComment?.({
        ...ready,
        targetPullRequestNumber: 8,
      }),
    ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    expect(posts).toBe(0);
  });

  test("fails closed for unsafe, null, and mismatched comment principals", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    for (const [user, expectedKind] of [
      [null, "unknownOutcome"],
      [{ id: 9007199254740992, login: "bot", type: "Bot" }, "unknownOutcome"],
      [{ id: 41, login: "bot", type: "Bot" }, "ambiguousOwnership"],
      [{ id: 42, login: "bot", type: "User" }, "ambiguousOwnership"],
    ] as const) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) => {
            if (
              request.method === "GET" &&
              request.path.endsWith("/issues/7/comments")
            )
              return {
                status: 200,
                data: [
                  {
                    id: 123,
                    body,
                    user,
                    issue_url:
                      "https://api.github.com/repos/acme/hello/issues/7",
                  },
                ],
              };
            throw new Error("mutation must not be attempted");
          },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(
        platform.ensureComment?.({
          targetPullRequestNumber: 7,
          slot: "source-status",
          actionKey: "run=x;target=7;slot=source-status",
          phase: "setup",
          body,
        }),
      ).resolves.toMatchObject({ kind: expectedKind });
    }
  });

  test("uses Link next only, treats an absent Link as terminal, and rejects conflicting duplicate IDs", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    let page = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (
            request.method === "GET" &&
            request.path.includes("/issues/7/comments")
          ) {
            page += 1;
            return page === 1
              ? {
                  status: 200,
                  data: [
                    {
                      id: 123,
                      body,
                      user: { id: 42, type: "Bot" },
                      issue_url:
                        "https://api.github.com/repos/acme/hello/issues/7",
                    },
                  ],
                  headers: {
                    link: '<https://api.github.com/repos/acme/hello/issues/7/comments?page=2>; rel="next"',
                  },
                }
              : {
                  status: 200,
                  data: [
                    {
                      id: 123,
                      body: `${body}changed`,
                      user: { id: 42, type: "Bot" },
                      issue_url:
                        "https://api.github.com/repos/acme/hello/issues/7",
                    },
                  ],
                };
          }
          throw new Error("unexpected mutation");
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      platform.ensureComment?.({
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: "run=x;target=7;slot=source-status",
        phase: "setup",
        body,
      }),
    ).resolves.toMatchObject({ kind: "unknownOutcome" });
  });

  test("does not use legacy nextPage for Comment pagination", async () => {
    const intent = commentTestIntent();
    let lists = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          ) {
            lists += 1;
            return { status: 200, data: [], nextPage: 2 };
          }
          if (request.method === "POST")
            return { status: 201, data: commentTestRecord(intent.body) };
          if (request.method === "GET")
            return { status: 200, data: commentTestRecord(intent.body) };
          throw new Error("unexpected mutation");
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(lists).toBe(1);
  });

  test("rejects every present malformed or non-continuing Link header before mutation", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    for (const link of [
      '<https://api.github.com/repos/acme/hello/issues/7/comments?page=1>; rel="prev"',
      '<https://api.github.com/repos/acme/hello/issues/7/comments?page=9>; rel="last"',
      '<https://api.github.com/repos/acme/hello/issues/7/comments?page=abc>; rel="next"',
      '<https://api.github.com/repos/acme/hello/issues/7/comments?page=2>; rel="next", broken',
      '<https://api.github.com/repos/acme/hello/issues/7/comments?page=2>; rel="next", <https://api.github.com/repos/acme/hello/issues/7/comments?page=3>; rel="next"',
      '<https://attacker.invalid/repos/acme/hello/issues/7/comments?page=2>; rel="next"',
    ]) {
      let posts = 0;
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) => {
            if (request.method === "POST") {
              posts += 1;
              throw new Error(
                "mutation must not follow incomplete enumeration",
              );
            }
            return {
              status: 200,
              data: [],
              headers: { link },
            };
          },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(
        platform.ensureComment?.({
          targetPullRequestNumber: 7,
          slot: "source-status",
          actionKey: "run=x;target=7;slot=source-status",
          phase: "setup",
          body,
        }),
      ).resolves.toMatchObject({ kind: "unknownOutcome" });
      expect(posts).toBe(0);
    }
  });

  test("delays ambiguous POST visibility with bounded injected readback and never reposts", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const comment = {
      id: 123,
      body,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    let posts = 0;
    let reads = 0;
    const currentComment = comment;
    const waits: number[] = [];
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      commentReadback: {
        attempts: 3,
        delayMs: 7,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
      transport: {
        rest: async (request) => {
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          ) {
            reads += 1;
            return { status: 200, data: reads < 3 ? [] : [currentComment] };
          }
          if (request.method === "POST") {
            posts += 1;
            throw new Error("response lost");
          }
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/comments/123")
          )
            return { status: 200, data: currentComment };
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    const intent: CommentIntent = {
      targetPullRequestNumber: 7,
      slot: "source-status",
      actionKey: "run=x;target=7;slot=source-status",
      phase: "setup",
      body,
    };
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(posts).toBe(0);
    expect(waits).toEqual([]);
  });

  test("clears the converged create lifecycle before a later same-slot phase update", async () => {
    const oldBody =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nold\n";
    const newBody =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=validation-success -->\nnew\n";
    const oldComment = {
      id: 123,
      body: oldBody,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    const newComment = { ...oldComment, body: newBody };
    let lists = 0;
    const requests: string[] = [];
    let currentComment = oldComment;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      commentReadback: { attempts: 3, sleep: async () => {} },
      transport: {
        rest: async (request) => {
          requests.push(`${request.method} ${request.path}`);
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          ) {
            lists += 1;
            return { status: 200, data: lists < 3 ? [] : [currentComment] };
          }
          if (request.method === "POST") throw new Error("response lost");
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/comments/123")
          )
            return { status: 200, data: currentComment };
          if (request.method === "PATCH") {
            currentComment = newComment;
            return { status: 200, data: newComment };
          }
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    const actionKey = "run=x;target=7;slot=source-status";
    const setup: CommentIntent = {
      targetPullRequestNumber: 7,
      slot: "source-status",
      actionKey,
      phase: "setup",
      body: oldBody,
    };
    await expect(platform.ensureComment?.(setup)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(
      requests.filter((request) => request.startsWith("POST")),
    ).toHaveLength(0);
  });

  test("keeps successful 201 visibility uncertainty in the no-repost readback lifecycle", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const comment = {
      id: 123,
      body,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    let posts = 0;
    let gets = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      commentReadback: { attempts: 2, sleep: async () => {} },
      transport: {
        rest: async (request) => {
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          ) {
            gets += 1;
            return { status: 200, data: gets < 3 ? [] : [comment] };
          }
          if (request.method === "POST") {
            posts += 1;
            return { status: 201, data: comment };
          }
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/comments/123")
          )
            return { status: 404, data: {} };
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    const intent: CommentIntent = {
      targetPullRequestNumber: 7,
      slot: "source-status",
      actionKey: "run=x;target=7;slot=source-status",
      phase: "setup",
      body,
    };
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(posts).toBe(0);
  });

  test("fails closed on any same-key recovery conflict before accepting exact body", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const conflict = {
      id: 124,
      body: `${body}changed`,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    const exact = { ...conflict, id: 123, body };
    let posts = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          )
            return { status: 200, data: [exact, conflict] };
          if (request.method === "POST") posts += 1;
          throw new Error("mutation must not follow conflict");
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      platform.ensureComment?.({
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: "run=x;target=7;slot=source-status",
        phase: "setup",
        body,
      }),
    ).resolves.toMatchObject({ kind: "ambiguousOwnership" });
    expect(posts).toBe(0);
  });

  test("classifies rate-limit 403 before permission and preserves retry metadata", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    for (const headers of [
      { "x-ratelimit-remaining": "0", "retry-after": "12" },
      { "retry-after": "12", "x-ratelimit-reset": "123" },
    ]) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async () => ({ status: 403, data: {}, headers }),
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(
        platform.ensureComment?.({
          targetPullRequestNumber: 7,
          slot: "source-status",
          actionKey: "run=x;target=7;slot=source-status",
          phase: "setup",
          body,
        }),
      ).resolves.toMatchObject({
        kind: "retryableTransport",
        detail: expect.stringContaining("retry-after=12"),
      });
    }
  });

  test("requires exact GET comment ID and treats 410/422 as terminal manual recovery", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const mismatched = {
      id: 999,
      body,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    for (const status of [410, 422]) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) => {
            if (
              request.method === "GET" &&
              request.path.endsWith("/issues/7/comments")
            )
              return { status: 200, data: [{ ...mismatched, id: 123 }] };
            if (
              request.method === "GET" &&
              request.path.endsWith("/issues/comments/123")
            )
              return status === 410
                ? { status, data: {} }
                : { status, data: { message: "policy" } };
            throw new Error("mutation must not be attempted");
          },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(
        platform.ensureComment?.({
          targetPullRequestNumber: 7,
          slot: "source-status",
          actionKey: "run=x;target=7;slot=source-status",
          phase: "setup",
          body,
        }),
      ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    }

    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) =>
          request.method === "GET" &&
          request.path.endsWith("/issues/7/comments")
            ? { status: 200, data: [{ ...mismatched, id: 123 }] }
            : { status: 200, data: mismatched },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      platform.ensureComment?.({
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: "run=x;target=7;slot=source-status",
        phase: "setup",
        body,
      }),
    ).resolves.toMatchObject({ kind: "unknownOutcome" });
  });

  test("confines issue_url to the configured GitHub API origin, including GHES", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const issue = {
      id: 123,
      body,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      apiOrigin: "https://github.enterprise.example/api/v3",
      transport: {
        rest: async () => ({ status: 200, data: [issue] }),
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      platform.ensureComment?.({
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: "run=x;target=7;slot=source-status",
        phase: "setup",
        body,
      }),
    ).resolves.toMatchObject({ kind: "unknownOutcome" });
  });

  test("composes GHES comment routes with /api/v3 exactly once across list/create/read/PATCH", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    const updatedBody =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=validation-success -->\nupdated\n";
    const issueUrl =
      "https://github.enterprise.example/api/v3/repos/acme/hello/issues/7";
    const comment = {
      id: 123,
      body,
      user: { id: 42, type: "Bot" },
      issue_url: issueUrl,
    };
    let current = comment;
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      urls.push(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && String(input).includes("/issues/7/comments"))
        return new Response(
          JSON.stringify(urls.length === 1 ? [] : [current]),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      if (method === "POST")
        return new Response(JSON.stringify(comment), { status: 201 });
      if (method === "PATCH") {
        current = { ...current, body: updatedBody };
        return new Response(JSON.stringify(current), { status: 200 });
      }
      if (method === "GET" && String(input).endsWith("/issues/comments/123"))
        return new Response(JSON.stringify(current), { status: 200 });
      throw new Error(`unexpected ${method} ${String(input)}`);
    }) as typeof fetch;
    try {
      const transport = createGithubTransport(
        "token",
        "https://github.enterprise.example/api/v3",
      );
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        apiOrigin: "https://github.enterprise.example/api/v3",
        transport,
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      const intent: CommentIntent = {
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: "run=x;target=7;slot=source-status",
        phase: "setup",
        body,
      };
      await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
        kind: "capabilityUnavailable",
      });
      expect(urls).toEqual([
        "https://github.enterprise.example/api/v3/repos/acme/hello/issues/7/comments?per_page=100&page=1",
      ]);
      expect(urls.every((url) => url.match(/\/api\/v3/g)?.length === 1)).toBe(
        true,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reconciles a lost PATCH with an exact post-read instead of reposting", async () => {
    const oldBody =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nold\n";
    const newBody =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=validation-success -->\nnew\n";
    const oldComment = {
      id: 123,
      body: oldBody,
      user: { id: 42, type: "Bot" },
      issue_url: "https://api.github.com/repos/acme/hello/issues/7",
    };
    const newComment = { ...oldComment, body: newBody };
    let readCount = 0;
    const requests: string[] = [];
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          requests.push(`${request.method} ${request.path}`);
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          )
            return { status: 200, data: [oldComment] };
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/comments/123")
          ) {
            readCount += 1;
            return {
              status: 200,
              data: readCount < 2 ? oldComment : newComment,
            };
          }
          if (request.method === "PATCH") throw new Error("response lost");
          throw new Error(`unexpected ${request.method} ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    const observed = {
      id: 123,
      user: { id: "42", actorType: "Bot" as const },
      ownerPrincipal: { actorId: "42", actorType: "Bot" as const },
      actionKey: "run=x;target=7;slot=source-status",
      body: oldBody,
      targetPullRequestNumber: 7,
    };
    await expect(
      platform.ensureComment?.({
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: observed.actionKey,
        phase: "validation-success",
        body: newBody,
        observed,
      }),
    ).resolves.toMatchObject({ kind: "updated" });
    expect(
      requests.filter((request) => request.startsWith("PATCH")),
    ).toHaveLength(1);
  });

  test("does not treat a wrong create 2xx as success and retains retry metadata", async () => {
    const body =
      "<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=setup -->\nsetup\n";
    let listCount = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (
            request.method === "GET" &&
            request.path.endsWith("/issues/7/comments")
          ) {
            listCount += 1;
            return { status: 200, data: [] };
          }
          if (request.method === "POST")
            return {
              status: 200,
              data: { message: "wrong create status" },
              headers: {
                "retry-after": "9",
                "x-ratelimit-reset": "123",
              },
            };
          throw new Error("duplicate create or unexpected read");
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      platform.ensureComment?.({
        targetPullRequestNumber: 7,
        slot: "source-status",
        actionKey: "run=x;target=7;slot=source-status",
        phase: "setup",
        body,
      }),
    ).resolves.toMatchObject({ kind: "capabilityUnavailable" });
    expect(listCount).toBe(1);
  });

  test("covers the Comment list/read/PATCH/create status matrix and schemas", async () => {
    const intent = commentTestIntent();
    const expectedByStatus = new Map<number, string>([
      [401, "permissionDenied"],
      [403, "permissionDenied"],
      [404, "notVisibleYet"],
      [410, "capabilityUnavailable"],
      [422, "capabilityUnavailable"],
      [429, "retryableTransport"],
      [500, "retryableTransport"],
    ]);

    for (const [status, expected] of expectedByStatus) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async () => ({
            status,
            data: {},
            ...(status === 403
              ? { headers: { "x-ratelimit-remaining": "1" } }
              : {}),
          }),
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
        kind: expected,
      });
    }

    for (const status of [204, 302]) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async () => ({ status, data: [] }),
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
        kind: "unknownOutcome",
      });
    }

    const malformedList = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async () => ({ status: 200, data: {} }),
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(malformedList.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "unknownOutcome",
    });

    for (const status of expectedByStatus.keys()) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) =>
            request.path.endsWith("/issues/7/comments")
              ? { status: 200, data: [commentTestRecord(intent.body)] }
              : { status, data: {} },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
        kind: expectedByStatus.get(status),
      });
    }

    const malformedRead = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) =>
          request.path.endsWith("/issues/7/comments")
            ? { status: 200, data: [commentTestRecord(intent.body)] }
            : { status: 200, data: {} },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(malformedRead.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "unknownOutcome",
    });

    const oldBody = commentTestBody("setup");
    const patchIntent = {
      ...intent,
      body: commentTestBody("validation-success"),
      observed: {
        id: 123,
        user: { id: "42", actorType: "Bot" as const },
        ownerPrincipal: { actorId: "42", actorType: "Bot" as const },
        actionKey: intent.actionKey,
        body: oldBody,
        targetPullRequestNumber: 7,
      },
    };
    for (const status of expectedByStatus.keys()) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) => {
            if (request.path.endsWith("/issues/7/comments"))
              return { status: 200, data: [commentTestRecord(oldBody)] };
            if (request.path.endsWith("/issues/comments/123")) {
              if (request.method === "PATCH") return { status, data: {} };
              return { status: 200, data: commentTestRecord(oldBody) };
            }
            throw new Error("unexpected comment route");
          },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(
        platform.ensureComment?.(patchIntent),
      ).resolves.toMatchObject({
        kind:
          status === 401 || status === 403
            ? "permissionDenied"
            : status === 404 || status === 500
              ? "unknownOutcome"
              : expectedByStatus.get(status),
      });
    }

    const malformedPatch = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/issues/7/comments"))
            return { status: 200, data: [commentTestRecord(oldBody)] };
          if (request.method === "PATCH") return { status: 200, data: {} };
          return { status: 200, data: commentTestRecord(oldBody) };
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      malformedPatch.ensureComment?.(patchIntent),
    ).resolves.toMatchObject({ kind: "unknownOutcome" });

    for (const status of [201, 204, 302]) {
      const patchWrong2xx = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) => {
            if (request.path.endsWith("/issues/7/comments"))
              return { status: 200, data: [commentTestRecord(oldBody)] };
            if (request.method === "PATCH") return { status, data: {} };
            return { status: 200, data: commentTestRecord(oldBody) };
          },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(
        patchWrong2xx.ensureComment?.(patchIntent),
      ).resolves.toMatchObject({ kind: "unknownOutcome" });
    }

    for (const status of [201, 204, 302]) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) =>
            request.path.endsWith("/issues/7/comments")
              ? request.method === "GET"
                ? { status: 200, data: [] }
                : { status, data: {} }
              : { status: 200, data: commentTestRecord(intent.body) },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
        kind: "capabilityUnavailable",
      });
    }

    for (const status of [201, 204, 302]) {
      const readWrong2xx = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) =>
            request.path.endsWith("/issues/7/comments")
              ? { status: 200, data: [commentTestRecord(intent.body)] }
              : { status, data: commentTestRecord(intent.body) },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(readWrong2xx.ensureComment?.(intent)).resolves.toMatchObject(
        { kind: "unknownOutcome" },
      );
    }

    for (const status of [401, 403, 404, 410, 422, 429, 500]) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) =>
            request.method === "GET"
              ? { status: 200, data: [] }
              : {
                  status,
                  data: {},
                  ...(status === 403 || status === 429
                    ? {
                        headers: {
                          ...(status === 403
                            ? { "x-ratelimit-remaining": "1" }
                            : { "retry-after": "12" }),
                        },
                      }
                    : {}),
                },
          graphql: async () => ({ data: {} }),
        },
        expectedCommentOwner: { actorId: "42", actorType: "Bot" },
      });
      await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
        kind: "capabilityUnavailable",
      });
    }

    const malformedCreate = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) =>
          request.method === "GET"
            ? { status: 200, data: [] }
            : { status: 201, data: {} },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      malformedCreate.ensureComment?.(intent),
    ).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });

    const transportFailure = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async () => {
          throw new Error("wire failure");
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(
      transportFailure.ensureComment?.(intent),
    ).resolves.toMatchObject({
      kind: "retryableTransport",
    });
  });

  test("keeps ambiguous POST bounded and never reposts when visibility stays zero", async () => {
    const intent = commentTestIntent();
    let posts = 0;
    let lists = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      commentReadback: { attempts: 3, sleep: async () => {} },
      transport: {
        rest: async (request) => {
          if (request.method === "GET") {
            lists += 1;
            return { status: 200, data: [] };
          }
          posts += 1;
          throw new Error("response lost");
        },
        graphql: async () => ({ data: {} }),
      },
      expectedCommentOwner: { actorId: "42", actorType: "Bot" },
    });
    await expect(platform.ensureComment?.(intent)).resolves.toMatchObject({
      kind: "capabilityUnavailable",
    });
    expect(posts).toBe(0);
    expect(lists).toBe(1);
  });

  test("maps ready-for-review to the exact GraphQL mutation and variables", async () => {
    const requests: unknown[] = [];
    const transport: OctokitRequestTransport = {
      rest: async (request) =>
        request.path.endsWith("/pulls/7")
          ? {
              status: 200,
              data: {
                number: 7,
                draft: false,
                head: { sha: "candidate-1" },
                base: { sha: "main-1" },
              },
            }
          : { status: 200, data: { sha: "unused" } },
      graphql: async (request) => {
        requests.push(request);
        return {
          data: {
            markPullRequestReadyForReview: {
              pullRequest: {
                id: "PR_node",
                isDraft: false,
                headRefOid: "candidate-1",
              },
            },
          },
        };
      },
    };
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport,
      pullRequestNodeIds: new Map([[7, "PR_node"]]),
      readyState: async () => ({
        pullRequest: {
          number: 7,
          kind: "integration",
          headOid: oid("candidate-1"),
          baseOid: oid("main-1"),
          draft: true,
          observedOid: oid("candidate-1"),
          provenance: "provider",
        },
        candidate: {
          integrationHeadOid: oid("candidate-1"),
          cardPath: "people/a.md",
          cardBlobOid: oid("card"),
          readmeBlobOid: oid("readme"),
          observedOid: oid("candidate-1"),
          provenance: "provider",
        },
      }),
    });

    const result = await platform.markPullRequestReadyForReview({
      pullRequestNumber: 7,
      expectedCandidateHeadOid: "candidate-1",
    });

    expect(result.kind).toBe("readyAtExpectedCandidate");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      query: expect.stringContaining("mutation markPullRequestReadyForReview"),
      variables: { pullRequestId: "PR_node" },
    });
  });

  test("fails closed on replay transport mismatch instead of falling back to network", async () => {
    const transport: OctokitRequestTransport = {
      rest: async () => {
        throw new Error("replay mismatch");
      },
      graphql: async () => {
        throw new Error("network must not be used");
      },
    };
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport,
      replay: true,
    });

    await expect(platform.observeRepository()).resolves.toMatchObject({
      status: "incomplete",
      error: "replay mismatch",
    });
  });

  test("passes an invocation AbortSignal to the injected REST transport", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          received = request.signal;
          return { status: 404, data: {} };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await platform.createIntegrationBranch(
      { name: "feature", fromMainOid: "main" },
      { signal: controller.signal },
    );
    expect(received).toBe(controller.signal);
  });

  test("fails closed when Ready lacks an authoritative GraphQL node ID", async () => {
    const requests: unknown[] = [];
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) =>
          request.path.endsWith("/pulls/7")
            ? {
                status: 200,
                data: {
                  number: 7,
                  draft: true,
                  head: { sha: "candidate-1" },
                  base: { sha: "main-1" },
                },
              }
            : { status: 200, data: {} },
        graphql: async (request) => {
          requests.push(request);
          return { data: {} };
        },
      },
      readyState: async () => ({
        pullRequest: {
          number: 7,
          kind: "integration",
          headOid: oid("candidate-1"),
          baseOid: oid("main-1"),
          draft: true,
          observedOid: oid("candidate-1"),
          provenance: "provider",
        },
        candidate: {
          integrationHeadOid: oid("candidate-1"),
          cardPath: "people/a.md",
          cardBlobOid: oid("card"),
          readmeBlobOid: oid("readme"),
          observedOid: oid("candidate-1"),
          provenance: "provider",
        },
      }),
    });

    await expect(
      platform.markPullRequestReadyForReview({
        pullRequestNumber: 7,
        expectedCandidateHeadOid: "candidate-1",
      }),
    ).resolves.toEqual({ kind: "blocked", reason: "notVisibleYet" });
    expect(requests).toHaveLength(0);
  });

  test("distinguishes permission, rate-limit, and not-visible HTTP failures", async () => {
    const responses = [
      { status: 403, data: {}, headers: {} },
      { status: 403, data: {}, headers: { "x-ratelimit-remaining": "0" } },
      {
        status: 404,
        data: { message: "Resource not accessible by integration" },
      },
    ];
    for (const expected of [
      "permissionDenied",
      "rateLimited",
      "notVisibleYet",
    ]) {
      const response = responses.shift();
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async () => ({
            status: response?.status ?? 500,
            data: response?.data ?? {},
            ...(response?.headers ? { headers: response.headers } : {}),
          }),
          graphql: async () => ({ data: {} }),
        },
      });
      await expect(
        platform.createIntegrationBranch({
          name: "feature",
          fromMainOid: "main",
        }),
      ).resolves.toMatchObject({ kind: expected });
    }
  });

  test("rejects overlapping pagination and preserves changed membership across pages", async () => {
    let page = 0;
    const pagePullRequest = (number: number) => ({
      number,
      draft: false,
      head: { ref: `add/user-${number}`, sha: `head-${number}` },
      base: { ref: "main", sha: "main-1" },
    });
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main-1" } } };
          if (
            request.path.endsWith("/git/trees/main-1") ||
            request.path.endsWith("/git/trees/integration-1")
          )
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
                encoding: "base64",
              },
            };
          page += 1;
          return page === 1
            ? { status: 200, data: [pagePullRequest(1)], nextPage: 2 }
            : { status: 200, data: [pagePullRequest(2)] };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    expect((await platform.observeRepository()).status).toBe("ready");

    let overlapPage = 0;
    const overlap = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main-1" } } };
          if (request.path.endsWith("/git/trees/main-1"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
                encoding: "base64",
              },
            };
          overlapPage += 1;
          return {
            status: 200,
            data: [pagePullRequest(1)],
            ...(overlapPage === 1 ? { nextPage: 2 } : {}),
          };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await expect(overlap.observeRepository()).resolves.toMatchObject({
      status: "incomplete",
      error: "pagination overlap",
    });
  });

  test("uses PUT with an exact head guard, rejects merged:false, and looks up lost responses", async () => {
    const requests: unknown[] = [];
    const rejected = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          requests.push(request);
          return {
            status: 200,
            data: { merged: false, message: "checks incomplete" },
          };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await expect(
      rejected.mergePullRequest({
        kind: "contribution",
        pullRequestNumber: 3,
        expectedHeadOid: oid("head"),
      }),
    ).resolves.toEqual({
      kind: "contributionRejected",
      reason: "policyRejected",
    });
    expect(requests[0]).toEqual(
      expect.objectContaining({
        method: "PUT",
        path: "/repos/acme/hello/pulls/3/merge",
        parameters: { sha: "head", merge_method: "merge" },
      }),
    );

    const recovered = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async () => {
          throw new Error("response lost");
        },
        graphql: async () => ({ data: {} }),
      },
      lookupContributionMerge: async () => ({
        merged: true,
        mergeCommitOid: "merge-1",
      }),
    });
    await expect(
      recovered.mergePullRequest({
        kind: "contribution",
        pullRequestNumber: 3,
        expectedHeadOid: oid("head"),
      }),
    ).resolves.toEqual({ kind: "contributionMerged", headOid: oid("merge-1") });
  });

  test("requires an exact merged SHA readback after a successful PUT", async () => {
    let calls = 0;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      transport: {
        rest: async () => {
          calls += 1;
          return calls === 1
            ? { status: 200, data: { merged: true, sha: "merge-1" } }
            : {
                status: 200,
                data: { merged: true, merge_commit_sha: "other" },
              };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await expect(
      platform.mergePullRequest({
        kind: "contribution",
        pullRequestNumber: 3,
        expectedHeadOid: oid("head"),
      }),
    ).resolves.toEqual({
      kind: "contributionRejected",
      reason: "stalePrecondition",
    });
  });

  test.each([
    [404, "notFound"],
    [405, "policyRejected"],
    [409, "stalePrecondition"],
    [422, "policyRejected"],
  ] as const)("fails closed for merge response %i", async (status, reason) => {
    const requests: { method: string }[] = [];
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      transport: {
        rest: async (request) => {
          requests.push(request);
          return { status, data: { message: "provider rejection" } };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    await expect(
      platform.mergePullRequest({
        kind: "contribution",
        pullRequestNumber: 3,
        expectedHeadOid: oid("head"),
      }),
    ).resolves.toEqual({ kind: "contributionRejected", reason });
    expect(requests).toEqual([expect.objectContaining({ method: "PUT" })]);
  });

  test("fails closed for production Integration merges until a provider base-current gate exists", async () => {
    let lookedUp = false;
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async () => ({
          status: 200,
          data: { merged: true, sha: "wrong" },
        }),
        graphql: async () => ({ data: {} }),
      },
      lookupIntegrationMain: async () => {
        lookedUp = true;
        return { mainOid: "candidate" };
      },
    });

    await expect(
      platform.mergePullRequest({
        kind: "integration",
        pullRequestNumber: 9,
        expectedHeadOid: oid("candidate"),
        observedBaseOid: oid("main"),
        baseCurrentGate: "required",
      }),
    ).resolves.toEqual({
      kind: "integrationRejected",
      reason: "gateUnsupported",
    });
    expect(lookedUp).toBe(false);
  });

  test("maps malformed observation pages to a typed incomplete observation", async () => {
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) =>
          request.path.endsWith("/git/ref/heads/main")
            ? { status: 200, data: { object: { sha: "main-1" } } }
            : { status: 200, data: { malformed: true } },
        graphql: async () => ({ data: {} }),
      },
    });

    await expect(platform.observeRepository()).resolves.toMatchObject({
      status: "incomplete",
    });
  });

  test("observes a retargeted run, current tree facts, eligibility, and original Contributor confirmation without initialFacts", async () => {
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main-1" } } };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 1,
                  state: "closed",
                  merged: true,
                  merge_commit_sha: "contribution-merge",
                  user: { login: "alice" },
                  head: { ref: "add/alice", sha: "rebased" },
                  base: {
                    ref: "feature/card-alice-source-1",
                    sha: "integration-1",
                  },
                  draft: false,
                },
                {
                  number: 2,
                  state: "open",
                  user: { login: "bot" },
                  head: {
                    ref: "feature/card-alice-source-1",
                    sha: "integration-1",
                  },
                  base: { ref: "main", sha: "main-1" },
                  draft: false,
                  mergeable: true,
                },
              ],
            };
          if (request.path.endsWith("/git/matching-refs/heads/feature/card-"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/git/commits/contribution-merge"))
            return {
              status: 200,
              data: { parents: [{ sha: "integration-1" }, { sha: "rebased" }] },
            };
          if (request.path.includes("/git/trees/"))
            return {
              status: 200,
              data: {
                tree: [
                  { path: "people/alice.md", type: "blob", sha: "card-blob" },
                  { path: "README.md", type: "blob", sha: "readme-blob" },
                ],
              },
            };
          if (request.path.endsWith("/git/blobs/card-blob"))
            return {
              status: 200,
              data: {
                content: Buffer.from(
                  "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾：Git\n\n> Hi\n",
                ).toString("base64"),
                encoding: "base64",
              },
            };
          if (request.path.endsWith("/git/blobs/readme-blob"))
            return {
              status: 200,
              data: {
                content: Buffer.from(
                  "# Hello\n<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
                encoding: "base64",
              },
            };
          if (request.path.endsWith("/pulls/2/reviews"))
            return {
              status: 200,
              data: [
                {
                  user: { login: "alice" },
                  state: "APPROVED",
                  commit_id: "integration-1",
                },
              ],
            };
          if (request.path.endsWith("/commits/integration-1/check-runs"))
            return {
              status: 200,
              data: {
                check_runs: [
                  {
                    status: "completed",
                    conclusion: "success",
                    head_sha: "integration-1",
                  },
                ],
              },
            };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });

    const observed = await platform.observeRepository();

    expect(observed).toMatchObject({ status: "ready" });
    expect(observed.value?.sourcePullRequest.value).toMatchObject({
      number: 1,
      merged: true,
      mergeCommitOid: oid("contribution-merge"),
      authorLogin: "alice",
    });
    expect(observed.value?.candidate.value).toMatchObject({
      cardBlobOid: oid("card-blob"),
      readmeBlobOid: oid("readme-blob"),
    });
    expect(observed.value?.confirmations).toEqual([
      expect.objectContaining({
        contributorLogin: "alice",
        reviewedCommitOid: oid("integration-1"),
        cardBlobOid: oid("card-blob"),
      }),
    ]);
  });

  test("binds source and Integration PR discovery to the requested run", async () => {
    const requests: string[] = [];
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          requests.push(request.path);
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main" } } };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 99,
                  user: { login: "mallory" },
                  head: { ref: "add/mallory", sha: "m" },
                  base: { ref: "main", sha: "main" },
                },
                {
                  number: 2,
                  user: { login: "bot" },
                  head: { ref: "feature/card-alice-source-1", sha: "wrong" },
                  base: { ref: "main", sha: "main" },
                },
                {
                  number: 1,
                  user: { login: "alice", id: 7 },
                  head: {
                    ref: "add/alice",
                    sha: "source",
                    repo: { fork: true, owner: { login: "alice" } },
                  },
                  base: { ref: "feature/card-alice-source-1", sha: "shell" },
                },
                {
                  number: 3,
                  user: { login: "bot" },
                  head: { ref: "feature/card-bob-source-8", sha: "other" },
                  base: { ref: "main", sha: "main" },
                },
              ],
            };
          if (request.path.endsWith("/pulls/1/files"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/git/trees/main"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                encoding: "base64",
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
              },
            };
          if (request.path.endsWith("/pulls/2/reviews"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/commits/wrong/check-runs"))
            return { status: 200, data: { check_runs: [] } };
          if (request.path.includes("/git/trees/"))
            return { status: 200, data: { tree: [] } };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const observed = await platform.observeRepository({
      expectedSourcePullRequestNumber: 1,
      expectedSourceLogin: "alice",
    });
    expect(observed.value?.sourcePullRequest.value?.number).toBe(1);
    expect(observed.value?.integrationPullRequest.value?.headRef).toBe(
      "feature/card-alice-source-1",
    );
    expect(observed.value?.integrationPullRequest.value?.headOid).toBe(
      oid("wrong"),
    );
  });

  test("ignores a same-head Integration PR with the wrong base", async () => {
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main" } } };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 1,
                  user: { login: "alice", id: 7 },
                  head: {
                    ref: "add/alice",
                    sha: "source",
                    repo: { fork: true, owner: { login: "alice" } },
                  },
                  base: { ref: "main", sha: "main" },
                },
                {
                  number: 9,
                  user: { login: "bot" },
                  head: {
                    ref: "feature/card-alice-source-1",
                    sha: "same-head",
                  },
                  base: { ref: "release", sha: "release" },
                },
                {
                  number: 2,
                  user: { login: "bot" },
                  head: {
                    ref: "feature/card-alice-source-1",
                    sha: "same-head",
                  },
                  base: { ref: "main", sha: "main" },
                },
              ],
            };
          if (request.path.endsWith("/pulls/1/files"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/git/trees/main"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                encoding: "base64",
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
              },
            };
          if (
            request.path.includes("/git/trees/") ||
            request.path.includes("/git/blobs/")
          )
            return { status: 200, data: { tree: [] } };
          if (
            request.path.endsWith("/pulls/2/reviews") ||
            request.path.endsWith("/pulls/9/reviews")
          )
            return { status: 200, data: [] };
          if (request.path.includes("check-runs"))
            return { status: 200, data: { check_runs: [] } };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const observed = await platform.observeRepository({
      expectedSourcePullRequestNumber: 1,
      expectedSourceLogin: "alice",
    });
    expect(observed.value?.integrationPullRequest.value?.number).toBe(2);
    expect(
      observed.value?.eligibility.reviews.value?.every(
        (review) => review.pullRequestNumber === 2,
      ),
    ).toBe(true);
    expect(
      observed.value?.eligibility.checks.value?.every(
        (check) => check.pullRequestNumber === 2,
      ),
    ).toBe(true);
  });

  test("fails closed for unknown review state and stale or missing check head identity", async () => {
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main" } } };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 1,
                  user: { login: "alice", id: 7 },
                  head: {
                    ref: "add/alice",
                    sha: "source",
                    repo: { fork: true, owner: { login: "alice" } },
                  },
                  base: { ref: "feature/card-alice-source-1", sha: "shell" },
                },
                {
                  number: 2,
                  user: { login: "bot" },
                  head: {
                    ref: "feature/card-alice-source-1",
                    sha: "candidate",
                  },
                  base: { ref: "main", sha: "main" },
                },
              ],
            };
          if (request.path.endsWith("/pulls/1/files"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/git/trees/main"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/trees/candidate"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                encoding: "base64",
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
              },
            };
          if (request.path.endsWith("/git/matching-refs/heads/feature/card-"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/git/trees/main"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                encoding: "base64",
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
              },
            };
          if (request.path.endsWith("/pulls/2/reviews"))
            return {
              status: 200,
              data: [
                {
                  state: "mystery",
                  user: { login: "alice" },
                  commit_id: "candidate",
                },
              ],
            };
          if (request.path.endsWith("/commits/candidate/check-runs"))
            return {
              status: 200,
              data: {
                check_runs: [
                  {
                    status: "completed",
                    conclusion: "success",
                    head_sha: "stale",
                  },
                ],
              },
            };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const observed = await platform.observeRepository();
    expect(observed.value?.eligibility.reviews.status).toBe("incomplete");
    expect(observed.value?.eligibility.checks.status).toBe("incomplete");
  });

  test("replays exact main and candidate tree/blob facts without empty placeholders", async () => {
    const bytes = (
      login: string,
      id: string,
      sourcePr: number,
      nickname: string,
    ) =>
      Buffer.from(
        `---\ngithub: ${login}\ngithub_id: ${id}\navatar: https://avatars.githubusercontent.com/u/${id}?v=4\nsource_pr: ${sourcePr}\n---\n\n# ${nickname}\n\n最近在折腾：Git\n\n> Hi\n`,
      );
    const blobs: Record<string, Buffer> = {
      "main-readme": Buffer.from(
        "prefix\n<!-- cards:start -->\nold\n<!-- cards:end -->\nsuffix\n",
      ),
      bob: bytes("bob", "8", 3, "Bob"),
      carol: bytes("carol", "9", 4, "Carol"),
      "candidate-readme": Buffer.from(
        "prefix\n<!-- cards:start -->\nBob\nCarol\nAlice\n<!-- cards:end -->\nsuffix\n",
      ),
      alice: bytes("alice", "7", 1, "Alice"),
    };
    const mainReadme = blobs["main-readme"];
    const bob = blobs.bob;
    const carol = blobs.carol;
    if (!mainReadme || !bob || !carol)
      throw new Error("fixture blobs are required");
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main-1" } } };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 1,
                  state: "closed",
                  merged: true,
                  merge_commit_sha: "contribution-merge",
                  user: { login: "alice" },
                  head: { ref: "add/alice", sha: "contribution-1" },
                  base: {
                    ref: "feature/card-alice-source-1",
                    sha: "candidate-1",
                  },
                  draft: false,
                },
                {
                  number: 2,
                  state: "open",
                  user: { login: "bot" },
                  head: {
                    ref: "feature/card-alice-source-1",
                    sha: "candidate-1",
                  },
                  base: { ref: "main", sha: "main-1" },
                  draft: false,
                  mergeable: true,
                },
              ],
            };
          if (request.path.endsWith("/git/commits/contribution-merge"))
            return {
              status: 200,
              data: {
                parents: [{ sha: "candidate-1" }, { sha: "contribution-1" }],
              },
            };
          if (request.path.endsWith("/git/trees/main-1"))
            return {
              status: 200,
              data: {
                tree: [
                  { path: "README.md", type: "blob", sha: "main-readme" },
                  { path: "people/bob.md", type: "blob", sha: "bob" },
                  { path: "people/carol.md", type: "blob", sha: "carol" },
                ],
              },
            };
          if (request.path.endsWith("/git/trees/candidate-1"))
            return {
              status: 200,
              data: {
                tree: [
                  { path: "README.md", type: "blob", sha: "candidate-readme" },
                  { path: "people/alice.md", type: "blob", sha: "alice" },
                ],
              },
            };
          const blob = /\/git\/blobs\/([^/]+)$/.exec(request.path)?.[1];
          if (blob && blobs[blob])
            return {
              status: 200,
              data: {
                content: blobs[blob].toString("base64"),
                encoding: "base64",
              },
            };
          if (request.path.endsWith("/pulls/2/reviews"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/commits/candidate-1/check-runs"))
            return {
              status: 200,
              data: {
                check_runs: [
                  { status: "queued", head_sha: "candidate-1" },
                  { status: "in_progress", head_sha: "candidate-1" },
                  {
                    status: "completed",
                    conclusion: "success",
                    head_sha: "candidate-1",
                  },
                  {
                    status: "completed",
                    conclusion: "failure",
                    head_sha: "candidate-1",
                  },
                ],
              },
            };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const observed = await platform.observeRepository();
    expect(observed).toMatchObject({ status: "ready" });
    expect(observed.value?.main.value).toMatchObject({
      oid: oid("main-1"),
      cardManifests: [
        {
          path: "people/bob.md",
          blobOid: oid("bob"),
          githubId: "8",
          sourcePrNumber: 3,
        },
        {
          path: "people/carol.md",
          blobOid: oid("carol"),
          githubId: "9",
          sourcePrNumber: 4,
        },
      ],
    });
    expect(observed.value?.main.value?.readmeBytes).toEqual(
      new Uint8Array(mainReadme),
    );
    expect(
      observed.value?.main.value?.cardPayloads?.map((item) => item.bytes),
    ).toEqual([new Uint8Array(bob), new Uint8Array(carol)]);
    expect(observed.value?.acceptedCard).toMatchObject({
      path: "people/alice.md",
      githubId: "7",
      sourcePrNumber: 1,
    });
    expect(observed.value?.candidate.value).toMatchObject({
      integrationHeadOid: oid("candidate-1"),
      mainOid: oid("main-1"),
      cardBlobOid: oid("alice"),
      readmeBlobOid: oid("candidate-readme"),
    });
    expect(
      observed.value?.eligibility.checks.value?.map((check) => check.state),
    ).toEqual(["queued", "inProgress", "success", "failure"]);
  });

  test("does not mistake missing candidate tree entries or malformed blobs for an absent ready candidate", async () => {
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      replay: true,
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main-1" } } };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 1,
                  state: "closed",
                  merged: true,
                  user: { login: "alice" },
                  head: { ref: "add/alice", sha: "source" },
                  base: {
                    ref: "feature/card-alice-source-1",
                    sha: "candidate-1",
                  },
                  draft: false,
                },
                {
                  number: 2,
                  state: "open",
                  head: {
                    ref: "feature/card-alice-source-1",
                    sha: "candidate-1",
                  },
                  base: { ref: "main", sha: "main-1" },
                  draft: true,
                },
              ],
            };
          if (request.path.endsWith("/git/trees/main-1"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "main-readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/main-readme"))
            return {
              status: 200,
              data: {
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
                encoding: "base64",
              },
            };
          if (request.path.endsWith("/git/trees/candidate-1"))
            return { status: 200, data: { tree: [] } };
          if (request.path.endsWith("/pulls/2/reviews"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/commits/candidate-1/check-runs"))
            return { status: 200, data: { check_runs: [] } };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const observed = await platform.observeRepository();
    expect(observed).toMatchObject({ status: "ready" });
    expect(observed.value?.candidate).toMatchObject({
      status: "notVisibleYet",
    });
  });

  test("reads complete source intake facts from the fork and paginated changed files", async () => {
    const card = Buffer.from(
      "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾：Git\n\n> Hi\n",
    );
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: {
        rest: async (request) => {
          if (request.path.endsWith("/git/ref/heads/main"))
            return { status: 200, data: { object: { sha: "main" } } };
          if (request.path.endsWith("/git/matching-refs/heads/feature/card-"))
            return { status: 200, data: [] };
          if (request.path.endsWith("/pulls"))
            return {
              status: 200,
              data: [
                {
                  number: 1,
                  state: "open",
                  draft: false,
                  user: { login: "alice", id: 7 },
                  head: {
                    ref: "add/alice",
                    sha: "source",
                    repo: { fork: true, owner: { login: "alice" } },
                  },
                  base: { ref: "main", sha: "main" },
                },
              ],
            };
          if (request.path.endsWith("/pulls/1/files"))
            return {
              status: 200,
              data: [{ filename: "people/alice.md", sha: "card" }],
            };
          if (request.path.endsWith("/git/trees/main"))
            return {
              status: 200,
              data: {
                tree: [{ path: "README.md", type: "blob", sha: "readme" }],
              },
            };
          if (request.path.endsWith("/git/blobs/readme"))
            return {
              status: 200,
              data: {
                content: Buffer.from(
                  "<!-- cards:start -->\n<!-- cards:end -->\n",
                ).toString("base64"),
                encoding: "base64",
              },
            };
          if (request.path.endsWith("/git/blobs/card"))
            return {
              status: 200,
              data: { content: card.toString("base64"), encoding: "base64" },
            };
          throw new Error(`unexpected ${request.path}`);
        },
        graphql: async () => ({ data: {} }),
      },
    });
    const observed = await platform.observeRepository();
    expect(observed.value?.sourcePullRequest.value).toMatchObject({
      authorLogin: "alice",
      authorGithubId: "7",
      headRepositoryOwnerLogin: "alice",
      headRepositoryIsFork: true,
      changedFilesComplete: true,
      changedFiles: [
        expect.objectContaining({
          path: "people/alice.md",
          blobOid: oid("card"),
        }),
      ],
    });
  });

  test("aggregates validated multi-page Compare links and rejects duplicate commits", async () => {
    const transport = (duplicate = false): OctokitRequestTransport => ({
      rest: async (request) => {
        if (request.path.endsWith("/git/ref/heads/main"))
          return { status: 200, data: { object: { sha: "main" } } };
        if (request.path.endsWith("/pulls"))
          return {
            status: 200,
            data: [
              {
                number: 1,
                state: "open",
                draft: false,
                user: { login: "alice", id: 7 },
                head: {
                  ref: "add/alice",
                  sha: "source",
                  repo: { fork: true, owner: { login: "alice" } },
                },
                base: {
                  ref: "feature/card-alice-source-1",
                  sha: "integration",
                },
              },
              {
                number: 2,
                state: "open",
                draft: true,
                head: {
                  ref: "feature/card-alice-source-1",
                  sha: "integration",
                },
                base: { ref: "main", sha: "main" },
              },
            ],
          };
        if (request.path.includes("matching-refs"))
          return { status: 200, data: [] };
        if (request.path === "/repos/acme/hello/compare/integration...source")
          return {
            status: 200,
            data: {
              status: "ahead",
              base_commit: { sha: "integration" },
              head_commit: { sha: "source" },
              merge_base_commit: { sha: "integration" },
              commits: [{ sha: "one" }],
              total_commits: 2,
            },
            headers: {
              link: '<https://api.github.com/repos/acme/hello/compare/integration...source?per_page=100&page=2>; rel="next"',
            },
          };
        if (
          request.path ===
          "/repos/acme/hello/compare/integration...source?per_page=100&page=2"
        )
          return {
            status: 200,
            data: {
              status: "ahead",
              base_commit: { sha: "integration" },
              head_commit: { sha: "source" },
              merge_base_commit: { sha: "integration" },
              commits: [{ sha: duplicate ? "one" : "two" }],
              total_commits: 2,
            },
          };
        if (request.path.endsWith("/pulls/1/files"))
          return {
            status: 200,
            data: [{ filename: "people/alice.md", sha: "card" }],
          };
        if (
          request.path.endsWith("/git/trees/main") ||
          request.path.endsWith("/git/trees/integration")
        )
          return {
            status: 200,
            data: {
              tree: [{ path: "README.md", type: "blob", sha: "readme" }],
            },
          };
        if (request.path.endsWith("/git/blobs/readme"))
          return {
            status: 200,
            data: {
              encoding: "base64",
              content: Buffer.from("# Hello\n").toString("base64"),
            },
          };
        if (request.path.endsWith("/git/blobs/card"))
          return {
            status: 200,
            data: {
              encoding: "base64",
              content: Buffer.from(
                "---\ngithub: alice\ngithub_id: 7\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾：Git\n\n> Hi\n",
              ).toString("base64"),
            },
          };
        if (request.path.endsWith("/commits/integration/check-runs"))
          return { status: 200, data: { check_runs: [] } };
        if (request.path.endsWith("/pulls/2/reviews"))
          return { status: 200, data: [] };
        throw new Error(`unexpected ${request.path}`);
      },
      graphql: async () => ({ data: {} }),
    });
    const complete = await createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: transport(),
    }).observeRepository();
    expect(complete.value?.sourceHeadBasedOnIntegration).toMatchObject({
      status: "ready",
      value: { isAncestor: true },
    });
    const malformed = await createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: transport(true),
    }).observeRepository();
    expect(malformed.value?.sourceHeadBasedOnIntegration).toMatchObject({
      status: "incomplete",
    });
  });

  test("accepts canonical string source and active identities without numeric coercion", async () => {
    const platform = createOctokitGithubPlatform({
      owner: "acme",
      repo: "hello",
      transport: identityObservationTransport("9007199254740991", "42"),
    });
    const observed = await platform.observeRepository();
    expect(observed).toMatchObject({ status: "ready" });
    expect(observed.value?.sourcePullRequest.value?.authorGithubId).toBe(
      "9007199254740991",
    );
    expect(observed.value?.activeGithubIds).toEqual(["42"]);
  });

  test("fails closed for unsafe numeric source and active identities", async () => {
    for (const [sourceId, activeId] of [
      [9007199254740992, "42"],
      ["7", 9007199254740992],
    ] as const) {
      const platform = createOctokitGithubPlatform({
        owner: "acme",
        repo: "hello",
        transport: identityObservationTransport(sourceId, activeId),
      });
      await expect(platform.observeRepository()).resolves.toMatchObject({
        status: "incomplete",
        error: expect.stringMatching(/identity/iu),
      });
    }
  });
});

function identityObservationTransport(
  sourceId: string | number,
  activeId: string | number,
): OctokitRequestTransport {
  return {
    rest: async (request) => {
      if (request.path.endsWith("/git/ref/heads/main"))
        return { status: 200, data: { object: { sha: "main" } } };
      if (request.path.endsWith("/pulls"))
        return {
          status: 200,
          data: [
            {
              number: 1,
              state: "open",
              draft: false,
              user: { login: "alice", id: sourceId },
              head: {
                ref: "add/alice",
                sha: "source",
                repo: { fork: true, owner: { login: "alice" } },
              },
              base: { ref: "main", sha: "main" },
            },
            {
              number: 2,
              state: "open",
              user: { login: "bob", id: activeId },
              head: { ref: "add/bob", sha: "active" },
              base: { ref: "main", sha: "main" },
            },
          ],
        };
      if (request.path.endsWith("/git/matching-refs/heads/feature/card-"))
        return { status: 200, data: [] };
      if (request.path.endsWith("/pulls/1/files"))
        return { status: 200, data: [] };
      if (request.path.endsWith("/git/trees/main"))
        return {
          status: 200,
          data: { tree: [{ path: "README.md", type: "blob", sha: "readme" }] },
        };
      if (request.path.endsWith("/git/blobs/readme"))
        return {
          status: 200,
          data: {
            encoding: "base64",
            content: Buffer.from(
              "<!-- cards:start -->\n<!-- cards:end -->\n",
            ).toString("base64"),
          },
        };
      throw new Error(`unexpected ${request.path}`);
    },
    graphql: async () => ({ data: {} }),
  };
}

function commentTestBody(phase = "setup"): string {
  return `<!-- hello-from-main: key=run%3Dx%3Btarget%3D7%3Bslot%3Dsource-status phase=${phase} -->\nbody\n`;
}

function commentTestIntent(): CommentIntent {
  return {
    targetPullRequestNumber: 7,
    slot: "source-status",
    actionKey: "run=x;target=7;slot=source-status",
    phase: "setup",
    body: commentTestBody(),
  };
}

function commentTestRecord(body: string) {
  return {
    id: 123,
    body,
    user: { id: 42, login: "hello-bot", type: "Bot" },
    issue_url: "https://api.github.com/repos/acme/hello/issues/7",
  };
}

function sourceCommentFacts(): RepositoryFacts {
  return {
    main: { status: "absent" as const },
    sourcePullRequest: {
      status: "ready" as const,
      value: {
        number: 7,
        kind: "contribution" as const,
        headOid: oid("source"),
        baseOid: oid("base"),
        draft: false,
        authorGithubId: "42",
        observedOid: oid("source"),
        provenance: "provider" as const,
      },
    },
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
  };
}

function retargetedSourcePullRequest() {
  return {
    number: 7,
    draft: false,
    head: { sha: "source" },
    base: { sha: "base", ref: "feature/card-alice-source-7" },
  };
}
