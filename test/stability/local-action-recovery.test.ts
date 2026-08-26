import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createGitRunner, RealGitWorkspace } from "../../src/adapters/git.js";
import {
  type LocalEffectRecord,
  LocalPlatformOperationError,
  openLocalActionRun,
} from "../../src/adapters/local-github.js";
import { gitBlobOid, oid, type RepositoryFacts } from "../../src/core/model.js";
import {
  createGoodFirstConflictScenario,
  resolvedAliceCardBytes,
} from "../../src/scenarios/good-first-conflict.js";

function minimumSeed(input: {
  mainOid: ReturnType<typeof oid>;
  sourceOid: ReturnType<typeof oid>;
}): RepositoryFacts {
  return {
    trustedCommentOwner: { actorId: "42", actorType: "Bot" },
    trustedRepository: {
      webBaseUrl: "https://github.com",
      owner: "local",
      repo: "verification",
    },
    main: {
      status: "ready",
      provenance: "provider",
      value: {
        oid: input.mainOid,
        readmeBytes: new TextEncoder().encode(
          "# Hello from Main\n\n<!-- cards:start -->\n<!-- cards:end -->\n",
        ),
        cardManifests: [],
        cardPayloads: [],
      },
    },
    sourcePullRequest: {
      status: "ready",
      provenance: "provider",
      value: {
        number: 1,
        kind: "contribution",
        headOid: input.sourceOid,
        baseOid: input.mainOid,
        headRef: "add/alice",
        baseRef: "main",
        draft: false,
        authorLogin: "alice",
        authorGithubId: "7",
        headRepositoryOwnerLogin: "alice",
        headRepositoryIsFork: true,
        changedFiles: [
          {
            path: "people/alice.md",
            blobOid: gitBlobOid(resolvedAliceCardBytes),
            bytes: resolvedAliceCardBytes,
          },
        ],
        changedFilesComplete: true,
        observedOid: input.sourceOid,
        provenance: "provider",
      },
    },
    integrationBranch: { status: "absent" },
    integrationPullRequest: { status: "absent" },
    candidate: { status: "absent" },
    eligibility: {
      checks: { status: "pending" },
      reviews: { status: "pending" },
      mergeability: { status: "pending" },
      baseCurrent: { status: "pending" },
    },
    confirmations: [],
  };
}

describe("F-R1 Local Action recovery", () => {
  test("reopens a real Git-backed run after a durable lost setup-comment response without replaying it", async () => {
    const scenario = await createGoodFirstConflictScenario();
    try {
      const runner = createGitRunner({ root: scenario.root });
      const mainOid = oid(
        (
          await runner.run(["rev-parse", "origin/main"], {
            cwd: scenario.integrationPath,
          })
        ).stdout.trim(),
      );
      const sourceOid = oid(
        (
          await runner.run(["rev-parse", "origin/add/alice"], {
            cwd: scenario.contributorPath,
          })
        ).stdout.trim(),
      );
      const publisherPath = join(scenario.root, "recovery-publisher");
      await runner.run(["clone", scenario.upstream, publisherPath], {
        cwd: scenario.root,
      });
      await runner.run(["switch", "main"], { cwd: publisherPath });
      const effects: LocalEffectRecord[] = [];
      let loseResponse = true;
      const seed = {
        facts: minimumSeed({ mainOid, sourceOid }),
        actionContext: {
          eventName: "workflow_dispatch",
          repository: "local/verification",
          ref: "refs/heads/main",
          sha: "local-main",
          eventPath: "local-event.json",
        },
        onEffect: (effect: LocalEffectRecord) => effects.push(effect),
        afterPersistBeforeReturn: (intent: { phase: string }) => {
          if (!loseResponse || intent.phase !== "setup") return undefined;
          loseResponse = false;
          return { kind: "unknownOutcome" as const, detail: "response lost" };
        },
      };
      const realGit = {
        workspace: scenario.botWorkspace,
        integrationWorkspace: new RealGitWorkspace(
          runner,
          publisherPath,
          "origin",
          "main",
        ),
        refs: {
          contribution: "contributor/add/alice",
          integration: "origin/feature/card-alice-source-1",
        },
      };
      const first = await openLocalActionRun({
        dir: scenario.root,
        realGit,
        seed,
        event: { kind: "wake" },
      });
      await expect(first.wake({ maxEffects: 4 })).resolves.toEqual({
        kind: "retryable",
        reason: "unknownOutcome",
      });
      await first.close();

      const reopened = await openLocalActionRun({
        dir: scenario.root,
        realGit,
        seed,
        event: { kind: "wake" },
      });
      await reopened.platform.observeRepository();
      await expect(reopened.wake({ maxEffects: 1 })).resolves.toEqual({
        kind: "budgetExhausted",
        effects: 1,
      });
      await reopened.close();

      const snapshot = JSON.parse(
        await readFile(join(scenario.root, "state.json"), "utf8"),
      ) as { facts: { comments: Array<{ actionKey: string }> } };
      expect(snapshot.facts.comments).toHaveLength(1);
      expect(effects.filter((effect) => effect.kind === "create")).toHaveLength(
        1,
      );
      expect(effects.filter((effect) => effect.kind === "update")).toHaveLength(
        1,
      );
      expect(effects.map((effect) => effect.kind)).toEqual([
        "create",
        "update",
      ]);
    } finally {
      await scenario.dispose();
    }
  }, 15_000);

  test.each(['{"version":1', '{"version":999,"facts":{}}', "not-json"])(
    "F-S1 fails closed for %j without mutating state or invoking Git",
    async (snapshot) => {
      const dir = await mkdtemp(join(tmpdir(), "hello-from-main-stability-"));
      try {
        const stateFile = join(dir, "state.json");
        await writeFile(stateFile, snapshot);
        let gitReads = 0;
        const seed = {
          facts: minimumSeed({
            mainOid: oid("main-1"),
            sourceOid: oid("source-1"),
          }),
          actionContext: {
            repository: "local/verification",
            ref: "refs/heads/main",
            sha: "local-main",
            eventPath: "local-event.json",
          },
        };
        await expect(
          openLocalActionRun({
            dir,
            realGit: {
              workspace: {
                readWorkspace: async () => {
                  gitReads += 1;
                  return { status: "ready" as const };
                },
              },
              refs: { contribution: "source", integration: "integration" },
            },
            seed,
            event: { kind: "wake" },
          }),
        ).rejects.toBeInstanceOf(LocalPlatformOperationError);
        expect(await readFile(stateFile, "utf8")).toBe(snapshot);
        expect(gitReads).toBe(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
