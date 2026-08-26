import { decodeUtf8, encodeUtf8 } from "./bytes.js";

export type CardField = "nickname" | "exploring" | "message";

export type CardPolicy = {
  fieldLimits: Record<CardField, number>;
  templateTexts: readonly string[];
  isAllowedText: (value: string, field: CardField) => boolean;
};

export type CardMetadata = {
  github: string;
  githubId: string;
  avatar: string;
  sourcePr: number;
};

export type CardContributor = {
  nickname: string;
  exploring: string;
  message: string;
};

export type Card = {
  path: string;
  metadata: CardMetadata;
  contributor: CardContributor;
};

export const PROJECT_SHELL_NICKNAME = "Project shell";
export const PROJECT_SHELL_EXPLORING = "Git metadata";
export const PROJECT_SHELL_MESSAGE = "Project source metadata";

export function renderProjectShellBytes(input: {
  path: string;
  github: string;
  githubId: string;
  sourcePr: number;
  avatar?: string;
}): Uint8Array {
  return renderCardBytes(
    {
      path: input.path,
      metadata: {
        github: input.github,
        githubId: input.githubId,
        sourcePr: input.sourcePr,
        avatar:
          input.avatar ??
          `https://avatars.githubusercontent.com/u/${input.githubId}?v=4`,
      },
      contributor: {
        nickname: PROJECT_SHELL_NICKNAME,
        exploring: PROJECT_SHELL_EXPLORING,
        message: PROJECT_SHELL_MESSAGE,
      },
    },
    {
      fieldLimits: { nickname: 80, exploring: 200, message: 200 },
      templateTexts: [],
      isAllowedText: () => true,
    },
  );
}

export type CardParseError = {
  kind: "invalidCard";
  reason: string;
};

export type CardParseResult =
  | { ok: true; card: Card }
  | { ok: false; error: CardParseError };

type CardInput = string | Uint8Array;

function reject(reason: string): CardParseResult {
  return { ok: false, error: { kind: "invalidCard", reason } };
}

function inputText(input: CardInput): string {
  return typeof input === "string" ? input : decodeUtf8(input);
}

function hasForbiddenText(value: string): boolean {
  return (
    hasForbiddenControlCharacters(value) ||
    /(?:<<<<<<<|=======|>>>>>>>)/u.test(value) ||
    /!?(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/iu.test(value) ||
    /<\/?[A-Za-z][^>]*>/u.test(value) ||
    /[`*_~]/u.test(value)
  );
}

function hasForbiddenStructure(value: string): boolean {
  return (
    hasForbiddenControlCharacters(value) ||
    /(?:<<<<<<<|=======|>>>>>>>)/u.test(value)
  );
}

function hasForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (
      code !== undefined &&
      ((code >= 0 && code <= 8) ||
        code === 11 ||
        code === 12 ||
        (code >= 14 && code <= 31) ||
        (code >= 127 && code <= 159) ||
        code === 0x2028 ||
        code === 0x2029)
    ) {
      return true;
    }
  }
  return false;
}

function validField(
  value: string,
  field: CardField,
  policy: CardPolicy,
): boolean {
  return (
    value.length <= policy.fieldLimits[field] &&
    !policy.templateTexts.some((template) => value.includes(template)) &&
    !hasForbiddenText(value) &&
    policy.isAllowedText(value, field)
  );
}

function validateCard(card: Card, policy: CardPolicy): void {
  if (!/^people\/[A-Za-z0-9-]+\.md$/u.test(card.path))
    throw new Error("invalid Card path");
  if (card.path !== `people/${card.metadata.github}.md`)
    throw new Error("path/login mismatch");
  if (!/^[A-Za-z0-9-]+$/u.test(card.metadata.github))
    throw new Error("invalid github login");
  if (!/^\d+$/u.test(card.metadata.githubId))
    throw new Error("invalid github_id");
  if (!/^https:\/\//u.test(card.metadata.avatar))
    throw new Error("invalid avatar URL");
  if (
    !Number.isSafeInteger(card.metadata.sourcePr) ||
    card.metadata.sourcePr < 1
  ) {
    throw new Error("invalid source_pr");
  }
  if (!validField(card.contributor.nickname, "nickname", policy))
    throw new Error("invalid nickname");
  if (!validField(card.contributor.exploring, "exploring", policy))
    throw new Error("invalid exploring text");
  if (!validField(card.contributor.message, "message", policy))
    throw new Error("invalid message");
}

export function parseCard(
  input: CardInput,
  options: { path: string; policy: CardPolicy },
): CardParseResult {
  let text: string;
  try {
    text = inputText(input);
  } catch {
    return reject("invalid UTF-8");
  }

  if (text.startsWith("\uFEFF")) return reject("BOM is forbidden");
  if (!text.endsWith("\n")) return reject("Card must end with LF");
  if (hasForbiddenStructure(text))
    return reject("forbidden control or conflict marker");

  const match =
    /^---\ngithub: ([A-Za-z0-9-]+)\ngithub_id: (\d+)\navatar: (https:\/\/[^\n]+)\nsource_pr: (\d+)\n---\n\n# ([^\n]+)\n\n最近在折腾：([^\n]+)\n\n> ([^\n]+)\n$/u.exec(
      text,
    );
  if (!match) return reject("Card does not follow the fixed structure");

  const [, github, githubId, avatar, sourcePr, nickname, exploring, message] =
    match;
  if (
    !github ||
    !githubId ||
    !avatar ||
    !sourcePr ||
    !nickname ||
    !exploring ||
    !message
  ) {
    return reject("Card has missing fields");
  }

  const card: Card = {
    path: options.path,
    metadata: { github, githubId, avatar, sourcePr: Number(sourcePr) },
    contributor: { nickname, exploring, message },
  };

  try {
    validateCard(card, options.policy);
  } catch (error) {
    return reject(error instanceof Error ? error.message : "invalid Card");
  }

  return { ok: true, card };
}

export function renderCard(card: Card, policy: CardPolicy): string {
  validateCard(card, policy);
  return `---\ngithub: ${card.metadata.github}\ngithub_id: ${card.metadata.githubId}\navatar: ${card.metadata.avatar}\nsource_pr: ${card.metadata.sourcePr}\n---\n\n# ${card.contributor.nickname}\n\n最近在折腾：${card.contributor.exploring}\n\n> ${card.contributor.message}\n`;
}

export function renderCardBytes(card: Card, policy: CardPolicy): Uint8Array {
  return encodeUtf8(renderCard(card, policy));
}
