import { createHash } from "node:crypto";

export type Oid = string & { readonly __brand: "Oid" };

export function oid(value: string): Oid {
  if (value.length === 0) throw new Error("OID must not be empty");
  return value as Oid;
}

export function gitBlobOid(bytes: Uint8Array): Oid {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return oid(createHash("sha1").update(header).update(bytes).digest("hex"));
}

export type Provenance = "provider" | "modeled" | "observed" | "derived";

export type ObservationStatus =
  | "absent"
  | "notVisibleYet"
  | "readFailed"
  | "incomplete"
  | "pending"
  | "ready"
  | "conclusiveFailure";

export type Observation<T> = {
  status: ObservationStatus;
  observedOid?: Oid;
  provenance?: Provenance;
  value?: T;
  error?: string;
};

export type OidBound<T> = T & {
  observedOid: Oid;
  provenance: Provenance;
};

export type PullRequestKind = "contribution" | "integration";

export type PullRequestFact = OidBound<{
  number: number;
  nodeId?: string;
  kind: PullRequestKind;
  headOid: Oid;
  baseOid: Oid;
  headRef?: string;
  baseRef?: string;
  draft: boolean;
  /** Provider merge/closure facts remain meaningful after the PR is retargeted. */
  merged?: boolean;
  closed?: boolean;
  mergeCommitOid?: Oid;
  mergeParentOids?: readonly Oid[];
  authorLogin?: string;
  /** Immutable numeric identity returned by the provider's user API. */
  authorGithubId?: string;
  authorAvatarUrl?: string;
  headRepositoryOwnerLogin?: string;
  headRepositoryIsFork?: boolean;
  changedFiles?: readonly {
    path: string;
    blobOid: Oid;
    bytes: Uint8Array;
  }[];
  changedFilesComplete?: boolean;
  runKey?: string;
}>;

export type BranchAnchor = {
  name: string;
  headOid: Oid;
  provenance: Provenance;
};

/** A provider or Git-derived proof that the Integration head is in the source head's ancestry. */
export type SourceHeadAncestry = OidBound<{
  integrationHeadOid: Oid;
  sourceHeadOid: Oid;
  isAncestor: boolean;
}>;

export type ProviderEligibility = {
  checks: Observation<readonly CheckFact[]>;
  reviews: Observation<readonly ReviewFact[]>;
  mergeability: Observation<"mergeable" | "conflicting" | null>;
  baseCurrent: Observation<boolean>;
};

export type RepositoryFacts = {
  main: Observation<{
    oid: Oid;
    readmeBytes?: Uint8Array;
    cardManifests: readonly CardManifest[];
    cardPayloads?: readonly CardPayload[];
  }>;
  sourcePullRequest: Observation<PullRequestFact>;
  sourceHeadBasedOnIntegration?: Observation<SourceHeadAncestry>;
  integrationBranch: Observation<BranchAnchor>;
  integrationPullRequest: Observation<PullRequestFact>;
  candidate: Observation<CandidateFact>;
  eligibility: ProviderEligibility;
  confirmations: readonly Confirmation[];
  /** Identities already published on main, plus identities anchored by another run. */
  publishedGithubIds?: readonly string[];
  activeGithubIds?: readonly string[];
  acceptedCard?: {
    path: string;
    bytes: Uint8Array;
    readmeBytes?: Uint8Array;
    githubId: string;
    sourcePrNumber: number;
  };
  protocolAnchors?: {
    contribution?: {
      projectShellOid: Oid;
      rebasedContributorOid: Oid;
    };
    integration?: {
      mainBeforePublicationOid: Oid;
      candidateOid: Oid;
    };
  };
  comments?: readonly CommentFact[];
  trustedCommentOwner?: TrustedPrincipal;
  trustedRepository?: TrustedRepositoryContext;
};

export type CommentSlot = "source-status" | "integration-status";
export type CommentPhase =
  | "setup"
  | "validation-feedback"
  | "validation-success"
  | "ready-guidance"
  | "completion";

export type ActorType = "Bot" | "User";

export type TrustedPrincipal = {
  actorId: string;
  actorType: ActorType;
};

export type CommentUser = {
  id: string;
  actorType: ActorType;
  login?: string;
};

export type CommentFact = {
  id: number;
  user: CommentUser | null;
  ownerPrincipal: TrustedPrincipal;
  actionKey: string;
  body: string;
  updatedAt?: string;
  targetPullRequestNumber: number;
};

export type CommentIntent = {
  targetPullRequestNumber: number;
  slot: CommentSlot;
  actionKey: string;
  phase: CommentPhase;
  body: string;
  observed?: CommentFact;
};

export type CommentEnsureResult =
  | { kind: "created"; comment: CommentFact }
  | { kind: "updated"; comment: CommentFact }
  | { kind: "alreadyApplied"; comment: CommentFact }
  | { kind: "noOp"; comment: CommentFact }
  | { kind: "ambiguousOwnership" }
  | { kind: "stale" }
  | { kind: "permissionDenied"; detail?: string }
  | { kind: "notVisibleYet"; detail?: string }
  | { kind: "retryableTransport"; detail?: string }
  | { kind: "capabilityUnavailable"; detail?: string }
  | { kind: "unknownOutcome"; detail?: string };

export type TrustedRepositoryContext = {
  webBaseUrl: string;
  owner: string;
  repo: string;
};

export type PublishedCardTarget = {
  webBaseUrl: string;
  owner: string;
  repo: string;
  publishedMainOid: Oid;
  cardPath: string;
  expectedCardBlobOid: Oid;
  sourcePullRequestNumber: number;
};

export type PublishedCardTargetReadback = {
  publishedMainOid: Oid;
  cardPath: string;
  expectedCardBlobOid: Oid;
  actualCardBlobOid: Oid;
  expectedCardBytes: Uint8Array;
  actualCardBytes: Uint8Array;
  sourcePullRequestNumber: number;
};

export type PublishedCardTargetResult =
  | { ok: true; target: PublishedCardTarget }
  | { ok: false; reason: string };

export type CommentMutationPlan =
  | { kind: "create" }
  | { kind: "update"; comment: CommentFact }
  | { kind: "noOp"; comment: CommentFact }
  | { kind: "ambiguousOwnership" }
  | { kind: "stale" };

export type ValidationCategory =
  | "intake-author-or-fork"
  | "intake-ref-or-path"
  | "change-scope"
  | "identity-or-metadata"
  | "card-grammar-or-template"
  | "card-safety"
  | "integration-base-or-ancestry"
  | "valid";

export type ValidationIssue = {
  category: Exclude<ValidationCategory, "valid">;
  path?: string;
  field?: string;
  detail?: string;
};

export type ValidationResult =
  | { kind: "valid"; headOid: Oid }
  | {
      kind: "invalid";
      headOid?: Oid;
      issues: readonly ValidationIssue[];
      blocksMerge: true;
    };

export function commentActionKey(input: {
  runIdentity: string;
  targetPullRequestNumber: number;
  slot: CommentSlot;
}): string {
  if (
    !input.runIdentity ||
    !Number.isSafeInteger(input.targetPullRequestNumber)
  )
    throw new Error("comment action key inputs are invalid");
  return `run=${input.runIdentity};target=${input.targetPullRequestNumber};slot=${input.slot}`;
}

export function commentOwnership(
  fact: CommentFact,
  expected: TrustedPrincipal | undefined,
): "owned" | "notOwned" {
  if (
    !expected ||
    !fact.user ||
    !canonicalActorId(expected.actorId) ||
    !canonicalActorId(fact.user.id)
  )
    return "notOwned";
  return fact.user.id === expected.actorId &&
    fact.user.actorType === expected.actorType &&
    fact.ownerPrincipal.actorId === expected.actorId &&
    fact.ownerPrincipal.actorType === expected.actorType
    ? "owned"
    : "notOwned";
}

export function planCommentMutation(
  intent: CommentIntent,
  comments: readonly CommentFact[],
  expected: TrustedPrincipal | undefined,
): CommentMutationPlan {
  if (!expected || !canonicalActorId(expected.actorId))
    return { kind: "ambiguousOwnership" };
  const matches = comments.filter(
    (comment) =>
      comment.actionKey === intent.actionKey &&
      comment.targetPullRequestNumber === intent.targetPullRequestNumber,
  );
  if (
    comments.some(
      (comment) =>
        comment.actionKey === intent.actionKey &&
        comment.targetPullRequestNumber !== intent.targetPullRequestNumber,
    )
  )
    return { kind: "ambiguousOwnership" };
  if (matches.length === 0) return { kind: "create" };
  const owned = matches.filter(
    (comment) => commentOwnership(comment, expected) === "owned",
  );
  if (owned.length !== 1 || owned.length !== matches.length)
    return { kind: "ambiguousOwnership" };
  const current = owned[0];
  if (!current) return { kind: "ambiguousOwnership" };
  if (
    intent.observed &&
    (current.id !== intent.observed.id ||
      current.actionKey !== intent.observed.actionKey ||
      current.body !== intent.observed.body ||
      current.ownerPrincipal.actorId !==
        intent.observed.ownerPrincipal.actorId ||
      current.ownerPrincipal.actorType !==
        intent.observed.ownerPrincipal.actorType)
  )
    return { kind: "stale" };
  return current.body === intent.body
    ? { kind: "noOp", comment: current }
    : { kind: "update", comment: current };
}

function canonicalActorId(value: string): boolean {
  return /^[1-9][0-9]*$/u.test(value);
}

export function createPublishedCardTarget(
  repository: TrustedRepositoryContext,
  readback: PublishedCardTargetReadback,
): PublishedCardTargetResult {
  if (!/^https:\/\/[^/?#]+$/u.test(repository.webBaseUrl))
    return { ok: false, reason: "untrusted web base" };
  if (
    !/^[A-Za-z0-9._-]+$/u.test(repository.owner) ||
    !/^[A-Za-z0-9._-]+$/u.test(repository.repo)
  )
    return { ok: false, reason: "invalid repository identity" };
  if (
    !/^[0-9a-f]{40}$/iu.test(readback.publishedMainOid) ||
    !/^[0-9a-f]{40}$/iu.test(readback.expectedCardBlobOid) ||
    readback.expectedCardBlobOid !== readback.actualCardBlobOid
  )
    return { ok: false, reason: "invalid or mismatched Git OID" };
  if (
    !/^people\/[A-Za-z0-9._+-]+\.md$/u.test(readback.cardPath) ||
    readback.cardPath.includes("..")
  )
    return { ok: false, reason: "invalid Card path" };
  if (
    !Number.isSafeInteger(readback.sourcePullRequestNumber) ||
    readback.sourcePullRequestNumber < 1
  )
    return { ok: false, reason: "invalid source pull request" };
  if (!bytesEqual(readback.expectedCardBytes, readback.actualCardBytes))
    return { ok: false, reason: "Card blob bytes do not match" };
  if (gitBlobOid(readback.actualCardBytes) !== readback.expectedCardBlobOid)
    return { ok: false, reason: "Card blob OID does not match bytes" };
  return {
    ok: true,
    target: {
      ...repository,
      publishedMainOid: readback.publishedMainOid,
      cardPath: readback.cardPath,
      expectedCardBlobOid: readback.expectedCardBlobOid,
      sourcePullRequestNumber: readback.sourcePullRequestNumber,
    },
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export type CheckFact = OidBound<{
  pullRequestNumber: number;
  prHeadOid: Oid;
  state: "queued" | "inProgress" | "success" | "failure";
}>;

export type ReviewFact = OidBound<{
  pullRequestNumber: number;
  prHeadOid: Oid;
  reviewerLogin: string;
  state: "approved" | "changesRequested" | "dismissed" | "commented";
  reviewedCommitOid: Oid;
}>;

export type CandidateFact = OidBound<{
  integrationHeadOid: Oid;
  mainOid?: Oid;
  cardPath: string;
  cardBlobOid: Oid;
  readmeBlobOid: Oid;
  readmeBytes?: Uint8Array;
  retainedCommitOids?: readonly Oid[];
  requiredParentOids?: readonly Oid[];
}>;

export type Confirmation = {
  kind: "domainConfirmation";
  contributorLogin: string;
  githubId: string;
  sourcePrNumber: number;
  integrationPrNumber: number;
  reviewedCommitOid: Oid;
  cardPath: string;
  cardBlobOid: Oid;
};

export type CardManifest = {
  path: string;
  blobOid: Oid;
  githubId: string;
  sourcePrNumber: number;
};

export type CardPayload = CardManifest & {
  bytes: Uint8Array;
};

export type HistoryPostconditions = {
  retainCommitOids: readonly Oid[];
  requiredParentOids: readonly Oid[];
};

export type CandidateWriteInput = {
  observedMainOid: Oid;
  expectedIntegrationHeadOid: Oid;
  cardPath: string;
  cardBytes: Uint8Array;
  readmeBytes: Uint8Array;
  preserveConfirmedCardBlobOid?: Oid;
};

export type CandidateWritePostconditions = {
  managedCard?: Omit<CardManifest, "blobOid">;
  cardManifest: CardManifest;
  readmeBlobOid: Oid;
  history: HistoryPostconditions;
};

export type CandidateWrite = {
  input: CandidateWriteInput;
  postconditions: CandidateWritePostconditions;
};

/** The only outcomes a candidate mutation may report to Core. */
export type CandidateWriteResult =
  | { kind: "succeeded"; value: WorkspaceReadback }
  | { kind: "alreadyApplied"; value: WorkspaceReadback }
  | { kind: "staleLease" }
  | { kind: "staleMain" }
  | { kind: "policyPostcondition"; detail?: string }
  | { kind: "retryableTransport"; detail?: string }
  | { kind: "unknownOutcome"; detail?: string };

export type ContributionMergeRequest = {
  kind: "contribution";
  pullRequestNumber: number;
  expectedHeadOid: Oid;
};

export type IntegrationMergeRequest = {
  kind: "integration";
  pullRequestNumber: number;
  expectedHeadOid: Oid;
  observedBaseOid: Oid;
  baseCurrentGate: "required" | "unsupported";
};

export type OperationResultCategory =
  | "permissionDenied"
  | "rateLimited"
  | "notVisibleYet"
  | "notFound"
  | "stalePrecondition"
  | "policyRejected"
  | "retryableTransport"
  | "unknownOutcome"
  | "alreadyApplied";

export type OperationSuccess<T> = {
  kind: "succeeded";
  value: T;
};

export type OperationResult<T> =
  | OperationSuccess<T>
  | { kind: "alreadyApplied"; value: T }
  | {
      kind: Exclude<OperationResultCategory, "alreadyApplied">;
      retryAfterSeconds?: number;
      detail?: string;
    };

export type ContributionMergeResult =
  | { kind: "contributionMerged"; headOid: Oid }
  | { kind: "contributionAlreadyApplied"; headOid: Oid }
  | {
      kind: "contributionRejected";
      reason: Exclude<OperationResultCategory, "alreadyApplied">;
    };

export type IntegrationMergeResult =
  | { kind: "integrationMerged"; mainOid: Oid }
  | {
      kind: "integrationAlreadyApplied";
      mainOid: Oid;
      publicationEstablishedByCurrentOperation?: true;
    }
  | {
      kind: "integrationRejected";
      reason:
        | Exclude<OperationResultCategory, "alreadyApplied">
        | "baseMoved"
        | "gateRejected"
        | "gateUnsupported";
    };

export type ReconcileBudget = {
  maxEffects: number;
  deadlineMs?: number;
};

export type ReconcileOutcome =
  | { kind: "quiescent" }
  | {
      kind: "awaitingExternalFact";
      reason: "awaitingApproval" | "notVisibleYet" | "pending" | "incomplete";
    }
  | {
      kind: "retryable";
      reason: "retryableTransport" | "stalePrecondition" | "unknownOutcome";
    }
  | { kind: "budgetExhausted"; effects: number }
  | {
      kind: "terminal";
      reason:
        | "permissionDenied"
        | "notFound"
        | "policyRejected"
        | "capabilityUnavailable";
    };

export type SetupMutationResult = OperationResult<{
  branch?: BranchAnchor;
  pullRequest?: PullRequestFact;
  setupEstablishedByCurrentOperation?: true;
}>;

export type ReadyReadback =
  | {
      kind: "readyAtExpectedCandidate";
      pullRequest: PullRequestFact;
      candidate: CandidateFact;
    }
  | {
      kind: "alreadyReadyAtExpectedCandidate";
      pullRequest: PullRequestFact;
      candidate: CandidateFact;
    }
  | { kind: "headChanged"; observedHeadOid: Oid }
  | {
      kind: "blocked";
      reason: Exclude<OperationResultCategory, "alreadyApplied">;
    };

export type WorkspaceReadback = {
  status: ObservationStatus;
  integrationHeadOid?: Oid;
  candidate?: CandidateFact;
  readmeBlobOid?: Oid;
  retainedCommitOids?: readonly Oid[];
  requiredParentOids?: readonly Oid[];
};

export type FinalMainPostconditions = {
  mainOid: Oid;
  cardManifest: CardManifest;
  readmeBytes: Uint8Array;
  /** Optional Git readback bytes required before a permalink target is trusted. */
  cardBytes?: Uint8Array;
  retainedCommitOids: readonly Oid[];
  requiredParentOids: readonly Oid[];
  sourceMergeCommitOid?: Oid;
  integrationMergeCommitOid?: Oid;
  contributionMergeParentOids?: readonly Oid[];
  integrationMergeParentOids?: readonly Oid[];
};
