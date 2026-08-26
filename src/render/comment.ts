import type {
  CommentPhase,
  CommentSlot,
  Oid,
  PublishedCardTarget,
  ValidationResult,
} from "../core/model.js";
import { commentActionKey } from "../core/model.js";

const MARKER = "hello-from-main";

export type RenderedComment = {
  actionKey: string;
  slot: CommentSlot;
  phase: CommentPhase;
  body: string;
};

export type SetupCommentPayload = {
  runIdentity: string;
  sourcePullRequestNumber: number;
  integrationBranchName: string;
  integrationPullRequestNumber: number;
  rebaseCommand: string;
};

export type ValidationCommentPayload = {
  runIdentity: string;
  sourcePullRequestNumber: number;
  sourceHeadOid: Oid;
  result: ValidationResult;
};

export type ReadyCommentPayload = {
  runIdentity: string;
  originalContributor: string;
  integrationPullRequestNumber: number;
  candidateHeadOid: Oid;
  cardPath: string;
  cardBlobOid: Oid;
};

export type CompletionCommentPayload = {
  runIdentity: string;
  targetPullRequestNumber: number;
  slot?: CommentSlot;
  target: PublishedCardTarget;
};

export function renderSetupComment(
  input: SetupCommentPayload,
): RenderedComment {
  const actionKey = key(
    input.runIdentity,
    input.sourcePullRequestNumber,
    "source-status",
  );
  return rendered(actionKey, "source-status", "setup", [
    "## Integration setup",
    `Contribution PR #${input.sourcePullRequestNumber} is connected to Integration PR #${input.integrationPullRequestNumber}.`,
    `Integration branch: \`${escapeInline(input.integrationBranchName)}\``,
    "Project automation owns the integration branch and the Integration PR; the contributor owns the Contribution PR and rebase.",
    `Run \`${escapeInline(input.rebaseCommand)}\` against the integration branch, resolve the Card yourself, then push with force-with-lease.`,
  ]);
}

export function renderValidationComment(
  input: ValidationCommentPayload,
): RenderedComment {
  const invalid = input.result.kind === "invalid";
  const phase = invalid ? "validation-feedback" : "validation-success";
  const details =
    invalid && input.result.kind === "invalid"
      ? input.result.issues
          .map(
            (issue) =>
              `- ${escapeInline(issue.category)}${issue.path ? ` (${escapeInline(issue.path)})` : ""}${issue.field ? `: ${escapeInline(issue.field)}` : ""}`,
          )
          .join("\n")
      : "All current Card identity, structure, safety, and integration-base checks passed for this source head.";
  const actionKey = key(
    input.runIdentity,
    input.sourcePullRequestNumber,
    "source-status",
  );
  return rendered(actionKey, "source-status", phase, [
    invalid ? "## Card validation needs changes" : "## Card validation passed",
    `Source head: \`${escapeInline(input.sourceHeadOid)}\``,
    details,
    invalid
      ? "The Contribution PR remains blocked until a new head passes validation."
      : "The Contribution PR can proceed to automated acceptance.",
  ]);
}

export function renderReadyComment(
  input: ReadyCommentPayload,
): RenderedComment {
  const actionKey = key(
    input.runIdentity,
    input.integrationPullRequestNumber,
    "integration-status",
  );
  return rendered(actionKey, "integration-status", "ready-guidance", [
    "## Ready for your confirmation",
    `Original Contributor: ${escapeInline(input.originalContributor)}`,
    `Integration PR #${input.integrationPullRequestNumber} candidate head: \`${escapeInline(input.candidateHeadOid)}\``,
    `Card: \`${escapeInline(input.cardPath)}\` (blob \`${escapeInline(input.cardBlobOid)}\`)`,
    "Please inspect your Card and approve this Integration PR. Approval confirms the Card only; it grants no merge permission and does not approve the generated README.",
  ]);
}

export function derivePublishedCardLinks(target: PublishedCardTarget): {
  cardUrl: string;
  sourcePullRequestUrl: string;
} {
  assertPublishedCardTargetShape(target);
  return {
    cardUrl: `${target.webBaseUrl}/${target.owner}/${target.repo}/blob/${target.publishedMainOid}/${encodeURIComponent(target.cardPath)}`,
    sourcePullRequestUrl: `${target.webBaseUrl}/${target.owner}/${target.repo}/pull/${target.sourcePullRequestNumber}`,
  };
}

export function renderCompletionComment(
  input: CompletionCommentPayload,
): RenderedComment {
  const links = derivePublishedCardLinks(input.target);
  const slot = input.slot ?? "source-status";
  const actionKey = key(input.runIdentity, input.targetPullRequestNumber, slot);
  return rendered(actionKey, slot, "completion", [
    "## Tutorial Run complete",
    `Published Card: [open Card](${links.cardUrl})`,
    `Source Contribution PR: [open PR](${links.sourcePullRequestUrl})`,
    `Published main: \`${escapeInline(input.target.publishedMainOid)}\``,
  ]);
}

function key(
  runIdentity: string,
  targetPullRequestNumber: number,
  slot: CommentSlot,
): string {
  return commentActionKey({ runIdentity, targetPullRequestNumber, slot });
}

function rendered(
  actionKey: string,
  slot: CommentSlot,
  phase: CommentPhase,
  lines: readonly string[],
): RenderedComment {
  return {
    actionKey,
    slot,
    phase,
    body: `<!-- ${MARKER}: key=${escapeMarker(actionKey)} phase=${phase} -->\n${lines.join("\n")}\n`,
  };
}

function escapeInline(value: string): string {
  assertSafeText(value);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeMarker(value: string): string {
  assertSafeText(value);
  return value
    .replaceAll("--", "- -")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E");
}

function assertSafeText(value: string): void {
  if (/[`\\[\]()!#*_~|]/u.test(value))
    throw new Error("comment text contains unsafe Markdown delimiters");
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
    )
      throw new Error("comment text contains forbidden control characters");
  }
}

function assertPublishedCardTargetShape(target: PublishedCardTarget): void {
  if (
    !/^https:\/\/[^/?#]+$/u.test(target.webBaseUrl) ||
    !/^[A-Za-z0-9._-]+$/u.test(target.owner) ||
    !/^[A-Za-z0-9._-]+$/u.test(target.repo) ||
    !/^[0-9a-f]{40}$/iu.test(target.publishedMainOid) ||
    !/^[0-9a-f]{40}$/iu.test(target.expectedCardBlobOid) ||
    !/^people\/[A-Za-z0-9._+-]+\.md$/u.test(target.cardPath) ||
    target.cardPath.includes("..") ||
    !Number.isSafeInteger(target.sourcePullRequestNumber) ||
    target.sourcePullRequestNumber < 1
  )
    throw new Error("invalid PublishedCardTarget");
}
