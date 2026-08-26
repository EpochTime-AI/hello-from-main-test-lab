import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ContributorGitDriver,
  createGitSandbox,
  type GitRunner,
  git,
  RealGitWorkspace,
} from "../adapters/git.js";
import { encodeUtf8 } from "../render/bytes.js";

const shell = `---
github: alice
github_id: 7
avatar: https://avatars.githubusercontent.com/u/7?v=4
source_pr: 1
---

# Project shell

最近在折腾：Git metadata

> Project source metadata
`;

const contribution = `---
github: alice
github_id: 7
avatar: https://avatars.githubusercontent.com/u/7?v=4
source_pr: 1
---

# Alice

最近在折腾：TypeScript / Git

> I am learning to resolve a real conflict.
`;

export type GoodFirstConflictScenario = {
  root: string;
  contributor: ContributorGitDriver;
  botWorkspace: RealGitWorkspace;
  contributorPath: string;
  integrationPath: string;
  upstream: string;
  fork: string;
  dispose: () => Promise<void>;
};

export async function createGoodFirstConflictScenario(
  options: { prebuiltIntegration?: boolean } = {},
): Promise<GoodFirstConflictScenario> {
  const sandbox = await createGitSandbox();
  try {
    const { root, runner } = sandbox;
    const upstream = join(root, "upstream.git");
    const fork = join(root, "fork.git");
    const seed = join(root, "seed");
    const contributorPath = join(root, "contributor");
    const integrationPath = join(root, "integration");
    await git(runner, root, "init", "--bare", upstream);
    await git(runner, root, "clone", upstream, seed);
    await mkdir(join(seed, "people"), { recursive: true });
    await writeFile(
      join(seed, "README.md"),
      "# Hello from Main\n\n<!-- cards:start -->\n<!-- cards:end -->\n",
    );
    await git(runner, seed, "add", "README.md", "people");
    await git(runner, seed, "commit", "--message", "Initialize tutorial");
    await git(runner, seed, "branch", "--show-current");
    await git(runner, seed, "push", "origin", "HEAD:main");
    await git(runner, root, "clone", "--bare", upstream, fork);
    await git(runner, root, "clone", fork, contributorPath);
    await git(runner, contributorPath, "remote", "add", "upstream", upstream);
    await git(
      runner,
      contributorPath,
      "switch",
      "-c",
      "add/alice",
      "origin/main",
    );
    await mkdir(join(contributorPath, "people"), { recursive: true });
    await writeFile(join(contributorPath, "people/alice.md"), contribution);
    await git(runner, contributorPath, "add", "--", "people/alice.md");
    await git(
      runner,
      contributorPath,
      "commit",
      "--message",
      "Add Alice contribution",
    );
    await git(runner, contributorPath, "push", "origin", "HEAD:add/alice");
    await git(runner, root, "clone", upstream, integrationPath);
    await git(runner, integrationPath, "switch", "-c", "main", "origin/main");
    await git(runner, integrationPath, "remote", "add", "contributor", fork);
    if (options.prebuiltIntegration) {
      await git(
        runner,
        integrationPath,
        "switch",
        "-c",
        "feature/card-alice-source-1",
        "origin/main",
      );
      await mkdir(join(integrationPath, "people"), { recursive: true });
      await writeFile(join(integrationPath, "people/alice.md"), shell);
      await git(runner, integrationPath, "add", "--", "people/alice.md");
      await git(
        runner,
        integrationPath,
        "commit",
        "--message",
        "Create Project Shell",
      );
      await git(
        runner,
        integrationPath,
        "push",
        "origin",
        "HEAD:feature/card-alice-source-1",
      );
    }
    const contributorRunner = createContributorRunner(runner);
    const contributor = new ContributorGitDriver(
      contributorRunner,
      contributorPath,
      "add/alice",
    );
    const botWorkspace = new RealGitWorkspace(
      runner,
      integrationPath,
      "origin",
      "feature/card-alice-source-1",
    );
    return {
      root,
      contributor,
      botWorkspace,
      contributorPath,
      integrationPath,
      upstream,
      fork,
      dispose: sandbox.dispose,
    };
  } catch (error) {
    await sandbox.dispose();
    throw error;
  }
}

function createContributorRunner(runner: GitRunner): GitRunner {
  return {
    run: (argv, options) =>
      runner.run(argv, {
        ...options,
        env: {
          ...options.env,
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          GIT_EDITOR: ":",
          GIT_SEQUENCE_EDITOR: ":",
        },
      }),
  };
}

export const resolvedAliceCardBytes = encodeUtf8(contribution);
