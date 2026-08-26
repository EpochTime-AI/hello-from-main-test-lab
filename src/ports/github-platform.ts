import type {
  CommentEnsureResult,
  CommentIntent,
  ContributionMergeRequest,
  ContributionMergeResult,
  IntegrationMergeRequest,
  IntegrationMergeResult,
  Observation,
  OperationResult,
  PullRequestFact,
  ReadyReadback,
  RepositoryFacts,
  SetupMutationResult,
} from "../core/model.js";

export type GithubPlatform = {
  observeRepository(
    context?: InvocationContext,
  ): Promise<Observation<RepositoryFacts>>;
  createIntegrationBranch(
    input: {
      name: string;
      fromMainOid: string;
      cardPath?: string;
      cardBytes?: Uint8Array;
    },
    context?: InvocationContext,
  ): Promise<SetupMutationResult>;
  createIntegrationPullRequest(
    input: {
      branchName: string;
      title: string;
    },
    context?: InvocationContext,
  ): Promise<SetupMutationResult>;
  updatePullRequestBase(
    input: {
      pullRequestNumber: number;
      integrationBranchName: string;
    },
    context?: InvocationContext,
  ): Promise<OperationResult<PullRequestFact>>;
  markPullRequestReadyForReview(
    input: {
      pullRequestNumber: number;
      expectedCandidateHeadOid: string;
    },
    context?: InvocationContext,
  ): Promise<ReadyReadback>;
  mergePullRequest(
    request: ContributionMergeRequest,
    context?: InvocationContext,
  ): Promise<ContributionMergeResult>;
  mergePullRequest(
    request: IntegrationMergeRequest,
    context?: InvocationContext,
  ): Promise<IntegrationMergeResult>;
  ensureComment(
    intent: CommentIntent,
    context?: InvocationContext,
  ): Promise<CommentEnsureResult>;
};

export type InvocationContext = {
  signal?: AbortSignal;
  deadlineMs?: number;
  expectedSourcePullRequestNumber?: number;
  expectedSourceLogin?: string;
};
