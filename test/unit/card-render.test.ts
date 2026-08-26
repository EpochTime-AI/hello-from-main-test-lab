import { describe, expect, test } from "vitest";
import { productionCandidatePolicy } from "../../src/entry/policy.js";
import {
  type CardPolicy,
  parseCard,
  renderCard,
} from "../../src/render/card.js";

const policy: CardPolicy = {
  fieldLimits: { nickname: 40, exploring: 80, message: 160 },
  templateTexts: ["你的昵称", "最近在折腾：填写内容", "请写下一句话"],
  isAllowedText: () => true,
};

const validCard = `---
github: c-w-xiaohei
github_id: 12345678
avatar: https://avatars.githubusercontent.com/u/12345678?v=4
source_pr: 184
---

# 小黑

最近在折腾：TypeScript / Agent / Git

> 希望以后看到 Git conflict 不会下意识删仓库重来。
`;

describe("Card grammar", () => {
  test("parses and deterministically renders a valid Card while preserving trusted metadata", () => {
    const parsed = parseCard(validCard, {
      path: "people/c-w-xiaohei.md",
      policy,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.card.metadata).toEqual({
      github: "c-w-xiaohei",
      githubId: "12345678",
      avatar: "https://avatars.githubusercontent.com/u/12345678?v=4",
      sourcePr: 184,
    });
    expect(renderCard(parsed.card, policy)).toBe(validCard);
  });

  test.each([
    ["BOM", `\uFEFF${validCard}`],
    ["NUL", validCard.replace("小黑", "小\u0000黑")],
    ["control character", validCard.replace("Agent", "Agent\u0007")],
    ["conflict marker", validCard.replace("# 小黑", "<<<<<<< HEAD\n# 小黑")],
    ["link", validCard.replace("Agent / Git", "[Agent](https://example.com)")],
    [
      "image",
      validCard.replace("Agent / Git", "![Agent](https://example.com/a.png)"),
    ],
    ["HTML", validCard.replace("Agent / Git", "<b>Agent</b> / Git")],
    ["extra structure", validCard.replace("# 小黑", "# 小黑\n\n- extra")],
    ["template placeholder", validCard.replace("小黑", "你的昵称")],
  ])("rejects %s without semantic moderation", (_reason, input) => {
    const parsed = parseCard(input, {
      path: "people/c-w-xiaohei.md",
      policy,
    });

    expect(parsed.ok).toBe(false);
  });

  test("requires the caller to provide field policy instead of applying hidden limits", () => {
    const longText = "x".repeat(500);
    const input = validCard.replace("TypeScript / Agent / Git", longText);

    const parsed = parseCard(input, {
      path: "people/c-w-xiaohei.md",
      policy: {
        ...policy,
        fieldLimits: { nickname: 500, exploring: 500, message: 500 },
      },
    });

    expect(parsed.ok).toBe(true);
  });

  test.each([
    ["nickname", "小黑", "Project shell"],
    ["exploring", "TypeScript / Agent / Git", "Git metadata"],
    [
      "message",
      "希望以后看到 Git conflict 不会下意识删仓库重来。",
      "Project source metadata",
    ],
  ])(
    "production policy rejects unchanged Project Shell %s",
    (_field, source, placeholder) => {
      const parsed = parseCard(validCard.replace(source, placeholder), {
        path: "people/c-w-xiaohei.md",
        policy: productionCandidatePolicy.card,
      });
      expect(parsed.ok).toBe(false);
    },
  );

  test("production policy accepts nonempty strict plaintext contributor fields", () => {
    expect(
      parseCard(validCard, {
        path: "people/c-w-xiaohei.md",
        policy: productionCandidatePolicy.card,
      }).ok,
    ).toBe(true);
  });
});
