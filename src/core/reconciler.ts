import type { GitWorkspace } from "../ports/git-workspace.js";
import type {
  GithubPlatform,
  InvocationContext,
} from "../ports/github-platform.js";
import type { Card, CardPolicy } from "../render/card.js";
import { parseCard, renderProjectShellBytes } from "../render/card.js";
import {
  renderCompletionComment,
  renderReadyComment,
  renderSetupComment,
  renderValidationComment,
} from "../render/comment.js";
import { renderReadmeMarkers } from "../render/readme.js";
import type {
  CandidateWrite,
  CandidateWriteResult,
  CommentIntent,
  CommentPhase,
  CommentSlot,
  ContributionMergeRequest,
  FinalMainPostconditions,
  IntegrationMergeRequest,
  Observation,
  OperationResultCategory,
  PublishedCardTarget,
  ReconcileBudget,
  ReconcileOutcome,
  RepositoryFacts,
  ValidationResult,
  WorkspaceReadback,
} from "./model.js";
import {
  createPublishedCardTarget,
  gitBlobOid,
  oid,
  planCommentMutation,
} from "./model.js";

type Diagnostic = { turn: number; effect?: string; outcome: ReconcileOutcome };

export type Reconciler = {
  reconcile(input: {
    budget: ReconcileBudget;
    onDiagnostic?: (diagnostic: Diagnostic) => void;
  }): Promise<ReconcileOutcome>;
};

type CommentEffect = { kind: "ensureComment"; intent: CommentIntent };

export function validateIntake(
  facts: RepositoryFacts,
  candidatePolicy?: {
    card: CardPolicy;
  },
): ValidationResult {
  const source = facts.sourcePullRequest.value;
  const issues: import("./model.js").ValidationIssue[] = [];
  const headOid = source?.headOid;
  if (
    !source?.authorLogin ||
    !source.authorGithubId ||
    source.headRepositoryOwnerLogin !== source.authorLogin ||
    source.headRepositoryIsFork !== true
  )
    issues.push({ category: "intake-author-or-fork" });
  const expectedPath = source?.authorLogin
    ? `people/${source.authorLogin}.md`
    : undefined;
  if (
    !source?.headRef ||
    source.headRef !== `add/${source.authorLogin ?? ""}` ||
    source.changedFiles?.length !== 1 ||
    source.changedFiles?.[0]?.path !== expectedPath
  )
    issues.push({
      category: "intake-ref-or-path",
      ...(expectedPath ? { path: expectedPath } : {}),
    });
  if (
    source?.changedFilesComplete !== true ||
    source.changedFiles?.length !== 1
  )
    issues.push({ category: "change-scope" });
  const file = source?.changedFiles?.[0];
  if (
    !source?.authorGithubId ||
    facts.publishedGithubIds?.includes(source.authorGithubId) ||
    facts.activeGithubIds?.includes(source.authorGithubId) ||
    (file &&
      (file.path !== expectedPath ||
        !new TextDecoder()
          .decode(file.bytes)
          .includes(`github_id: ${source.authorGithubId}`) ||
        !new TextDecoder()
          .decode(file.bytes)
          .includes(`source_pr: ${source.number}`)))
  )
    issues.push({ category: "identity-or-metadata" });
  if (candidatePolicy && file) {
    const rawCardText = new TextDecoder().decode(file.bytes);
    const contributorText = rawCardText.split("\n---\n\n")[1] ?? rawCardText;
    const parsed = parseCard(file.bytes, {
      path: file.path,
      policy: candidatePolicy.card,
    });
    if (hasUnsafeContributorText(contributorText))
      issues.push({ category: "card-safety", path: file.path });
    if (!parsed.ok) {
      const safety = /control|conflict|link|image|HTML|syntax/iu.test(
        parsed.error.reason,
      );
      if (!safety || !issues.some((issue) => issue.category === "card-safety"))
        issues.push({ category: "card-grammar-or-template", path: file.path });
      else if (
        !issues.some((issue) => issue.category === "card-grammar-or-template")
      )
        issues.push({
          category: "card-grammar-or-template",
          path: file.path,
          detail: parsed.error.reason,
        });
    } else if (
      parsed.card.metadata.github !== source?.authorLogin ||
      parsed.card.metadata.githubId !== source?.authorGithubId ||
      parsed.card.metadata.sourcePr !== source?.number ||
      (source.authorAvatarUrl !== undefined &&
        parsed.card.metadata.avatar !== source.authorAvatarUrl)
    ) {
      issues.push({ category: "identity-or-metadata", path: file.path });
    }
  }
  const branchHead = facts.integrationBranch.value?.headOid;
  const ancestry = facts.sourceHeadBasedOnIntegration;
  if (
    branchHead &&
    source &&
    !source.merged &&
    (source.baseOid !== branchHead ||
      ancestry?.status !== "ready" ||
      !ancestry.value ||
      ancestry.value.integrationHeadOid !== branchHead ||
      ancestry.value.sourceHeadOid !== source.headOid ||
      ancestry.value.isAncestor !== true)
  )
    issues.push({ category: "integration-base-or-ancestry" });
  return issues.length > 0
    ? {
        kind: "invalid",
        ...(headOid ? { headOid } : {}),
        issues,
        blocksMerge: true,
      }
    : headOid
      ? { kind: "valid", headOid }
      : {
          kind: "invalid",
          issues: [{ category: "intake-author-or-fork" }],
          blocksMerge: true,
        };
}

function hasUnsafeContributorText(value: string): boolean {
  if (
    /(?:<<<<<<<|=======|>>>>>>>|!?(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)|<\/?[A-Za-z][^>]*>)/u.test(
      value,
    )
  )
    return true;
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
      return true;
  }
  return false;
}

export function createReconciler(dependencies: {
  github: GithubPlatform;
  git: GitWorkspace;
  candidatePolicy?: {
    card: CardPolicy;
    compare: (left: Card, right: Card) => number;
    renderRegion: (cards: readonly Card[]) => string;
  };
  invocationContext?: InvocationContext;
}): Reconciler {
  return {
    async reconcile({ budget, onDiagnostic }) {
      let effects = 0;
      let turn = 0;
      while (effects < budget.maxEffects) {
        turn += 1;
        let observed: Observation<RepositoryFacts>;
        let workspace: Observation<WorkspaceReadback>;
        try {
          observed = await withinBudget(budget, (context) =>
            dependencies.github.observeRepository({
              ...context,
              ...(dependencies.invocationContext
                ?.expectedSourcePullRequestNumber !== undefined
                ? {
                    expectedSourcePullRequestNumber:
                      dependencies.invocationContext
                        .expectedSourcePullRequestNumber,
                  }
                : {}),
              ...(dependencies.invocationContext?.expectedSourceLogin !==
              undefined
                ? {
                    expectedSourceLogin:
                      dependencies.invocationContext.expectedSourceLogin,
                  }
                : {}),
            }),
          );
          workspace = await withinBudget(budget, (context) =>
            dependencies.git.readWorkspace(context),
          );
        } catch {
          const outcome: ReconcileOutcome = {
            kind: "retryable",
            reason: "retryableTransport",
          };
          onDiagnostic?.({ turn, outcome });
          return outcome;
        }
        if (observed.status !== "ready" || !observed.value) {
          const outcome = observationOutcome(observed.status);
          onDiagnostic?.({ turn, outcome });
          return outcome;
        }
        if (workspace.status !== "ready" || !workspace.value) {
          const outcome = observationOutcome(workspace.status);
          onDiagnostic?.({ turn, outcome });
          return outcome;
        }

        const facts = observed.value;
        // The port type makes this capability mandatory in every production composition.
        // Runtime tolerance keeps narrow lower-level Git doubles usable in unit tests.
        const commentsSupported =
          typeof dependencies.github.ensureComment === "function";
        let terminal: ReconcileOutcome | Effect | undefined;
        try {
          terminal = await terminalPublicationOutcome(
            facts,
            dependencies.git,
            budget,
            commentsSupported,
          );
        } catch {
          terminal = { kind: "retryable", reason: "retryableTransport" };
        }
        if (terminal && isReconcileOutcome(terminal)) {
          onDiagnostic?.({ turn, outcome: terminal });
          return terminal;
        }
        if (terminal) {
          effects += 1;
          let outcome: ReconcileOutcome | undefined;
          try {
            outcome = await executeEffect(terminal, dependencies, budget);
          } catch {
            outcome = { kind: "retryable", reason: "unknownOutcome" };
          }
          if (!outcome) continue;
          onDiagnostic?.({ turn, effect: terminal.kind, outcome });
          return outcome;
        }
        const derived = deriveEffect(
          facts,
          workspace.value,
          dependencies.candidatePolicy,
          commentsSupported,
        );
        if (
          derived?.kind === "awaitingExternalFact" ||
          derived?.kind === "retryable" ||
          derived?.kind === "terminal" ||
          derived?.kind === "budgetExhausted"
        ) {
          onDiagnostic?.({ turn, outcome: derived });
          return derived;
        }
        const effect = derived as Effect | undefined;
        if (!effect) {
          const outcome: ReconcileOutcome = { kind: "quiescent" };
          onDiagnostic?.({ turn, outcome });
          return outcome;
        }
        if (
          budget.deadlineMs !== undefined &&
          Date.now() >= budget.deadlineMs
        ) {
          const outcome: ReconcileOutcome = {
            kind: "budgetExhausted",
            effects,
          };
          onDiagnostic?.({ turn, outcome });
          return outcome;
        }

        effects += 1;
        let outcome: ReconcileOutcome | undefined;
        try {
          outcome = await executeEffect(effect, dependencies, budget);
        } catch {
          outcome = { kind: "retryable", reason: "unknownOutcome" };
        }
        if (!outcome) continue;
        onDiagnostic?.({ turn, effect: effect.kind, outcome });
        if (
          outcome.kind === "terminal" ||
          outcome.kind === "awaitingExternalFact" ||
          outcome.kind === "retryable" ||
          outcome.kind === "quiescent"
        )
          return outcome;
        if (effects >= budget.maxEffects)
          return { kind: "budgetExhausted", effects };
      }
      return { kind: "budgetExhausted", effects };
    },
  };
}

type Effect =
  | CommentEffect
  | {
      kind: "createBranch";
      name: string;
      fromMainOid: string;
      cardPath: string;
      cardBytes: Uint8Array;
    }
  | { kind: "createIntegrationPr"; branchName: string }
  | { kind: "retarget"; pullRequestNumber: number; branchName: string }
  | { kind: "mergeContribution"; request: ContributionMergeRequest }
  | { kind: "writeCandidate"; candidate: CandidateWrite }
  | { kind: "ready"; pullRequestNumber: number; candidateHeadOid: string }
  | {
      kind: "mergeIntegration";
      request: IntegrationMergeRequest;
      expectedFinalMain: FinalMainPostconditions;
      commentsSupported: boolean;
    };

function deriveEffect(
  facts: RepositoryFacts,
  workspace: WorkspaceReadback,
  candidatePolicy: Parameters<typeof createReconciler>[0]["candidatePolicy"],
  commentsSupported: boolean,
): Effect | ReconcileOutcome | undefined {
  const source = facts.sourcePullRequest.value;
  const branch = facts.integrationBranch.value;
  const integration = facts.integrationPullRequest.value;
  const main = facts.main.value;
  if (!source || !main) return undefined;
  const validation = validateIntake(facts, candidatePolicy);
  if (source.closed && !source.merged)
    return { kind: "terminal", reason: "policyRejected" };
  const branchName =
    branch?.name ??
    integration?.headRef ??
    `feature/card-${source.authorLogin ?? "source"}-source-${source.number}`;
  const branchStatus = setupStatusOutcome(facts.integrationBranch.status);
  if (branchStatus) return branchStatus;
  const integrationStatus = setupStatusOutcome(
    facts.integrationPullRequest.status,
  );
  if (integrationStatus) return integrationStatus;
  const branchHeadOid = branch?.headOid ?? integration?.headOid;
  if (!branch && !integration && facts.integrationBranch.status === "absent") {
    if (!source.authorGithubId || !source.authorLogin)
      return awaitingIncomplete();
    return {
      kind: "createBranch",
      name: branchName,
      fromMainOid: main.oid,
      cardPath: `people/${source.authorLogin}.md`,
      cardBytes: renderProjectShellBytes({
        path: `people/${source.authorLogin}.md`,
        github: source.authorLogin,
        githubId: source.authorGithubId,
        sourcePr: source.number,
        ...(source.authorAvatarUrl ? { avatar: source.authorAvatarUrl } : {}),
      }),
    };
  }
  if (!integration && facts.integrationPullRequest.status === "absent")
    return { kind: "createIntegrationPr", branchName };
  if (!branchHeadOid || !integration) return undefined;
  if (!source.merged && source.baseOid !== branchHeadOid) {
    return { kind: "retarget", pullRequestNumber: source.number, branchName };
  }
  if (
    facts.sourceHeadBasedOnIntegration?.status !== "ready" ||
    !facts.sourceHeadBasedOnIntegration.value
  )
    return sourceAncestryOutcome(facts.sourceHeadBasedOnIntegration?.status);
  if (
    commentsSupported &&
    (!source.authorGithubId || !facts.trustedCommentOwner)
  )
    return { kind: "terminal", reason: "permissionDenied" };
  const setupComment = commentsSupported
    ? commentEffect(
        facts,
        source.number,
        "source-status",
        "setup",
        renderSetupComment({
          runIdentity: runIdentity(source),
          sourcePullRequestNumber: source.number,
          integrationBranchName: branchName,
          integrationPullRequestNumber: integration.number,
          rebaseCommand: `git rebase upstream/${branchName}`,
        }),
      )
    : undefined;
  if (setupComment) return setupComment;
  if (validation.kind === "invalid") {
    const feedback = commentsSupported
      ? commentEffect(
          facts,
          source.number,
          "source-status",
          "validation-feedback",
          renderValidationComment({
            runIdentity: runIdentity(source),
            sourcePullRequestNumber: source.number,
            sourceHeadOid: source.headOid,
            result: validation,
          }),
        )
      : undefined;
    return feedback ?? { kind: "terminal", reason: "policyRejected" };
  }
  const validationSuccess = commentsSupported
    ? commentEffect(
        facts,
        source.number,
        "source-status",
        "validation-success",
        renderValidationComment({
          runIdentity: runIdentity(source),
          sourcePullRequestNumber: source.number,
          sourceHeadOid: source.headOid,
          result: validation,
        }),
      )
    : undefined;
  if (validationSuccess) return validationSuccess;
  if (!source.merged) {
    return {
      kind: "mergeContribution",
      request: {
        kind: "contribution",
        pullRequestNumber: source.number,
        expectedHeadOid: source.headOid,
      },
    };
  }
  if (!main.readmeBytes || !main.cardPayloads) return awaitingIncomplete();
  if (!workspace.retainedCommitOids || !workspace.requiredParentOids)
    return awaitingIncomplete();
  const candidate = facts.candidate.value;
  const durableCandidate = workspace.candidate;
  const confirmation = facts.confirmations.find(
    (item) =>
      item.contributorLogin === source.authorLogin &&
      item.integrationPrNumber === integration?.number &&
      item.reviewedCommitOid === integration?.headOid &&
      item.cardBlobOid === candidate?.cardBlobOid &&
      item.cardPath === candidate?.cardPath &&
      item.sourcePrNumber === source.number &&
      item.githubId === facts.acceptedCard?.githubId &&
      facts.eligibility.reviews.status === "ready" &&
      (facts.eligibility.reviews.value?.length ?? 0) > 0 &&
      facts.eligibility.reviews.value?.some(
        (review) =>
          review.pullRequestNumber === integration.number &&
          review.prHeadOid === integration.headOid &&
          review.reviewerLogin === source.authorLogin &&
          review.state === "approved" &&
          review.reviewedCommitOid === integration.headOid,
      ),
  );
  if (
    facts.acceptedCard &&
    (workspace.integrationHeadOid || branchHeadOid) &&
    (!durableCandidate ||
      durableCandidate.mainOid !== main.oid ||
      durableCandidate.integrationHeadOid !== integration.headOid ||
      durableCandidate.cardBlobOid !== gitBlobOid(facts.acceptedCard.bytes))
  ) {
    const card = facts.acceptedCard;
    if (!workspace.retainedCommitOids || !workspace.requiredParentOids)
      return awaitingIncomplete();
    if (!candidatePolicy) return undefined;
    let readmeBytes: Uint8Array;
    if (!candidatePolicy) readmeBytes = card.readmeBytes ?? new Uint8Array();
    else {
      const parsedCards = [...main.cardPayloads, card].map((payload) => ({
        payload,
        parsed: parseCard(payload.bytes, {
          path: payload.path,
          policy: candidatePolicy.card,
        }),
      }));
      if (
        parsedCards.some(
          ({ payload, parsed }) =>
            !parsed.ok ||
            (parsed.ok &&
              (parsed.card.metadata.githubId !== payload.githubId ||
                parsed.card.metadata.sourcePr !== payload.sourcePrNumber)),
        )
      )
        return undefined;
      try {
        readmeBytes = new TextEncoder().encode(
          renderReadmeMarkers(new TextDecoder().decode(main.readmeBytes), {
            cards: parsedCards.map(({ parsed }) => {
              if (!parsed.ok) throw new Error("invalid Card");
              return parsed.card;
            }),
            compare: candidatePolicy.compare,
            renderRegion: candidatePolicy.renderRegion,
          }),
        );
      } catch {
        return undefined;
      }
    }
    const preserved = confirmation?.cardBlobOid;
    return {
      kind: "writeCandidate",
      candidate: {
        input: {
          observedMainOid: main.oid,
          expectedIntegrationHeadOid: oid(
            workspace.integrationHeadOid ?? branchHeadOid,
          ),
          cardPath: card.path,
          cardBytes: card.bytes,
          readmeBytes,
          ...(preserved ? { preserveConfirmedCardBlobOid: preserved } : {}),
        },
        postconditions: {
          managedCard: {
            path: card.path,
            githubId: card.githubId,
            sourcePrNumber: card.sourcePrNumber,
          },
          cardManifest: {
            path: card.path,
            blobOid: gitBlobOid(card.bytes),
            githubId: card.githubId,
            sourcePrNumber: card.sourcePrNumber,
          },
          readmeBlobOid: gitBlobOid(readmeBytes),
          history: {
            retainCommitOids: [
              ...new Set([
                ...workspace.retainedCommitOids,
                ...(durableCandidate?.retainedCommitOids ?? []),
                oid(workspace.integrationHeadOid ?? branchHeadOid),
              ]),
            ],
            requiredParentOids:
              durableCandidate && durableCandidate.mainOid !== main.oid
                ? []
                : [oid(workspace.integrationHeadOid ?? branchHeadOid)],
          },
        },
      },
    };
  }
  if (
    durableCandidate &&
    integration?.draft &&
    durableCandidate.integrationHeadOid === integration.headOid
  ) {
    if (
      !durableCandidate.retainedCommitOids ||
      !durableCandidate.requiredParentOids ||
      !workspace.retainedCommitOids ||
      !workspace.requiredParentOids
    )
      return awaitingIncomplete();
    return {
      kind: "ready",
      pullRequestNumber: integration.number,
      candidateHeadOid: durableCandidate.integrationHeadOid,
    };
  }
  if (
    durableCandidate &&
    !integration?.draft &&
    durableCandidate.integrationHeadOid === integration.headOid
  ) {
    const readyComment = commentsSupported
      ? commentEffect(
          facts,
          integration.number,
          "integration-status",
          "ready-guidance",
          renderReadyComment({
            runIdentity: runIdentity(source),
            originalContributor: source.authorLogin ?? "",
            integrationPullRequestNumber: integration.number,
            candidateHeadOid: durableCandidate.integrationHeadOid,
            cardPath: durableCandidate.cardPath,
            cardBlobOid: durableCandidate.cardBlobOid,
          }),
        )
      : undefined;
    if (readyComment) return readyComment;
  }
  if (
    confirmation &&
    integration &&
    durableCandidate &&
    durableCandidate.integrationHeadOid === integration.headOid &&
    providerEligible(facts, integration.number, integration.headOid)
  ) {
    if (
      !durableCandidate.retainedCommitOids ||
      !durableCandidate.requiredParentOids ||
      !workspace.retainedCommitOids ||
      !workspace.requiredParentOids ||
      !main.readmeBytes ||
      !source.mergeCommitOid ||
      !facts.protocolAnchors?.contribution
    )
      return awaitingIncomplete();
    const request: IntegrationMergeRequest = {
      kind: "integration",
      pullRequestNumber: integration.number,
      expectedHeadOid: integration.headOid,
      observedBaseOid: integration.baseOid,
      baseCurrentGate: "required",
    };
    return {
      kind: "mergeIntegration",
      request,
      commentsSupported,
      expectedFinalMain: {
        mainOid: integration.headOid,
        cardManifest: {
          path: durableCandidate.cardPath,
          blobOid: durableCandidate.cardBlobOid,
          githubId: confirmation.githubId,
          sourcePrNumber: confirmation.sourcePrNumber,
        },
        readmeBytes: durableCandidate.readmeBytes ?? main.readmeBytes,
        retainedCommitOids: durableCandidate.retainedCommitOids,
        requiredParentOids: [main.oid, durableCandidate.integrationHeadOid],
        sourceMergeCommitOid: source.mergeCommitOid,
        integrationMergeCommitOid: integration.headOid,
        contributionMergeParentOids: [
          facts.protocolAnchors.contribution.projectShellOid,
          facts.protocolAnchors.contribution.rebasedContributorOid,
        ],
        integrationMergeParentOids: [
          main.oid,
          durableCandidate.integrationHeadOid,
        ],
      },
    };
  }
  return undefined;
}

function providerEligible(
  facts: RepositoryFacts,
  pullRequestNumber: number,
  headOid: string,
): boolean {
  const { checks, reviews, mergeability, baseCurrent } = facts.eligibility;
  return (
    checks.status === "ready" &&
    checks.value !== undefined &&
    checks.value.length > 0 &&
    checks.value.every(
      (check) =>
        check.pullRequestNumber === pullRequestNumber &&
        check.prHeadOid === headOid &&
        check.state === "success",
    ) &&
    reviews.status === "ready" &&
    reviews.value !== undefined &&
    !reviews.value.some(
      (review) =>
        review.pullRequestNumber === pullRequestNumber &&
        review.prHeadOid === headOid &&
        (review.state === "changesRequested" || review.state === "dismissed"),
    ) &&
    mergeability.status === "ready" &&
    mergeability.value === "mergeable" &&
    baseCurrent.status === "ready" &&
    baseCurrent.value === true
  );
}

export function validIntake(
  facts: RepositoryFacts,
  candidatePolicy: Parameters<typeof createReconciler>[0]["candidatePolicy"],
): boolean {
  return validateIntake(facts, candidatePolicy).kind === "valid";
}

async function terminalPublicationOutcome(
  facts: RepositoryFacts,
  git: GitWorkspace,
  budget: ReconcileBudget,
  commentsSupported: boolean,
): Promise<ReconcileOutcome | Effect | undefined> {
  const integration = facts.integrationPullRequest.value;
  const main = facts.main.value;
  const source = facts.sourcePullRequest.value;
  if (!integration?.closed) return undefined;
  if (!integration.merged)
    return { kind: "terminal", reason: "policyRejected" };
  if (
    !main ||
    !source?.authorLogin ||
    !source.authorGithubId ||
    !main.readmeBytes ||
    !source.mergeCommitOid ||
    !integration.mergeCommitOid ||
    !facts.protocolAnchors?.contribution ||
    !facts.protocolAnchors.integration
  )
    return awaitingIncomplete();
  const contributionParents = [
    facts.protocolAnchors.contribution.projectShellOid,
    facts.protocolAnchors.contribution.rebasedContributorOid,
  ];
  const integrationParents = [
    facts.protocolAnchors.integration.mainBeforePublicationOid,
    facts.protocolAnchors.integration.candidateOid,
  ];
  const manifest = main.cardManifests.find(
    (card) =>
      card.githubId === source.authorGithubId &&
      card.sourcePrNumber === source.number &&
      card.path === `people/${source.authorLogin}.md`,
  );
  if (!manifest) return { kind: "terminal", reason: "policyRejected" };
  const expected: FinalMainPostconditions = {
    mainOid: main.oid,
    cardManifest: manifest,
    readmeBytes: main.readmeBytes,
    retainedCommitOids: [
      source.mergeCommitOid,
      integration.mergeCommitOid,
    ].filter(
      (commit): commit is NonNullable<typeof commit> => commit !== undefined,
    ),
    // The Integration merge commit is main itself, so it is retained rather
    // than (impossibly) required as one of its own immediate parents.
    requiredParentOids: [],
    sourceMergeCommitOid: source.mergeCommitOid,
    integrationMergeCommitOid: integration.mergeCommitOid,
    contributionMergeParentOids: contributionParents,
    integrationMergeParentOids: integrationParents,
  };
  if (
    contributionParents[0] === contributionParents[1] ||
    integrationParents[0] === integrationParents[1]
  )
    return { kind: "terminal", reason: "policyRejected" };
  const actual = await withinBudget(budget, (context) =>
    git.readFinalMainPostconditions(expected, context),
  );
  if (actual.status !== "ready" || !actual.value)
    return observationOutcome(actual.status);
  if (!validateFinalMain(actual.value, expected))
    return { kind: "terminal", reason: "policyRejected" };
  if (!commentsSupported) return { kind: "quiescent" };
  if (!facts.trustedRepository || !facts.trustedCommentOwner)
    return { kind: "terminal", reason: "permissionDenied" };
  const actualCardBytes = actual.value.cardBytes;
  if (!actualCardBytes) return { kind: "terminal", reason: "policyRejected" };
  const targetResult = createPublishedCardTarget(facts.trustedRepository, {
    publishedMainOid: actual.value.mainOid,
    cardPath: actual.value.cardManifest.path,
    expectedCardBlobOid: actual.value.cardManifest.blobOid,
    actualCardBlobOid: actual.value.cardManifest.blobOid,
    expectedCardBytes: actualCardBytes,
    actualCardBytes,
    sourcePullRequestNumber: source.number,
  });
  if (!targetResult.ok) return { kind: "terminal", reason: "policyRejected" };
  const sourceCompletion = completionEffect(
    facts,
    targetResult.target,
    source.number,
    "source-status",
  );
  if (sourceCompletion) return sourceCompletion;
  const integrationCompletion = completionEffect(
    facts,
    targetResult.target,
    integration.number,
    "integration-status",
  );
  return integrationCompletion ?? { kind: "quiescent" };
}

async function executeEffect(
  effect: Effect,
  dependencies: {
    github: GithubPlatform;
    git: GitWorkspace;
    invocationContext?: InvocationContext;
  },
  budget: ReconcileBudget,
): Promise<ReconcileOutcome | undefined> {
  if (effect.kind === "ensureComment") {
    const result = await withinBudget(budget, (context) =>
      dependencies.github.ensureComment(effect.intent, context),
    );
    if (
      result.kind === "created" ||
      result.kind === "updated" ||
      result.kind === "alreadyApplied" ||
      result.kind === "noOp"
    )
      return undefined;
    if (
      result.kind === "ambiguousOwnership" ||
      result.kind === "permissionDenied"
    )
      return { kind: "terminal", reason: "permissionDenied" };
    if (result.kind === "stale")
      return { kind: "retryable", reason: "stalePrecondition" };
    if (result.kind === "notVisibleYet")
      return { kind: "awaitingExternalFact", reason: "notVisibleYet" };
    if (result.kind === "capabilityUnavailable")
      return { kind: "terminal", reason: "capabilityUnavailable" };
    return {
      kind: "retryable",
      reason:
        result.kind === "unknownOutcome"
          ? "unknownOutcome"
          : "retryableTransport",
    };
  }
  if (effect.kind === "writeCandidate") {
    const result = await withinBudget(budget, (context) =>
      context
        ? dependencies.git.writeIntegrationCandidate(effect.candidate, context)
        : dependencies.git.writeIntegrationCandidate(effect.candidate),
    );
    if (result.kind !== "succeeded" && result.kind !== "alreadyApplied")
      return candidateWriteOutcome(result);
    if (
      effect.candidate.input.preserveConfirmedCardBlobOid !== undefined &&
      result.value.candidate?.cardBlobOid !==
        effect.candidate.input.preserveConfirmedCardBlobOid
    )
      return { kind: "retryable", reason: "stalePrecondition" };
    const actual = result.value.candidate;
    const readback = result.value;
    const expected = effect.candidate.postconditions;
    if (
      !actual ||
      actual.cardPath !== expected.cardManifest.path ||
      actual.cardBlobOid !== expected.cardManifest.blobOid ||
      actual.readmeBlobOid !== expected.readmeBlobOid ||
      !expected.history.retainCommitOids.every(
        (commit) => readback.retainedCommitOids?.includes(commit) === true,
      )
    )
      return { kind: "retryable", reason: "stalePrecondition" };
    return undefined;
  }
  if (effect.kind === "createBranch")
    return operationOutcome(
      await withinBudget(budget, (context) =>
        dependencies.github.createIntegrationBranch(effect, {
          ...context,
          ...dependencies.invocationContext,
        }),
      ),
    );
  if (effect.kind === "createIntegrationPr")
    return operationOutcome(
      await withinBudget(budget, (context) =>
        dependencies.github.createIntegrationPullRequest(
          { branchName: effect.branchName, title: "Integration Card" },
          context,
        ),
      ),
    );
  if (effect.kind === "retarget")
    return operationOutcome(
      await withinBudget(budget, (context) =>
        dependencies.github.updatePullRequestBase(
          {
            pullRequestNumber: effect.pullRequestNumber,
            integrationBranchName: effect.branchName,
          },
          context,
        ),
      ),
    );
  if (effect.kind === "ready") {
    const result = await withinBudget(budget, (context) =>
      dependencies.github.markPullRequestReadyForReview(
        {
          pullRequestNumber: effect.pullRequestNumber,
          expectedCandidateHeadOid: effect.candidateHeadOid,
        },
        context,
      ),
    );
    return result.kind === "readyAtExpectedCandidate" ||
      result.kind === "alreadyReadyAtExpectedCandidate"
      ? undefined
      : result.kind === "headChanged"
        ? { kind: "retryable", reason: "stalePrecondition" }
        : operationCategoryOutcome(result.reason);
  }
  if (effect.kind === "mergeContribution")
    return mergeOutcome(
      await withinBudget(budget, (context) =>
        dependencies.github.mergePullRequest(effect.request, context),
      ),
    );
  if (effect.kind !== "mergeIntegration")
    return { kind: "terminal", reason: "policyRejected" };
  const merge = await withinBudget(budget, (context) =>
    dependencies.github.mergePullRequest(effect.request, context),
  );
  if (merge.kind === "integrationRejected") return mergeOutcome(merge);
  const expected = {
    ...effect.expectedFinalMain,
    mainOid: merge.mainOid,
    integrationMergeCommitOid: merge.mainOid,
  };
  const actual = await withinBudget(budget, (context) =>
    dependencies.git.readFinalMainPostconditions(expected, context),
  );
  if (actual.status !== "ready" || !actual.value)
    return observationOutcome(actual.status);
  if (!validateFinalMain(actual.value, expected))
    return { kind: "retryable", reason: "stalePrecondition" };
  return effect.commentsSupported ? undefined : { kind: "quiescent" };
}

function isReconcileOutcome(
  value: ReconcileOutcome | Effect,
): value is ReconcileOutcome {
  return (
    value.kind === "quiescent" ||
    value.kind === "awaitingExternalFact" ||
    value.kind === "retryable" ||
    value.kind === "budgetExhausted" ||
    value.kind === "terminal"
  );
}

function runIdentity(source: {
  number: number;
  authorGithubId?: string;
}): string {
  if (!source.authorGithubId)
    throw new Error("immutable contributor identity is required");
  return `source:${source.number}:${source.authorGithubId}`;
}

function commentEffect(
  facts: RepositoryFacts,
  targetPullRequestNumber: number,
  slot: CommentSlot,
  phase: CommentPhase,
  rendered: { actionKey: string; body: string },
): Effect | ReconcileOutcome | undefined {
  const expected = facts.trustedCommentOwner;
  const intent: CommentIntent = {
    targetPullRequestNumber,
    slot,
    actionKey: rendered.actionKey,
    phase,
    body: rendered.body,
  };
  const plan = planCommentMutation(intent, facts.comments ?? [], expected);
  if (plan.kind === "ambiguousOwnership")
    return { kind: "terminal", reason: "permissionDenied" };
  if (plan.kind === "stale")
    return { kind: "retryable", reason: "stalePrecondition" };
  if (plan.kind === "noOp") return undefined;
  if (
    plan.kind === "update" &&
    phase !== "completion" &&
    commentPhaseRank(commentPhase(plan.comment.body)) > commentPhaseRank(phase)
  )
    return undefined;
  return {
    kind: "ensureComment",
    intent:
      plan.kind === "update" ? { ...intent, observed: plan.comment } : intent,
  };
}

function commentPhase(value: string): CommentPhase | undefined {
  const phase = /\bphase=([a-z-]+)/u.exec(value)?.[1];
  return phase && isCommentPhase(phase) ? phase : undefined;
}

function isCommentPhase(value: string): value is CommentPhase {
  return (
    value === "setup" ||
    value === "validation-feedback" ||
    value === "validation-success" ||
    value === "ready-guidance" ||
    value === "completion"
  );
}

function commentPhaseRank(value: CommentPhase | undefined): number {
  if (!value) return -1;
  return {
    setup: 0,
    "validation-feedback": 1,
    "validation-success": 2,
    "ready-guidance": 3,
    completion: 4,
  }[value];
}

function completionEffect(
  facts: RepositoryFacts,
  target: PublishedCardTarget,
  targetPullRequestNumber: number,
  slot: CommentSlot,
): Effect | ReconcileOutcome | undefined {
  const source = facts.sourcePullRequest.value;
  if (!source) return { kind: "terminal", reason: "notFound" };
  return commentEffect(
    facts,
    targetPullRequestNumber,
    slot,
    "completion",
    renderCompletionComment({
      runIdentity: runIdentity(source),
      targetPullRequestNumber,
      slot,
      target,
    }),
  );
}

function awaitingIncomplete(): ReconcileOutcome {
  return { kind: "awaitingExternalFact", reason: "incomplete" };
}

function sourceAncestryOutcome(
  status: Observation<unknown>["status"] | undefined,
): ReconcileOutcome {
  if (status === "readFailed")
    return { kind: "retryable", reason: "retryableTransport" };
  if (status === "notVisibleYet")
    return { kind: "awaitingExternalFact", reason: "notVisibleYet" };
  return awaitingIncomplete();
}

function candidateWriteOutcome(
  result: Exclude<
    CandidateWriteResult,
    { kind: "succeeded" | "alreadyApplied" }
  >,
): ReconcileOutcome {
  if (result.kind === "policyPostcondition")
    return { kind: "terminal", reason: "policyRejected" };
  if (result.kind === "staleLease" || result.kind === "staleMain")
    return { kind: "retryable", reason: "stalePrecondition" };
  return {
    kind: "retryable",
    reason:
      result.kind === "unknownOutcome"
        ? "unknownOutcome"
        : "retryableTransport",
  };
}

function setupStatusOutcome(
  status: Observation<unknown>["status"],
): ReconcileOutcome | undefined {
  if (status === "ready" || status === "absent") return undefined;
  if (status === "readFailed")
    return { kind: "retryable", reason: "retryableTransport" };
  if (status === "conclusiveFailure")
    return { kind: "terminal", reason: "notFound" };
  return {
    kind: "awaitingExternalFact",
    reason: status === "notVisibleYet" ? "notVisibleYet" : status,
  };
}

function observationOutcome(
  status: Observation<unknown>["status"],
): ReconcileOutcome {
  if (status === "incomplete" || status === "pending")
    return { kind: "awaitingExternalFact", reason: status };
  if (status === "notVisibleYet")
    return { kind: "awaitingExternalFact", reason: status };
  if (status === "readFailed")
    return { kind: "retryable", reason: "retryableTransport" };
  return { kind: "terminal", reason: "notFound" };
}

function operationOutcome(result: {
  kind: string;
  retryAfterSeconds?: number;
}): ReconcileOutcome | undefined {
  if (result.kind === "succeeded" || result.kind === "alreadyApplied")
    return undefined;
  return operationCategoryOutcome(result.kind as OperationResultCategory);
}

function operationCategoryOutcome(
  category: OperationResultCategory,
): ReconcileOutcome {
  if (
    category === "permissionDenied" ||
    category === "notFound" ||
    category === "policyRejected"
  )
    return { kind: "terminal", reason: category };
  if (category === "notVisibleYet")
    return { kind: "awaitingExternalFact", reason: category };
  return {
    kind: "retryable",
    reason:
      category === "stalePrecondition"
        ? category
        : category === "unknownOutcome"
          ? category
          : "retryableTransport",
  };
}

function mergeOutcome(result: {
  kind: string;
  reason?: string;
}): ReconcileOutcome | undefined {
  if (
    result.kind === "contributionMerged" ||
    result.kind === "contributionAlreadyApplied" ||
    result.kind === "integrationMerged" ||
    result.kind === "integrationAlreadyApplied"
  )
    return undefined;
  if (
    result.reason === "gateRejected" ||
    result.reason === "gateUnsupported" ||
    result.reason === "baseMoved"
  )
    return { kind: "retryable", reason: "stalePrecondition" };
  return operationCategoryOutcome(
    (result.reason ?? "unknownOutcome") as OperationResultCategory,
  );
}

export function validateFinalMain(
  actual: FinalMainPostconditions,
  expected: FinalMainPostconditions,
): boolean {
  return (
    actual.mainOid === expected.mainOid &&
    actual.sourceMergeCommitOid !== undefined &&
    actual.integrationMergeCommitOid !== undefined &&
    actual.contributionMergeParentOids !== undefined &&
    actual.integrationMergeParentOids !== undefined &&
    expected.sourceMergeCommitOid !== undefined &&
    expected.integrationMergeCommitOid !== undefined &&
    expected.contributionMergeParentOids !== undefined &&
    expected.integrationMergeParentOids !== undefined &&
    actual.sourceMergeCommitOid === expected.sourceMergeCommitOid &&
    actual.integrationMergeCommitOid === expected.integrationMergeCommitOid &&
    actual.sourceMergeCommitOid !== actual.integrationMergeCommitOid &&
    sameOids(
      actual.contributionMergeParentOids,
      expected.contributionMergeParentOids,
    ) &&
    sameOids(
      actual.integrationMergeParentOids,
      expected.integrationMergeParentOids,
    ) &&
    actual.cardManifest.path === expected.cardManifest.path &&
    actual.cardManifest.blobOid === expected.cardManifest.blobOid &&
    actual.cardManifest.githubId === expected.cardManifest.githubId &&
    actual.cardManifest.sourcePrNumber ===
      expected.cardManifest.sourcePrNumber &&
    bytesEqual(actual.readmeBytes, expected.readmeBytes) &&
    expected.retainedCommitOids.every((commit) =>
      actual.retainedCommitOids.includes(commit),
    ) &&
    expected.requiredParentOids.every((parent) =>
      actual.requiredParentOids.includes(parent),
    )
  );
}

function sameOids(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    right.every((value, index) => left[index] === value)
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function withinBudget<T>(
  budget: ReconcileBudget,
  operation: (context?: InvocationContext) => Promise<T>,
): Promise<T> {
  if (budget.deadlineMs === undefined) {
    return operation();
  }
  const remaining = budget.deadlineMs - Date.now();
  if (remaining <= 0)
    return Promise.reject(new Error("reconcile deadline elapsed"));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, remaining);
  });
  return Promise.race([
    operation({ signal: controller.signal, deadlineMs: budget.deadlineMs }),
    deadline,
  ])
    .then((result) => {
      if (result && typeof result === "object" && "timedOut" in result)
        throw new Error("reconcile deadline elapsed");
      return result as T;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}
