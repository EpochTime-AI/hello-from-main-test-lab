import { describe, expect, test } from "vitest";
import type { CommentIntent } from "../../../src/core/model.js";
import {
  type CommentFact,
  commentActionKey,
  commentOwnership,
  createPublishedCardTarget,
  gitBlobOid,
  oid,
  planCommentMutation,
  type TrustedPrincipal,
} from "../../../src/core/model.js";
import {
  createReconciler,
  validateIntake,
} from "../../../src/core/reconciler.js";
import type { GitWorkspace } from "../../../src/ports/git-workspace.js";
import type { GithubPlatform } from "../../../src/ports/github-platform.js";
import {
  stabilityFacts,
  testCandidatePolicy,
} from "../../fixtures/stability.js";

function validOwner(): TrustedPrincipal {
  return { actorId: "9007199254740991", actorType: "Bot" };
}

describe("Core comment contracts", () => {
  test("C-I1 keeps exactly two slots while phase and body remain mutable", () => {
    const setup = commentActionKey({
      runIdentity: "source:7",
      targetPullRequestNumber: 12,
      slot: "source-status",
    });
    const validation = commentActionKey({
      runIdentity: "source:7",
      targetPullRequestNumber: 12,
      slot: "source-status",
    });

    expect(setup).toBe(validation);
    expect(
      commentActionKey({
        runIdentity: "source:7",
        targetPullRequestNumber: 12,
        slot: "integration-status",
      }),
    ).not.toBe(setup);
  });

  test("C-I2 accepts ownership only from the trusted numeric principal", () => {
    const expected = validOwner();
    const owned: CommentFact = {
      id: 17,
      targetPullRequestNumber: 12,
      user: { id: "9007199254740991", actorType: "Bot", login: "trusted" },
      ownerPrincipal: expected,
      actionKey: "run=source%3A7;target=12;slot=source-status",
      body: "body",
    };

    expect(commentOwnership(owned, expected)).toBe("owned");
    expect(commentOwnership({ ...owned, user: null }, expected)).toBe(
      "notOwned",
    );
    expect(
      commentOwnership(
        {
          ...owned,
          user: { id: "9007199254740990", actorType: "Bot" },
        },
        expected,
      ),
    ).toBe("notOwned");
    expect(
      commentOwnership(
        {
          ...owned,
          user: { id: "9007199254740991", actorType: "User" },
        },
        expected,
      ),
    ).toBe("notOwned");
    expect(
      commentOwnership(owned, {
        actorId: "9007199254740992",
        actorType: "Bot",
      }),
    ).toBe("notOwned");
    expect(commentOwnership(owned, undefined)).toBe("notOwned");
    expect(
      planCommentMutation(
        {
          targetPullRequestNumber: 12,
          slot: "source-status",
          actionKey: owned.actionKey,
          phase: "setup",
          body: "body",
        },
        [owned],
        undefined,
      ),
    ).toEqual({ kind: "ambiguousOwnership" });
  });

  test("C-I3 plans exact-body no-op/update and rejects stale observations", () => {
    const owner = validOwner();
    const key = commentActionKey({
      runIdentity: "source:7",
      targetPullRequestNumber: 12,
      slot: "source-status",
    });
    const current: CommentFact = {
      id: 17,
      targetPullRequestNumber: 12,
      user: { id: owner.actorId, actorType: owner.actorType },
      ownerPrincipal: owner,
      actionKey: key,
      body: "old",
    };
    const intent = {
      targetPullRequestNumber: 12,
      slot: "source-status" as const,
      actionKey: key,
      phase: "validation-success" as const,
      body: "new",
    };

    expect(
      planCommentMutation({ ...intent, body: "old" }, [current], owner),
    ).toEqual({
      kind: "noOp",
      comment: current,
    });
    expect(planCommentMutation(intent, [current], owner)).toEqual({
      kind: "update",
      comment: current,
    });
    expect(
      planCommentMutation(
        { ...intent, observed: { ...current, body: "different" } },
        [current],
        owner,
      ),
    ).toEqual({ kind: "stale" });
    expect(
      planCommentMutation(intent, [{ ...current, id: 18 }], owner),
    ).toEqual({
      kind: "update",
      comment: { ...current, id: 18 },
    });
    expect(
      planCommentMutation(intent, [current, { ...current, id: 18 }], owner),
    ).toEqual({ kind: "ambiguousOwnership" });
    expect(
      planCommentMutation(
        intent,
        [{ ...current, targetPullRequestNumber: 99 }],
        owner,
      ),
    ).toEqual({ kind: "ambiguousOwnership" });
  });

  test("C-V1 exposes every invalid validation category and preserves boolean callers", () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = {
      ...source,
      authorLogin: "bob",
      headRef: "wrong",
      headRepositoryOwnerLogin: "mallory",
      headRepositoryIsFork: false,
      changedFilesComplete: false,
      changedFiles: [
        ...(source.changedFiles ?? []),
        { path: "README.md", blobOid: oid("extra"), bytes: new Uint8Array() },
      ],
    };
    const result = validateIntake(facts, testCandidatePolicy);

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.issues.map((issue) => issue.category)).toEqual(
      expect.arrayContaining([
        "intake-author-or-fork",
        "intake-ref-or-path",
        "change-scope",
        "identity-or-metadata",
      ]),
    );
    expect(result.blocksMerge).toBe(true);
    expect(result.headOid).toBe(source.headOid);
  });

  test.each([
    [
      "intake-author-or-fork",
      (facts: ReturnType<typeof stabilityFacts>) => {
        const source = facts.sourcePullRequest.value;
        if (!source) throw new Error("source is required");
        facts.sourcePullRequest.value = {
          ...source,
          headRepositoryIsFork: false,
        };
      },
    ],
    [
      "intake-ref-or-path",
      (facts: ReturnType<typeof stabilityFacts>) => {
        const source = facts.sourcePullRequest.value;
        if (!source) throw new Error("source is required");
        facts.sourcePullRequest.value = { ...source, headRef: "add/wrong" };
      },
    ],
    [
      "change-scope",
      (facts: ReturnType<typeof stabilityFacts>) => {
        const source = facts.sourcePullRequest.value;
        if (!source) throw new Error("source is required");
        facts.sourcePullRequest.value = {
          ...source,
          changedFilesComplete: false,
        };
      },
    ],
    [
      "identity-or-metadata",
      (facts: ReturnType<typeof stabilityFacts>) => {
        facts.publishedGithubIds = ["7"];
      },
    ],
    [
      "card-grammar-or-template",
      (facts: ReturnType<typeof stabilityFacts>) => {
        const source = facts.sourcePullRequest.value;
        if (!source?.changedFiles?.[0]) throw new Error("Card is required");
        facts.sourcePullRequest.value = {
          ...source,
          changedFiles: [
            {
              ...source.changedFiles[0],
              bytes: new TextEncoder().encode("not a Card\n"),
            },
          ],
        };
      },
    ],
    [
      "card-safety",
      (facts: ReturnType<typeof stabilityFacts>) => {
        const source = facts.sourcePullRequest.value;
        if (!source?.changedFiles?.[0]) throw new Error("Card is required");
        facts.sourcePullRequest.value = {
          ...source,
          changedFiles: [
            {
              ...source.changedFiles[0],
              bytes: new TextEncoder().encode(
                "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾：[unsafe](https://example.test)\n\n> Hi\n",
              ),
            },
          ],
        };
      },
    ],
    [
      "integration-base-or-ancestry",
      (facts: ReturnType<typeof stabilityFacts>) => {
        const branch = facts.integrationBranch.value;
        if (!branch) throw new Error("branch is required");
        const source = facts.sourcePullRequest.value;
        if (!source) throw new Error("source is required");
        facts.integrationBranch.value = {
          ...branch,
          headOid: oid("other-base"),
        };
        facts.sourcePullRequest.value = {
          ...source,
          merged: false,
          closed: false,
        };
      },
    ],
  ] as const)("C-V1 reports %s as a concrete category", (category, mutate) => {
    const facts = stabilityFacts();
    mutate(facts);
    const result = validateIntake(facts, testCandidatePolicy);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid")
      expect(result.issues.map((issue) => issue.category)).toContain(category);
  });

  test("C-V2 returns valid for the current head and recomputes after a head change", () => {
    const facts = stabilityFacts();
    const first = validateIntake(facts, testCandidatePolicy);
    expect(first).toEqual({ kind: "valid", headOid: oid("contribution-1") });

    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    facts.sourcePullRequest.value = {
      ...source,
      headOid: oid("contribution-2"),
      observedOid: oid("contribution-2"),
    };
    facts.sourceHeadBasedOnIntegration = {
      status: "ready",
      provenance: "modeled",
      value: {
        integrationHeadOid: oid("integration-1"),
        sourceHeadOid: oid("contribution-1"),
        isAncestor: true,
        observedOid: oid("contribution-1"),
        provenance: "modeled",
      },
    };
    const second = validateIntake(facts, testCandidatePolicy);
    expect(second.kind).toBe("valid");
    if (second.kind === "valid")
      expect(second.headOid).toBe(oid("contribution-2"));
  });

  test("validIntake delegates to the typed validator", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    if (!source?.changedFiles?.[0]) throw new Error("Card is required");
    facts.sourcePullRequest.value = {
      ...source,
      changedFiles: [
        {
          ...source.changedFiles[0],
          bytes: new TextEncoder().encode(
            "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾:[unsafe](https://example.test)\n\n> Hi\n",
          ),
        },
      ],
    };
    const { validIntake } = await import("../../../src/core/reconciler.js");
    expect(validIntake(facts, testCandidatePolicy)).toBe(false);
    expect(validateIntake(facts, testCandidatePolicy).kind).toBe("invalid");
  });

  test("C-L1 creates a PublishedCardTarget only after trusted final-main readback", () => {
    const bytes = new TextEncoder().encode("card\n");
    const blobOid = gitBlobOid(bytes);
    const result = createPublishedCardTarget(
      {
        webBaseUrl: "https://github.example.test",
        owner: "hello",
        repo: "main",
      },
      {
        publishedMainOid: oid("0123456789abcdef0123456789abcdef01234567"),
        cardPath: "people/alice.md",
        expectedCardBlobOid: blobOid,
        actualCardBlobOid: blobOid,
        expectedCardBytes: bytes,
        actualCardBytes: bytes,
        sourcePullRequestNumber: 12,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toMatchObject({
      owner: "hello",
      repo: "main",
      cardPath: "people/alice.md",
      sourcePullRequestNumber: 12,
    });
    expect(
      createPublishedCardTarget(
        {
          webBaseUrl: "https://evil.example/%2f",
          owner: "hello",
          repo: "main",
        },
        {
          publishedMainOid: oid("0123456789abcdef0123456789abcdef01234567"),
          cardPath: "people/alice.md",
          expectedCardBlobOid: blobOid,
          actualCardBlobOid: oid("wrong"),
          expectedCardBytes: bytes,
          actualCardBytes: bytes,
          sourcePullRequestNumber: 12,
        },
      ).ok,
    ).toBe(false);
  });

  test("C-S1 emits one source-status setup intent with a stable key", async () => {
    const facts = stabilityFacts();
    facts.trustedCommentOwner = validOwner();
    const intents: string[] = [];
    const github = {
      observeRepository: async () => ({ status: "ready", value: facts }),
      ensureComment: async (intent: CommentIntent) => {
        intents.push(
          `${intent.targetPullRequestNumber}:${intent.slot}:${intent.phase}`,
        );
        return {
          kind: "created",
          comment: {
            id: 1,
            user: { id: validOwner().actorId, actorType: "Bot" },
            ownerPrincipal: validOwner(),
            targetPullRequestNumber: intent.targetPullRequestNumber,
            actionKey: intent.actionKey,
            body: intent.body,
          },
        };
      },
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: async () => ({
        status: "ready",
        value: { status: "ready", integrationHeadOid: oid("integration-1") },
      }),
      writeIntegrationCandidate: async () => ({ kind: "retryableTransport" }),
      readFinalMainPostconditions: async () => ({ status: "pending" }),
    };

    const result = await createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(result).toEqual({ kind: "budgetExhausted", effects: 1 });
    expect(intents).toEqual(["1:source-status:setup"]);
  });

  test("C-C1/C-C2 publish once, then complete source and Integration targets independently", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    const main = facts.main.value;
    const accepted = facts.acceptedCard;
    if (!source || !integration || !main || !accepted)
      throw new Error("facts are required");
    facts.trustedCommentOwner = validOwner();
    facts.trustedRepository = {
      webBaseUrl: "https://github.example.test",
      owner: "hello",
      repo: "main",
    };
    facts.protocolAnchors = {
      contribution: {
        projectShellOid: oid("integration-base"),
        rebasedContributorOid: oid("source-merge"),
      },
      integration: {
        mainBeforePublicationOid: main.oid,
        candidateOid: integration.headOid,
      },
    };
    facts.main.value = {
      ...main,
      cardManifests: [
        {
          path: accepted.path,
          blobOid: gitBlobOid(accepted.bytes),
          githubId: accepted.githubId,
          sourcePrNumber: accepted.sourcePrNumber,
        },
      ],
    };
    const cardBlob = gitBlobOid(accepted.bytes);
    facts.main.value = {
      ...main,
      oid: oid("0123456789abcdef0123456789abcdef01234567"),
      cardManifests: [
        {
          path: accepted.path,
          blobOid: cardBlob,
          githubId: accepted.githubId,
          sourcePrNumber: accepted.sourcePrNumber,
        },
      ],
    };
    facts.integrationPullRequest.value = {
      ...integration,
      closed: true,
      merged: true,
      mergeCommitOid: oid("integration-merge"),
      mergeParentOids: [oid("main-1"), integration.headOid],
    };
    const intents: string[] = [];
    let merges = 0;
    const github: GithubPlatform = {
      observeRepository: async () => ({ status: "ready", value: facts }),
      ensureComment: async (intent: CommentIntent) => {
        intents.push(`${intent.targetPullRequestNumber}:${intent.slot}`);
        const current = facts.comments ?? [];
        facts.comments = [
          ...current,
          {
            id: current.length + 1,
            user: { id: validOwner().actorId, actorType: "Bot" },
            ownerPrincipal: validOwner(),
            targetPullRequestNumber: intent.targetPullRequestNumber,
            actionKey: intent.actionKey,
            body: intent.body,
          },
        ];
        const comment = facts.comments[facts.comments.length - 1];
        if (!comment) throw new Error("comment was not recorded");
        return {
          kind: "created",
          comment,
        };
      },
      mergePullRequest: async () => {
        merges += 1;
        return { kind: "integrationRejected", reason: "unknownOutcome" };
      },
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: async () => ({
        status: "ready",
        value: {
          status: "ready",
          integrationHeadOid: oid("integration-1"),
          retainedCommitOids: [oid("integration-1")],
          requiredParentOids: [],
        },
      }),
      writeIntegrationCandidate: async () => ({ kind: "retryableTransport" }),
      readFinalMainPostconditions: async (expected) => ({
        status: "ready",
        value: { ...expected, cardBytes: accepted.bytes },
      }),
    };

    const result = await createReconciler({ github, git }).reconcile({
      budget: { maxEffects: 4 },
    });

    expect(result).toEqual({ kind: "quiescent" });
    expect(intents).toEqual(["1:source-status", "2:integration-status"]);
    expect(merges).toBe(0);
  });

  test("C-C2 retries one failed completion target without re-merging", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    const main = facts.main.value;
    const accepted = facts.acceptedCard;
    if (!source || !integration || !main || !accepted)
      throw new Error("facts are required");
    facts.trustedCommentOwner = validOwner();
    facts.trustedRepository = {
      webBaseUrl: "https://github.example.test",
      owner: "hello",
      repo: "main",
    };
    const cardBlob = gitBlobOid(accepted.bytes);
    facts.main.value = {
      ...main,
      oid: oid("0123456789abcdef0123456789abcdef01234567"),
      cardManifests: [
        {
          path: accepted.path,
          blobOid: cardBlob,
          githubId: accepted.githubId,
          sourcePrNumber: accepted.sourcePrNumber,
        },
      ],
    };
    facts.integrationPullRequest.value = {
      ...integration,
      closed: true,
      merged: true,
      mergeCommitOid: oid("integration-merge"),
      mergeParentOids: [oid("main-1"), integration.headOid],
    };
    let sourceAttempts = 0;
    let merges = 0;
    const github = {
      observeRepository: async () => ({ status: "ready", value: facts }),
      ensureComment: async (intent: CommentIntent) => {
        if (intent.slot === "source-status" && sourceAttempts++ === 0)
          return { kind: "retryableTransport" as const };
        const current = facts.comments ?? [];
        const comment = {
          id: current.length + 1,
          user: { id: validOwner().actorId, actorType: "Bot" as const },
          ownerPrincipal: validOwner(),
          targetPullRequestNumber: intent.targetPullRequestNumber,
          actionKey: intent.actionKey,
          body: intent.body,
        };
        facts.comments = [...current, comment];
        return { kind: "created" as const, comment };
      },
      mergePullRequest: async () => {
        merges += 1;
        return {
          kind: "integrationRejected" as const,
          reason: "unknownOutcome" as const,
        };
      },
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: async () => ({
        status: "ready",
        value: {
          status: "ready",
          integrationHeadOid: oid("integration-1"),
          retainedCommitOids: [oid("integration-1")],
          requiredParentOids: [],
        },
      }),
      writeIntegrationCandidate: async () => ({ kind: "retryableTransport" }),
      readFinalMainPostconditions: async (expected) => ({
        status: "ready",
        value: { ...expected, cardBytes: accepted.bytes },
      }),
    };

    const reconciler = createReconciler({ github, git });
    await expect(
      reconciler.reconcile({ budget: { maxEffects: 1 } }),
    ).resolves.toEqual({
      kind: "retryable",
      reason: "retryableTransport",
    });
    await expect(
      reconciler.reconcile({ budget: { maxEffects: 3 } }),
    ).resolves.toEqual({
      kind: "quiescent",
    });
    expect(sourceAttempts).toBe(2);
    expect(merges).toBe(0);
  });

  test("C-C1 continues after a successful Integration merge until completion comments are read back", async () => {
    const facts = stabilityFacts();
    const source = facts.sourcePullRequest.value;
    const integration = facts.integrationPullRequest.value;
    const main = facts.main.value;
    const accepted = facts.acceptedCard;
    if (!source || !integration || !main || !accepted)
      throw new Error("facts are required");
    facts.sourcePullRequest.value = {
      ...source,
      merged: true,
      closed: true,
      mergeCommitOid: oid("source-merge"),
    };
    facts.integrationPullRequest.value = {
      ...integration,
      draft: false,
      merged: false,
      closed: false,
    };
    facts.candidate = {
      status: "ready",
      provenance: "modeled",
      value: {
        observedOid: integration.headOid,
        provenance: "modeled",
        integrationHeadOid: integration.headOid,
        mainOid: main.oid,
        cardPath: accepted.path,
        cardBlobOid: gitBlobOid(accepted.bytes),
        readmeBlobOid: oid("readme-1"),
        retainedCommitOids: [integration.headOid],
        requiredParentOids: [],
      },
    };
    const durableCandidate = facts.candidate.value;
    if (!durableCandidate) throw new Error("candidate is required");
    facts.confirmations = [
      {
        kind: "domainConfirmation",
        contributorLogin: source.authorLogin ?? "alice",
        githubId: accepted.githubId,
        sourcePrNumber: source.number,
        integrationPrNumber: integration.number,
        reviewedCommitOid: integration.headOid,
        cardPath: accepted.path,
        cardBlobOid: gitBlobOid(accepted.bytes),
      },
    ];
    facts.eligibility.checks.value = [
      {
        pullRequestNumber: integration.number,
        prHeadOid: integration.headOid,
        state: "success",
        observedOid: integration.headOid,
        provenance: "modeled",
      },
    ];
    facts.eligibility.reviews.value = [
      {
        pullRequestNumber: integration.number,
        prHeadOid: integration.headOid,
        reviewerLogin: source.authorLogin ?? "alice",
        state: "approved",
        reviewedCommitOid: integration.headOid,
        observedOid: integration.headOid,
        provenance: "modeled",
      },
    ];
    facts.trustedCommentOwner = validOwner();
    facts.trustedRepository = {
      webBaseUrl: "https://github.example.test",
      owner: "hello",
      repo: "main",
    };
    facts.protocolAnchors = {
      contribution: {
        projectShellOid: oid("integration-base"),
        rebasedContributorOid: oid("source-merge"),
      },
      integration: {
        mainBeforePublicationOid: main.oid,
        candidateOid: integration.headOid,
      },
    };
    facts.main.value = {
      ...main,
      cardManifests: [
        {
          path: accepted.path,
          blobOid: gitBlobOid(accepted.bytes),
          githubId: accepted.githubId,
          sourcePrNumber: accepted.sourcePrNumber,
        },
      ],
    };
    const comments: CommentFact[] = [];
    const intents: string[] = [];
    let merges = 0;
    const github = {
      observeRepository: async () => ({ status: "ready", value: facts }),
      ensureComment: async (intent: CommentIntent) => {
        intents.push(
          `${intent.targetPullRequestNumber}:${intent.slot}:${intent.phase}`,
        );
        const comment: CommentFact = {
          id: comments.length + 1,
          user: { id: validOwner().actorId, actorType: "Bot" },
          ownerPrincipal: validOwner(),
          targetPullRequestNumber: intent.targetPullRequestNumber,
          actionKey: intent.actionKey,
          body: intent.body,
        };
        const existing = comments.findIndex(
          (current) => current.actionKey === comment.actionKey,
        );
        if (existing >= 0) comments[existing] = comment;
        else comments.push(comment);
        facts.comments = [...comments];
        return { kind: "created" as const, comment };
      },
      mergePullRequest: async () => {
        merges += 1;
        const current = facts.integrationPullRequest.value;
        if (!current) throw new Error("Integration PR is required");
        facts.integrationPullRequest.value = {
          ...current,
          merged: true,
          closed: true,
          mergeCommitOid: oid("0123456789abcdef0123456789abcdef01234567"),
          mergeParentOids: [main.oid, integration.headOid],
        };
        facts.main.value = {
          ...main,
          oid: oid("0123456789abcdef0123456789abcdef01234567"),
          cardManifests: [
            {
              path: accepted.path,
              blobOid: gitBlobOid(accepted.bytes),
              githubId: accepted.githubId,
              sourcePrNumber: accepted.sourcePrNumber,
            },
          ],
        };
        return {
          kind: "integrationMerged" as const,
          mainOid: oid("0123456789abcdef0123456789abcdef01234567"),
        };
      },
    } as unknown as GithubPlatform;
    const git: GitWorkspace = {
      readWorkspace: async () => ({
        status: "ready",
        value: {
          status: "ready",
          integrationHeadOid: integration.headOid,
          candidate: durableCandidate,
          retainedCommitOids: [integration.headOid],
          requiredParentOids: [],
        },
      }),
      writeIntegrationCandidate: async () => ({ kind: "retryableTransport" }),
      readFinalMainPostconditions: async (expected) => ({
        status: "ready",
        value: {
          ...expected,
          mainOid: oid("0123456789abcdef0123456789abcdef01234567"),
          integrationMergeCommitOid: oid(
            "0123456789abcdef0123456789abcdef01234567",
          ),
          cardBytes: accepted.bytes,
        },
      }),
    };

    const diagnostics: unknown[] = [];
    const reconciler = createReconciler({
      github,
      git,
      candidatePolicy: testCandidatePolicy,
    });
    const publicationResult = await reconciler.reconcile({
      budget: { maxEffects: 8 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(
      publicationResult,
      JSON.stringify({ diagnostics, intents, merges }),
    ).toEqual({ kind: "quiescent" });

    const completionResult = await reconciler.reconcile({
      budget: { maxEffects: 3 },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(
      completionResult,
      JSON.stringify({ diagnostics, intents, merges }),
    ).toEqual({
      kind: "quiescent",
    });
    expect(merges).toBe(1);
    expect(intents).toContain(`${source.number}:source-status:completion`);
    expect(intents).toContain(
      `${integration.number}:integration-status:completion`,
    );
    expect(
      comments.map((comment) => comment.targetPullRequestNumber),
    ).toContain(source.number);
    expect(
      comments.map((comment) => comment.targetPullRequestNumber),
    ).toContain(integration.number);
  });

  test("completion does not let a user-authored same-key marker suppress the obligation", async () => {
    const facts = stabilityFacts();
    facts.trustedCommentOwner = validOwner();
    facts.trustedRepository = {
      webBaseUrl: "https://github.example.test",
      owner: "hello",
      repo: "main",
    };
    const source = facts.sourcePullRequest.value;
    if (!source) throw new Error("source is required");
    const actionKey = commentActionKey({
      runIdentity: `source:${source.number}:${source.authorGithubId}`,
      targetPullRequestNumber: source.number,
      slot: "source-status",
    });
    facts.comments = [
      {
        id: 99,
        targetPullRequestNumber: source.number,
        user: { id: "42", actorType: "User" },
        ownerPrincipal: { actorId: "42", actorType: "User" },
        actionKey,
        body: "<!-- hello-from-main: key=... phase=completion -->",
      },
    ];
    expect(
      planCommentMutation(
        {
          targetPullRequestNumber: source.number,
          slot: "source-status",
          actionKey,
          phase: "completion",
          body: "exact completion body",
        },
        facts.comments,
        validOwner(),
      ),
    ).toEqual({ kind: "ambiguousOwnership" });
    const seen: CommentIntent[] = [];
    const result = await createReconciler({
      github: {
        observeRepository: async () => ({ status: "ready", value: facts }),
        ensureComment: async (intent: CommentIntent) => {
          seen.push(intent);
          return {
            kind: "created" as const,
            comment: {
              id: 100,
              targetPullRequestNumber: intent.targetPullRequestNumber,
              user: { id: validOwner().actorId, actorType: "Bot" },
              ownerPrincipal: validOwner(),
              actionKey: intent.actionKey,
              body: intent.body,
            },
          };
        },
      } as unknown as GithubPlatform,
      git: {
        readWorkspace: async () => ({ status: "incomplete" }),
      } as unknown as GitWorkspace,
    }).reconcile({ budget: { maxEffects: 1 } });

    expect(result).not.toEqual({ kind: "quiescent" });
    expect(seen).toHaveLength(0);
  });

  test("owned completion with a stale body is not satisfied by its higher phase", () => {
    const owner = validOwner();
    const actionKey = commentActionKey({
      runIdentity: "source:7:9007199254740991",
      targetPullRequestNumber: 12,
      slot: "source-status",
    });
    const stale: CommentFact = {
      id: 7,
      targetPullRequestNumber: 12,
      user: { id: owner.actorId, actorType: owner.actorType },
      ownerPrincipal: owner,
      actionKey,
      body: "<!-- hello-from-main: key=x phase=completion -->\nstale",
    };
    const intent: CommentIntent = {
      targetPullRequestNumber: 12,
      slot: "source-status",
      actionKey,
      phase: "completion",
      body: "<!-- hello-from-main: key=x phase=completion -->\nexact",
    };

    expect(planCommentMutation(intent, [stale], owner)).toEqual({
      kind: "update",
      comment: stale,
    });
  });
});
