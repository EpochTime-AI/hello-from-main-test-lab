import type {
  CandidateWrite,
  CandidateWriteResult,
  FinalMainPostconditions,
  IntegrationMergeRequest,
  IntegrationMergeResult,
  Observation,
  Oid,
  WorkspaceReadback,
} from "../core/model.js";
import type { InvocationContext } from "./github-platform.js";

export type GitWorkspace = {
  createIntegrationBranchWithProjectShell?: (input: {
    name: string;
    fromMainOid: Oid;
    cardPath: string;
    cardBytes: Uint8Array;
    setupOperationNonce?: string;
  }) => Promise<{
    branch: { name: string; headOid: Oid; provenance: "observed" };
    establishedByCurrentOperation?: true;
    setupOperationNonce?: string;
    setupProjectShellProof?: import("../adapters/git.js").SetupProjectShellProof;
  }>;
  readWorkspace(
    context?: InvocationContext,
  ): Promise<Observation<WorkspaceReadback>>;
  writeIntegrationCandidate(
    candidate: CandidateWrite,
    context?: InvocationContext,
  ): Promise<CandidateWriteResult>;
  publishIntegrationMerge?(
    request: IntegrationMergeRequest,
    context?: InvocationContext,
  ): Promise<IntegrationMergeResult>;
  readFinalMainPostconditions(
    expected: FinalMainPostconditions,
    context?: InvocationContext,
  ): Promise<Observation<FinalMainPostconditions>>;
};
