import type { Card, CardPolicy } from "../render/card.js";

// These values are product-owned composition inputs, not Core defaults.
export const productionCandidatePolicy = {
  card: {
    fieldLimits: { nickname: 80, exploring: 200, message: 200 },
    templateTexts: ["Project shell", "Git metadata", "Project source metadata"],
    isAllowedText: (value) => value.trim().length > 0,
  } satisfies CardPolicy,
  compare: (left: Card, right: Card) => left.path.localeCompare(right.path),
  renderRegion: (cards: readonly Card[]) =>
    cards
      .map(
        (card) =>
          `[![${markdownText(card.metadata.github)}](${markdownUrl(card.metadata.avatar)})](https://github.com/${card.metadata.github})\n\n[${markdownText(card.metadata.github)}](https://github.com/${card.metadata.github}) · **${markdownText(card.contributor.nickname)}**\n\n最近在折腾：${markdownText(card.contributor.exploring)}\n\n> ${markdownText(card.contributor.message)}\n\n[查看完整 Card](${markdownUrl(card.path)})`,
      )
      .join("\n\n---\n\n"),
};

function markdownText(value: string): string {
  return value.replace(/[\\`*_[\]<>]/g, "\\$&");
}

function markdownUrl(value: string): string {
  return value.replace(/([()\\])/g, "\\$1");
}
