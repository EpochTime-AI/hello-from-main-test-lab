import type {
  CandidateWrite,
  CandidateWriteResult,
  Observation,
  RepositoryFacts,
  WorkspaceReadback,
} from "../../src/core/model.js";
import { oid } from "../../src/core/model.js";
import type { Card, CardPolicy } from "../../src/render/card.js";

export const testCandidatePolicy = {
  card: {
    fieldLimits: { nickname: 80, exploring: 200, message: 200 },
    templateTexts: [],
    isAllowedText: () => true,
  } satisfies CardPolicy,
  compare: (left: Card, right: Card) => left.path.localeCompare(right.path),
  renderRegion: (cards: readonly Card[]) =>
    cards.map((card) => card.contributor.nickname).join("\n"),
};

export function stabilityFacts(): RepositoryFacts {
  return {
    comments: [],
    trustedCommentOwner: { actorId: "42", actorType: "Bot" },
    main: {
      status: "ready",
      provenance: "modeled",
      value: {
        oid: oid("main-1"),
        readmeBytes: new TextEncoder().encode(
          "# Hello\n<!-- cards:start -->\n<!-- cards:end -->\n",
        ),
        cardManifests: [],
        cardPayloads: [],
      },
    },
    sourcePullRequest: {
      status: "ready",
      provenance: "modeled",
      value: {
        number: 1,
        kind: "contribution",
        headOid: oid("contribution-1"),
        baseOid: oid("integration-1"),
        headRef: "add/alice",
        baseRef: "feature/card-alice-source-1",
        draft: false,
        merged: true,
        closed: true,
        mergeCommitOid: oid("integration-1"),
        mergeParentOids: [oid("integration-base"), oid("contribution-1")],
        authorLogin: "alice",
        authorGithubId: "7",
        headRepositoryOwnerLogin: "alice",
        headRepositoryIsFork: true,
        changedFiles: [
          {
            path: "people/alice.md",
            blobOid: oid("card"),
            bytes: new TextEncoder().encode(
              "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾：Git\n\n> Hi\n",
            ),
          },
        ],
        changedFilesComplete: true,
        observedOid: oid("contribution-1"),
        provenance: "modeled",
      },
    },
    sourceHeadBasedOnIntegration: {
      status: "ready",
      provenance: "modeled",
      value: {
        integrationHeadOid: oid("integration-1"),
        sourceHeadOid: oid("contribution-1"),
        isAncestor: true,
        observedOid: oid("contribution-1"),
        provenance: "modeled",
      },
    },
    integrationBranch: {
      status: "ready",
      provenance: "modeled",
      value: {
        name: "feature/card-alice-source-1",
        headOid: oid("integration-1"),
        provenance: "modeled",
      },
    },
    integrationPullRequest: {
      status: "ready",
      provenance: "modeled",
      value: {
        number: 2,
        kind: "integration",
        headOid: oid("integration-1"),
        baseOid: oid("main-1"),
        draft: true,
        observedOid: oid("integration-1"),
        provenance: "modeled",
      },
    },
    candidate: { status: "absent", provenance: "modeled" },
    eligibility: {
      checks: { status: "ready", provenance: "modeled", value: [] },
      reviews: { status: "ready", provenance: "modeled", value: [] },
      mergeability: {
        status: "ready",
        provenance: "modeled",
        value: "mergeable",
      },
      baseCurrent: { status: "ready", provenance: "modeled", value: true },
    },
    confirmations: [],
    acceptedCard: {
      path: "people/alice.md",
      bytes: new TextEncoder().encode(
        "---\ngithub: alice\ngithub_id: 7\navatar: https://avatars.githubusercontent.com/u/7?v=4\nsource_pr: 1\n---\n\n# Alice\n\n最近在折腾：Git\n\n> Hi\n",
      ),
      readmeBytes: new TextEncoder().encode(
        "# Hello\n<!-- cards:start -->\n<!-- cards:end -->\n",
      ),
      githubId: "7",
      sourcePrNumber: 1,
    },
    protocolAnchors: {
      contribution: {
        projectShellOid: oid("integration-base"),
        rebasedContributorOid: oid("contribution-1"),
      },
      integration: {
        mainBeforePublicationOid: oid("main-1"),
        candidateOid: oid("candidate-1"),
      },
    },
  };
}

export async function readyWorkspace(): Promise<
  Observation<WorkspaceReadback>
> {
  return {
    status: "ready",
    provenance: "observed",
    value: {
      status: "ready",
      integrationHeadOid: oid("integration-1"),
      retainedCommitOids: [oid("integration-1")],
      requiredParentOids: [],
    },
  };
}

export type CandidateRecorder = {
  writes: CandidateWrite[];
  write(candidate: CandidateWrite): Promise<CandidateWriteResult>;
};

export function candidateRecorder(): CandidateRecorder {
  const writes: CandidateWrite[] = [];
  return {
    writes,
    async write(candidate) {
      writes.push(candidate);
      return {
        kind: "succeeded",
        value: {
          status: "ready",
          integrationHeadOid: oid("candidate-1"),
          retainedCommitOids: [oid("candidate-1")],
          requiredParentOids: [oid("integration-1")],
        },
      };
    },
  };
}
