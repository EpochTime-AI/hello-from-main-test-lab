import type { TrustedActionContext } from "../adapters/action-context.js";
import type { ReconcileBudget, ReconcileOutcome } from "../core/model.js";
import { createReconciler } from "../core/reconciler.js";
import type { GitWorkspace } from "../ports/git-workspace.js";
import type {
  GithubPlatform,
  InvocationContext,
} from "../ports/github-platform.js";
import type { Card, CardPolicy } from "../render/card.js";

export type CandidatePolicy = {
  card: CardPolicy;
  compare: (left: Card, right: Card) => number;
  renderRegion: (cards: readonly Card[]) => string;
};

export function createActionComposition(input: {
  context: TrustedActionContext;
  github: GithubPlatform;
  git: GitWorkspace;
  candidatePolicy?: CandidatePolicy;
  invocationContext?: InvocationContext;
}) {
  if (!input.candidatePolicy) throw new Error("candidate policy is required");
  const reconciler = createReconciler(input);
  return {
    context: input.context,
    run(budget: ReconcileBudget): Promise<ReconcileOutcome> {
      return reconciler.reconcile({ budget });
    },
  };
}
