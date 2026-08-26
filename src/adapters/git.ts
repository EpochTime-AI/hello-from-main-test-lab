import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  CandidateWrite,
  CandidateWriteResult,
  CardManifest,
  FinalMainPostconditions,
  IntegrationMergeRequest,
  IntegrationMergeResult,
  Observation,
  Oid,
  WorkspaceReadback,
} from "../core/model.js";
import { oid } from "../core/model.js";

const allowed = new Set([
  "--version",
  "init",
  "clone",
  "config",
  "switch",
  "checkout",
  "add",
  "commit",
  "branch",
  "fetch",
  "rebase",
  "status",
  "ls-files",
  "rev-parse",
  "show",
  "ls-tree",
  "log",
  "merge",
  "merge-base",
  "--no-ff",
  "push",
  "remote",
  "rm",
  "update-ref",
  "cat-file",
  "diff",
  "diff-tree",
  "rev-list",
]);
const legacyCandidateManifestPath = ".hello-from-main/candidate.json";

export type GitResult = {
  commandId: string;
  argv: readonly string[];
  cwd: string;
  stdout: string;
  stderr: string;
  status: number;
};
export class GitCommandError extends Error {
  constructor(public readonly result: GitResult) {
    super(
      `git ${result.argv.join(" ")} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
}
export type GitRunner = {
  run(
    argv: readonly string[],
    options: {
      cwd: string;
      env?: Record<string, string | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<GitResult>;
};

export type GitAuthentication = {
  token: string;
};

export function createGitAuthenticationEnv(
  input: GitAuthentication & { helperPath: string },
): {
  env: Record<string, string>;
  dispose: () => Promise<void>;
} {
  if (!input.token) throw new Error("Git authentication token is required");
  return {
    env: {
      GIT_ASKPASS: input.helperPath,
      GIT_TERMINAL_PROMPT: "0",
      HELLO_FROM_MAIN_GIT_TOKEN: input.token,
    },
    // This low-level constructor owns no filesystem resource.
    dispose: async () => undefined,
  };
}

export async function installGitAuthentication(
  input: GitAuthentication & { root?: string },
) {
  // Authentication material must not share a repository's worktree.
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "hello-from-main-git-auth-"));
    await chmod(directory, 0o700);
    const askpass = join(directory, "git-askpass.sh");
    const auth = createGitAuthenticationEnv({
      token: input.token,
      helperPath: askpass,
    });
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "x-access-token\\n" ;;\n  *Password*) printf "%s\\n" "$HELLO_FROM_MAIN_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o700 },
    );
    await chmod(askpass, 0o700);
    return {
      ...auth,
      // This disposer owns the directory allocated by this installation.
      dispose: async () =>
        rm(directory as string, { force: true, recursive: true }),
    };
  } catch (error) {
    if (directory)
      await rm(directory, { force: true, recursive: true }).catch(
        () => undefined,
      );
    throw error;
  }
}

let nextCommand = 0;
export function createGitRunner(input: {
  root: string;
  env?: Record<string, string | undefined>;
}): GitRunner {
  return {
    run: (argv, options) =>
      runGit(input.root, argv, {
        ...options,
        env: { ...input.env, ...options.env },
      }),
  };
}

async function runGit(
  root: string,
  argv: readonly string[],
  options: {
    cwd: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
  },
): Promise<GitResult> {
  if (
    argv.length === 0 ||
    !allowed.has(argv[0] ?? "") ||
    argv.some((arg) => arg.includes("\0"))
  ) {
    throw new GitCommandError({
      commandId: `git-${++nextCommand}`,
      argv,
      cwd: options.cwd,
      stdout: "",
      stderr: "command not allowlisted",
      status: 126,
    });
  }
  const home = join(root, "home");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    GIT_CONFIG_COUNT: "8",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Hello from Main Bot",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "bot@example.invalid",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: "/dev/null",
    GIT_CONFIG_KEY_3: "commit.gpgSign",
    GIT_CONFIG_VALUE_3: "false",
    GIT_CONFIG_KEY_4: "tag.gpgSign",
    GIT_CONFIG_VALUE_4: "false",
    GIT_CONFIG_KEY_5: "core.autocrlf",
    GIT_CONFIG_VALUE_5: "false",
    GIT_CONFIG_KEY_6: "core.filemode",
    GIT_CONFIG_VALUE_6: "false",
    GIT_CONFIG_KEY_7: "gc.auto",
    GIT_CONFIG_VALUE_7: "0",
  };
  const commandId = `git-${++nextCommand}`;
  const result = await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", argv, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let spawnError: Error | undefined;
    const abort = () => child.kill("SIGTERM");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status) => {
      options.signal?.removeEventListener("abort", abort);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      resolve({
        commandId,
        argv,
        cwd: options.cwd,
        stdout,
        stderr,
        status: status ?? 1,
      });
    });
  });
  const token = options.env?.HELLO_FROM_MAIN_GIT_TOKEN;
  if (token) {
    result.stdout = result.stdout.split(token).join("[REDACTED]");
    result.stderr = result.stderr.split(token).join("[REDACTED]");
  }
  if (result.status !== 0) throw new GitCommandError(result);
  return result;
}

export async function git(
  runner: GitRunner,
  cwd: string,
  ...argv: string[]
): Promise<string> {
  return (await runner.run(argv, { cwd })).stdout.trim();
}

export type ConflictInspection = {
  path: string;
  stages: { 2: string; 3: string };
  rebaseHead: string;
};
export class ContributorGitDriver {
  constructor(
    private readonly runner: GitRunner,
    private readonly cwd: string,
    private readonly branch: string,
  ) {}
  async fetchAndRebase(): Promise<void> {
    await git(this.runner, this.cwd, "fetch", "upstream");
    await git(
      this.runner,
      this.cwd,
      "rebase",
      "upstream/feature/card-alice-source-1",
    );
  }
  async rebaseAndInspectConflict(): Promise<ConflictInspection> {
    try {
      await this.fetchAndRebase();
    } catch (error) {
      if (!(error instanceof GitCommandError)) throw error;
      const stages = await this.runner.run(
        ["ls-files", "--stage", "--", "people/alice.md"],
        { cwd: this.cwd },
      );
      const lines = stages.stdout.split("\n").filter(Boolean);
      const content = async (stage: string) =>
        readFile(join(this.cwd, "people/alice.md"), "utf8").catch(() => stage);
      const ours = await git(
        this.runner,
        this.cwd,
        "show",
        ":2:people/alice.md",
      );
      const theirs = await git(
        this.runner,
        this.cwd,
        "show",
        ":3:people/alice.md",
      );
      const rebaseHead = await git(
        this.runner,
        this.cwd,
        "rev-parse",
        "REBASE_HEAD",
      );
      void lines;
      void content;
      return {
        path: "people/alice.md",
        stages: { 2: ours, 3: theirs },
        rebaseHead,
      };
    }
    throw new Error("expected add/add conflict");
  }
  async resolveCard(bytes: Uint8Array): Promise<void> {
    await writeFile(join(this.cwd, "people/alice.md"), bytes);
    await git(this.runner, this.cwd, "add", "--", "people/alice.md");
  }
  async continueRebase(): Promise<void> {
    await git(this.runner, this.cwd, "rebase", "--continue");
  }
  async pushForceWithLease(): Promise<void> {
    await git(
      this.runner,
      this.cwd,
      "push",
      "--force-with-lease",
      "origin",
      `${this.branch}:${this.branch}`,
    );
  }
}

export class RealGitWorkspace {
  private activeSignal: AbortSignal | undefined;
  private readonly runner: GitRunner;

  constructor(
    runner: GitRunner,
    private readonly cwd: string,
    private readonly remote: string,
    private readonly branch: string,
  ) {
    this.runner = {
      run: (argv, options) =>
        runner.run(argv, {
          ...options,
          ...(this.activeSignal ? { signal: this.activeSignal } : {}),
        }),
    };
  }

  async createIntegrationBranchWithProjectShell(input: {
    name: string;
    fromMainOid: Oid;
    cardPath: string;
    cardBytes: Uint8Array;
  }) {
    const main = oid(
      await git(this.runner, this.cwd, "rev-parse", "origin/main"),
    );
    if (main !== input.fromMainOid) throw new Error("stale main setup target");
    const existing = await git(
      this.runner,
      this.cwd,
      "rev-parse",
      `origin/${input.name}`,
    ).catch(() => undefined);
    if (existing) {
      const existingCard = await git(
        this.runner,
        this.cwd,
        "rev-parse",
        `${existing}:${input.cardPath}`,
      ).catch(() => undefined);
      if (existingCard === oidFromBytes(input.cardBytes))
        return {
          branch: {
            name: input.name,
            headOid: oid(existing),
            provenance: "observed" as const,
          },
        };
    }
    await git(this.runner, this.cwd, "switch", "-C", input.name, "origin/main");
    await mkdir(dirname(join(this.cwd, input.cardPath)), { recursive: true });
    await writeFile(join(this.cwd, input.cardPath), input.cardBytes);
    await git(this.runner, this.cwd, "add", "--", input.cardPath);
    await git(
      this.runner,
      this.cwd,
      "commit",
      "--message",
      "Create Project Shell",
    );
    await git(
      this.runner,
      this.cwd,
      "push",
      "--force-with-lease",
      this.remote,
      `HEAD:${input.name}`,
    );
    return {
      branch: {
        name: input.name,
        headOid: oid(await git(this.runner, this.cwd, "rev-parse", "HEAD")),
        provenance: "observed" as const,
      },
    };
  }
  async readWorkspace(context?: {
    signal: AbortSignal;
  }): Promise<Observation<WorkspaceReadback>> {
    this.activeSignal = context?.signal;
    await git(this.runner, this.cwd, "fetch", this.remote).catch(
      () => undefined,
    );
    const remoteHead = await git(
      this.runner,
      this.cwd,
      "rev-parse",
      `origin/${this.branch}`,
    ).catch(() => undefined);
    if (!remoteHead) {
      const repository = await git(
        this.runner,
        this.cwd,
        "rev-parse",
        "--is-inside-work-tree",
      ).catch(() => undefined);
      if (repository !== "true") return { status: "readFailed" };
      return { status: "ready", value: { status: "ready" } };
    }
    const head = oid(remoteHead);
    const mainOid = await git(this.runner, this.cwd, "rev-parse", "origin/main")
      .then(oid)
      .catch(() => undefined);
    const readmeBlobOid = oid(
      await git(this.runner, this.cwd, "rev-parse", `${head}:README.md`),
    );
    const retainedCommitOids = (
      await git(this.runner, this.cwd, "rev-list", head)
    )
      .split("\n")
      .filter(Boolean)
      .map(oid);
    const parents = (
      await git(this.runner, this.cwd, "rev-list", "--parents", "-n", "1", head)
    )
      .split(" ")
      .slice(1)
      .filter(Boolean)
      .map(oid);
    const candidate = await candidateFromCommit(
      this.runner,
      this.cwd,
      head,
      readmeBlobOid,
      retainedCommitOids,
      parents,
      mainOid,
    );
    return {
      status: "ready",
      value: {
        status: "ready",
        integrationHeadOid: head,
        ...(candidate ? { candidate } : {}),
        readmeBlobOid,
        retainedCommitOids,
        requiredParentOids: parents,
      },
    };
  }
  async writeIntegrationCandidate(
    candidate: CandidateWrite,
    context?: { signal: AbortSignal },
  ): Promise<CandidateWriteResult> {
    this.activeSignal = context?.signal;
    try {
      const current = oid(
        await git(this.runner, this.cwd, "rev-parse", `origin/${this.branch}`),
      );
      await git(this.runner, this.cwd, "switch", "-C", this.branch, current);
      if (current !== candidate.input.expectedIntegrationHeadOid)
        return { kind: "staleLease" };
      const observedMain = oid(
        await git(this.runner, this.cwd, "rev-parse", `origin/main`),
      );
      if (observedMain !== candidate.input.observedMainOid)
        return { kind: "staleMain" };
      const existing = await this.readWorkspace().catch(() => undefined);
      if (
        existing?.value &&
        (await candidateMatches(
          this.runner,
          this.cwd,
          existing.value,
          candidate,
        ))
      )
        return { kind: "alreadyApplied", value: existing.value };
      if (!(await isAncestor(this.runner, this.cwd, observedMain, current))) {
        await git(
          this.runner,
          this.cwd,
          "merge",
          "--no-ff",
          "--no-edit",
          candidate.input.observedMainOid,
        );
      }
      const cardPath = join(this.cwd, candidate.input.cardPath);
      await mkdir(dirname(cardPath), { recursive: true });
      await writeFile(cardPath, candidate.input.cardBytes);
      await writeFile(join(this.cwd, "README.md"), candidate.input.readmeBytes);
      // Candidate facts are committed metadata, never a public tree artifact.
      await git(
        this.runner,
        this.cwd,
        "rm",
        "--ignore-unmatch",
        "--",
        legacyCandidateManifestPath,
      );
      await git(
        this.runner,
        this.cwd,
        "add",
        "--",
        candidate.input.cardPath,
        "README.md",
      );
      const candidateParentOid = oid(
        await git(this.runner, this.cwd, "rev-parse", "HEAD"),
      );
      await git(
        this.runner,
        this.cwd,
        "commit",
        "--allow-empty",
        "--message",
        "Build candidate Card",
        "--message",
        candidateCommitTrailers(candidate, candidateParentOid),
      );
      try {
        await git(
          this.runner,
          this.cwd,
          "push",
          "--force-with-lease",
          this.remote,
          `${this.branch}:${this.branch}`,
        );
      } catch {
        const readback = await this.readWorkspace().catch(() => undefined);
        if (
          readback?.value &&
          (await candidateMatches(
            this.runner,
            this.cwd,
            readback.value,
            candidate,
          ))
        )
          return { kind: "alreadyApplied", value: readback.value };
        return { kind: "retryableTransport" };
      }
      const head = oid(await git(this.runner, this.cwd, "rev-parse", "HEAD"));
      const cardBlob = oid(
        await git(
          this.runner,
          this.cwd,
          "rev-parse",
          `HEAD:${candidate.input.cardPath}`,
        ),
      );
      const readmeBlob = oid(
        await git(this.runner, this.cwd, "rev-parse", "HEAD:README.md"),
      );
      const managedCard =
        candidate.postconditions.managedCard ??
        candidate.postconditions.cardManifest;
      if (!managedCard)
        return { kind: "policyPostcondition", detail: "missing managed Card" };
      const manifest: CardManifest = { ...managedCard, blobOid: cardBlob };
      if (
        manifest.path !== candidate.postconditions.cardManifest.path ||
        manifest.blobOid !== candidate.postconditions.cardManifest.blobOid ||
        manifest.githubId !== candidate.postconditions.cardManifest.githubId ||
        manifest.sourcePrNumber !==
          candidate.postconditions.cardManifest.sourcePrNumber ||
        readmeBlob !== candidate.postconditions.readmeBlobOid
      )
        return {
          kind: "policyPostcondition",
          detail: "blob or manifest mismatch",
        };
      const retainedCommitOids = (
        await git(this.runner, this.cwd, "rev-list", "HEAD")
      )
        .split("\n")
        .filter(Boolean)
        .map(oid);
      if (
        !candidate.postconditions.history.retainCommitOids.every((commit) =>
          retainedCommitOids.includes(commit),
        )
      )
        return {
          kind: "policyPostcondition",
          detail: "retained history mismatch",
        };
      const requiredParentOids = (
        await git(
          this.runner,
          this.cwd,
          "rev-list",
          "--parents",
          "-n",
          "1",
          "HEAD",
        )
      )
        .split(" ")
        .slice(1)
        .map(oid);
      if (requiredParentOids.length !== 1)
        return {
          kind: "policyPostcondition",
          detail: "candidate must have one immediate parent",
        };
      const parsedCandidate = await candidateFromCommit(
        this.runner,
        this.cwd,
        head,
        readmeBlob,
        retainedCommitOids,
        requiredParentOids,
        candidate.input.observedMainOid,
      );
      if (!parsedCandidate)
        return {
          kind: "policyPostcondition",
          detail: "candidate tree or parent contract mismatch",
        };
      const readback: WorkspaceReadback = {
        status: "ready",
        integrationHeadOid: head,
        candidate: {
          observedOid: head,
          provenance: "observed",
          integrationHeadOid: head,
          mainOid: candidate.input.observedMainOid,
          cardPath: manifest.path,
          cardBlobOid: cardBlob,
          readmeBlobOid: readmeBlob,
          readmeBytes: candidate.input.readmeBytes,
          retainedCommitOids,
          requiredParentOids,
        },
        readmeBlobOid: readmeBlob,
        retainedCommitOids,
      };
      return { kind: "succeeded", value: readback };
    } catch (error) {
      return {
        kind: "unknownOutcome",
        ...(error instanceof GitCommandError
          ? { detail: gitCommandFailureDetail(error) }
          : {}),
      };
    }
  }

  async readFinalMainPostconditions(
    expected: FinalMainPostconditions,
    context?: { signal: AbortSignal },
  ): Promise<{
    status: "ready";
    value: FinalMainPostconditions;
  }> {
    this.activeSignal = context?.signal;
    await git(this.runner, this.cwd, "fetch", this.remote, "main");
    const mainOid = oid(
      await git(this.runner, this.cwd, "rev-parse", "origin/main"),
    );
    const cardBlobOid = oid(
      await git(
        this.runner,
        this.cwd,
        "rev-parse",
        `origin/main:${expected.cardManifest.path}`,
      ),
    );
    const cardBytes = new TextEncoder().encode(
      (
        await this.runner.run(
          ["show", `origin/main:${expected.cardManifest.path}`],
          { cwd: this.cwd },
        )
      ).stdout,
    );
    const readmeBytes = new TextEncoder().encode(
      (
        await this.runner.run(["show", "origin/main:README.md"], {
          cwd: this.cwd,
        })
      ).stdout,
    );
    const retainedCommitOids = (
      await git(this.runner, this.cwd, "rev-list", "origin/main")
    )
      .split("\n")
      .filter(Boolean)
      .map(oid);
    const requiredParentOids = (
      await git(
        this.runner,
        this.cwd,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "origin/main",
      )
    )
      .split(" ")
      .slice(1)
      .map(oid);
    const parentsOf = async (commit: Oid | undefined) =>
      commit
        ? (
            await git(
              this.runner,
              this.cwd,
              "rev-list",
              "--parents",
              "-n",
              "1",
              commit,
            )
          )
            .split(" ")
            .slice(1)
            .filter(Boolean)
            .map(oid)
        : undefined;
    const contributionMergeParentOids = await parentsOf(
      expected.sourceMergeCommitOid,
    );
    const integrationMergeParentOids = await parentsOf(
      expected.integrationMergeCommitOid,
    );
    return {
      status: "ready",
      value: {
        mainOid,
        cardManifest: { ...expected.cardManifest, blobOid: cardBlobOid },
        cardBytes,
        readmeBytes,
        retainedCommitOids,
        requiredParentOids,
        ...(expected.sourceMergeCommitOid
          ? { sourceMergeCommitOid: expected.sourceMergeCommitOid }
          : {}),
        ...(expected.integrationMergeCommitOid
          ? { integrationMergeCommitOid: expected.integrationMergeCommitOid }
          : {}),
        ...(expected.contributionMergeParentOids
          ? contributionMergeParentOids
            ? { contributionMergeParentOids }
            : {}
          : {}),
        ...(expected.integrationMergeParentOids
          ? integrationMergeParentOids
            ? { integrationMergeParentOids }
            : {}
          : {}),
      },
    };
  }

  async mergeNoFastForward(input: {
    sourceRef: string;
    expectedTargetOid: Oid;
    message: string;
  }): Promise<{ mergeCommitOid: Oid; parents: readonly Oid[] }> {
    const sourceRemote = input.sourceRef.split("/", 1)[0];
    if (sourceRemote && input.sourceRef.includes("/")) {
      await git(
        this.runner,
        this.cwd,
        "fetch",
        sourceRemote,
        input.sourceRef.slice(sourceRemote.length + 1),
      );
    }
    const target = oid(await git(this.runner, this.cwd, "rev-parse", "HEAD"));
    if (target !== input.expectedTargetOid)
      throw new Error("stale merge target");
    await git(
      this.runner,
      this.cwd,
      "merge",
      "--no-ff",
      "--no-edit",
      input.sourceRef,
      "--message",
      input.message,
    );
    const mergeCommitOid = oid(
      await git(this.runner, this.cwd, "rev-parse", "HEAD"),
    );
    const parents = (
      await git(
        this.runner,
        this.cwd,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      )
    )
      .split(" ")
      .slice(1)
      .map(oid);
    if (parents.length !== 2)
      throw new Error("expected a two-parent no-ff merge");
    await git(
      this.runner,
      this.cwd,
      "push",
      "--force-with-lease",
      this.remote,
      `${this.branch}:${this.branch}`,
    );
    return { mergeCommitOid, parents };
  }

  async publishIntegrationMerge(
    request: IntegrationMergeRequest,
    context?: { signal?: AbortSignal },
  ): Promise<IntegrationMergeResult> {
    this.activeSignal = context?.signal;
    if (request.baseCurrentGate !== "required")
      return { kind: "integrationRejected", reason: "gateUnsupported" };
    try {
      await git(
        this.runner,
        this.cwd,
        "fetch",
        this.remote,
        "refs/heads/main:refs/remotes/origin/main",
        `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`,
      );
      const observedMain = oid(
        await git(this.runner, this.cwd, "rev-parse", "origin/main"),
      );
      const expectedTreeOid = oid(
        await git(
          this.runner,
          this.cwd,
          "rev-parse",
          `${request.expectedHeadOid}^{tree}`,
        ),
      );
      const existing = await findPublishedIntegrationMerge(
        this.runner,
        this.cwd,
        observedMain,
        request,
        expectedTreeOid,
      );
      if (existing.kind === "exact")
        return { kind: "integrationAlreadyApplied", mainOid: existing.oid };
      if (existing.kind === "ambiguous")
        return { kind: "integrationRejected", reason: "unknownOutcome" };
      if (observedMain !== request.observedBaseOid)
        return { kind: "integrationRejected", reason: "baseMoved" };
      const observedCandidateOid = oid(
        await git(this.runner, this.cwd, "rev-parse", `origin/${this.branch}`),
      );
      if (observedCandidateOid !== request.expectedHeadOid)
        return { kind: "integrationRejected", reason: "stalePrecondition" };
      await git(this.runner, this.cwd, "switch", "-C", "main", observedMain);
      try {
        await git(
          this.runner,
          this.cwd,
          "merge",
          "--no-ff",
          "--no-edit",
          observedCandidateOid,
        );
      } catch (error) {
        await git(this.runner, this.cwd, "merge", "--abort").catch(
          () => undefined,
        );
        throw error;
      }
      const proposedMergeOid = oid(
        await git(this.runner, this.cwd, "rev-parse", "HEAD"),
      );
      if (
        !(await integrationMergeMatches(
          this.runner,
          this.cwd,
          proposedMergeOid,
          request,
          expectedTreeOid,
        ))
      )
        return { kind: "integrationRejected", reason: "gateRejected" };
      try {
        await git(
          this.runner,
          this.cwd,
          "push",
          "--porcelain",
          "--atomic",
          `--force-with-lease=refs/heads/main:${request.observedBaseOid}`,
          `--force-with-lease=refs/heads/${this.branch}:${request.expectedHeadOid}`,
          this.remote,
          `${proposedMergeOid}:refs/heads/main`,
          `${request.expectedHeadOid}:refs/heads/${this.branch}`,
        );
      } catch (error) {
        const readback = await readIntegrationPublication(
          this.runner,
          this.cwd,
          this.remote,
          this.branch,
          proposedMergeOid,
          request,
          expectedTreeOid,
        );
        if (readback.kind === "applied")
          return { kind: "integrationAlreadyApplied", mainOid: readback.oid };
        const readbackReason = integrationReadbackRejectionReason(readback);
        return {
          kind: "integrationRejected",
          reason:
            readbackReason === "unknownOutcome" &&
            error instanceof GitCommandError &&
            isPolicyRejection(error)
              ? "policyRejected"
              : readbackReason,
        };
      }
      const readback = await readIntegrationPublication(
        this.runner,
        this.cwd,
        this.remote,
        this.branch,
        proposedMergeOid,
        request,
        expectedTreeOid,
      );
      if (readback.kind === "applied")
        return { kind: "integrationMerged", mainOid: readback.oid };
      return {
        kind: "integrationRejected",
        reason: integrationReadbackRejectionReason(readback),
      };
    } catch (error) {
      return {
        kind: "integrationRejected",
        reason:
          error instanceof GitCommandError && isPolicyRejection(error)
            ? "policyRejected"
            : "retryableTransport",
      };
    }
  }

  async isAncestor(
    ancestor: Oid,
    descendant: string,
    expectedSourceOid: Oid,
  ): Promise<{ isAncestor: boolean; sourceHeadOid: Oid }> {
    const remote = descendant.split("/", 1)[0];
    let resolvedDescendant = descendant;
    if (remote && descendant.includes("/"))
      await git(
        this.runner,
        this.cwd,
        "fetch",
        remote,
        descendant.slice(remote.length + 1),
      ).then(() => {
        resolvedDescendant = "FETCH_HEAD";
      });
    const sourceHeadOid = oid(
      await git(this.runner, this.cwd, "rev-parse", resolvedDescendant),
    );
    if (sourceHeadOid !== expectedSourceOid)
      return { isAncestor: false, sourceHeadOid };
    return {
      isAncestor: await isAncestor(
        this.runner,
        this.cwd,
        ancestor,
        sourceHeadOid,
      ),
      sourceHeadOid,
    };
  }
}

function gitCommandFailureDetail(error: GitCommandError): string {
  const operation = error.result.argv[0] ?? "unknown";
  return `operation=${operation}; status=${error.result.status}; category=local-git`;
}

type IntegrationPublicationReadback =
  | { kind: "applied"; oid: Oid }
  | { kind: "baseMoved" | "staleCandidate" | "inconclusive" };

async function readIntegrationPublication(
  runner: GitRunner,
  cwd: string,
  remote: string,
  branch: string,
  mergeOid: Oid,
  request: IntegrationMergeRequest,
  expectedTreeOid: Oid,
): Promise<IntegrationPublicationReadback> {
  try {
    await git(
      runner,
      cwd,
      "fetch",
      remote,
      "refs/heads/main:refs/remotes/origin/main",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    );
    const remoteMain = oid(await git(runner, cwd, "rev-parse", "origin/main"));
    const remoteCandidate = oid(
      await git(runner, cwd, "rev-parse", `origin/${branch}`),
    );
    if (remoteMain === mergeOid)
      return (await integrationMergeMatches(
        runner,
        cwd,
        mergeOid,
        request,
        expectedTreeOid,
      ))
        ? { kind: "applied", oid: mergeOid }
        : { kind: "inconclusive" };
    const existing = await findPublishedIntegrationMerge(
      runner,
      cwd,
      remoteMain,
      request,
      expectedTreeOid,
    );
    if (existing.kind === "exact")
      return { kind: "applied", oid: existing.oid };
    if (existing.kind === "ambiguous") return { kind: "inconclusive" };
    if (
      remoteMain === request.observedBaseOid &&
      remoteCandidate !== request.expectedHeadOid
    )
      return { kind: "staleCandidate" };
    return remoteMain === request.observedBaseOid
      ? { kind: "inconclusive" }
      : { kind: "baseMoved" };
  } catch {
    return { kind: "inconclusive" };
  }
}

function integrationReadbackRejectionReason(
  readback: Exclude<IntegrationPublicationReadback, { kind: "applied" }>,
): "baseMoved" | "stalePrecondition" | "unknownOutcome" {
  if (readback.kind === "baseMoved") return "baseMoved";
  if (readback.kind === "staleCandidate") return "stalePrecondition";
  return "unknownOutcome";
}

async function findPublishedIntegrationMerge(
  runner: GitRunner,
  cwd: string,
  mainOid: Oid,
  request: IntegrationMergeRequest,
  expectedTreeOid: Oid,
): Promise<
  { kind: "none" } | { kind: "exact"; oid: Oid } | { kind: "ambiguous" }
> {
  const commits = (
    await git(runner, cwd, "rev-list", "--max-count=256", mainOid)
  )
    .split("\n")
    .filter(Boolean)
    .map(oid);
  const matches: Oid[] = [];
  for (const commit of commits) {
    if (
      await integrationMergeMatches(
        runner,
        cwd,
        commit,
        request,
        expectedTreeOid,
      )
    )
      matches.push(commit);
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1 && matches[0])
    return { kind: "exact", oid: matches[0] };
  return { kind: "ambiguous" };
}

async function integrationMergeMatches(
  runner: GitRunner,
  cwd: string,
  mergeOid: Oid,
  request: IntegrationMergeRequest,
  expectedTree: Oid,
): Promise<boolean> {
  const parents = (
    await git(runner, cwd, "rev-list", "--parents", "-n", "1", mergeOid)
  )
    .split(" ")
    .slice(1)
    .filter(Boolean)
    .map(oid);
  const tree = oid(await git(runner, cwd, "rev-parse", `${mergeOid}^{tree}`));
  return (
    parents.length === 2 &&
    parents[0] === request.observedBaseOid &&
    parents[1] === request.expectedHeadOid &&
    tree === expectedTree
  );
}

function isPolicyRejection(error: GitCommandError): boolean {
  return /protected branch|hook declined|GH006|denied|permission/i.test(
    error.result.stderr,
  );
}

function oidFromBytes(bytes: Uint8Array): Oid {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return oid(createHash("sha1").update(header).update(bytes).digest("hex"));
}

async function candidateFromCommit(
  runner: GitRunner,
  cwd: string,
  head: Oid,
  readmeBlobOid: Oid,
  retainedCommitOids: readonly Oid[],
  requiredParentOids: readonly Oid[],
  mainOid?: Oid,
) {
  type CandidateTrailers = {
    mainOid: Oid;
    cardManifest: CardManifest;
    readmeBlobOid: Oid;
    history: {
      retainCommitOids: readonly Oid[];
      requiredParentOids: readonly Oid[];
    };
  };
  let trailers: CandidateTrailers;
  try {
    trailers = parseCandidateTrailers(
      (await runner.run(["cat-file", "-p", head], { cwd })).stdout,
    );
  } catch {
    return undefined;
  }
  if (!mainOid) return undefined;
  const observedMainOid = mainOid;
  const cardBlobOid = oid(
    await git(
      runner,
      cwd,
      "rev-parse",
      `${head}:${trailers.cardManifest.path}`,
    ),
  );
  const canonicalParentContract =
    trailers.history.requiredParentOids.length === 1 &&
    requiredParentOids.length === 1 &&
    trailers.history.requiredParentOids[0] === requiredParentOids[0];
  const legacyH2ParentContract =
    !canonicalParentContract &&
    (await legacyH2CandidateParentContract(
      runner,
      cwd,
      trailers.history.requiredParentOids,
      trailers.history.retainCommitOids,
      requiredParentOids,
      retainedCommitOids,
      observedMainOid,
    ));
  const treeDeltaIsExact = await candidateTreeDeltaIsExact(
    runner,
    cwd,
    head,
    requiredParentOids,
    trailers.cardManifest.path,
  );
  if (
    cardBlobOid !== trailers.cardManifest.blobOid ||
    readmeBlobOid !== trailers.readmeBlobOid ||
    trailers.mainOid !== observedMainOid ||
    !trailers.history.retainCommitOids.every((commit) =>
      retainedCommitOids.includes(commit),
    ) ||
    !treeDeltaIsExact ||
    (!canonicalParentContract && !legacyH2ParentContract)
  )
    return undefined;
  const readmeBytes = new TextEncoder().encode(
    (await runner.run(["show", `${head}:README.md`], { cwd })).stdout,
  );
  return {
    observedOid: head,
    provenance: "observed" as const,
    integrationHeadOid: head,
    mainOid: trailers.mainOid,
    cardPath: trailers.cardManifest.path,
    cardBlobOid,
    readmeBlobOid,
    readmeBytes,
    retainedCommitOids,
    requiredParentOids,
  };
}

/** A candidate changes only its Card and the generated README relative to HEAD. */
async function candidateTreeDeltaIsExact(
  runner: GitRunner,
  cwd: string,
  head: Oid,
  candidateParents: readonly Oid[],
  cardPath: string,
): Promise<boolean> {
  const [parent] = candidateParents;
  if (candidateParents.length !== 1 || !parent) return false;
  const changedPaths = (
    await git(
      runner,
      cwd,
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      parent,
      head,
    )
  )
    .split("\n")
    .filter(Boolean);
  return changedPaths.every(
    (path) => path === cardPath || path === "README.md",
  );
}

/** Recognize only the H2 shape shipped with the stale required-parent trailer. */
async function legacyH2CandidateParentContract(
  runner: GitRunner,
  cwd: string,
  trailerRequiredParentOids: readonly Oid[],
  trailerRetainCommitOids: readonly Oid[],
  candidateParents: readonly Oid[],
  retainedCommitOids: readonly Oid[],
  mainOid: Oid,
): Promise<boolean> {
  const [trailerRequiredParentOid] = trailerRequiredParentOids;
  const [preRefreshIntegrationOid] = trailerRetainCommitOids;
  const [candidateParent] = candidateParents;
  if (
    trailerRequiredParentOids.length !== 1 ||
    candidateParents.length !== 1 ||
    !trailerRequiredParentOid ||
    !preRefreshIntegrationOid ||
    !candidateParent ||
    trailerRequiredParentOid === mainOid ||
    trailerRequiredParentOid !== preRefreshIntegrationOid ||
    !trailerRequiredParentOids.every((parent) =>
      retainedCommitOids.includes(parent),
    )
  )
    return false;
  const refreshParents = (
    await git(runner, cwd, "rev-list", "--parents", "-n", "1", candidateParent)
  )
    .split(" ")
    .slice(1)
    .filter(Boolean)
    .map(oid);
  return (
    refreshParents.length === 2 &&
    refreshParents[0] === preRefreshIntegrationOid &&
    refreshParents[1] === mainOid
  );
}

function candidateCommitTrailers(
  candidate: CandidateWrite,
  parent: Oid,
): string {
  const { cardManifest, readmeBlobOid, history } = candidate.postconditions;
  return [
    `Hello-From-Main-Main-Oid: ${candidate.input.observedMainOid}`,
    `Hello-From-Main-Card-Path: ${cardManifest.path}`,
    `Hello-From-Main-Card-Blob-Oid: ${cardManifest.blobOid}`,
    `Hello-From-Main-GitHub-Id: ${cardManifest.githubId}`,
    `Hello-From-Main-Source-Pr: ${cardManifest.sourcePrNumber}`,
    `Hello-From-Main-Readme-Blob-Oid: ${readmeBlobOid}`,
    `Hello-From-Main-Retain-Commit-Oids: ${history.retainCommitOids.join(",")}`,
    `Hello-From-Main-Required-Parent-Oids: ${[parent].join(",")}`,
  ].join("\n");
}

function parseCandidateTrailers(commit: string): {
  mainOid: Oid;
  cardManifest: CardManifest;
  readmeBlobOid: Oid;
  history: {
    retainCommitOids: readonly Oid[];
    requiredParentOids: readonly Oid[];
  };
} {
  const trailers = new Map<string, string>();
  for (const line of commit.split("\n")) {
    const match = /^(Hello-From-Main-[A-Za-z-]+): (.+)$/.exec(line);
    if (match?.[1] && match[2]) trailers.set(match[1], match[2]);
  }
  const value = (name: string) => {
    const trailer = trailers.get(name);
    if (!trailer) throw new Error(`missing candidate trailer: ${name}`);
    return trailer;
  };
  const oidList = (name: string) =>
    value(name).split(",").filter(Boolean).map(oid);
  const sourcePrNumber = Number(value("Hello-From-Main-Source-Pr"));
  if (!Number.isSafeInteger(sourcePrNumber) || sourcePrNumber < 1)
    throw new Error("invalid candidate source PR trailer");
  return {
    mainOid: oid(value("Hello-From-Main-Main-Oid")),
    cardManifest: {
      path: value("Hello-From-Main-Card-Path"),
      blobOid: oid(value("Hello-From-Main-Card-Blob-Oid")),
      githubId: value("Hello-From-Main-GitHub-Id"),
      sourcePrNumber,
    },
    readmeBlobOid: oid(value("Hello-From-Main-Readme-Blob-Oid")),
    history: {
      retainCommitOids: oidList("Hello-From-Main-Retain-Commit-Oids"),
      requiredParentOids: oidList("Hello-From-Main-Required-Parent-Oids"),
    },
  };
}

async function candidateMatches(
  runner: GitRunner,
  cwd: string,
  readback: WorkspaceReadback,
  candidate: CandidateWrite,
): Promise<boolean> {
  const actual = readback.candidate;
  const head = readback.integrationHeadOid;
  const readmeBlobOid = readback.readmeBlobOid;
  const retainedCommitOids = readback.retainedCommitOids;
  const requiredParentOids = readback.requiredParentOids;
  if (
    !actual ||
    !head ||
    !readmeBlobOid ||
    !retainedCommitOids ||
    !requiredParentOids
  )
    return false;
  const validated = await candidateFromCommit(
    runner,
    cwd,
    head,
    readmeBlobOid,
    retainedCommitOids,
    requiredParentOids,
    candidate.input.observedMainOid,
  );
  return (
    validated?.mainOid === candidate.input.observedMainOid &&
    validated.cardPath === candidate.postconditions.cardManifest.path &&
    validated.cardBlobOid === candidate.postconditions.cardManifest.blobOid &&
    validated.readmeBlobOid === candidate.postconditions.readmeBlobOid &&
    candidate.postconditions.history.retainCommitOids.every((commit) =>
      retainedCommitOids.includes(commit),
    ) &&
    validated.requiredParentOids?.length === 1 &&
    (candidate.postconditions.history.requiredParentOids.length === 0 ||
      candidate.postconditions.history.requiredParentOids.every((parent) =>
        retainedCommitOids.includes(parent),
      ))
  );
}

async function isAncestor(
  runner: GitRunner,
  cwd: string,
  ancestor: Oid,
  descendant: Oid,
): Promise<boolean> {
  try {
    await runner.run(["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
    });
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.result.status === 1)
      return false;
    throw error;
  }
}

export async function createGitSandbox(): Promise<{
  root: string;
  runner: GitRunner;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "hello-from-main-"));
  return {
    root,
    runner: createGitRunner({ root }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
