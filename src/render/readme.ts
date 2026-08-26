import type { Card } from "./card.js";

export const CARDS_START = "<!-- cards:start -->";
export const CARDS_END = "<!-- cards:end -->";

export type ReadmeRenderOptions = {
  cards: readonly Card[];
  compare: (left: Card, right: Card) => number;
  renderRegion: (cards: readonly Card[]) => string;
};

function markerOffsets(readme: string): { start: number; end: number } {
  const lines = readme.split("\n");
  let start = -1;
  let end = -1;
  let offset = 0;

  for (const line of lines) {
    if (
      (line.includes(CARDS_START) && line !== CARDS_START) ||
      (line.includes(CARDS_END) && line !== CARDS_END)
    ) {
      throw new Error("malformed README marker line");
    }
    if (line === CARDS_START) {
      if (start !== -1) throw new Error("duplicate cards:start marker");
      start = offset;
    }
    if (line === CARDS_END) {
      if (end !== -1) throw new Error("duplicate cards:end marker");
      end = offset;
    }
    offset += line.length + 1;
  }

  if (start === -1 || end === -1)
    throw new Error("README markers are required");
  if (start > end) throw new Error("README markers are reversed");

  return { start, end };
}

function assertCards(cards: readonly Card[]): void {
  const paths = new Set<string>();
  const identities = new Set<string>();

  for (const card of cards) {
    if (paths.has(card.path))
      throw new Error(`duplicate Card path: ${card.path}`);
    if (identities.has(card.metadata.githubId)) {
      throw new Error(`duplicate Card identity: ${card.metadata.githubId}`);
    }
    paths.add(card.path);
    identities.add(card.metadata.githubId);
  }
}

export function renderReadmeMarkers(
  readme: string,
  options: ReadmeRenderOptions,
): string {
  const { start, end } = markerOffsets(readme);
  assertCards(options.cards);
  const cards = [...options.cards].sort(options.compare);
  const region = options.renderRegion(cards);
  if (region.includes("\r"))
    throw new Error("README generated region must use LF");
  if (region.includes(CARDS_START) || region.includes(CARDS_END)) {
    throw new Error("generated region contains README markers");
  }

  return `${readme.slice(0, start + CARDS_START.length)}\n${region}\n${readme.slice(end)}`;
}
