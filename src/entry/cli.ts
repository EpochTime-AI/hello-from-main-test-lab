import type { ReconcileBudget, ReconcileOutcome } from "../core/model.js";
import { createReconciler } from "../core/reconciler.js";
import type { GitWorkspace } from "../ports/git-workspace.js";
import type { GithubPlatform } from "../ports/github-platform.js";
import type { CandidatePolicy } from "./action.js";

export function createCliComposition(dependencies: {
  github: GithubPlatform;
  git: GitWorkspace;
  candidatePolicy?: CandidatePolicy;
}) {
  if (!dependencies.candidatePolicy)
    throw new Error("candidate policy is required");
  const reconciler = createReconciler(dependencies);
  return {
    run(input: ReconcileBudget): Promise<ReconcileOutcome> {
      return reconciler.reconcile({ budget: input });
    },
  };
}
