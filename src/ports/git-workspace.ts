import type {
  CandidateWrite,
  CandidateWriteResult,
  FinalMainPostconditions,
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
  }) => Promise<{
    branch: { name: string; headOid: Oid; provenance: "observed" };
  }>;
  readWorkspace(
    context?: InvocationContext,
  ): Promise<Observation<WorkspaceReadback>>;
  writeIntegrationCandidate(
    candidate: CandidateWrite,
    context?: InvocationContext,
  ): Promise<CandidateWriteResult>;
  readFinalMainPostconditions(
    expected: FinalMainPostconditions,
    context?: InvocationContext,
  ): Promise<Observation<FinalMainPostconditions>>;
};
