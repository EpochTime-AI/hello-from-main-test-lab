import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  BranchAnchor,
  CommentEnsureResult,
  CommentFact,
  CommentIntent,
  ContributionMergeRequest,
  ContributionMergeResult,
  IntegrationMergeRequest,
  IntegrationMergeResult,
  Observation,
  Provenance,
  PullRequestFact,
  ReadyReadback,
  ReconcileOutcome,
  RepositoryFacts,
} from "../core/model.js";
import { gitBlobOid, oid, planCommentMutation } from "../core/model.js";
import { createActionComposition } from "../entry/action.js";
import { productionCandidatePolicy } from "../entry/policy.js";
import type { GitWorkspace } from "../ports/git-workspace.js";
import type { GithubPlatform } from "../ports/github-platform.js";
import type { TrustedActionContext } from "./action-context.js";

type MergeWorkspace = Pick<GitWorkspace, "readWorkspace"> &
  Partial<
    Pick<
      GitWorkspace,
      | "createIntegrationBranchWithProjectShell"
      | "writeIntegrationCandidate"
      | "readFinalMainPostconditions"
    >
  > & {
    mergeNoFastForward?: (input: {
      sourceRef: string;
      expectedTargetOid: ReturnType<typeof oid>;
      message: string;
    }) => Promise<{
      mergeCommitOid: ReturnType<typeof oid>;
      parents: readonly ReturnType<typeof oid>[];
    }>;
    isAncestor?: (
      ancestor: ReturnType<typeof oid>,
      descendant: string,
      expectedSourceOid: ReturnType<typeof oid>,
    ) => Promise<{
      isAncestor: boolean;
      sourceHeadOid: ReturnType<typeof oid>;
    }>;
  };

export type LocalGithubPlatformOptions = {
  facts: RepositoryFacts;
  workspace: MergeWorkspace;
  contributionWorkspace?: MergeWorkspace;
  integrationWorkspace?: MergeWorkspace;
  refs: {
    contribution: string;
    integration: string;
  };
  mergeTarget?: "contribution" | "integration";
  /** Test-only versioned semantic snapshot. */
  stateFile?: string;
  onEffect?: (effect: LocalEffectRecord) => void;
  afterPersistBeforeReturn?: (
    intent: CommentIntent,
  ) => Extract<CommentEnsureResult, { kind: "unknownOutcome" }> | undefined;
};

export type LocalEffectRecord = {
  kind: "create" | "update" | "noOp" | "wrongTarget";
  attempted: true;
  completed: boolean;
  targetPullRequestNumber: number;
  actionKey: string;
  body: string;
};

export type LocalActionEvent =
  | { kind: "wake" }
  | {
      kind: "push";
      actorLogin: string;
      sourcePrNumber: number;
      headOid: ReturnType<typeof oid>;
      cardBytes: Uint8Array;
    }
  | { kind: "checksCompleted"; candidateOid: ReturnType<typeof oid> }
  | {
      kind: "approval";
      actorLogin: string;
      sourcePrNumber: number;
      integrationPrNumber: number;
      candidateOid: ReturnType<typeof oid>;
    };

export type LocalActionSeed = {
  facts: RepositoryFacts;
  actionContext: TrustedActionContext;
  integrationWorkspace?: MergeWorkspace;
  contributionWorkspace?: MergeWorkspace;
  onEffect?: (effect: LocalEffectRecord) => void;
  /** Test-only uncertainty injected after a comment mutation is durable. */
  afterPersistBeforeReturn?: (
    intent: CommentIntent,
  ) => Extract<CommentEnsureResult, { kind: "unknownOutcome" }> | undefined;
};

export type LocalActionRun = {
  platform: GithubPlatform & { fixture: LocalFixtureActions };
  composition: ReturnType<typeof createActionComposition>;
  wake: (input?: { maxEffects?: number }) => Promise<ReconcileOutcome>;
  close: () => Promise<void>;
};

export type LocalActionRealGit = {
  workspace: MergeWorkspace;
  integrationWorkspace?: MergeWorkspace;
  contributionWorkspace?: MergeWorkspace;
  refs: { contribution: string; integration: string };
};

export type LocalFixtureActions = {
  recordContributorPush(input: {
    actorLogin: string;
    sourcePrNumber: number;
    headOid: ReturnType<typeof oid>;
    cardBytes: Uint8Array;
  }): void;
  recordChecksCompleted(candidateOid: ReturnType<typeof oid>): void;
  recordContributorApproval(input: {
    actorLogin: string;
    sourcePrNumber: number;
    integrationPrNumber: number;
    candidateOid: ReturnType<typeof oid>;
  }): void;
};

export class LocalPlatformOperationError extends Error {
  constructor(
    public readonly category:
      | "stalePrecondition"
      | "policyRejected"
      | "notFound"
      | "unknownOutcome",
    message: string,
  ) {
    super(message);
  }
}

export function createLocalGithubPlatform(
  options: LocalGithubPlatformOptions,
): GithubPlatform & { fixture: LocalFixtureActions } {
  const hadStateFile =
    options.stateFile !== undefined && existsSync(options.stateFile);
  let state = loadState(options.stateFile, options.facts);
  const stateFile = options.stateFile;
  let nextPullRequestNumber = maxPullRequestNumber(state) + 1;
  let nextCommentId = maxCommentId(state) + 1;
  const persist = () => persistState(stateFile, state);
  const afterPersist = (intent: CommentIntent) =>
    options.afterPersistBeforeReturn?.(intent);
  const effect = (value: LocalEffectRecord) => options.onEffect?.(value);

  const fixture: LocalFixtureActions = {
    recordContributorPush(input) {
      const source = requiredValue(
        state.sourcePullRequest,
        "source pull request",
      );
      if (
        source.number !== input.sourcePrNumber ||
        source.authorLogin !== input.actorLogin ||
        source.headRepositoryOwnerLogin !== input.actorLogin ||
        source.headRepositoryIsFork !== true
      )
        throw new LocalPlatformOperationError(
          "policyRejected",
          "invalid contributor push actor or source",
        );
      const changed = source.changedFiles?.[0];
      if (!changed || source.changedFiles?.length !== 1)
        throw new LocalPlatformOperationError(
          "policyRejected",
          "source intake is incomplete",
        );
      const updated = modeledPullRequest({
        ...source,
        headOid: input.headOid,
        changedFiles: [
          {
            ...changed,
            bytes: input.cardBytes,
            blobOid: gitBlobOid(input.cardBytes),
          },
        ],
      });
      state = { ...state, sourcePullRequest: modeledObservation(updated) };
      persist();
    },
    recordChecksCompleted(candidateOid) {
      const integration = requiredValue(
        state.integrationPullRequest,
        "integration pull request",
      );
      if (integration.headOid !== candidateOid)
        throw new LocalPlatformOperationError(
          "stalePrecondition",
          "checks do not match current candidate",
        );
      state = {
        ...state,
        eligibility: {
          ...state.eligibility,
          checks: modeledObservation([
            {
              pullRequestNumber: integration.number,
              prHeadOid: candidateOid,
              state: "success",
              observedOid: candidateOid,
              provenance: "observed",
            },
          ]),
        },
      };
      persist();
    },
    recordContributorApproval(input) {
      const source = requiredValue(
        state.sourcePullRequest,
        "source pull request",
      );
      const integration = requiredValue(
        state.integrationPullRequest,
        "integration pull request",
      );
      const candidate = requiredValue(state.candidate, "candidate");
      if (
        source.number !== input.sourcePrNumber ||
        source.authorLogin !== input.actorLogin ||
        integration.number !== input.integrationPrNumber ||
        integration.headOid !== input.candidateOid ||
        candidate.integrationHeadOid !== input.candidateOid
      )
        throw new LocalPlatformOperationError(
          "stalePrecondition",
          "approval does not match current candidate",
        );
      state = {
        ...state,
        eligibility: {
          ...state.eligibility,
          reviews: modeledObservation([
            {
              pullRequestNumber: integration.number,
              prHeadOid: input.candidateOid,
              reviewerLogin: input.actorLogin,
              state: "approved",
              reviewedCommitOid: input.candidateOid,
              observedOid: input.candidateOid,
              provenance: "observed",
            },
          ]),
        },
        confirmations: [
          {
            kind: "domainConfirmation",
            contributorLogin: input.actorLogin,
            githubId: source.authorGithubId ?? "",
            sourcePrNumber: source.number,
            integrationPrNumber: integration.number,
            reviewedCommitOid: input.candidateOid,
            cardPath: candidate.cardPath,
            cardBlobOid: candidate.cardBlobOid,
          },
        ],
        protocolAnchors: {
          ...state.protocolAnchors,
          integration: {
            mainBeforePublicationOid:
              candidate.mainOid ?? state.main.value?.oid ?? input.candidateOid,
            candidateOid: input.candidateOid,
          },
        },
      };
      persist();
    },
  };

  const mergeIntegration = async (
    request: IntegrationMergeRequest,
  ): Promise<IntegrationMergeResult> => {
    const integration = state.integrationPullRequest.value;
    const main = state.main.value;
    const branch = state.integrationBranch.value;
    if (
      !integration ||
      !main ||
      !branch ||
      integration.number !== request.pullRequestNumber
    )
      return { kind: "integrationRejected", reason: "notFound" };
    if (integration.headOid !== request.expectedHeadOid)
      return { kind: "integrationRejected", reason: "stalePrecondition" };
    if (request.baseCurrentGate === "unsupported")
      return { kind: "integrationRejected", reason: "gateUnsupported" };
    if (
      state.eligibility.baseCurrent.status !== "ready" ||
      state.eligibility.baseCurrent.value !== true
    )
      return { kind: "integrationRejected", reason: "gateRejected" };
    if (request.observedBaseOid !== main.oid)
      return { kind: "integrationRejected", reason: "baseMoved" };
    const result = await merge(
      options.integrationWorkspace ?? options.workspace,
      options.refs.integration,
      main.oid,
      `Merge integration PR #${request.pullRequestNumber}`,
    );
    if (result.kind !== "merged")
      return { kind: "integrationRejected", reason: result.reason };
    state = {
      ...state,
      main: modeledObservation({ ...main, oid: result.oid }),
      integrationPullRequest: modeledObservation(
        modeledPullRequest({
          ...integration,
          merged: true,
          closed: true,
          mergeCommitOid: result.oid,
          mergeParentOids: result.parents,
        }),
      ),
    };
    persist();
    return { kind: "integrationMerged", mainOid: result.oid };
  };

  const platform = {
    async ensureComment(intent: CommentIntent): Promise<CommentEnsureResult> {
      const targetExists = [
        intent.slot === "source-status"
          ? state.sourcePullRequest.value?.number
          : state.integrationPullRequest.value?.number,
      ].includes(intent.targetPullRequestNumber);
      if (!targetExists) {
        effect({
          kind: "wrongTarget",
          attempted: true,
          completed: false,
          targetPullRequestNumber: intent.targetPullRequestNumber,
          actionKey: intent.actionKey,
          body: intent.body,
        });
        return {
          kind: "notVisibleYet",
          detail: "comment target is not a Local PR",
        };
      }
      const plan = planCommentMutation(
        intent,
        state.comments ?? [],
        state.trustedCommentOwner,
      );
      if (plan.kind === "ambiguousOwnership") {
        effect({
          kind: "wrongTarget",
          attempted: true,
          completed: false,
          targetPullRequestNumber: intent.targetPullRequestNumber,
          actionKey: intent.actionKey,
          body: intent.body,
        });
        return plan;
      }
      if (plan.kind === "stale") return plan;
      if (plan.kind === "create") {
        const owner = state.trustedCommentOwner;
        if (!owner) return { kind: "ambiguousOwnership" };
        const comment: CommentFact = {
          id: nextCommentId++,
          user: { id: owner.actorId, actorType: owner.actorType },
          ownerPrincipal: owner,
          actionKey: intent.actionKey,
          body: intent.body,
          targetPullRequestNumber: intent.targetPullRequestNumber,
        };
        state = { ...state, comments: [...(state.comments ?? []), comment] };
        persist();
        const uncertain = afterPersist(intent);
        const record: LocalEffectRecord = {
          kind: "create",
          attempted: true,
          completed: true,
          targetPullRequestNumber: intent.targetPullRequestNumber,
          actionKey: intent.actionKey,
          body: intent.body,
        };
        effect(record);
        if (uncertain) return uncertain;
        return { kind: "created", comment };
      }
      if (plan.kind === "noOp") {
        effect({
          kind: "noOp",
          attempted: true,
          completed: true,
          targetPullRequestNumber: intent.targetPullRequestNumber,
          actionKey: intent.actionKey,
          body: intent.body,
        });
        return { kind: "noOp", comment: plan.comment };
      }
      const comment = {
        ...plan.comment,
        body: intent.body,
      };
      state = {
        ...state,
        comments: (state.comments ?? []).map((item) =>
          item.id === comment.id ? comment : item,
        ),
      };
      persist();
      const uncertain = afterPersist(intent);
      const record: LocalEffectRecord = {
        kind: "update",
        attempted: true,
        completed: true,
        targetPullRequestNumber: intent.targetPullRequestNumber,
        actionKey: intent.actionKey,
        body: intent.body,
      };
      effect(record);
      if (uncertain) return uncertain;
      return { kind: "updated", comment };
    },
    async observeRepository() {
      state = {
        ...state,
      };
      const workspace = await options.workspace.readWorkspace();
      const mainWorkspace = options.integrationWorkspace ?? options.workspace;
      const mainReadback = await mainWorkspace.readWorkspace();
      if (workspace.status === "ready" && workspace.value?.candidate)
        validateWorkspaceProjection(workspace.value, workspace.value.candidate);
      if (mainReadback.status === "ready" && mainReadback.value?.candidate)
        validateWorkspaceProjection(
          mainReadback.value,
          mainReadback.value.candidate,
        );
      if (workspace.status === "ready" && workspace.value) {
        const main = state.main.value;
        const candidate = workspace.value.candidate;
        const reconstructedBranch =
          workspace.value.integrationHeadOid && !state.integrationBranch.value
            ? {
                name: `feature/card-${state.sourcePullRequest.value?.authorLogin ?? "source"}-source-${state.sourcePullRequest.value?.number ?? 0}`,
                headOid: workspace.value.integrationHeadOid,
                provenance: "observed" as const,
              }
            : undefined;
        if (
          state.integrationBranch.value &&
          workspace.value.integrationHeadOid &&
          workspace.value.integrationHeadOid !==
            state.integrationBranch.value.headOid &&
          !workspace.value.candidate
        )
          throw new LocalPlatformOperationError(
            "stalePrecondition",
            "Git workspace projection does not match Local branch state",
          );
        state = {
          ...state,
          candidate: workspace.value.candidate
            ? {
                status: "ready",
                provenance: "observed",
                observedOid: workspace.value.candidate.observedOid,
                value: workspace.value.candidate,
              }
            : state.candidate,
          main:
            main && candidate?.mainOid
              ? modeledObservation({
                  ...main,
                  oid: candidate.mainOid,
                  ...((candidate.readmeBytes ?? main.readmeBytes)
                    ? { readmeBytes: candidate.readmeBytes ?? main.readmeBytes }
                    : {}),
                  cardManifests: candidate
                    ? [
                        ...main.cardManifests.filter(
                          (card) => card.path !== candidate.cardPath,
                        ),
                        {
                          path: candidate.cardPath,
                          blobOid: candidate.cardBlobOid,
                          githubId:
                            state.sourcePullRequest.value?.authorGithubId ?? "",
                          sourcePrNumber:
                            state.sourcePullRequest.value?.number ?? 0,
                        },
                      ]
                    : main.cardManifests,
                })
              : state.main,
          integrationBranch: reconstructedBranch
            ? modeledObservation(reconstructedBranch)
            : workspace.value.integrationHeadOid &&
                state.integrationBranch.value
              ? {
                  status: "ready",
                  provenance: "observed",
                  value: {
                    ...state.integrationBranch.value,
                    headOid: workspace.value.integrationHeadOid,
                    provenance: "observed",
                  },
                }
              : state.integrationBranch,
          integrationPullRequest:
            workspace.value.candidate &&
            workspace.value.integrationHeadOid &&
            state.integrationPullRequest.value
              ? modeledObservation(
                  modeledPullRequest({
                    ...state.integrationPullRequest.value,
                    headOid: workspace.value.integrationHeadOid,
                  }),
                )
              : state.integrationPullRequest,
        };
        if (reconstructedBranch) persist();
      }
      if (
        mainReadback.status === "ready" &&
        mainReadback.value?.integrationHeadOid &&
        state.main.value
      ) {
        const published = mainReadback.value.candidate;
        state = {
          ...state,
          main: modeledObservation({
            ...state.main.value,
            oid: mainReadback.value.integrationHeadOid,
            ...(published?.readmeBytes
              ? { readmeBytes: published.readmeBytes }
              : {}),
            cardManifests: published
              ? [
                  ...state.main.value.cardManifests.filter(
                    (card) => card.path !== published.cardPath,
                  ),
                  {
                    path: published.cardPath,
                    blobOid: published.cardBlobOid,
                    githubId:
                      state.sourcePullRequest.value?.authorGithubId ?? "",
                    sourcePrNumber: state.sourcePullRequest.value?.number ?? 0,
                  },
                ]
              : state.main.value.cardManifests,
          }),
        };
      }
      const integration = state.integrationPullRequest.value;
      const currentMain = state.main.value;
      if (integration && currentMain) {
        // These provider-facing gates are observable from the Local PR topology
        // and the real main workspace, rather than being supplied by a seed.
        state = {
          ...state,
          eligibility: {
            ...state.eligibility,
            mergeability: {
              status: "ready",
              provenance: "derived",
              value: "mergeable",
            },
            baseCurrent: {
              status: "ready",
              provenance: "derived",
              value: integration.baseOid === currentMain.oid,
            },
          },
        };
      }
      const source = state.sourcePullRequest.value;
      const branch = state.integrationBranch.value;
      const ancestryWorkspace =
        options.contributionWorkspace ?? options.workspace;
      if (source && branch && !source.merged && ancestryWorkspace.isAncestor) {
        try {
          const ancestry = await ancestryWorkspace.isAncestor(
            branch.headOid,
            options.refs.contribution,
            source.headOid,
          );
          if (ancestry.sourceHeadOid !== source.headOid)
            throw new Error("source ref moved during ancestry observation");
          state = {
            ...state,
            sourceHeadBasedOnIntegration: {
              status: "ready",
              provenance: "observed",
              value: {
                integrationHeadOid: branch.headOid,
                sourceHeadOid: source.headOid,
                isAncestor: ancestry.isAncestor,
                observedOid: source.headOid,
                provenance: "observed",
              },
            },
          };
        } catch {
          state = {
            ...state,
            sourceHeadBasedOnIntegration: {
              status: "incomplete",
              provenance: "observed",
              error: "local source ancestry could not be read",
            },
          };
        }
      }
      const accepted = source?.merged ? source.changedFiles?.[0] : undefined;
      if (
        source?.authorGithubId &&
        accepted &&
        accepted.path === `people/${source.authorLogin}.md`
      ) {
        state = {
          ...state,
          acceptedCard: {
            path: accepted.path,
            bytes: accepted.bytes,
            githubId: source.authorGithubId,
            sourcePrNumber: source.number,
          },
        };
      }
      state = {
        ...state,
      };
      persist();
      return ready(state);
    },

    async createIntegrationBranch(input: {
      name: string;
      fromMainOid: string;
      cardPath?: string;
      cardBytes?: Uint8Array;
    }) {
      const existing = state.integrationBranch.value;
      if (existing)
        return { kind: "alreadyApplied", value: { branch: existing } };
      const branch: BranchAnchor = {
        name: input.name,
        headOid: oid(input.fromMainOid),
        provenance: "modeled",
      };
      if (options.workspace.createIntegrationBranchWithProjectShell) {
        const created =
          await options.workspace.createIntegrationBranchWithProjectShell({
            name: input.name,
            fromMainOid: oid(input.fromMainOid),
            cardPath: input.cardPath ?? cardPathForSource(state),
            cardBytes: input.cardBytes ?? projectShellForSource(state),
          });
        const realBranch: BranchAnchor = {
          ...created.branch,
          provenance: "observed",
        };
        if (realBranch.headOid !== created.branch.headOid)
          return { kind: "policyRejected" };
        state = { ...state, integrationBranch: modeledObservation(realBranch) };
        persist();
        return { kind: "succeeded", value: { branch: realBranch } };
      }
      state = { ...state, integrationBranch: modeledObservation(branch) };
      persist();
      return { kind: "succeeded", value: { branch } };
    },

    async createIntegrationPullRequest(input: {
      branchName: string;
      title: string;
    }) {
      const existing = state.integrationPullRequest.value;
      if (existing)
        return { kind: "alreadyApplied", value: { pullRequest: existing } };
      const main = requiredValue(state.main, "main");
      const branch = requiredValue(
        state.integrationBranch,
        "integration branch",
      );
      if (branch.name !== input.branchName)
        return { kind: "stalePrecondition" };
      const pullRequest = modeledPullRequest({
        number: nextPullRequestNumber++,
        kind: "integration",
        headOid: branch.headOid,
        baseOid: main.oid,
        draft: true,
      });
      state = {
        ...state,
        integrationPullRequest: modeledObservation(pullRequest),
      };
      persist();
      return { kind: "succeeded", value: { pullRequest } };
    },

    async updatePullRequestBase(input: {
      pullRequestNumber: number;
      integrationBranchName: string;
    }) {
      const source = requiredValue(
        state.sourcePullRequest,
        "source pull request",
      );
      const branch = requiredValue(
        state.integrationBranch,
        "integration branch",
      );
      if (source.baseOid === branch.headOid)
        return { kind: "alreadyApplied", value: source };
      if (source.number !== input.pullRequestNumber)
        return { kind: "notFound" };
      if (branch.name !== input.integrationBranchName)
        return { kind: "stalePrecondition" };
      const updated = modeledPullRequest({
        ...source,
        baseOid: branch.headOid,
      });
      state = { ...state, sourcePullRequest: modeledObservation(updated) };
      persist();
      return { kind: "succeeded", value: updated };
    },

    async markPullRequestReadyForReview(input: {
      pullRequestNumber: number;
      expectedCandidateHeadOid: string;
    }) {
      const integration = state.integrationPullRequest.value;
      const candidate = state.candidate.value;
      if (
        !integration ||
        !candidate ||
        integration.number !== input.pullRequestNumber
      )
        return { kind: "blocked", reason: "notFound" };
      if (integration.headOid !== oid(input.expectedCandidateHeadOid))
        return { kind: "headChanged", observedHeadOid: integration.headOid };
      const updated = modeledPullRequest({ ...integration, draft: false });
      state = { ...state, integrationPullRequest: modeledObservation(updated) };
      persist();
      return {
        kind: integration.draft
          ? "readyAtExpectedCandidate"
          : "alreadyReadyAtExpectedCandidate",
        pullRequest: updated,
        candidate,
      } satisfies ReadyReadback;
    },

    async mergePullRequest(
      request: ContributionMergeRequest | IntegrationMergeRequest,
    ): Promise<ContributionMergeResult | IntegrationMergeResult> {
      if (request.kind === "integration") return mergeIntegration(request);
      const source = state.sourcePullRequest.value;
      const branch = state.integrationBranch.value;
      if (!source || !branch || source.number !== request.pullRequestNumber)
        return { kind: "contributionRejected", reason: "notFound" };
      if (source.headOid !== request.expectedHeadOid)
        return { kind: "contributionRejected", reason: "stalePrecondition" };
      const result = await merge(
        options.contributionWorkspace ?? options.workspace,
        options.refs.contribution,
        branch.headOid,
        `Merge contribution PR #${request.pullRequestNumber}`,
      );
      if (result.kind !== "merged")
        return { kind: "contributionRejected", reason: result.reason };
      const updatedBranch = {
        ...branch,
        headOid: result.oid,
        provenance: "modeled" as const,
      };
      state = {
        ...state,
        protocolAnchors: {
          ...state.protocolAnchors,
          contribution: {
            projectShellOid: source.baseOid,
            rebasedContributorOid: source.headOid,
          },
        },
        sourcePullRequest: modeledObservation(
          modeledPullRequest({
            ...source,
            merged: true,
            closed: true,
            mergeCommitOid: result.oid,
            mergeParentOids: result.parents,
          }),
        ),
        integrationBranch: modeledObservation(updatedBranch),
        integrationPullRequest: state.integrationPullRequest.value
          ? modeledObservation(
              modeledPullRequest({
                ...state.integrationPullRequest.value,
                headOid: result.oid,
              }),
            )
          : state.integrationPullRequest,
      };
      persist();
      return { kind: "contributionMerged", headOid: result.oid };
    },
  };
  if (!hadStateFile) persist();
  return { ...platform, fixture } as GithubPlatform & {
    fixture: LocalFixtureActions;
  };
}

async function merge(
  workspace: MergeWorkspace,
  sourceRef: string,
  expectedTargetOid: ReturnType<typeof oid>,
  message: string,
): Promise<
  | {
      kind: "merged";
      oid: ReturnType<typeof oid>;
      parents: readonly ReturnType<typeof oid>[];
    }
  | { kind: "rejected"; reason: "stalePrecondition" | "unknownOutcome" }
> {
  if (!workspace.mergeNoFastForward)
    return { kind: "rejected", reason: "unknownOutcome" };
  try {
    const result = await workspace.mergeNoFastForward({
      sourceRef,
      expectedTargetOid,
      message,
    });
    return {
      kind: "merged",
      oid: result.mergeCommitOid,
      parents: result.parents,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "merge failed";
    return {
      kind: "rejected",
      reason: message.includes("stale")
        ? "stalePrecondition"
        : "unknownOutcome",
    };
  }
}

function ready(value: RepositoryFacts): Observation<RepositoryFacts> {
  return { status: "ready", provenance: "modeled", value };
}

function modeledObservation<T>(value: T): Observation<T> {
  return { status: "ready", provenance: "modeled", value };
}

function modeledPullRequest(
  value: Omit<PullRequestFact, "observedOid" | "provenance">,
): PullRequestFact {
  return { ...value, observedOid: value.headOid, provenance: "modeled" };
}

function requiredValue<T>(observation: Observation<T>, name: string): T {
  if (!observation.value)
    throw new LocalPlatformOperationError("notFound", `${name} is unavailable`);
  return observation.value;
}

function modeledFacts(input: RepositoryFacts): RepositoryFacts {
  const observation = <T>(
    value: T | undefined,
    source: Observation<T>,
  ): Observation<T> =>
    value === undefined
      ? source.error
        ? { status: source.status, provenance: "modeled", error: source.error }
        : { status: source.status, provenance: "modeled" }
      : {
          status: source.status,
          provenance: "modeled",
          value,
        };
  return {
    ...input,
    main: observation(input.main.value, input.main),
    sourcePullRequest: observation(
      input.sourcePullRequest.value,
      input.sourcePullRequest,
    ),
    integrationBranch: observation(
      input.integrationBranch.value,
      input.integrationBranch,
    ),
    integrationPullRequest: observation(
      input.integrationPullRequest.value,
      input.integrationPullRequest,
    ),
    candidate: observation(input.candidate.value, input.candidate),
    eligibility: {
      checks: observation(
        input.eligibility.checks.value,
        input.eligibility.checks,
      ),
      reviews: observation(
        input.eligibility.reviews.value,
        input.eligibility.reviews,
      ),
      mergeability: observation(
        input.eligibility.mergeability.value,
        input.eligibility.mergeability,
      ),
      baseCurrent: observation(
        input.eligibility.baseCurrent.value,
        input.eligibility.baseCurrent,
      ),
    },
    confirmations: input.confirmations,
    ...(input.comments ? { comments: input.comments } : {}),
    ...(input.trustedCommentOwner
      ? { trustedCommentOwner: input.trustedCommentOwner }
      : {}),
    ...(input.trustedRepository
      ? { trustedRepository: input.trustedRepository }
      : {}),
  };
}

function cardPathForSource(state: RepositoryFacts): string {
  const source = requiredValue(state.sourcePullRequest, "source pull request");
  if (!source.authorLogin)
    throw new LocalPlatformOperationError(
      "notFound",
      "source author is unavailable",
    );
  return `people/${source.authorLogin}.md`;
}

function projectShellForSource(state: RepositoryFacts): Uint8Array {
  const source = requiredValue(state.sourcePullRequest, "source pull request");
  if (!source.authorLogin || !source.authorGithubId)
    throw new LocalPlatformOperationError(
      "notFound",
      "source identity is unavailable",
    );
  const avatar = source.authorAvatarUrl ?? "";
  return new TextEncoder().encode(
    `---\ngithub: ${source.authorLogin}\ngithub_id: ${source.authorGithubId}\navatar: ${avatar}\nsource_pr: ${source.number}\n---\n\n# Project shell\n\n> Project source metadata\n`,
  );
}

type LocalSnapshot = {
  version: 1;
  facts: unknown;
};

function loadState(
  stateFile: string | undefined,
  facts: RepositoryFacts,
): RepositoryFacts {
  if (!stateFile || !existsSync(stateFile)) return modeledFacts(facts);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    throw new LocalPlatformOperationError(
      "unknownOutcome",
      "Local state snapshot is corrupt",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new LocalPlatformOperationError(
      "unknownOutcome",
      "Local state snapshot is corrupt",
    );
  const snapshot = parsed as Partial<LocalSnapshot>;
  if (snapshot.version !== 1)
    throw new LocalPlatformOperationError(
      "unknownOutcome",
      "unsupported Local state version",
    );
  try {
    assertKeys(snapshot, ["version", "facts"], "snapshot");
    if (!snapshot.facts || typeof snapshot.facts !== "object")
      throw new Error("snapshot facts are incomplete");
    return decodeRepositoryFacts(decodeSnapshotValue(snapshot.facts));
  } catch (error) {
    throw new LocalPlatformOperationError(
      "unknownOutcome",
      `invalid Local state snapshot: ${
        error instanceof Error ? error.message : "semantic facts are malformed"
      }`,
    );
  }
}

function persistState(
  stateFile: string | undefined,
  state: RepositoryFacts,
): void {
  if (!stateFile) return;
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const snapshot: LocalSnapshot = {
    version: 1,
    facts: serialize(state),
  };
  writeFileSync(temporary, JSON.stringify(snapshot));
  renameSync(temporary, stateFile);
}

function serialize(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { __localBytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serialize(item)]),
    );
  return value;
}

function decodeSnapshotValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeSnapshotValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("__localBytes" in record) {
      if (
        Object.keys(record).length !== 1 ||
        typeof record.__localBytes !== "string" ||
        !isCanonicalBase64(record.__localBytes)
      )
        throw new Error("invalid encoded bytes");
      return new Uint8Array(Buffer.from(record.__localBytes, "base64"));
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        decodeSnapshotValue(item),
      ]),
    );
  }
  return value;
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function decodeRepositoryFacts(value: unknown): RepositoryFacts {
  const record = object(value, "facts");
  assertKeys(
    record,
    [
      "main",
      "sourcePullRequest",
      "sourceHeadBasedOnIntegration",
      "integrationBranch",
      "integrationPullRequest",
      "candidate",
      "eligibility",
      "confirmations",
      "publishedGithubIds",
      "activeGithubIds",
      "acceptedCard",
      "protocolAnchors",
      "comments",
      "trustedCommentOwner",
      "trustedRepository",
    ],
    "facts",
  );
  const eligibility = object(record.eligibility, "eligibility");
  assertKeys(
    eligibility,
    ["checks", "reviews", "mergeability", "baseCurrent"],
    "eligibility",
  );
  const facts: RepositoryFacts = {
    main: decodeObservation(record.main, decodeMain),
    sourcePullRequest: decodeObservation(
      record.sourcePullRequest,
      decodePullRequest,
    ),
    ...(record.sourceHeadBasedOnIntegration !== undefined
      ? {
          sourceHeadBasedOnIntegration: decodeObservation(
            record.sourceHeadBasedOnIntegration,
            decodeSourceHeadAncestry,
          ),
        }
      : {}),
    integrationBranch: decodeObservation(
      record.integrationBranch,
      decodeBranch,
    ),
    integrationPullRequest: decodeObservation(
      record.integrationPullRequest,
      decodePullRequest,
    ),
    candidate: decodeObservation(record.candidate, decodeCandidate),
    eligibility: {
      checks: decodeObservation(eligibility.checks, decodeChecks),
      reviews: decodeObservation(eligibility.reviews, decodeReviews),
      mergeability: decodeObservation(
        eligibility.mergeability,
        decodeMergeability,
      ),
      baseCurrent: decodeObservation(eligibility.baseCurrent, decodeBoolean),
    },
    confirmations: array(record.confirmations, "confirmations").map(
      decodeConfirmation,
    ),
  };
  if (record.comments !== undefined)
    facts.comments = array(record.comments, "comments").map(decodeComment);
  if (record.trustedCommentOwner !== undefined)
    facts.trustedCommentOwner = decodePrincipal(record.trustedCommentOwner);
  if (record.trustedRepository !== undefined)
    facts.trustedRepository = decodeTrustedRepository(record.trustedRepository);
  if (record.publishedGithubIds !== undefined)
    facts.publishedGithubIds = array(
      record.publishedGithubIds,
      "publishedGithubIds",
    ).map((item) => string(item, "publishedGithubId"));
  if (record.activeGithubIds !== undefined)
    facts.activeGithubIds = array(
      record.activeGithubIds,
      "activeGithubIds",
    ).map((item) => string(item, "activeGithubId"));
  if (record.acceptedCard !== undefined)
    facts.acceptedCard = decodeAcceptedCard(record.acceptedCard);
  if (record.protocolAnchors !== undefined)
    facts.protocolAnchors = decodeProtocolAnchors(record.protocolAnchors);
  return facts;
}

function decodeObservation<T>(
  value: unknown,
  decodeValue: (value: unknown) => T,
): Observation<T> {
  const record = object(value, "observation");
  assertKeys(
    record,
    ["status", "observedOid", "provenance", "value", "error"],
    "observation",
  );
  const status = string(record.status, "observation.status");
  if (!OBSERVATION_STATUSES.has(status))
    throw new Error("invalid observation status");
  const result = { status } as Observation<T>;
  if (record.provenance !== undefined) {
    const provenance = string(record.provenance, "observation.provenance");
    if (!PROVENANCES.has(provenance))
      throw new Error("invalid observation provenance");
    result.provenance = provenance as Provenance;
  }
  if (record.observedOid !== undefined)
    result.observedOid = oidValue(
      record.observedOid,
      "observation.observedOid",
    );
  if (record.error !== undefined)
    result.error = string(record.error, "observation.error");
  if (record.value !== undefined) result.value = decodeValue(record.value);
  if (status === "ready" && result.value === undefined)
    throw new Error("ready observation must have a value");
  if (status === "absent" && result.value !== undefined)
    throw new Error("absent observation must not have a value");
  return result;
}

const OBSERVATION_STATUSES = new Set([
  "absent",
  "notVisibleYet",
  "readFailed",
  "incomplete",
  "pending",
  "ready",
  "conclusiveFailure",
]);
const PROVENANCES = new Set(["provider", "modeled", "observed", "derived"]);

type MainValue = NonNullable<RepositoryFacts["main"]["value"]>;
type CandidateValue = NonNullable<RepositoryFacts["candidate"]["value"]>;

function decodeMain(value: unknown): MainValue {
  const record = object(value, "main");
  assertKeys(
    record,
    ["oid", "readmeBytes", "cardManifests", "cardPayloads"],
    "main",
  );
  return {
    oid: oidValue(record.oid, "main.oid"),
    cardManifests: array(record.cardManifests, "main.cardManifests").map(
      decodeManifest,
    ),
    ...(record.readmeBytes !== undefined
      ? { readmeBytes: bytes(record.readmeBytes, "main.readmeBytes") }
      : {}),
    ...(record.cardPayloads !== undefined
      ? {
          cardPayloads: array(record.cardPayloads, "main.cardPayloads").map(
            decodePayload,
          ),
        }
      : {}),
  };
}

function decodePullRequest(value: unknown): PullRequestFact {
  const record = object(value, "pull request");
  assertKeys(
    record,
    [
      "number",
      "nodeId",
      "kind",
      "headOid",
      "baseOid",
      "headRef",
      "baseRef",
      "draft",
      "merged",
      "closed",
      "mergeCommitOid",
      "mergeParentOids",
      "authorLogin",
      "authorGithubId",
      "authorAvatarUrl",
      "headRepositoryOwnerLogin",
      "headRepositoryIsFork",
      "changedFiles",
      "changedFilesComplete",
      "runKey",
      "observedOid",
      "provenance",
    ],
    "pull request",
  );
  const result = {
    number: positiveInteger(record.number, "pull request.number"),
    kind: literal(
      record.kind,
      ["contribution", "integration"] as const,
      "pull request.kind",
    ),
    headOid: oidValue(record.headOid, "pull request.headOid"),
    baseOid: oidValue(record.baseOid, "pull request.baseOid"),
    draft: boolean(record.draft, "pull request.draft"),
    observedOid: oidValue(record.observedOid, "pull request.observedOid"),
    provenance: literal(
      record.provenance,
      ["provider", "modeled", "observed", "derived"] as const,
      "pull request.provenance",
    ),
  } as PullRequestFact;
  for (const key of [
    "nodeId",
    "headRef",
    "baseRef",
    "authorLogin",
    "authorGithubId",
    "authorAvatarUrl",
    "headRepositoryOwnerLogin",
    "runKey",
  ] as const)
    if (record[key] !== undefined)
      result[key] =
        key === "authorGithubId"
          ? (numericId(record[key], `pull request.${key}`) as never)
          : (string(record[key], `pull request.${key}`) as never);
  if (record.headRepositoryIsFork !== undefined)
    result.headRepositoryIsFork = boolean(
      record.headRepositoryIsFork,
      "pull request.headRepositoryIsFork",
    );
  for (const key of ["merged", "closed", "changedFilesComplete"] as const)
    if (record[key] !== undefined)
      result[key] = boolean(record[key], `pull request.${key}`) as never;
  if (record.mergeCommitOid !== undefined)
    result.mergeCommitOid = oidValue(
      record.mergeCommitOid,
      "pull request.mergeCommitOid",
    );
  if (record.mergeParentOids !== undefined)
    result.mergeParentOids = array(
      record.mergeParentOids,
      "pull request.mergeParentOids",
    ).map((item) => oidValue(item, "merge parent"));
  if (record.changedFiles !== undefined)
    result.changedFiles = array(
      record.changedFiles,
      "pull request.changedFiles",
    ).map(decodeChangedFile);
  return result;
}

function decodeBranch(value: unknown): BranchAnchor {
  const record = object(value, "branch");
  assertKeys(record, ["name", "headOid", "provenance"], "branch");
  return {
    name: string(record.name, "branch.name"),
    headOid: oidValue(record.headOid, "branch.headOid"),
    provenance: literal(
      record.provenance,
      ["provider", "modeled", "observed", "derived"] as const,
      "branch.provenance",
    ),
  };
}

function decodeSourceHeadAncestry(value: unknown) {
  const record = object(value, "source head ancestry");
  assertKeys(
    record,
    [
      "integrationHeadOid",
      "sourceHeadOid",
      "isAncestor",
      "observedOid",
      "provenance",
    ],
    "source head ancestry",
  );
  return {
    integrationHeadOid: oidValue(
      record.integrationHeadOid,
      "source ancestry integration head",
    ),
    sourceHeadOid: oidValue(
      record.sourceHeadOid,
      "source ancestry source head",
    ),
    isAncestor: boolean(record.isAncestor, "source ancestry result"),
    observedOid: oidValue(record.observedOid, "source ancestry observed head"),
    provenance: literal(
      record.provenance,
      ["provider", "modeled", "observed", "derived"] as const,
      "source ancestry provenance",
    ),
  };
}

function decodeCandidate(value: unknown): CandidateValue {
  const record = object(value, "candidate");
  assertKeys(
    record,
    [
      "observedOid",
      "provenance",
      "integrationHeadOid",
      "mainOid",
      "cardPath",
      "cardBlobOid",
      "readmeBlobOid",
      "readmeBytes",
      "retainedCommitOids",
      "requiredParentOids",
    ],
    "candidate",
  );
  const result: CandidateValue = {
    observedOid: oidValue(record.observedOid, "candidate.observedOid"),
    provenance: literal(
      record.provenance,
      ["provider", "modeled", "observed", "derived"] as const,
      "candidate.provenance",
    ),
    integrationHeadOid: oidValue(
      record.integrationHeadOid,
      "candidate.integrationHeadOid",
    ),
    cardPath: string(record.cardPath, "candidate.cardPath"),
    cardBlobOid: oidValue(record.cardBlobOid, "candidate.cardBlobOid"),
    readmeBlobOid: oidValue(record.readmeBlobOid, "candidate.readmeBlobOid"),
  };
  if (record.mainOid !== undefined)
    result.mainOid = oidValue(record.mainOid, "candidate.mainOid");
  if (record.readmeBytes !== undefined)
    result.readmeBytes = bytes(record.readmeBytes, "candidate.readmeBytes");
  if (
    result.readmeBytes &&
    gitBlobOid(result.readmeBytes) !== result.readmeBlobOid
  )
    throw new Error("candidate README blob OID does not match bytes");
  if (record.retainedCommitOids !== undefined)
    result.retainedCommitOids = array(
      record.retainedCommitOids,
      "candidate.retainedCommitOids",
    ).map((item) => oidValue(item, "candidate.retainedCommitOid"));
  if (record.requiredParentOids !== undefined)
    result.requiredParentOids = array(
      record.requiredParentOids,
      "candidate.requiredParentOids",
    ).map((item) => oidValue(item, "candidate.requiredParentOid"));
  return result;
}

function decodeChecks(value: unknown) {
  return array(value, "checks").map((item) => {
    const r = object(item, "check");
    assertKeys(
      r,
      ["pullRequestNumber", "prHeadOid", "state", "observedOid", "provenance"],
      "check",
    );
    return {
      pullRequestNumber: positiveInteger(
        r.pullRequestNumber,
        "check.pullRequestNumber",
      ),
      prHeadOid: oidValue(r.prHeadOid, "check.prHeadOid"),
      state: literal(
        r.state,
        ["queued", "inProgress", "success", "failure"] as const,
        "check.state",
      ),
      observedOid: oidValue(r.observedOid, "check.observedOid"),
      provenance: literal(
        r.provenance,
        ["provider", "modeled", "observed", "derived"] as const,
        "check.provenance",
      ),
    };
  });
}
function decodeReviews(value: unknown) {
  return array(value, "reviews").map((item) => {
    const r = object(item, "review");
    assertKeys(
      r,
      [
        "pullRequestNumber",
        "prHeadOid",
        "reviewerLogin",
        "state",
        "reviewedCommitOid",
        "observedOid",
        "provenance",
      ],
      "review",
    );
    return {
      pullRequestNumber: positiveInteger(
        r.pullRequestNumber,
        "review.pullRequestNumber",
      ),
      prHeadOid: oidValue(r.prHeadOid, "review.prHeadOid"),
      reviewerLogin: string(r.reviewerLogin, "review.reviewerLogin"),
      state: literal(
        r.state,
        ["approved", "changesRequested", "dismissed", "commented"] as const,
        "review.state",
      ),
      reviewedCommitOid: oidValue(
        r.reviewedCommitOid,
        "review.reviewedCommitOid",
      ),
      observedOid: oidValue(r.observedOid, "review.observedOid"),
      provenance: literal(
        r.provenance,
        ["provider", "modeled", "observed", "derived"] as const,
        "review.provenance",
      ),
    };
  });
}
function decodeMergeability(value: unknown) {
  if (value !== null) {
    const v = string(value, "mergeability");
    if (v !== "mergeable" && v !== "conflicting")
      throw new Error("invalid mergeability");
    return v as "mergeable" | "conflicting";
  }
  return null;
}
function decodeBoolean(value: unknown) {
  return boolean(value, "baseCurrent");
}
function decodeManifest(value: unknown) {
  const r = object(value, "manifest");
  assertKeys(r, ["path", "blobOid", "githubId", "sourcePrNumber"], "manifest");
  return {
    path: string(r.path, "manifest.path"),
    blobOid: oidValue(r.blobOid, "manifest.blobOid"),
    githubId: numericId(r.githubId, "manifest.githubId"),
    sourcePrNumber: positiveInteger(
      r.sourcePrNumber,
      "manifest.sourcePrNumber",
    ),
  };
}
function decodePayload(value: unknown) {
  const r = object(value, "payload");
  assertKeys(
    r,
    ["path", "blobOid", "githubId", "sourcePrNumber", "bytes"],
    "payload",
  );
  const payload = {
    ...decodeManifest(r),
    bytes: bytes(r.bytes, "payload.bytes"),
  };
  if (gitBlobOid(payload.bytes) !== payload.blobOid)
    throw new Error("payload blob OID does not match bytes");
  return payload;
}
function decodeChangedFile(value: unknown) {
  const r = object(value, "changed file");
  assertKeys(r, ["path", "blobOid", "bytes"], "changed file");
  const file = {
    path: string(r.path, "changed file.path"),
    blobOid: oidValue(r.blobOid, "changed file.blobOid"),
    bytes: bytes(r.bytes, "changed file.bytes"),
  };
  if (gitBlobOid(file.bytes) !== file.blobOid)
    throw new Error("changed file blob OID does not match bytes");
  return file;
}
function decodeConfirmation(value: unknown) {
  const r = object(value, "confirmation");
  assertKeys(
    r,
    [
      "kind",
      "contributorLogin",
      "githubId",
      "sourcePrNumber",
      "integrationPrNumber",
      "reviewedCommitOid",
      "cardPath",
      "cardBlobOid",
    ],
    "confirmation",
  );
  return {
    kind: literal(r.kind, ["domainConfirmation"] as const, "confirmation.kind"),
    contributorLogin: string(
      r.contributorLogin,
      "confirmation.contributorLogin",
    ),
    githubId: numericId(r.githubId, "confirmation.githubId"),
    sourcePrNumber: positiveInteger(
      r.sourcePrNumber,
      "confirmation.sourcePrNumber",
    ),
    integrationPrNumber: positiveInteger(
      r.integrationPrNumber,
      "confirmation.integrationPrNumber",
    ),
    reviewedCommitOid: oidValue(
      r.reviewedCommitOid,
      "confirmation.reviewedCommitOid",
    ),
    cardPath: string(r.cardPath, "confirmation.cardPath"),
    cardBlobOid: oidValue(r.cardBlobOid, "confirmation.cardBlobOid"),
  };
}
function decodeComment(value: unknown): CommentFact {
  const r = object(value, "comment");
  assertKeys(
    r,
    [
      "id",
      "user",
      "ownerPrincipal",
      "actionKey",
      "body",
      "updatedAt",
      "targetPullRequestNumber",
    ],
    "comment",
  );
  const user = r.user === null ? null : decodeUser(r.user);
  return {
    id: positiveInteger(r.id, "comment.id"),
    user,
    ownerPrincipal: decodePrincipal(r.ownerPrincipal),
    actionKey: nonEmptyString(r.actionKey, "comment.actionKey"),
    body: string(r.body, "comment.body"),
    targetPullRequestNumber: positiveInteger(
      r.targetPullRequestNumber,
      "comment.targetPullRequestNumber",
    ),
    ...(r.updatedAt !== undefined
      ? { updatedAt: string(r.updatedAt, "comment.updatedAt") }
      : {}),
  };
}
function decodeUser(value: unknown) {
  const r = object(value, "comment.user");
  assertKeys(r, ["id", "actorType", "login"], "comment.user");
  const id = string(r.id, "comment.user.id");
  if (!/^[1-9][0-9]*$/u.test(id)) throw new Error("invalid comment user ID");
  return {
    id,
    actorType: literal(
      r.actorType,
      ["Bot", "User"] as const,
      "comment.user.actorType",
    ),
    ...(r.login !== undefined
      ? { login: string(r.login, "comment.user.login") }
      : {}),
  };
}
function decodePrincipal(value: unknown) {
  const r = object(value, "principal");
  assertKeys(r, ["actorId", "actorType"], "principal");
  const actorId = string(r.actorId, "principal.actorId");
  if (!/^[1-9][0-9]*$/u.test(actorId))
    throw new Error("invalid principal actor ID");
  return {
    actorId,
    actorType: literal(
      r.actorType,
      ["Bot", "User"] as const,
      "principal.actorType",
    ),
  };
}
function decodeTrustedRepository(value: unknown) {
  const r = object(value, "trustedRepository");
  assertKeys(r, ["webBaseUrl", "owner", "repo"], "trustedRepository");
  return {
    webBaseUrl: string(r.webBaseUrl, "trustedRepository.webBaseUrl"),
    owner: string(r.owner, "trustedRepository.owner"),
    repo: string(r.repo, "trustedRepository.repo"),
  };
}
function decodeAcceptedCard(value: unknown) {
  const r = object(value, "acceptedCard");
  assertKeys(
    r,
    ["path", "bytes", "readmeBytes", "githubId", "sourcePrNumber"],
    "acceptedCard",
  );
  return {
    path: string(r.path, "acceptedCard.path"),
    bytes: bytes(r.bytes, "acceptedCard.bytes"),
    ...(r.readmeBytes !== undefined
      ? { readmeBytes: bytes(r.readmeBytes, "acceptedCard.readmeBytes") }
      : {}),
    githubId: numericId(r.githubId, "acceptedCard.githubId"),
    sourcePrNumber: positiveInteger(
      r.sourcePrNumber,
      "acceptedCard.sourcePrNumber",
    ),
  };
}
function decodeProtocolAnchors(value: unknown) {
  const r = object(value, "protocolAnchors");
  assertKeys(r, ["contribution", "integration"], "protocolAnchors");
  const result: RepositoryFacts["protocolAnchors"] = {};
  if (r.contribution !== undefined) {
    const c = object(r.contribution, "protocolAnchors.contribution");
    assertKeys(
      c,
      ["projectShellOid", "rebasedContributorOid"],
      "protocolAnchors.contribution",
    );
    result.contribution = {
      projectShellOid: oidValue(c.projectShellOid, "projectShellOid"),
      rebasedContributorOid: oidValue(
        c.rebasedContributorOid,
        "rebasedContributorOid",
      ),
    };
  }
  if (r.integration !== undefined) {
    const i = object(r.integration, "protocolAnchors.integration");
    assertKeys(
      i,
      ["mainBeforePublicationOid", "candidateOid"],
      "protocolAnchors.integration",
    );
    result.integration = {
      mainBeforePublicationOid: oidValue(
        i.mainBeforePublicationOid,
        "mainBeforePublicationOid",
      ),
      candidateOid: oidValue(i.candidateOid, "candidateOid"),
    };
  }
  return result;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value;
}
function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}
function nonEmptyString(value: unknown, name: string): string {
  const result = string(value, name);
  if (!result) throw new Error(`${name} must not be empty`);
  return result;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}
function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    throw new Error(`${name} must be a safe integer`);
  return value;
}
function positiveInteger(value: unknown, name: string): number {
  const result = safeInteger(value, name);
  if (result < 1) throw new Error(`${name} must be positive`);
  return result;
}
function oidValue(value: unknown, name: string) {
  const result = string(value, name);
  if (!result) throw new Error(`${name} must not be empty`);
  return oid(result);
}
function numericId(value: unknown, name: string): string {
  const result = string(value, name);
  if (!/^[1-9][0-9]*$/u.test(result))
    throw new Error(`${name} must be a canonical numeric ID`);
  return result;
}
function bytes(value: unknown, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} must be bytes`);
  return new Uint8Array(value);
}
function literal<T extends readonly string[]>(
  value: unknown,
  values: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value))
    throw new Error(`${name} is invalid`);
  return value as T[number];
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw new Error(`${name} contains an unknown field`);
}

function maxPullRequestNumber(state: RepositoryFacts): number {
  return [
    state.sourcePullRequest.value?.number,
    state.integrationPullRequest.value?.number,
  ]
    .filter((value): value is number => value !== undefined)
    .reduce((max, value) => Math.max(max, value), 0);
}

function maxCommentId(state: RepositoryFacts): number {
  return (state.comments ?? []).reduce(
    (max, comment) => Math.max(max, comment.id),
    0,
  );
}

function validateWorkspaceProjection(
  workspace: NonNullable<
    Awaited<ReturnType<GitWorkspace["readWorkspace"]>>["value"]
  >,
  candidate: NonNullable<
    Awaited<ReturnType<GitWorkspace["readWorkspace"]>>["value"]
  >["candidate"],
): void {
  if (!candidate || !workspace.integrationHeadOid)
    throw new LocalPlatformOperationError(
      "stalePrecondition",
      "Git workspace projection is inconsistent",
    );
  if (
    candidate.integrationHeadOid !== workspace.integrationHeadOid ||
    candidate.observedOid !== workspace.integrationHeadOid ||
    candidate.cardBlobOid.length === 0 ||
    candidate.readmeBlobOid.length === 0 ||
    candidate.retainedCommitOids?.some((value) => !value) ||
    candidate.requiredParentOids?.some((value) => !value) ||
    (workspace.readmeBlobOid !== undefined &&
      workspace.readmeBlobOid !== candidate.readmeBlobOid) ||
    (workspace.retainedCommitOids !== undefined &&
      JSON.stringify(workspace.retainedCommitOids) !==
        JSON.stringify(candidate.retainedCommitOids)) ||
    (workspace.requiredParentOids !== undefined &&
      JSON.stringify(workspace.requiredParentOids) !==
        JSON.stringify(candidate.requiredParentOids))
  )
    throw new LocalPlatformOperationError(
      "stalePrecondition",
      "Git workspace projection is inconsistent",
    );
}

export async function openLocalActionRun(input: {
  dir: string;
  realGit: LocalActionRealGit;
  seed: LocalActionSeed;
  event: LocalActionEvent;
}): Promise<LocalActionRun> {
  const stateFile = join(input.dir, "state.json");
  const platform = createLocalGithubPlatform({
    facts: input.seed.facts,
    workspace: input.realGit.workspace,
    ...(input.realGit.integrationWorkspace
      ? { integrationWorkspace: input.realGit.integrationWorkspace }
      : {}),
    ...(input.realGit.contributionWorkspace
      ? { contributionWorkspace: input.realGit.contributionWorkspace }
      : {}),
    refs: input.realGit.refs,
    stateFile,
    ...(input.seed.onEffect ? { onEffect: input.seed.onEffect } : {}),
    ...(input.seed.afterPersistBeforeReturn
      ? { afterPersistBeforeReturn: input.seed.afterPersistBeforeReturn }
      : {}),
  });
  if (input.event.kind !== "wake") applyEvent(platform.fixture, input.event);
  const composition = createActionComposition({
    context: input.seed.actionContext,
    github: platform,
    git: input.realGit.workspace as GitWorkspace,
    candidatePolicy: productionCandidatePolicy,
  });
  return {
    platform,
    composition,
    wake: ({ maxEffects = 8 } = {}) => composition.run({ maxEffects }),
    close: async () => undefined,
  };
}

function applyEvent(
  fixture: LocalFixtureActions,
  event: Exclude<LocalActionEvent, { kind: "wake" }>,
): void {
  if (event.kind === "push") {
    fixture.recordContributorPush(event);
    return;
  }
  if (event.kind === "checksCompleted") {
    fixture.recordChecksCompleted(event.candidateOid);
    return;
  }
  fixture.recordContributorApproval(event);
}
