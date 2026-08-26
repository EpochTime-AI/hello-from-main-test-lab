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
  OperationResult,
  PullRequestFact,
  RepositoryFacts,
  ReviewFact,
  TrustedPrincipal,
} from "../core/model.js";
import { oid } from "../core/model.js";
import type {
  GithubPlatform,
  InvocationContext,
} from "../ports/github-platform.js";

type RestMethod = "GET" | "POST" | "PATCH" | "PUT";
type RestRequest = {
  method: RestMethod;
  path: string;
  parameters?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};
type RestResponse = {
  status: number;
  data: unknown;
  headers?: Record<string, string | undefined>;
};
type LegacyPaginationResponse = RestResponse & {
  nextPage?: number;
};
type GraphqlRequest = {
  query: string;
  variables: Record<string, unknown>;
  signal?: AbortSignal;
};
type GraphqlResponse = {
  data?: unknown;
  errors?: readonly { message: string }[];
};

// This seam is intentionally adapter-local. The semantic port never sees HTTP or GraphQL.
export type OctokitRequestTransport = {
  rest(request: RestRequest): Promise<LegacyPaginationResponse>;
  graphql(request: GraphqlRequest): Promise<GraphqlResponse>;
};

type ReadyState = {
  pullRequest: PullRequestFact;
  candidate: NonNullable<RepositoryFacts["candidate"]["value"]>;
};

type CommentCreatePermit = {
  runIdentity: string;
  targetPullRequestNumber: number;
  slot: "source-status" | "integration-status";
  phase: "setup" | "ready-guidance";
  milestone: "setup" | "ready";
};

export type OctokitGithubPlatformOptions = {
  owner: string;
  repo: string;
  transport: OctokitRequestTransport;
  replay?: boolean;
  initialFacts?: RepositoryFacts;
  readyState?: () => Promise<ReadyState>;
  pullRequestNodeIds?: ReadonlyMap<number, string>;
  expectedCommentOwner?: TrustedPrincipal;
  apiOrigin?: string;
  repositoryId?: number;
  commentReadback?: {
    attempts?: number;
    delayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  };
  lookupContributionMerge?: (number: number) => Promise<{
    merged: boolean;
    mergeCommitOid?: string;
  }>;
  lookupIntegrationMain?: (number: number) => Promise<{ mainOid?: string }>;
};

export class OctokitOperationError extends Error {
  constructor(
    public readonly category:
      | "permissionDenied"
      | "rateLimited"
      | "notVisibleYet"
      | "notFound"
      | "gone"
      | "stalePrecondition"
      | "policyRejected"
      | "retryableTransport"
      | "unknownOutcome",
    message: string,
  ) {
    super(message);
  }
}

export function createOctokitGithubPlatform(
  options: OctokitGithubPlatformOptions,
): GithubPlatform {
  let lastFacts = options.initialFacts;
  let activeSignal: AbortSignal | undefined;
  const apiOrigin = normalizeApiOrigin(options.apiOrigin);
  const repositoryId = options.repositoryId;
  const commentReadback = options.commentReadback ?? {};
  const commentLifecycle = new Set<string>();
  const commentCreatePermits: CommentCreatePermit[] = [];
  const path = (suffix: string) =>
    `/repos/${options.owner}/${options.repo}${suffix}`;
  const apiCommentPath = (suffix: string) => path(suffix);

  const mergeIntegration = async (
    request: IntegrationMergeRequest,
  ): Promise<IntegrationMergeResult> => {
    // GitHub's ordinary merge endpoint has no base-current CAS. Never claim it
    // satisfies the publisher's required gate until an L5-proven mechanism exists.
    // Even a lookup cannot turn an Integration PR head into an authoritative
    // main OID. This remains fail-closed pending the L5 provider gate.
    void options.lookupIntegrationMain;
    void request;
    return { kind: "integrationRejected", reason: "gateUnsupported" };
  };

  const observeRepository = async (
    context?: InvocationContext,
  ): Promise<Observation<RepositoryFacts>> => {
    activeSignal = context?.signal;
    if (options.replay && options.initialFacts) {
      lastFacts = options.initialFacts;
      return {
        status: "ready",
        provenance: "provider",
        value: options.initialFacts,
      };
    }
    try {
      const mainResponse = await requestRest(
        {
          method: "GET",
          path: path("/git/ref/heads/main"),
        },
        "read",
      );
      const main = asRecord(mainResponse.data);
      const mainOid = stringValue(asRecord(main.object).sha ?? main.sha);
      const pages = await paginatePullRequests();
      const expectedNumber = context?.expectedSourcePullRequestNumber;
      const expectedLogin = context?.expectedSourceLogin;
      const sourceCandidate = pages.find((item) => {
        const head = asRecord(item.head);
        const user = asRecord(item.user);
        return (
          stringValue(head.ref).startsWith("add/") &&
          (expectedNumber === undefined ||
            numberValue(item.number) === expectedNumber) &&
          (expectedLogin === undefined ||
            stringValue(user.login) === expectedLogin)
        );
      });
      if (
        (expectedNumber !== undefined || expectedLogin !== undefined) &&
        !sourceCandidate
      )
        throw new OctokitOperationError(
          "notVisibleYet",
          "expected source pull request is not visible",
        );
      const candidateLogin = asRecord(sourceCandidate?.user).login;
      const expectedBranch =
        sourceCandidate && typeof candidateLogin === "string"
          ? `feature/card-${candidateLogin}-source-${numberValue(sourceCandidate.number)}`
          : undefined;
      let integration = expectedBranch
        ? pages.find(
            (item) =>
              stringValue(asRecord(item.head).ref) === expectedBranch &&
              stringValue(asRecord(item.base).ref) === "main",
          )
        : undefined;
      const branchFact = integration
        ? undefined
        : await findIntegrationBranch(expectedBranch);
      const discoveredBranch =
        branchFact ??
        (integration
          ? {
              name: stringValue(asRecord(integration.head).ref),
              headOid: oid(stringValue(asRecord(integration.head).sha)),
              provenance: "provider" as const,
            }
          : undefined);
      if (!integration && discoveredBranch)
        integration = pages.find(
          (item) =>
            stringValue(asRecord(item.head).ref) === discoveredBranch.name &&
            stringValue(asRecord(item.base).ref) === "main" &&
            stringValue(asRecord(item.head).sha) === discoveredBranch.headOid,
        );
      const branch = discoveredBranch;
      const integrationRef = branch?.name;
      const source =
        sourceCandidate &&
        (!integrationRef ||
          stringValue(asRecord(sourceCandidate.base).ref) === integrationRef ||
          stringValue(asRecord(sourceCandidate.base).ref) === "main")
          ? sourceCandidate
          : undefined;
      const sourceRead = source
        ? await readExactPullRequest(
            numberValue(source.number),
            "contribution",
            source,
          )
        : undefined;
      const sourceFact = sourceRead
        ? await readSourceIntake(sourceRead.record, sourceRead.fact)
        : undefined;
      const sourceHeadBasedOnIntegration = sourceFact
        ? branch && !sourceFact.merged
          ? await observeSourceAncestry(branch.headOid, sourceFact.headOid)
          : sourceFact.merged
            ? {
                status: "ready" as const,
                provenance: "provider" as const,
                value: {
                  integrationHeadOid: sourceFact.baseOid,
                  sourceHeadOid: sourceFact.headOid,
                  isAncestor: true,
                  observedOid: sourceFact.headOid,
                  provenance: "provider" as const,
                },
              }
            : { status: "pending" as const, provenance: "provider" as const }
        : undefined;
      const integrationRead = integration
        ? await readExactPullRequest(
            numberValue(integration.number),
            "integration",
            integration,
          )
        : undefined;
      const integrationFact = integrationRead?.fact;
      const mainProjection = await readMainProjection(oid(mainOid));
      const facts: RepositoryFacts = {
        main: {
          status: "ready",
          provenance: "provider",
          value: mainProjection,
        },
        sourcePullRequest: sourceFact
          ? { status: "ready", provenance: "provider", value: sourceFact }
          : { status: "absent", provenance: "provider" },
        ...(sourceHeadBasedOnIntegration
          ? { sourceHeadBasedOnIntegration }
          : {}),
        integrationBranch: branch
          ? { status: "ready", provenance: "provider", value: branch }
          : { status: "absent", provenance: "provider" },
        integrationPullRequest: integrationFact
          ? { status: "ready", provenance: "provider", value: integrationFact }
          : { status: "absent", provenance: "provider" },
        candidate:
          sourceFact && integrationFact
            ? await readCandidate(sourceFact, integrationFact, oid(mainOid))
            : { status: "absent", provenance: "provider" },
        eligibility: {
          checks: integrationFact
            ? await observeEligibility(() => readChecks(integrationFact))
            : { status: "pending", provenance: "provider" },
          reviews: integrationFact
            ? await observeEligibility(() => readReviews(integrationFact))
            : { status: "pending", provenance: "provider" },
          mergeability: integrationRead
            ? mergeabilityObservation(integrationRead.record)
            : { status: "pending", provenance: "provider" },
          baseCurrent: integrationFact
            ? {
                status: "ready",
                provenance: "provider",
                value: integrationFact.baseOid === oid(mainOid),
              }
            : { status: "pending", provenance: "provider" },
        },
        confirmations: [],
        ...(options.expectedCommentOwner && sourceFact
          ? {
              comments: await readCommentsForTargets([
                sourceFact.number,
                ...(integrationFact ? [integrationFact.number] : []),
              ]),
              trustedCommentOwner: options.expectedCommentOwner,
            }
          : {}),
        publishedGithubIds: mainProjection.cardManifests.map(
          (card) => card.githubId,
        ),
        activeGithubIds: activeIdentityIds(pages, source),
        protocolAnchors: {
          ...(sourceFact
            ? {
                contribution: {
                  projectShellOid: sourceFact.baseOid,
                  rebasedContributorOid: sourceFact.headOid,
                },
              }
            : {}),
          ...(integrationFact
            ? {
                integration: {
                  mainBeforePublicationOid: integrationFact.baseOid,
                  candidateOid: integrationFact.headOid,
                },
              }
            : {}),
        },
      };
      if (facts.candidate.value && sourceFact) {
        facts.acceptedCard = await readAcceptedCard(
          facts.candidate.value,
          sourceFact.number,
        );
      }
      facts.confirmations = confirmationsFrom(facts);
      lastFacts = facts;
      return { status: "ready", provenance: "provider", value: facts };
    } catch (error) {
      const category =
        error instanceof OctokitOperationError
          ? error.category
          : "retryableTransport";
      return {
        status:
          category === "notVisibleYet"
            ? "notVisibleYet"
            : category === "notFound"
              ? "absent"
              : category === "permissionDenied"
                ? "conclusiveFailure"
                : "incomplete",
        provenance: "provider",
        error:
          error instanceof Error
            ? error.message
            : "provider observation failed",
      };
    }
  };

  const platform = {
    observeRepository,
    async createIntegrationBranch(
      input: {
        name: string;
        fromMainOid: string;
      },
      context?: InvocationContext,
    ) {
      activeSignal = context?.signal;
      let response: RestResponse;
      try {
        response = await requestRest(
          {
            method: "POST",
            path: path("/git/refs"),
            parameters: {
              ref: `refs/heads/${input.name}`,
              sha: input.fromMainOid,
            },
          },
          "mutation",
        );
      } catch (error) {
        if (
          error instanceof OctokitOperationError &&
          error.category === "unknownOutcome"
        ) {
          try {
            const branch = await readBranch(input.name);
            return { kind: "alreadyApplied", value: { branch } };
          } catch {
            // The provider may still be converging; retain unknown outcome.
          }
        }
        return operationFailure(error);
      }
      if (response.status === 201 || response.status === 200)
        return grantSetupCommentCreatePermit({
          kind: "succeeded",
          value: { branch: branchFromResponse(response.data, input.name) },
        });
      if (response.status === 422) {
        try {
          const branch = await readBranch(input.name);
          return { kind: "alreadyApplied", value: { branch } };
        } catch {
          /* response may have been lost before the ref became visible */
        }
      }
      return operationFailure(response);
    },
    async createIntegrationPullRequest(
      input: {
        branchName: string;
        title: string;
      },
      context?: InvocationContext,
    ) {
      activeSignal = context?.signal;
      let response: RestResponse;
      try {
        response = await requestRest(
          {
            method: "POST",
            path: path("/pulls"),
            parameters: {
              title: input.title,
              head: input.branchName,
              base: "main",
              draft: true,
            },
          },
          "mutation",
        );
      } catch (error) {
        if (
          error instanceof OctokitOperationError &&
          error.category === "unknownOutcome"
        ) {
          try {
            const response = await requestRest(
              {
                method: "GET",
                path: path("/pulls"),
                parameters: {
                  state: "all",
                  head: `${options.owner}:${input.branchName}`,
                  base: "main",
                },
              },
              "read",
            );
            const found = Array.isArray(response.data)
              ? response.data
                  .map(asRecord)
                  .find(
                    (item) =>
                      stringValue(asRecord(item.head).ref) === input.branchName,
                  )
              : undefined;
            if (found)
              return grantSetupCommentCreatePermit({
                kind: "alreadyApplied",
                value: { pullRequest: pullRequestFact(found, "integration") },
              });
          } catch {
            // The provider may still be converging; retain unknown outcome.
          }
        }
        return operationFailure(error);
      }
      if (response.status === 201 || response.status === 200)
        return grantSetupCommentCreatePermit({
          kind: "succeeded",
          value: { pullRequest: pullRequestFact(response.data, "integration") },
        });
      return operationFailure(response);
    },
    async updatePullRequestBase(
      input: {
        pullRequestNumber: number;
        integrationBranchName: string;
      },
      context?: InvocationContext,
    ) {
      activeSignal = context?.signal;
      let response: RestResponse;
      try {
        response = await requestRest(
          {
            method: "PATCH",
            path: path(`/pulls/${input.pullRequestNumber}`),
            parameters: { base: input.integrationBranchName },
          },
          "mutation",
        );
      } catch (error) {
        return operationFailure(error);
      }
      if (response.status === 200) {
        const updated = pullRequestFact(response.data, "contribution");
        if (updated.baseRef !== input.integrationBranchName)
          return { kind: "stalePrecondition" };
        return grantSetupCommentCreatePermit({
          kind: "succeeded",
          value: updated,
        });
      }
      return operationFailure(response);
    },
    async markPullRequestReadyForReview(
      input: {
        pullRequestNumber: number;
        expectedCandidateHeadOid: string;
      },
      context?: InvocationContext,
    ) {
      activeSignal = context?.signal;
      const state = options.readyState
        ? await options.readyState()
        : readyStateFromFacts(lastFacts, input);
      if (!state) return { kind: "blocked", reason: "notVisibleYet" };
      const nodeId =
        state.pullRequest.nodeId ??
        options.pullRequestNodeIds?.get(input.pullRequestNumber);
      if (!nodeId) return { kind: "blocked", reason: "notVisibleYet" };
      if (state.pullRequest.headOid !== oid(input.expectedCandidateHeadOid))
        return {
          kind: "headChanged",
          observedHeadOid: state.pullRequest.headOid,
        };
      if (!state.pullRequest.draft)
        return {
          kind: "alreadyReadyAtExpectedCandidate",
          pullRequest: state.pullRequest,
          candidate: state.candidate,
        };
      const response = await requestGraphql({
        query:
          "mutation markPullRequestReadyForReview($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id isDraft headRefOid } } }",
        variables: {
          pullRequestId: nodeId,
        },
      });
      const mutation = asRecord(
        asRecord(response.data).markPullRequestReadyForReview,
      );
      const mutationPr = asRecord(mutation.pullRequest);
      if (response.errors?.length || Object.keys(mutationPr).length === 0)
        return { kind: "blocked", reason: graphqlCategory(response.errors) };
      const post = await readPullRequest(input.pullRequestNumber);
      if (post.headOid !== oid(input.expectedCandidateHeadOid))
        return { kind: "headChanged", observedHeadOid: post.headOid };
      if (post.draft) return { kind: "blocked", reason: "unknownOutcome" };
      const result = {
        kind: "readyAtExpectedCandidate",
        pullRequest: post,
        candidate: state.candidate,
      } as const;
      grantCommentCreatePermit({
        targetPullRequestNumber: input.pullRequestNumber,
        slot: "integration-status",
        phase: "ready-guidance",
        milestone: "ready",
      });
      return result;
    },
    async mergePullRequest(
      request: ContributionMergeRequest | IntegrationMergeRequest,
      context?: InvocationContext,
    ): Promise<ContributionMergeResult | IntegrationMergeResult> {
      activeSignal = context?.signal;
      if (request.kind === "integration") return mergeIntegration(request);
      const response = await mergeRequest(
        request.pullRequestNumber,
        request.expectedHeadOid,
      );
      if (response.kind === "merged")
        return { kind: "contributionMerged", headOid: response.oid };
      return { kind: "contributionRejected", reason: response.reason };
    },
    async ensureComment(
      intent: CommentIntent,
      context?: InvocationContext,
    ): Promise<CommentEnsureResult> {
      activeSignal = context?.signal;
      const expected = options.expectedCommentOwner;
      if (!expected || !validPrincipal(expected))
        return {
          kind: "capabilityUnavailable",
          detail: "expected comment principal is unavailable",
        };
      try {
        const comments = await readIssueComments(
          intent.targetPullRequestNumber,
        );
        const matches = comments.filter(
          (comment) => comment.actionKey === intent.actionKey,
        );
        if (
          comments.some(
            (comment) =>
              comment.actionKey === intent.actionKey &&
              comment.targetPullRequestNumber !==
                intent.targetPullRequestNumber,
          )
        )
          return { kind: "ambiguousOwnership" };
        const owned = matches.filter(
          (comment) =>
            comment.user?.id === expected.actorId &&
            comment.user.actorType === expected.actorType,
        );
        if (
          owned.length > 1 ||
          (matches.length > 0 && owned.length !== matches.length)
        )
          return { kind: "ambiguousOwnership" };
        if (commentLifecycle.has(commentLifecycleKey(intent))) {
          return {
            kind: "capabilityUnavailable",
            detail: "comment creation is already reserved in this process",
          };
        }
        const current = owned[0];
        if (current) {
          const read = await readIssueComment(
            current.id,
            intent.targetPullRequestNumber,
          );
          if (!sameCommentIdentity(read, current)) return { kind: "stale" };
          if (intent.observed && !sameObservedComment(read, intent.observed))
            return { kind: "stale" };
          if (read.body === intent.body) return { kind: "noOp", comment: read };
          if (!intent.observed) return { kind: "stale" };
          let patched: CommentFact;
          try {
            const response = await requestCommentRest(
              {
                method: "PATCH",
                path: apiCommentPath(`/issues/comments/${read.id}`),
                parameters: { body: intent.body },
              },
              [200],
            );
            const materialized = materializeComment(
              response.data,
              intent.targetPullRequestNumber,
              apiCommentPath,
              true,
              apiOrigin,
            );
            if (!materialized) return { kind: "unknownOutcome" };
            patched = materialized;
          } catch (error) {
            if (!isAmbiguousMutation(error)) throw error;
            const recovered = await readIssueComment(
              read.id,
              intent.targetPullRequestNumber,
            );
            return sameIntendedComment(recovered, intent, expected)
              ? { kind: "updated", comment: recovered }
              : { kind: "unknownOutcome" };
          }
          if (!patched) return { kind: "unknownOutcome" };
          if (patched.body !== intent.body) return { kind: "unknownOutcome" };
          const post = await readIssueComment(
            read.id,
            intent.targetPullRequestNumber,
          );
          return sameIntendedComment(post, intent, expected)
            ? { kind: "updated", comment: post }
            : { kind: "stale" };
        }

        if (!reserveCommentCreatePermit(intent))
          return {
            kind: "capabilityUnavailable",
            detail:
              "missing same-process durable milestone for comment creation",
          };

        let response: RestResponse;
        commentLifecycle.add(commentLifecycleKey(intent));
        try {
          response = await requestCommentRest(
            {
              method: "POST",
              path: apiCommentPath(
                `/issues/${intent.targetPullRequestNumber}/comments`,
              ),
              parameters: { body: intent.body },
            },
            [201],
          );
        } catch (error) {
          if (isAmbiguousMutation(error))
            return await reconcileAmbiguousCreate(intent, expected, error);
          commentLifecycle.delete(commentLifecycleKey(intent));
          throw error;
        }
        const created = materializeComment(
          response.data,
          intent.targetPullRequestNumber,
          apiCommentPath,
          true,
          apiOrigin,
        );
        if (!created) {
          commentLifecycle.delete(commentLifecycleKey(intent));
          return { kind: "unknownOutcome" };
        }
        if (!sameIntendedComment(created, intent, expected)) {
          commentLifecycle.delete(commentLifecycleKey(intent));
          return { kind: "unknownOutcome" };
        }
        try {
          const post = await readIssueComment(
            created.id,
            intent.targetPullRequestNumber,
          );
          commentLifecycle.delete(commentLifecycleKey(intent));
          return sameIntendedComment(post, intent, expected)
            ? { kind: "created", comment: post }
            : { kind: "stale" };
        } catch (error) {
          if (!isVisibilityUncertainty(error)) throw error;
          return await reconcileAmbiguousCreate(intent, expected, error);
        }
      } catch (error) {
        return commentFailure(error);
      }
    },
  };
  return platform as GithubPlatform;

  async function mergeRequest(
    number: number,
    expectedHeadOid: string,
  ): Promise<
    | { kind: "merged"; oid: ReturnType<typeof oid> }
    | {
        kind: "rejected";
        reason: Exclude<
          OperationResult<unknown>["kind"],
          "succeeded" | "alreadyApplied"
        >;
      }
  > {
    let response: RestResponse;
    try {
      response = await options.transport.rest({
        method: "PUT",
        path: path(`/pulls/${number}/merge`),
        parameters: { sha: expectedHeadOid, merge_method: "merge" },
      });
    } catch (_error) {
      if (options.replay) throw _error;
      if (options.lookupContributionMerge) {
        const lookup = await options.lookupContributionMerge(number);
        if (lookup.merged && lookup.mergeCommitOid)
          return { kind: "merged", oid: oid(lookup.mergeCommitOid) };
      }
      return { kind: "rejected", reason: "unknownOutcome" };
    }
    if (response.status === 200) {
      const data = asRecord(response.data);
      const mergeOid =
        typeof data.sha === "string" && data.sha.length > 0
          ? oid(data.sha)
          : undefined;
      if (data.merged === true && mergeOid) {
        try {
          const readback = await requestRest(
            { method: "GET", path: path(`/pulls/${number}`) },
            "read",
          );
          const pullRequest = asRecord(readback.data);
          if (
            pullRequest.merged === true &&
            asRecord(pullRequest).merge_commit_sha === mergeOid
          )
            return { kind: "merged", oid: mergeOid };
        } catch {
          return { kind: "rejected", reason: "unknownOutcome" };
        }
        return { kind: "rejected", reason: "stalePrecondition" };
      }
      return { kind: "rejected", reason: "policyRejected" };
    }
    return { kind: "rejected", reason: errorCategory(response) };
  }

  async function readPullRequest(number: number): Promise<PullRequestFact> {
    const response = await requestRest(
      { method: "GET", path: path(`/pulls/${number}`) },
      "read",
    );
    return pullRequestFact(response.data, "integration");
  }

  async function readExactPullRequest(
    number: number,
    kind: "contribution" | "integration",
    summary?: Record<string, unknown>,
  ): Promise<{ fact: PullRequestFact; record: Record<string, unknown> }> {
    const response = await requestRest(
      { method: "GET", path: path(`/pulls/${number}`) },
      "read",
    );
    const record = asRecord(response.data);
    if (numberValue(record.number) !== number)
      throw new OctokitOperationError(
        "retryableTransport",
        "pull request detail returned a mismatched number",
      );
    if (summary && !samePullRequestIdentity(summary, record))
      throw new OctokitOperationError(
        "retryableTransport",
        "pull request detail does not match discovery summary",
      );
    if (
      kind === "integration" &&
      (stringValue(asRecord(record.base).ref) !== "main" ||
        stringValue(asRecord(record.head).ref) !==
          stringValue(asRecord(summary?.head).ref))
    )
      throw new OctokitOperationError(
        "retryableTransport",
        "exact integration pull request does not target the expected branch and main",
      );
    const fact = pullRequestFact(record, kind, true);
    return {
      fact: fact.merged === true ? await hydrateMergeParents(fact) : fact,
      record,
    };
  }

  async function observeSourceAncestry(
    integrationHeadOid: ReturnType<typeof oid>,
    sourceHeadOid: ReturnType<typeof oid>,
  ): Promise<RepositoryFacts["sourceHeadBasedOnIntegration"]> {
    try {
      const comparePath = path(
        `/compare/${integrationHeadOid}...${sourceHeadOid}`,
      );
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: comparePath,
          parameters: { per_page: 100, page: 1 },
        },
        "read",
      );
      const comparison = asRecord(response.data);
      const status = comparison.status;
      const base = stringValue(asRecord(comparison.base_commit).sha);
      const headCommitPresent = Object.hasOwn(comparison, "head_commit");
      const head = headCommitPresent
        ? stringValue(asRecord(comparison.head_commit).sha)
        : undefined;
      const mergeBase = stringValue(asRecord(comparison.merge_base_commit).sha);
      const commits = comparison.commits;
      const totalCommits = comparison.total_commits;
      if (
        base !== integrationHeadOid ||
        (headCommitPresent && head !== sourceHeadOid) ||
        !Array.isArray(commits) ||
        typeof totalCommits !== "number" ||
        !Number.isSafeInteger(totalCommits) ||
        totalCommits < commits.length ||
        (totalCommits > commits.length && !response.headers?.link)
      )
        return {
          status: "incomplete",
          provenance: "provider",
          error: "incomplete or malformed source ancestry comparison",
        };
      if (
        status !== "ahead" &&
        status !== "identical" &&
        status !== "behind" &&
        status !== "diverged"
      )
        return {
          status: "incomplete",
          provenance: "provider",
          error: "unknown source ancestry comparison status",
        };
      const commitOids = new Set<string>();
      if (!addCompareCommits(commits, commitOids))
        return incompleteAncestry(
          "malformed source ancestry comparison commits",
        );
      let currentPage = 1;
      let next = compareNextLink(
        response.headers?.link,
        apiOrigin,
        comparePath,
        currentPage,
        repositoryId,
      );
      const seenLinks = new Set<string>();
      let pages = 1;
      while (next !== undefined) {
        if (seenLinks.has(next))
          return incompleteAncestry(
            "source ancestry comparison pagination loop",
          );
        seenLinks.add(next);
        if (++pages > 100)
          return {
            status: "incomplete",
            provenance: "provider",
            error: "source ancestry comparison pagination exceeded budget",
          };
        const nextResponse = await requestLegacyRest(
          {
            method: "GET",
            path: next,
          },
          "read",
        );
        const pageComparison = asRecord(nextResponse.data);
        if (
          pageComparison.status !== status ||
          stringValue(asRecord(pageComparison.base_commit).sha) !== base ||
          (Object.hasOwn(pageComparison, "head_commit") &&
            stringValue(asRecord(pageComparison.head_commit).sha) !==
              sourceHeadOid) ||
          stringValue(asRecord(pageComparison.merge_base_commit).sha) !==
            mergeBase ||
          pageComparison.total_commits !== totalCommits ||
          typeof pageComparison.total_commits !== "number" ||
          !Number.isSafeInteger(pageComparison.total_commits) ||
          !Array.isArray(pageComparison.commits) ||
          pageComparison.total_commits < pageComparison.commits.length ||
          !addCompareCommits(pageComparison.commits, commitOids)
        )
          return incompleteAncestry(
            "malformed source ancestry comparison page",
          );
        next = compareNextLink(
          nextResponse.headers?.link,
          apiOrigin,
          comparePath,
          currentPage,
          repositoryId,
        );
        if (next !== undefined)
          currentPage = Number(
            new URL(`${apiOrigin.origin}${next}`).searchParams.get("page"),
          );
      }
      if (commitOids.size !== totalCommits)
        return incompleteAncestry(
          "source ancestry comparison commit count mismatch",
        );
      const finalCommitOid = Array.from(commitOids).pop();
      if (
        (!headCommitPresent &&
          status === "ahead" &&
          finalCommitOid !== sourceHeadOid) ||
        (status === "identical" &&
          (integrationHeadOid !== sourceHeadOid || totalCommits !== 0)) ||
        (!headCommitPresent && status !== "ahead" && status !== "identical") ||
        (headCommitPresent && head !== sourceHeadOid)
      )
        return incompleteAncestry(
          "source ancestry comparison does not prove requested source head",
        );
      return {
        status: "ready",
        provenance: "provider",
        value: {
          integrationHeadOid,
          sourceHeadOid,
          isAncestor:
            (status === "ahead" || status === "identical") &&
            mergeBase === integrationHeadOid,
          observedOid: sourceHeadOid,
          provenance: "provider",
        },
      };
    } catch (error) {
      return {
        status: "incomplete",
        provenance: "provider",
        error:
          error instanceof Error
            ? error.message
            : "source ancestry read failed",
      };
    }
  }

  async function readMainProjection(mainOid: ReturnType<typeof oid>) {
    const tree = await readTree(mainOid);
    const readme = tree.find(
      (entry) => entry.path === "README.md" && entry.type === "blob",
    );
    if (!readme)
      throw new OctokitOperationError(
        "notVisibleYet",
        "main README is not visible",
      );
    const cardEntries = tree.filter(
      (entry) =>
        entry.type === "blob" &&
        typeof entry.path === "string" &&
        /^people\/[A-Za-z0-9-]+\.md$/u.test(entry.path),
    );
    const readmeBytes = await readBlob(stringValue(readme.sha));
    const cardPayloads = await Promise.all(
      cardEntries.map(async (entry) => {
        const bytes = await readBlob(stringValue(entry.sha));
        const metadata = cardMetadata(bytes);
        return {
          path: stringValue(entry.path),
          blobOid: oid(stringValue(entry.sha)),
          githubId: metadata.githubId,
          sourcePrNumber: metadata.sourcePrNumber,
          bytes,
        };
      }),
    );
    return {
      oid: mainOid,
      readmeBytes,
      cardManifests: cardPayloads.map(
        ({ bytes: _bytes, ...manifest }) => manifest,
      ),
      cardPayloads,
    };
  }

  async function readCandidate(
    source: PullRequestFact,
    integration: PullRequestFact,
    mainOid: ReturnType<typeof oid>,
  ): Promise<Observation<NonNullable<RepositoryFacts["candidate"]["value"]>>> {
    const tree = await readTree(integration.headOid);
    const cardPath = `people/${source.authorLogin ?? source.headRef?.slice(4) ?? ""}.md`;
    const card = tree.find((entry) => entry.path === cardPath);
    const readme = tree.find((entry) => entry.path === "README.md");
    if (!card || !readme)
      return { status: "notVisibleYet", provenance: "provider" };
    const readmeBytes = await readBlob(stringValue(readme.sha));
    return {
      status: "ready",
      provenance: "provider",
      value: {
        integrationHeadOid: integration.headOid,
        mainOid,
        cardPath,
        cardBlobOid: oid(stringValue(card.sha)),
        readmeBlobOid: oid(stringValue(readme.sha)),
        readmeBytes,
        observedOid: integration.headOid,
        provenance: "provider",
      },
    };
  }

  async function readSourceIntake(
    source: Record<string, unknown>,
    fact: PullRequestFact,
  ): Promise<PullRequestFact> {
    const author = asRecord(source.user);
    const head = asRecord(source.head);
    const repository = asRecord(head.repo);
    const authorGithubId =
      author.id === undefined ? undefined : canonicalActorId(author.id);
    if (author.id !== undefined && authorGithubId === undefined)
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed contributor identity",
      );
    if (
      typeof repository.owner !== "object" ||
      typeof asRecord(repository.owner).login !== "string" ||
      typeof repository.fork !== "boolean"
    )
      return hydrateMergeParents(fact);
    const files = await paginateChangedFiles(fact.number);
    return hydrateMergeParents({
      ...fact,
      ...(authorGithubId ? { authorGithubId } : {}),
      headRepositoryOwnerLogin: stringValue(asRecord(repository.owner).login),
      headRepositoryIsFork: repository.fork === true,
      changedFiles: await Promise.all(
        files.map(async (file) => {
          const path = stringValue(file.filename);
          const blobOid = oid(stringValue(file.sha));
          return { path, blobOid, bytes: await readBlob(blobOid) };
        }),
      ),
      changedFilesComplete: true,
    });
  }

  async function hydrateMergeParents(
    fact: PullRequestFact,
  ): Promise<PullRequestFact> {
    if (!fact.merged || !fact.mergeCommitOid) return fact;
    const response = await requestRest(
      { method: "GET", path: path(`/git/commits/${fact.mergeCommitOid}`) },
      "read",
    );
    const commit = asRecord(response.data);
    if (stringValue(commit.sha) !== fact.mergeCommitOid)
      throw new OctokitOperationError(
        "retryableTransport",
        "merge commit response does not match pull request merge SHA",
      );
    const parents = commit.parents;
    if (!Array.isArray(parents))
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed merge parents",
      );
    const mergeParentOids = parents.map((parent) =>
      oid(stringValue(asRecord(parent).sha)),
    );
    if (
      mergeParentOids.length !== 2 ||
      mergeParentOids[0] !== fact.baseOid ||
      mergeParentOids[1] !== fact.headOid
    )
      throw new OctokitOperationError(
        "retryableTransport",
        "merge parents do not match pull request base and head",
      );
    return { ...fact, mergeParentOids };
  }

  async function paginateChangedFiles(
    number: number,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path(`/pulls/${number}/files`),
          parameters: { per_page: 100, page },
        },
        "read",
      );
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed changed-files page",
        );
      const files = response.data.map(asRecord);
      all.push(...files);
      const nextPage = legacyNextPage(response);
      if (!nextPage && files.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }

  async function readReviews(
    integration: PullRequestFact,
  ): Promise<Observation<readonly ReviewFact[]>> {
    const reviews = await paginateRecords(
      `/pulls/${integration.number}/reviews`,
    );
    const mapped = reviews.map((value) => {
      const review = asRecord(value);
      const state = reviewState(stringValue(review.state));
      if (!state)
        throw new OctokitOperationError(
          "retryableTransport",
          "unknown review state",
        );
      return {
        pullRequestNumber: integration.number,
        prHeadOid: integration.headOid,
        reviewerLogin: stringValue(asRecord(review.user).login),
        state,
        reviewedCommitOid: oid(stringValue(review.commit_id)),
        observedOid: integration.headOid,
        provenance: "provider" as const,
      };
    });
    return {
      status: "ready",
      provenance: "provider",
      value: mapped,
    };
  }

  async function observeEligibility<T>(
    read: () => Promise<Observation<T>>,
  ): Promise<Observation<T>> {
    try {
      return await read();
    } catch (error) {
      return {
        status: "incomplete",
        provenance: "provider",
        error:
          error instanceof Error ? error.message : "malformed eligibility fact",
      };
    }
  }

  async function readChecks(
    integration: PullRequestFact,
  ): Promise<Observation<readonly import("../core/model.js").CheckFact[]>> {
    const checks = await paginateCheckRuns(integration.headOid);
    const states = checks.map((value) => ({
      state: checkState(asRecord(value)),
      head: asRecord(value).head_sha,
    }));
    if (
      states.some(
        ({ state, head }) =>
          state === undefined || head !== integration.headOid,
      )
    )
      return {
        status: "incomplete",
        provenance: "provider",
        error: "malformed check state",
      };
    return {
      status: "ready",
      provenance: "provider",
      value: states.flatMap(({ state }) => {
        if (state === undefined) return [];
        return [
          {
            pullRequestNumber: integration.number,
            prHeadOid: integration.headOid,
            state,
            observedOid: integration.headOid,
            provenance: "provider" as const,
          },
        ];
      }),
    };
  }

  async function paginateRecords(
    pathSuffix: string,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path(pathSuffix),
          parameters: { per_page: 100, page },
        },
        "read",
      );
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed paginated page",
        );
      all.push(...response.data.map(asRecord));
      const nextPage = legacyNextPage(response);
      if (!nextPage && response.data.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }

  async function paginateCheckRuns(
    headOid: string,
  ): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let page = 1;
    for (;;) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path(`/commits/${headOid}/check-runs`),
          parameters: { per_page: 100, page },
        },
        "read",
      );
      const checks = asRecord(response.data).check_runs;
      if (!Array.isArray(checks))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed checks",
        );
      all.push(...checks.map(asRecord));
      const nextPage = legacyNextPage(response);
      if (!nextPage && checks.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }

  async function readTree(
    commitOid: string,
  ): Promise<Record<string, unknown>[]> {
    const response = await requestRest(
      {
        method: "GET",
        path: path(`/git/trees/${commitOid}`),
        parameters: { recursive: 1 },
      },
      "read",
    );
    const tree = asRecord(response.data).tree;
    if (!Array.isArray(tree))
      throw new OctokitOperationError("retryableTransport", "malformed tree");
    return tree.map(asRecord);
  }

  async function readBlob(blobOid: string): Promise<Uint8Array> {
    const response = await requestRest(
      { method: "GET", path: path(`/git/blobs/${blobOid}`) },
      "read",
    );
    const raw = asRecord(response.data);
    if (raw.encoding !== "base64")
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed blob encoding",
      );
    const content = stringValue(raw.content);
    const bytes = Buffer.from(content, "base64");
    if (bytes.length === 0 && content.length > 0)
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed blob content",
      );
    return new Uint8Array(bytes);
  }

  async function readAcceptedCard(
    candidate: NonNullable<RepositoryFacts["candidate"]["value"]>,
    sourcePrNumber: number,
  ): Promise<NonNullable<RepositoryFacts["acceptedCard"]>> {
    const bytes = await readBlob(candidate.cardBlobOid);
    return {
      path: candidate.cardPath,
      bytes,
      githubId: cardMetadata(bytes).githubId,
      sourcePrNumber,
    };
  }

  async function paginatePullRequests(): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    let page = 1;
    for (;;) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path("/pulls"),
          parameters: { state: "all", per_page: 100, page },
        },
        "read",
      );
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed pagination page",
        );
      const values = response.data.map(asRecord);
      for (const value of values) {
        const number = numberValue(value.number);
        if (seen.has(number))
          throw new OctokitOperationError(
            "retryableTransport",
            "pagination overlap",
          );
        seen.add(number);
        all.push(value);
      }
      const nextPage = legacyNextPage(response);
      if (!nextPage && values.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }

  async function readCommentsForTargets(
    targets: readonly number[],
  ): Promise<readonly CommentFact[]> {
    const comments = await Promise.all(targets.map(readIssueComments));
    return comments.flat();
  }

  async function readIssueComments(
    pullRequestNumber: number,
  ): Promise<CommentFact[]> {
    const all: CommentFact[] = [];
    const seenUrls = new Set<string>();
    let request: RestRequest = {
      method: "GET",
      path: apiCommentPath(`/issues/${pullRequestNumber}/comments`),
      parameters: { per_page: 100, page: 1 },
      headers: { "cache-control": "no-cache" },
    };
    for (let page = 0; page < COMMENT_PAGE_BUDGET; page += 1) {
      const response = await requestCommentRest(request, [200], "read");
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "unknownOutcome",
          "malformed issue comments page",
        );
      for (const value of response.data) {
        const comment = materializeComment(
          value,
          pullRequestNumber,
          apiCommentPath,
          false,
          apiOrigin,
        );
        if (comment) all.push(comment);
      }
      const next = nextCommentPage(
        response.headers?.link,
        request,
        pullRequestNumber,
        apiCommentPath,
        apiOrigin,
        repositoryId,
      );
      if (next.kind === "terminal") return deduplicateComments(all);
      if (next.kind === "malformed")
        throw new OctokitOperationError(
          "unknownOutcome",
          "malformed issue comments Link header",
        );
      if (seenUrls.has(next.url))
        throw new OctokitOperationError(
          "unknownOutcome",
          "cyclic issue comments pagination",
        );
      seenUrls.add(next.url);
      request = {
        method: "GET",
        path: next.url,
        headers: { "cache-control": "no-cache" },
      };
    }
    throw new OctokitOperationError(
      "unknownOutcome",
      "issue comments pagination budget exhausted",
    );
  }

  async function readIssueComment(
    commentId: number,
    pullRequestNumber: number,
  ): Promise<CommentFact> {
    const response = await requestCommentRest(
      {
        method: "GET",
        path: apiCommentPath(`/issues/comments/${commentId}`),
        headers: { "cache-control": "no-cache" },
      },
      [200],
      "read",
    );
    const comment = materializeComment(
      response.data,
      pullRequestNumber,
      apiCommentPath,
      true,
      apiOrigin,
    );
    if (!comment)
      throw new OctokitOperationError(
        "unknownOutcome",
        "comment is not controlled",
      );
    if (comment.id !== commentId)
      throw new OctokitOperationError(
        "unknownOutcome",
        `comment read returned ID ${comment.id}, expected ${commentId}`,
      );
    return comment;
  }

  async function reconcileAmbiguousCreate(
    intent: CommentIntent,
    expected: TrustedPrincipal,
    cause?: unknown,
  ): Promise<CommentEnsureResult> {
    const attempts = boundedReadbackAttempts(commentReadback.attempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const comments = await readIssueComments(
          intent.targetPullRequestNumber,
        );
        const matches = comments.filter(
          (comment) => comment.actionKey === intent.actionKey,
        );
        const conflicts = matches.filter(
          (comment) =>
            comment.body !== intent.body ||
            comment.user?.id !== expected.actorId ||
            comment.user.actorType !== expected.actorType ||
            comment.targetPullRequestNumber !== intent.targetPullRequestNumber,
        );
        const exact = matches.filter(
          (comment) =>
            comment.body === intent.body &&
            comment.user?.id === expected.actorId &&
            comment.user.actorType === expected.actorType &&
            comment.targetPullRequestNumber === intent.targetPullRequestNumber,
        );
        if (conflicts.length > 0 || exact.length > 1) {
          commentLifecycle.delete(commentLifecycleKey(intent));
          return { kind: "ambiguousOwnership" };
        }
        if (exact.length === 1 && exact[0]) {
          commentLifecycle.delete(commentLifecycleKey(intent));
          return { kind: "alreadyApplied", comment: exact[0] };
        }
      } catch (error) {
        if (!isVisibilityUncertainty(error)) {
          commentLifecycle.delete(commentLifecycleKey(intent));
          return commentFailure(error);
        }
      }
      if (attempt + 1 < attempts) await waitForCommentReadback(commentReadback);
    }
    return {
      kind: "unknownOutcome",
      detail: `${cause instanceof OctokitOperationError ? cause.message : "comment response was ambiguous"}; comment may still be converging`,
    };
  }

  async function requestCommentRest(
    request: RestRequest,
    statuses: readonly number[],
    operation: "read" | "mutation" = "mutation",
  ): Promise<RestResponse> {
    try {
      const response = await options.transport.rest({
        ...request,
        ...(activeSignal ? { signal: activeSignal } : {}),
      });
      if (statuses.includes(response.status)) return response;
      throw new OctokitOperationError(
        commentErrorCategory(response.status, operation, response.headers),
        `REST ${request.path} returned ${response.status}${retryMetadata(response)}`,
      );
    } catch (error) {
      if (error instanceof OctokitOperationError) throw error;
      throw new OctokitOperationError(
        operation === "mutation" ? "unknownOutcome" : "retryableTransport",
        `comment ${operation} transport failed`,
      );
    }
  }

  function grantSetupCommentCreatePermit<T>(result: T): T {
    const source = (lastFacts ?? options.initialFacts)?.sourcePullRequest.value;
    if (source)
      grantCommentCreatePermit({
        targetPullRequestNumber: source.number,
        slot: "source-status",
        phase: "setup",
        milestone: "setup",
      });
    return result;
  }

  function grantCommentCreatePermit(input: {
    targetPullRequestNumber: number;
    slot: "source-status" | "integration-status";
    phase: "setup" | "ready-guidance";
    milestone: "setup" | "ready";
  }): void {
    const source = (lastFacts ?? options.initialFacts)?.sourcePullRequest.value;
    if (!source?.authorGithubId) return;
    commentCreatePermits.push({
      runIdentity: `source:${source.number}:${source.authorGithubId}`,
      ...input,
    });
  }

  function reserveCommentCreatePermit(intent: CommentIntent): boolean {
    if (intent.phase === "completion") return false;
    const key = parseCommentActionKey(intent.actionKey);
    const index = commentCreatePermits.findIndex(
      (permit) =>
        key !== undefined &&
        key.runIdentity === permit.runIdentity &&
        key.targetPullRequestNumber === permit.targetPullRequestNumber &&
        key.slot === permit.slot &&
        intent.targetPullRequestNumber === permit.targetPullRequestNumber &&
        intent.slot === permit.slot &&
        intent.phase === permit.phase &&
        milestoneForCommentPhase(intent.phase) === permit.milestone,
    );
    if (index < 0) return false;
    commentCreatePermits.splice(index, 1);
    return true;
  }

  async function findIntegrationBranch(
    expectedName?: string,
  ): Promise<BranchAnchor | undefined> {
    const response = await requestRest(
      { method: "GET", path: path("/git/matching-refs/heads/feature/card-") },
      "read",
    );
    if (!Array.isArray(response.data))
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed branch refs",
      );
    const value = response.data.map(asRecord).find((item) => {
      const ref = item.ref;
      return (
        typeof ref === "string" &&
        ref.startsWith("refs/heads/feature/card-") &&
        (!expectedName || ref === `refs/heads/${expectedName}`)
      );
    });
    if (!value) return undefined;
    const ref = stringValue(value.ref).replace(/^refs\/heads\//u, "");
    return {
      name: ref,
      headOid: oid(stringValue(asRecord(value.object).sha)),
      provenance: "provider",
    };
  }

  async function readBranch(name: string): Promise<BranchAnchor> {
    const response = await requestRest(
      { method: "GET", path: path(`/git/ref/heads/${name}`) },
      "read",
    );
    return branchFromResponse(response.data, name);
  }

  async function requestRest(
    request: RestRequest,
    operation: "read" | "mutation",
  ): Promise<RestResponse> {
    try {
      const response = await options.transport.rest({
        ...request,
        ...(activeSignal ? { signal: activeSignal } : {}),
      });
      if (response.status >= 200 && response.status < 300) return response;
      throw new OctokitOperationError(
        errorCategory(response),
        `REST ${request.path} returned ${response.status}`,
      );
    } catch (error) {
      if (error instanceof OctokitOperationError) throw error;
      if (options.replay) throw error;
      throw new OctokitOperationError(
        operation === "mutation" ? "unknownOutcome" : "retryableTransport",
        "transport failed",
      );
    }
  }

  async function requestLegacyRest(
    request: RestRequest,
    operation: "read" | "mutation",
  ): Promise<LegacyPaginationResponse> {
    return (await requestRest(request, operation)) as LegacyPaginationResponse;
  }

  async function requestGraphql(
    request: GraphqlRequest,
  ): Promise<GraphqlResponse> {
    try {
      return await options.transport.graphql({
        ...request,
        ...(activeSignal ? { signal: activeSignal } : {}),
      });
    } catch (error) {
      if (options.replay) throw error;
      throw new OctokitOperationError(
        "unknownOutcome",
        "GraphQL transport failed",
      );
    }
  }
}

function milestoneForCommentPhase(
  phase: CommentIntent["phase"],
): "setup" | "ready" | undefined {
  if (phase === "setup") return "setup";
  if (phase === "ready-guidance") return "ready";
  return undefined;
}

const COMMENT_PAGE_BUDGET = 8;

function normalizeApiOrigin(value: string | undefined): URL {
  const parsed = new URL(value ?? "https://api.github.com");
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = pathname === "/" ? "" : pathname;
  return parsed;
}

function trustedApiPath(origin: URL): string {
  return origin.pathname === "/" ? "" : origin.pathname.replace(/\/+$/u, "");
}

function boundedReadbackAttempts(value: number | undefined): number {
  return Math.min(Math.max(value ?? 3, 1), 8);
}

function commentLifecycleKey(intent: CommentIntent): string {
  return `${intent.targetPullRequestNumber}:${intent.actionKey}`;
}

function parseCommentActionKey(value: string):
  | {
      runIdentity: string;
      targetPullRequestNumber: number;
      slot: "source-status" | "integration-status";
    }
  | undefined {
  const match =
    /^run=([^;]+);target=([1-9][0-9]*);slot=(source-status|integration-status)$/u.exec(
      value,
    );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const targetPullRequestNumber = Number(match[2]);
  return Number.isSafeInteger(targetPullRequestNumber)
    ? {
        runIdentity: match[1],
        targetPullRequestNumber,
        slot: match[3] as "source-status" | "integration-status",
      }
    : undefined;
}

async function waitForCommentReadback(
  options: OctokitGithubPlatformOptions["commentReadback"],
): Promise<void> {
  if (!options?.sleep) return;
  await options.sleep(options.delayMs ?? 0);
}

function readyStateFromFacts(
  facts: RepositoryFacts | undefined,
  input: { pullRequestNumber: number },
): ReadyState | undefined {
  const pullRequest = facts?.integrationPullRequest.value;
  const candidate = facts?.candidate.value;
  return pullRequest &&
    candidate &&
    pullRequest.number === input.pullRequestNumber
    ? { pullRequest, candidate }
    : undefined;
}

function activeIdentityIds(
  pages: readonly Record<string, unknown>[],
  source: Record<string, unknown> | undefined,
): string[] {
  return pages
    .filter(
      (item) =>
        item !== source &&
        stringValue(asRecord(item.head).ref).startsWith("add/") &&
        item.state !== "closed",
    )
    .map((item) => {
      const rawId = asRecord(item.user).id;
      if (rawId === undefined) return undefined;
      const id = canonicalActorId(rawId);
      if (id === undefined)
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed active contributor identity",
        );
      return id;
    })
    .filter((id): id is string => id !== undefined);
}

function legacyNextPage(response: RestResponse): number | undefined {
  const page = (response as LegacyPaginationResponse).nextPage;
  return typeof page === "number" && Number.isSafeInteger(page) && page > 0
    ? page
    : undefined;
}

function incompleteAncestry(
  error: string,
): RepositoryFacts["sourceHeadBasedOnIntegration"] {
  return { status: "incomplete", provenance: "provider", error };
}

function addCompareCommits(commits: unknown[], seen: Set<string>): boolean {
  for (const item of commits) {
    const sha = asRecord(item).sha;
    if (typeof sha !== "string" || sha.length === 0 || seen.has(sha))
      return false;
    seen.add(sha);
  }
  return true;
}

function compareNextLink(
  header: string | undefined,
  origin: URL,
  comparePath: string,
  currentPage: number,
  repositoryId: number | undefined,
): string | undefined {
  if (header === undefined) return undefined;
  if (header.trim().length === 0)
    throw new Error("malformed compare Link header");
  const entries = header.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !/^<[^<>]+>\s*;\s*rel="[^"]+"$/u.test(entry)))
    throw new Error("malformed compare Link header");
  const relations = entries.map((entry) => {
    const match = /^<([^<>]+)>\s*;\s*rel="([^"]+)"$/u.exec(entry);
    if (!match?.[1] || !match[2])
      throw new Error("malformed compare Link header");
    return { url: match[1], rels: match[2].split(/\s+/u) };
  });
  const nextLinks = relations.flatMap((entry) =>
    entry.rels
      .filter((rel) => rel.toLowerCase() === "next")
      .map(() => entry.url),
  );
  if (nextLinks.length > 1) throw new Error("malformed compare Link header");
  for (const relation of relations) {
    const url = new URL(relation.url, origin);
    if (
      url.origin !== origin.origin ||
      !compareLinkPath(url.pathname, origin, comparePath, repositoryId)
    )
      throw new Error("untrusted compare Link header");
    const page = url.searchParams.get("page");
    const perPage = url.searchParams.get("per_page");
    if (
      !page ||
      !perPage ||
      !/^[1-9][0-9]*$/u.test(page) ||
      perPage !== "100" ||
      url.searchParams.getAll("page").length !== 1 ||
      url.searchParams.getAll("per_page").length !== 1 ||
      [...url.searchParams.keys()].some(
        (key) => key !== "page" && key !== "per_page",
      )
    )
      throw new Error("malformed compare Link query");
    if (
      relation.rels.some((rel) => rel.toLowerCase() === "next") &&
      Number(page) <= currentPage
    )
      throw new Error("nonprogressing compare Link");
  }
  if (nextLinks.length === 0) return undefined;
  const nextLink = nextLinks[0];
  if (!nextLink) return undefined;
  const url = new URL(nextLink, origin);
  const apiPath = trustedApiPath(origin);
  return `${url.pathname.slice(apiPath.length)}?${url.searchParams.toString()}`;
}

function compareLinkPath(
  pathname: string,
  origin: URL,
  comparePath: string,
  repositoryId: number | undefined,
): boolean {
  const apiPath = trustedApiPath(origin);
  if (pathname === `${apiPath}${comparePath}`) return true;
  if (repositoryId === undefined) return false;
  const suffix = comparePath.match(
    /^\/repos\/[^/]+\/[^/]+(\/compare\/.*)$/u,
  )?.[1];
  return (
    suffix !== undefined &&
    pathname === `${apiPath}/repositories/${repositoryId}${suffix}`
  );
}

function pullRequestFact(
  value: unknown,
  kind: "contribution" | "integration",
  exact = false,
): PullRequestFact {
  const record = asRecord(value);
  if (exact) validateExactPullRequestLifecycle(record);
  return {
    number: numberValue(record.number),
    ...(typeof record.node_id === "string" ? { nodeId: record.node_id } : {}),
    kind,
    headOid: oid(stringValue(asRecord(record.head).sha)),
    baseOid: oid(stringValue(asRecord(record.base).sha)),
    ...(typeof asRecord(record.head).ref === "string"
      ? { headRef: stringValue(asRecord(record.head).ref) }
      : {}),
    ...(typeof asRecord(record.base).ref === "string"
      ? { baseRef: stringValue(asRecord(record.base).ref) }
      : {}),
    draft: record.draft === true,
    ...(record.merged === true || record.merged === false
      ? { merged: record.merged }
      : {}),
    ...(record.state === "closed" ? { closed: true } : {}),
    ...(record.merged === true &&
    typeof record.merge_commit_sha === "string" &&
    record.merge_commit_sha.length > 0
      ? { mergeCommitOid: oid(record.merge_commit_sha) }
      : {}),
    ...(record.merged === true && Array.isArray(record.merge_commit_parents)
      ? {
          mergeParentOids: record.merge_commit_parents
            .filter((value): value is string => typeof value === "string")
            .map(oid),
        }
      : {}),
    ...(typeof asRecord(record.user).login === "string"
      ? { authorLogin: stringValue(asRecord(record.user).login) }
      : {}),
    ...(typeof asRecord(record.head).ref === "string"
      ? {
          runKey: `${stringValue(asRecord(record.head).ref)}:${numberValue(record.number)}`,
        }
      : {}),
    observedOid: oid(stringValue(asRecord(record.head).sha)),
    provenance: "provider",
  };
}

function samePullRequestIdentity(
  summary: Record<string, unknown>,
  exact: Record<string, unknown>,
): boolean {
  return (
    numberValue(summary.number) === numberValue(exact.number) &&
    stringValue(asRecord(summary.head).sha) ===
      stringValue(asRecord(exact.head).sha) &&
    stringValue(asRecord(summary.head).ref) ===
      stringValue(asRecord(exact.head).ref) &&
    stringValue(asRecord(summary.base).sha) ===
      stringValue(asRecord(exact.base).sha) &&
    stringValue(asRecord(summary.base).ref) ===
      stringValue(asRecord(exact.base).ref)
  );
}

function validateExactPullRequestLifecycle(
  record: Record<string, unknown>,
): void {
  if (record.state !== "open" && record.state !== "closed")
    throw new OctokitOperationError(
      "retryableTransport",
      "malformed pull request state",
    );
  if (typeof record.merged !== "boolean")
    throw new OctokitOperationError(
      "retryableTransport",
      "exact pull request merged state is required",
    );
  const mergedAt = record.merged_at;
  const mergeCommitSha = record.merge_commit_sha;
  if (
    record.state === "open" &&
    (record.merged ||
      !absentOrNull(mergedAt) ||
      (mergeCommitSha !== undefined &&
        mergeCommitSha !== null &&
        (typeof mergeCommitSha !== "string" || mergeCommitSha.length === 0)))
  )
    throw new OctokitOperationError(
      "retryableTransport",
      "malformed open pull request lifecycle",
    );
  if (record.state !== "closed") return;
  if (
    !(typeof mergedAt === "string" || mergedAt === null) ||
    !(typeof mergeCommitSha === "string" || mergeCommitSha === null) ||
    (record.merged &&
      (typeof mergedAt !== "string" ||
        !validTimestamp(mergedAt) ||
        typeof mergeCommitSha !== "string" ||
        mergeCommitSha.length === 0)) ||
    (!record.merged && (mergedAt !== null || mergeCommitSha !== null))
  )
    throw new OctokitOperationError(
      "retryableTransport",
      "malformed closed pull request lifecycle",
    );
}

function absentOrNull(value: unknown): boolean {
  return value === undefined || value === null;
}

function validTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    return false;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const daysInMonth = new Date(
    Date.UTC(yearNumber, monthNumber, 0),
  ).getUTCDate();
  return (
    monthNumber >= 1 &&
    monthNumber <= 12 &&
    dayNumber >= 1 &&
    dayNumber <= daysInMonth &&
    hourNumber >= 0 &&
    hourNumber <= 23 &&
    minuteNumber >= 0 &&
    minuteNumber <= 59 &&
    secondNumber >= 0 &&
    secondNumber <= 59 &&
    !Number.isNaN(Date.parse(value))
  );
}

function mergeabilityObservation(
  record: Record<string, unknown>,
): RepositoryFacts["eligibility"]["mergeability"] {
  if (record.mergeable === true || record.mergeable === false)
    return {
      status: "ready",
      provenance: "provider",
      value: record.mergeable ? "mergeable" : null,
    };
  return {
    status: "incomplete",
    provenance: "provider",
    error: "exact integration pull request mergeability is incomplete",
  };
}

function reviewState(value: string): ReviewFact["state"] | undefined {
  if (value.toLowerCase() === "approved") return "approved";
  if (value.toLowerCase() === "changes_requested") return "changesRequested";
  if (value.toLowerCase() === "dismissed") return "dismissed";
  if (value.toLowerCase() === "commented") return "commented";
  return undefined;
}

function checkState(
  check: Record<string, unknown>,
): import("../core/model.js").CheckFact["state"] | undefined {
  if (check.status === "queued") return "queued";
  if (check.status === "in_progress") return "inProgress";
  if (check.status !== "completed") return undefined;
  if (check.conclusion === "success") return "success";
  if (typeof check.conclusion === "string") return "failure";
  return undefined;
}

function cardMetadata(bytes: Uint8Array): {
  githubId: string;
  sourcePrNumber: number;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OctokitOperationError("retryableTransport", "invalid Card UTF-8");
  }
  const githubId = /^github_id: (\d+)$/m.exec(text)?.[1];
  const sourcePr = /^source_pr: (\d+)$/m.exec(text)?.[1];
  if (!githubId || !canonicalActorId(githubId) || !sourcePr)
    throw new OctokitOperationError(
      "retryableTransport",
      "Card metadata is required",
    );
  return { githubId, sourcePrNumber: Number(sourcePr) };
}

function confirmationsFrom(
  facts: RepositoryFacts,
): RepositoryFacts["confirmations"] {
  const source = facts.sourcePullRequest.value;
  const integration = facts.integrationPullRequest.value;
  const candidate = facts.candidate.value;
  const reviews = facts.eligibility.reviews;
  const card = facts.acceptedCard;
  if (
    !source?.authorLogin ||
    !integration ||
    !candidate ||
    !card ||
    reviews.status !== "ready"
  )
    return [];
  const contributorLogin = source.authorLogin;
  return (reviews.value ?? [])
    .filter(
      (review) =>
        review.pullRequestNumber === integration.number &&
        review.prHeadOid === integration.headOid &&
        review.reviewerLogin === contributorLogin &&
        review.state === "approved" &&
        review.reviewedCommitOid === integration.headOid,
    )
    .map((review) => ({
      kind: "domainConfirmation" as const,
      contributorLogin,
      githubId: card.githubId,
      sourcePrNumber: source.number,
      integrationPrNumber: integration.number,
      reviewedCommitOid: review.reviewedCommitOid,
      cardPath: candidate.cardPath,
      cardBlobOid: candidate.cardBlobOid,
    }));
}

function branchFromResponse(value: unknown, name: string): BranchAnchor {
  const record = asRecord(value);
  return {
    name,
    headOid: oid(stringValue(asRecord(record.object).sha ?? record.sha)),
    provenance: "provider",
  };
}

function operationFailure<T>(error: unknown): OperationResult<T> {
  if (error instanceof OctokitOperationError) {
    const kind = error.category === "gone" ? "unknownOutcome" : error.category;
    return { kind, detail: error.message };
  }
  return {
    kind: "unknownOutcome",
    detail: "provider operation failed",
  };
}

function errorCategory(
  response: RestResponse,
): Exclude<OperationResult<unknown>["kind"], "succeeded" | "alreadyApplied"> {
  if (response.status === 403)
    return response.headers?.["x-ratelimit-remaining"] === "0"
      ? "rateLimited"
      : "permissionDenied";
  if (response.status === 404) {
    const rawMessage = asRecord(response.data).message;
    const message = typeof rawMessage === "string" ? rawMessage : "";
    return message.toLowerCase().includes("accessible")
      ? "notVisibleYet"
      : "notFound";
  }
  if (response.status === 409) return "stalePrecondition";
  if (response.status === 405) return "policyRejected";
  if (response.status === 422) return "policyRejected";
  if (response.status === 429) return "rateLimited";
  return response.status >= 500 ? "retryableTransport" : "unknownOutcome";
}

function graphqlCategory(
  errors: readonly { message: string }[] | undefined,
): Exclude<OperationResult<unknown>["kind"], "succeeded" | "alreadyApplied"> {
  const message =
    errors
      ?.map((error) => error.message)
      .join(" ")
      .toLowerCase() ?? "";
  if (message.includes("rate")) return "rateLimited";
  if (message.includes("permission") || message.includes("forbidden"))
    return "permissionDenied";
  if (message.includes("not found")) return "notFound";
  return "unknownOutcome";
}

function validPrincipal(value: TrustedPrincipal): boolean {
  return (
    /^[1-9][0-9]*$/u.test(value.actorId) &&
    (value.actorType === "Bot" || value.actorType === "User")
  );
}

function materializeComment(
  value: unknown,
  targetPullRequestNumber: number,
  repositoryPath: (suffix: string) => string,
  requireControlled: boolean,
  trustedOrigin: URL,
): CommentFact | undefined {
  const record = asRecord(value);
  const id = safeInteger(record.id);
  const user = asRecord(record.user);
  const userId = canonicalActorId(user.id);
  const actorType = user.type;
  const body = record.body;
  const issueUrl = record.issue_url;
  if (
    id === undefined ||
    userId === undefined ||
    Object.keys(user).length === 0 ||
    (actorType !== "Bot" && actorType !== "User") ||
    typeof body !== "string" ||
    typeof issueUrl !== "string" ||
    !commentTargetsPullRequest(
      issueUrl,
      targetPullRequestNumber,
      repositoryPath,
      trustedOrigin,
    )
  )
    throw new OctokitOperationError(
      "unknownOutcome",
      "malformed or wrong-target issue comment",
    );
  const marker =
    /^<!-- hello-from-main: key=([^\s]+) phase=(setup|validation-feedback|validation-success|ready-guidance|completion) -->/u.exec(
      body,
    );
  if (!marker?.[1]) {
    if (!requireControlled) return undefined;
    throw new OctokitOperationError(
      "unknownOutcome",
      "issue comment marker is required",
    );
  }
  let actionKey: string;
  try {
    actionKey = decodeURIComponent(marker[1]);
  } catch {
    throw new OctokitOperationError(
      "unknownOutcome",
      "issue comment marker is malformed",
    );
  }
  const updatedAt =
    typeof record.updated_at === "string" ? record.updated_at : undefined;
  return {
    id,
    user: {
      id: userId,
      actorType,
      ...(typeof user.login === "string" ? { login: user.login } : {}),
    },
    ownerPrincipal: { actorId: userId, actorType },
    actionKey,
    body,
    ...(updatedAt ? { updatedAt } : {}),
    targetPullRequestNumber,
  };
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function canonicalActorId(value: unknown): string | undefined {
  if (typeof value === "string")
    return /^[1-9][0-9]*$/u.test(value) ? value : undefined;
  const number = safeInteger(value);
  return number === undefined ? undefined : String(number);
}

function commentTargetsPullRequest(
  issueUrl: string,
  target: number,
  repositoryPath: (suffix: string) => string,
  trustedOrigin: URL,
): boolean {
  try {
    const url = new URL(issueUrl);
    return (
      url.origin === trustedOrigin.origin &&
      url.pathname ===
        `${trustedApiPath(trustedOrigin)}${repositoryPath(`/issues/${target}`)}`
    );
  } catch {
    return false;
  }
}

function sameCommentIdentity(left: CommentFact, right: CommentFact): boolean {
  return (
    left.id === right.id &&
    left.targetPullRequestNumber === right.targetPullRequestNumber &&
    left.actionKey === right.actionKey &&
    left.ownerPrincipal.actorId === right.ownerPrincipal.actorId &&
    left.ownerPrincipal.actorType === right.ownerPrincipal.actorType
  );
}

function sameObservedComment(left: CommentFact, right: CommentFact): boolean {
  return sameCommentIdentity(left, right) && left.body === right.body;
}

function sameIntendedComment(
  comment: CommentFact,
  intent: CommentIntent,
  expected: TrustedPrincipal,
): boolean {
  return (
    comment.targetPullRequestNumber === intent.targetPullRequestNumber &&
    comment.actionKey === intent.actionKey &&
    comment.body === intent.body &&
    comment.ownerPrincipal.actorId === expected.actorId &&
    comment.ownerPrincipal.actorType === expected.actorType
  );
}

function deduplicateComments(comments: readonly CommentFact[]): CommentFact[] {
  const byId = new Map<number, CommentFact>();
  for (const comment of comments) {
    const existing = byId.get(comment.id);
    if (!existing) {
      byId.set(comment.id, comment);
      continue;
    }
    if (!sameObservedComment(existing, comment))
      throw new OctokitOperationError(
        "unknownOutcome",
        "conflicting duplicate issue comment",
      );
  }
  return [...byId.values()];
}

type CommentNext =
  | { kind: "terminal" }
  | { kind: "next"; url: string }
  | { kind: "malformed" };

function nextCommentPage(
  raw: string | undefined,
  current: RestRequest,
  target: number,
  repositoryPath: (suffix: string) => string,
  trustedOrigin: URL,
  repositoryId: number | undefined,
): CommentNext {
  if (raw === undefined) return { kind: "terminal" };
  if (raw.trim().length === 0) return { kind: "malformed" };
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !/^<[^<>]+>\s*;\s*rel="[^"]+"$/u.test(entry)))
    return { kind: "malformed" };
  const relations = entries.map((entry) => {
    const match = /^<([^<>]+)>\s*;\s*rel="([^"]+)"$/u.exec(entry);
    return match?.[1] && match[2]
      ? { url: match[1], rels: match[2].split(/\s+/u) }
      : undefined;
  });
  if (relations.some((entry) => !entry)) return { kind: "malformed" };
  const next = relations.flatMap(
    (entry) => entry?.rels.map((rel) => ({ url: entry.url, rel })) ?? [],
  );
  const nextLinks = next.filter((entry) => entry.rel.toLowerCase() === "next");
  if (nextLinks.length === 0) return { kind: "malformed" };
  if (nextLinks.length !== 1 || !nextLinks[0]?.url)
    return { kind: "malformed" };
  if (
    next.some(
      (entry) =>
        entry.rel.toLowerCase() === "next" && entry.url !== nextLinks[0]?.url,
    )
  )
    return { kind: "malformed" };
  try {
    const url = new URL(nextLinks[0].url);
    const currentUrl = new URL(
      typeof current.path === "string" && current.path.startsWith("http")
        ? current.path
        : `${trustedOrigin.origin}${
            current.path.startsWith(trustedApiPath(trustedOrigin))
              ? current.path
              : `${trustedApiPath(trustedOrigin)}${current.path}`
          }`,
    );
    if (
      url.origin !== trustedOrigin.origin ||
      currentUrl.origin !== trustedOrigin.origin ||
      !trustedCommentListPath(
        url.pathname,
        target,
        repositoryPath,
        trustedOrigin,
        repositoryId,
      ) ||
      !positiveInteger(url.searchParams.get("page")) ||
      !positiveInteger(currentUrl.searchParams.get("page") ?? "1") ||
      Number(url.searchParams.get("page")) <=
        Number(currentUrl.searchParams.get("page") ?? "1")
    )
      return { kind: "malformed" };
    return { kind: "next", url: url.toString() };
  } catch {
    return { kind: "malformed" };
  }
}

function trustedCommentListPath(
  pathname: string,
  target: number,
  repositoryPath: (suffix: string) => string,
  trustedOrigin: URL,
  repositoryId: number | undefined,
): boolean {
  const apiPath = trustedApiPath(trustedOrigin);
  if (pathname === `${apiPath}${repositoryPath(`/issues/${target}/comments`)}`)
    return true;
  return (
    repositoryId !== undefined &&
    pathname ===
      `${apiPath}/repositories/${repositoryId}/issues/${target}/comments`
  );
}

function positiveInteger(value: string | null): boolean {
  return value !== null && /^[1-9][0-9]*$/u.test(value);
}

function commentErrorCategory(
  status: number,
  operation: "read" | "mutation",
  headers?: Record<string, string | undefined>,
): OctokitOperationError["category"] {
  if (
    status === 429 ||
    (status === 403 &&
      (headers?.["x-ratelimit-remaining"] === "0" ||
        headers?.["retry-after"] !== undefined ||
        headers?.["x-ratelimit-reset"] !== undefined))
  )
    return "rateLimited";
  if (status === 401 || status === 403) return "permissionDenied";
  if (status === 404)
    return operation === "mutation" ? "notFound" : "notVisibleYet";
  if (status === 410) return "gone";
  if (status === 422) return "policyRejected";
  if (status >= 500) return "retryableTransport";
  return "unknownOutcome";
}

function retryMetadata(response: RestResponse): string {
  const headers = response.headers ?? {};
  const values = [
    "retry-after",
    "x-ratelimit-reset",
    "x-ratelimit-remaining",
  ].flatMap((key) => (headers[key] ? [` ${key}=${headers[key]}`] : []));
  return values.length > 0 ? ` (${values.join(",")})` : "";
}

function isAmbiguousMutation(error: unknown): boolean {
  return (
    error instanceof OctokitOperationError &&
    (error.category === "unknownOutcome" ||
      error.category === "retryableTransport")
  );
}

function isVisibilityUncertainty(error: unknown): boolean {
  return (
    error instanceof OctokitOperationError &&
    (error.category === "notVisibleYet" ||
      error.category === "unknownOutcome" ||
      error.category === "retryableTransport")
  );
}

function commentFailure(error: unknown): CommentEnsureResult {
  if (error instanceof OctokitOperationError) {
    if (error.category === "permissionDenied")
      return { kind: "permissionDenied", detail: error.message };
    if (error.category === "notVisibleYet")
      return { kind: "notVisibleYet", detail: error.message };
    if (error.category === "gone" || error.category === "policyRejected")
      return { kind: "capabilityUnavailable", detail: error.message };
    if (error.category === "stalePrecondition") return { kind: "stale" };
    if (
      error.category === "retryableTransport" ||
      error.category === "rateLimited"
    )
      return { kind: "retryableTransport", detail: error.message };
    return { kind: "unknownOutcome", detail: error.message };
  }
  return { kind: "unknownOutcome", detail: "comment operation failed" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("provider response string is required");
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value !== "number")
    throw new Error("provider response number is required");
  return value;
}
