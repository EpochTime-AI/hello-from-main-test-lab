import { describe, expect, test } from "vitest";
import {
  createPublishedCardTarget,
  gitBlobOid,
  oid,
} from "../../src/core/model.js";
import {
  derivePublishedCardLinks,
  renderCompletionComment,
  renderReadyComment,
  renderSetupComment,
  renderValidationComment,
} from "../../src/render/comment.js";

const cardBytes = new TextEncoder().encode("card");
const cardBlobOid = gitBlobOid(cardBytes);
const targetResult = createPublishedCardTarget(
  { webBaseUrl: "https://github.example.test", owner: "hello", repo: "main" },
  {
    publishedMainOid: oid("0123456789abcdef0123456789abcdef01234567"),
    cardPath: "people/a+b.md",
    expectedCardBlobOid: cardBlobOid,
    actualCardBlobOid: cardBlobOid,
    expectedCardBytes: cardBytes,
    actualCardBytes: cardBytes,
    sourcePullRequestNumber: 12,
  },
);

describe("comment renderer", () => {
  test("C-R2 emits controlled markers and escapes text without deriving business state", () => {
    const setup = renderSetupComment({
      runIdentity: "source:<unsafe>",
      sourcePullRequestNumber: 12,
      integrationBranchName: "feature/card-a-source-12",
      integrationPullRequestNumber: 13,
      rebaseCommand: "git rebase upstream/<unsafe>",
    });
    const validation = renderValidationComment({
      runIdentity: "source:<unsafe>",
      sourcePullRequestNumber: 12,
      sourceHeadOid: oid("head"),
      result: {
        kind: "invalid",
        headOid: oid("head"),
        blocksMerge: true,
        issues: [
          { category: "card-safety", path: "people/a.md", field: "message" },
        ],
      },
    });

    expect(setup.body).toMatch(/^<!-- hello-from-main:/u);
    expect(setup.body).toContain("&lt;unsafe&gt;");
    expect(validation.body).toContain("card-safety");
    expect(validation.body).not.toContain("undefined");
    expect(setup.actionKey).toBe(validation.actionKey);
  });

  test("C-R1 binds Ready guidance to candidate facts and approval scope", () => {
    const ready = renderReadyComment({
      runIdentity: "source:7",
      originalContributor: "alice",
      integrationPullRequestNumber: 13,
      candidateHeadOid: oid("candidate"),
      cardPath: "people/alice.md",
      cardBlobOid: oid("abcdef0123456789abcdef0123456789abcdef01"),
    });
    expect(ready.phase).toBe("ready-guidance");
    expect(ready.body).toContain("Approval");
  });

  test("C-R2 rejects Markdown delimiters in interpolated values", () => {
    expect(() =>
      renderSetupComment({
        runIdentity: "source:7",
        sourcePullRequestNumber: 12,
        integrationBranchName: "feature/`bad",
        integrationPullRequestNumber: 13,
        rebaseCommand: "git rebase upstream\\bad",
      }),
    ).toThrow(/Markdown delimiters/u);
    expect(() =>
      renderReadyComment({
        runIdentity: "source:7",
        originalContributor: "[bad](https://example.test)",
        integrationPullRequestNumber: 13,
        candidateHeadOid: oid("candidate"),
        cardPath: "people/alice.md",
        cardBlobOid: oid("abcdef0123456789abcdef0123456789abcdef01"),
      }),
    ).toThrow(/Markdown delimiters/u);
  });

  test("C-C2 derives commit-pinned Card and source URLs with encoded paths", () => {
    if (!targetResult.ok) throw new Error("target is required");
    const links = derivePublishedCardLinks(targetResult.target);
    const completion = renderCompletionComment({
      runIdentity: "source:7",
      targetPullRequestNumber: 13,
      target: targetResult.target,
    });

    expect(links.cardUrl).toBe(
      "https://github.example.test/hello/main/blob/0123456789abcdef0123456789abcdef01234567/people%2Fa%2Bb.md",
    );
    expect(links.sourcePullRequestUrl).toBe(
      "https://github.example.test/hello/main/pull/12",
    );
    expect(completion.body).toContain(links.cardUrl);
    expect(completion.body).toContain(links.sourcePullRequestUrl);
  });

  test("C-L1 rejects a structurally forged target at the renderer boundary", () => {
    expect(() =>
      derivePublishedCardLinks({
        webBaseUrl: "https://evil.example/%2f",
        owner: "hello",
        repo: "main",
        publishedMainOid: oid("bad"),
        cardPath: "../secret.md",
        expectedCardBlobOid: oid("bad"),
        sourcePullRequestNumber: 0,
      }),
    ).toThrow(/invalid PublishedCardTarget/u);
  });
});
