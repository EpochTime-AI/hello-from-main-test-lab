#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/model.ts
import { createHash } from "node:crypto";
function oid(value) {
  if (value.length === 0) throw new Error("OID must not be empty");
  return value;
}
function gitBlobOid(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return oid(createHash("sha1").update(header).update(bytes).digest("hex"));
}
function commentActionKey(input) {
  if (!input.runIdentity || !Number.isSafeInteger(input.targetPullRequestNumber))
    throw new Error("comment action key inputs are invalid");
  return `run=${input.runIdentity};target=${input.targetPullRequestNumber};slot=${input.slot}`;
}
function commentOwnership(fact, expected) {
  if (!expected || !fact.user || !canonicalActorId(expected.actorId) || !canonicalActorId(fact.user.id))
    return "notOwned";
  return fact.user.id === expected.actorId && fact.user.actorType === expected.actorType && fact.ownerPrincipal.actorId === expected.actorId && fact.ownerPrincipal.actorType === expected.actorType ? "owned" : "notOwned";
}
function planCommentMutation(intent, comments, expected) {
  if (!expected || !canonicalActorId(expected.actorId))
    return { kind: "ambiguousOwnership" };
  const matches = comments.filter(
    (comment) => comment.actionKey === intent.actionKey && comment.targetPullRequestNumber === intent.targetPullRequestNumber
  );
  if (comments.some(
    (comment) => comment.actionKey === intent.actionKey && comment.targetPullRequestNumber !== intent.targetPullRequestNumber
  ))
    return { kind: "ambiguousOwnership" };
  if (matches.length === 0) return { kind: "create" };
  const owned = matches.filter(
    (comment) => commentOwnership(comment, expected) === "owned"
  );
  if (owned.length !== 1 || owned.length !== matches.length)
    return { kind: "ambiguousOwnership" };
  const current = owned[0];
  if (!current) return { kind: "ambiguousOwnership" };
  if (intent.observed && (current.id !== intent.observed.id || current.actionKey !== intent.observed.actionKey || current.body !== intent.observed.body || current.ownerPrincipal.actorId !== intent.observed.ownerPrincipal.actorId || current.ownerPrincipal.actorType !== intent.observed.ownerPrincipal.actorType))
    return { kind: "stale" };
  return current.body === intent.body ? { kind: "noOp", comment: current } : { kind: "update", comment: current };
}
function canonicalActorId(value) {
  return /^[1-9][0-9]*$/u.test(value);
}
function createPublishedCardTarget(repository, readback) {
  if (!/^https:\/\/[^/?#]+$/u.test(repository.webBaseUrl))
    return { ok: false, reason: "untrusted web base" };
  if (!/^[A-Za-z0-9._-]+$/u.test(repository.owner) || !/^[A-Za-z0-9._-]+$/u.test(repository.repo))
    return { ok: false, reason: "invalid repository identity" };
  if (!/^[0-9a-f]{40}$/iu.test(readback.publishedMainOid) || !/^[0-9a-f]{40}$/iu.test(readback.expectedCardBlobOid) || readback.expectedCardBlobOid !== readback.actualCardBlobOid)
    return { ok: false, reason: "invalid or mismatched Git OID" };
  if (!/^people\/[A-Za-z0-9._+-]+\.md$/u.test(readback.cardPath) || readback.cardPath.includes(".."))
    return { ok: false, reason: "invalid Card path" };
  if (!Number.isSafeInteger(readback.sourcePullRequestNumber) || readback.sourcePullRequestNumber < 1)
    return { ok: false, reason: "invalid source pull request" };
  if (!bytesEqual(readback.expectedCardBytes, readback.actualCardBytes))
    return { ok: false, reason: "Card blob bytes do not match" };
  if (gitBlobOid(readback.actualCardBytes) !== readback.expectedCardBlobOid)
    return { ok: false, reason: "Card blob OID does not match bytes" };
  return {
    ok: true,
    target: {
      ...repository,
      publishedMainOid: readback.publishedMainOid,
      cardPath: readback.cardPath,
      expectedCardBlobOid: readback.expectedCardBlobOid,
      sourcePullRequestNumber: readback.sourcePullRequestNumber
    }
  };
}
function bytesEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
var init_model = __esm({
  "src/core/model.ts"() {
    "use strict";
  }
});

// src/adapters/git.ts
var git_exports = {};
__export(git_exports, {
  ContributorGitDriver: () => ContributorGitDriver,
  GitCommandError: () => GitCommandError,
  RealGitWorkspace: () => RealGitWorkspace,
  createGitAuthenticationEnv: () => createGitAuthenticationEnv,
  createGitRunner: () => createGitRunner,
  createGitSandbox: () => createGitSandbox,
  git: () => git,
  installGitAuthentication: () => installGitAuthentication
});
import { spawn } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile as readFile2,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
function createGitAuthenticationEnv(input) {
  if (!input.token) throw new Error("Git authentication token is required");
  return {
    env: {
      GIT_ASKPASS: input.helperPath,
      GIT_TERMINAL_PROMPT: "0",
      HELLO_FROM_MAIN_GIT_TOKEN: input.token
    },
    // This low-level constructor owns no filesystem resource.
    dispose: async () => void 0
  };
}
async function installGitAuthentication(input) {
  let directory;
  try {
    directory = await mkdtemp(join(tmpdir(), "hello-from-main-git-auth-"));
    await chmod(directory, 448);
    const askpass = join(directory, "git-askpass.sh");
    const auth = createGitAuthenticationEnv({
      token: input.token,
      helperPath: askpass
    });
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *Username*) printf "x-access-token\\n" ;;\n  *Password*) printf "%s\\n" "$HELLO_FROM_MAIN_GIT_TOKEN" ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 448 }
    );
    await chmod(askpass, 448);
    return {
      ...auth,
      // This disposer owns the directory allocated by this installation.
      dispose: async () => rm(directory, { force: true, recursive: true })
    };
  } catch (error) {
    if (directory)
      await rm(directory, { force: true, recursive: true }).catch(
        () => void 0
      );
    throw error;
  }
}
function createGitRunner(input) {
  return {
    run: (argv, options) => runGit(input.root, argv, {
      ...options,
      env: { ...input.env, ...options.env }
    })
  };
}
async function runGit(root, argv, options) {
  if (argv.length === 0 || !allowed.has(argv[0] ?? "") || argv.some((arg) => arg.includes("\0"))) {
    throw new GitCommandError({
      commandId: `git-${++nextCommand}`,
      argv,
      cwd: options.cwd,
      stdout: "",
      stderr: "command not allowlisted",
      status: 126
    });
  }
  const home = join(root, "home");
  const env = {
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
    GIT_CONFIG_VALUE_7: "0"
  };
  const commandId = `git-${++nextCommand}`;
  const result = await new Promise((resolve, reject2) => {
    const child = spawn("git", argv, {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    let spawnError;
    const abort = () => child.kill("SIGTERM");
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status) => {
      options.signal?.removeEventListener("abort", abort);
      if (spawnError) {
        reject2(spawnError);
        return;
      }
      resolve({
        commandId,
        argv,
        cwd: options.cwd,
        stdout,
        stderr,
        status: status ?? 1
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
async function git(runner, cwd, ...argv) {
  return (await runner.run(argv, { cwd })).stdout.trim();
}
function gitCommandFailureDetail(error) {
  const operation = error.result.argv[0] ?? "unknown";
  return `operation=${operation}; status=${error.result.status}; category=local-git`;
}
async function readIntegrationPublication(runner, cwd, remote, branch, mergeOid, request, expectedTreeOid) {
  try {
    await git(
      runner,
      cwd,
      "fetch",
      remote,
      "refs/heads/main:refs/remotes/origin/main",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`
    );
    const remoteMain = oid(await git(runner, cwd, "rev-parse", "origin/main"));
    const remoteCandidate = oid(
      await git(runner, cwd, "rev-parse", `origin/${branch}`)
    );
    if (remoteMain === mergeOid)
      return await integrationMergeMatches(
        runner,
        cwd,
        mergeOid,
        request,
        expectedTreeOid
      ) ? { kind: "applied", oid: mergeOid } : { kind: "inconclusive" };
    const existing = await findPublishedIntegrationMerge(
      runner,
      cwd,
      remoteMain,
      request,
      expectedTreeOid
    );
    if (existing.kind === "exact")
      return { kind: "applied", oid: existing.oid };
    if (existing.kind === "ambiguous") return { kind: "inconclusive" };
    if (remoteMain === request.observedBaseOid && remoteCandidate !== request.expectedHeadOid)
      return { kind: "staleCandidate" };
    return remoteMain === request.observedBaseOid ? { kind: "inconclusive" } : { kind: "baseMoved" };
  } catch {
    return { kind: "inconclusive" };
  }
}
function integrationReadbackRejectionReason(readback) {
  if (readback.kind === "baseMoved") return "baseMoved";
  if (readback.kind === "staleCandidate") return "stalePrecondition";
  return "unknownOutcome";
}
async function findPublishedIntegrationMerge(runner, cwd, mainOid, request, expectedTreeOid) {
  const commits = (await git(runner, cwd, "rev-list", "--max-count=256", mainOid)).split("\n").filter(Boolean).map(oid);
  const matches = [];
  for (const commit of commits) {
    if (await integrationMergeMatches(
      runner,
      cwd,
      commit,
      request,
      expectedTreeOid
    ))
      matches.push(commit);
  }
  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1 && matches[0])
    return { kind: "exact", oid: matches[0] };
  return { kind: "ambiguous" };
}
async function integrationMergeMatches(runner, cwd, mergeOid, request, expectedTree) {
  const parents = (await git(runner, cwd, "rev-list", "--parents", "-n", "1", mergeOid)).split(" ").slice(1).filter(Boolean).map(oid);
  const tree = oid(await git(runner, cwd, "rev-parse", `${mergeOid}^{tree}`));
  return parents.length === 2 && parents[0] === request.observedBaseOid && parents[1] === request.expectedHeadOid && tree === expectedTree;
}
function isPolicyRejection(error) {
  return /protected branch|hook declined|GH006|denied|permission/i.test(
    error.result.stderr
  );
}
function oidFromBytes(bytes) {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  return oid(createHash2("sha1").update(header).update(bytes).digest("hex"));
}
async function candidateFromCommit(runner, cwd, head, readmeBlobOid, retainedCommitOids, requiredParentOids, mainOid) {
  let trailers;
  try {
    trailers = parseCandidateTrailers(
      (await runner.run(["cat-file", "-p", head], { cwd })).stdout
    );
  } catch {
    return void 0;
  }
  if (!mainOid) return void 0;
  const observedMainOid = mainOid;
  const cardBlobOid = oid(
    await git(
      runner,
      cwd,
      "rev-parse",
      `${head}:${trailers.cardManifest.path}`
    )
  );
  const canonicalParentContract = trailers.history.requiredParentOids.length === 1 && requiredParentOids.length === 1 && trailers.history.requiredParentOids[0] === requiredParentOids[0];
  const legacyH2ParentContract = !canonicalParentContract && await legacyH2CandidateParentContract(
    runner,
    cwd,
    trailers.history.requiredParentOids,
    trailers.history.retainCommitOids,
    requiredParentOids,
    retainedCommitOids,
    observedMainOid
  );
  const treeDeltaIsExact = await candidateTreeDeltaIsExact(
    runner,
    cwd,
    head,
    requiredParentOids,
    trailers.cardManifest.path
  );
  if (cardBlobOid !== trailers.cardManifest.blobOid || readmeBlobOid !== trailers.readmeBlobOid || trailers.mainOid !== observedMainOid || !trailers.history.retainCommitOids.every(
    (commit) => retainedCommitOids.includes(commit)
  ) || !treeDeltaIsExact || !canonicalParentContract && !legacyH2ParentContract)
    return void 0;
  const readmeBytes = new TextEncoder().encode(
    (await runner.run(["show", `${head}:README.md`], { cwd })).stdout
  );
  return {
    observedOid: head,
    provenance: "observed",
    integrationHeadOid: head,
    mainOid: trailers.mainOid,
    cardPath: trailers.cardManifest.path,
    cardBlobOid,
    readmeBlobOid,
    readmeBytes,
    retainedCommitOids,
    requiredParentOids
  };
}
async function candidateTreeDeltaIsExact(runner, cwd, head, candidateParents, cardPath) {
  const [parent] = candidateParents;
  if (candidateParents.length !== 1 || !parent) return false;
  const changedPaths = (await git(
    runner,
    cwd,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    parent,
    head
  )).split("\n").filter(Boolean);
  return changedPaths.every(
    (path) => path === cardPath || path === "README.md"
  );
}
async function legacyH2CandidateParentContract(runner, cwd, trailerRequiredParentOids, trailerRetainCommitOids, candidateParents, retainedCommitOids, mainOid) {
  const [trailerRequiredParentOid] = trailerRequiredParentOids;
  const [preRefreshIntegrationOid] = trailerRetainCommitOids;
  const [candidateParent] = candidateParents;
  if (trailerRequiredParentOids.length !== 1 || candidateParents.length !== 1 || !trailerRequiredParentOid || !preRefreshIntegrationOid || !candidateParent || trailerRequiredParentOid === mainOid || trailerRequiredParentOid !== preRefreshIntegrationOid || !trailerRequiredParentOids.every(
    (parent) => retainedCommitOids.includes(parent)
  ))
    return false;
  const refreshParents = (await git(runner, cwd, "rev-list", "--parents", "-n", "1", candidateParent)).split(" ").slice(1).filter(Boolean).map(oid);
  return refreshParents.length === 2 && refreshParents[0] === preRefreshIntegrationOid && refreshParents[1] === mainOid;
}
function candidateCommitTrailers(candidate, parent) {
  const { cardManifest, readmeBlobOid, history } = candidate.postconditions;
  return [
    `Hello-From-Main-Main-Oid: ${candidate.input.observedMainOid}`,
    `Hello-From-Main-Card-Path: ${cardManifest.path}`,
    `Hello-From-Main-Card-Blob-Oid: ${cardManifest.blobOid}`,
    `Hello-From-Main-GitHub-Id: ${cardManifest.githubId}`,
    `Hello-From-Main-Source-Pr: ${cardManifest.sourcePrNumber}`,
    `Hello-From-Main-Readme-Blob-Oid: ${readmeBlobOid}`,
    `Hello-From-Main-Retain-Commit-Oids: ${history.retainCommitOids.join(",")}`,
    `Hello-From-Main-Required-Parent-Oids: ${[parent].join(",")}`
  ].join("\n");
}
function parseCandidateTrailers(commit) {
  const trailers = /* @__PURE__ */ new Map();
  for (const line of commit.split("\n")) {
    const match = /^(Hello-From-Main-[A-Za-z-]+): (.+)$/.exec(line);
    if (match?.[1] && match[2]) trailers.set(match[1], match[2]);
  }
  const value = (name) => {
    const trailer = trailers.get(name);
    if (!trailer) throw new Error(`missing candidate trailer: ${name}`);
    return trailer;
  };
  const oidList = (name) => value(name).split(",").filter(Boolean).map(oid);
  const sourcePrNumber = Number(value("Hello-From-Main-Source-Pr"));
  if (!Number.isSafeInteger(sourcePrNumber) || sourcePrNumber < 1)
    throw new Error("invalid candidate source PR trailer");
  return {
    mainOid: oid(value("Hello-From-Main-Main-Oid")),
    cardManifest: {
      path: value("Hello-From-Main-Card-Path"),
      blobOid: oid(value("Hello-From-Main-Card-Blob-Oid")),
      githubId: value("Hello-From-Main-GitHub-Id"),
      sourcePrNumber
    },
    readmeBlobOid: oid(value("Hello-From-Main-Readme-Blob-Oid")),
    history: {
      retainCommitOids: oidList("Hello-From-Main-Retain-Commit-Oids"),
      requiredParentOids: oidList("Hello-From-Main-Required-Parent-Oids")
    }
  };
}
async function candidateMatches(runner, cwd, readback, candidate) {
  const actual = readback.candidate;
  const head = readback.integrationHeadOid;
  const readmeBlobOid = readback.readmeBlobOid;
  const retainedCommitOids = readback.retainedCommitOids;
  const requiredParentOids = readback.requiredParentOids;
  if (!actual || !head || !readmeBlobOid || !retainedCommitOids || !requiredParentOids)
    return false;
  const validated = await candidateFromCommit(
    runner,
    cwd,
    head,
    readmeBlobOid,
    retainedCommitOids,
    requiredParentOids,
    candidate.input.observedMainOid
  );
  return validated?.mainOid === candidate.input.observedMainOid && validated.cardPath === candidate.postconditions.cardManifest.path && validated.cardBlobOid === candidate.postconditions.cardManifest.blobOid && validated.readmeBlobOid === candidate.postconditions.readmeBlobOid && candidate.postconditions.history.retainCommitOids.every(
    (commit) => retainedCommitOids.includes(commit)
  ) && validated.requiredParentOids?.length === 1 && (candidate.postconditions.history.requiredParentOids.length === 0 || candidate.postconditions.history.requiredParentOids.every(
    (parent) => retainedCommitOids.includes(parent)
  ));
}
async function isAncestor(runner, cwd, ancestor, descendant) {
  try {
    await runner.run(["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd
    });
    return true;
  } catch (error) {
    if (error instanceof GitCommandError && error.result.status === 1)
      return false;
    throw error;
  }
}
async function createGitSandbox() {
  const root = await mkdtemp(join(tmpdir(), "hello-from-main-"));
  return {
    root,
    runner: createGitRunner({ root }),
    dispose: () => rm(root, { recursive: true, force: true })
  };
}
var allowed, legacyCandidateManifestPath, GitCommandError, nextCommand, ContributorGitDriver, RealGitWorkspace;
var init_git = __esm({
  "src/adapters/git.ts"() {
    "use strict";
    init_model();
    allowed = /* @__PURE__ */ new Set([
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
      "rev-list"
    ]);
    legacyCandidateManifestPath = ".hello-from-main/candidate.json";
    GitCommandError = class extends Error {
      constructor(result) {
        super(
          `git ${result.argv.join(" ")} exited ${result.status}: ${result.stderr.trim()}`
        );
        this.result = result;
      }
      result;
    };
    nextCommand = 0;
    ContributorGitDriver = class {
      constructor(runner, cwd, branch) {
        this.runner = runner;
        this.cwd = cwd;
        this.branch = branch;
      }
      runner;
      cwd;
      branch;
      async fetchAndRebase() {
        await git(this.runner, this.cwd, "fetch", "upstream");
        await git(
          this.runner,
          this.cwd,
          "rebase",
          "upstream/feature/card-alice-source-1"
        );
      }
      async rebaseAndInspectConflict() {
        try {
          await this.fetchAndRebase();
        } catch (error) {
          if (!(error instanceof GitCommandError)) throw error;
          const stages = await this.runner.run(
            ["ls-files", "--stage", "--", "people/alice.md"],
            { cwd: this.cwd }
          );
          const lines = stages.stdout.split("\n").filter(Boolean);
          const content = async (stage) => readFile2(join(this.cwd, "people/alice.md"), "utf8").catch(() => stage);
          const ours = await git(
            this.runner,
            this.cwd,
            "show",
            ":2:people/alice.md"
          );
          const theirs = await git(
            this.runner,
            this.cwd,
            "show",
            ":3:people/alice.md"
          );
          const rebaseHead = await git(
            this.runner,
            this.cwd,
            "rev-parse",
            "REBASE_HEAD"
          );
          void lines;
          void content;
          return {
            path: "people/alice.md",
            stages: { 2: ours, 3: theirs },
            rebaseHead
          };
        }
        throw new Error("expected add/add conflict");
      }
      async resolveCard(bytes) {
        await writeFile(join(this.cwd, "people/alice.md"), bytes);
        await git(this.runner, this.cwd, "add", "--", "people/alice.md");
      }
      async continueRebase() {
        await git(this.runner, this.cwd, "rebase", "--continue");
      }
      async pushForceWithLease() {
        await git(
          this.runner,
          this.cwd,
          "push",
          "--force-with-lease",
          "origin",
          `${this.branch}:${this.branch}`
        );
      }
    };
    RealGitWorkspace = class {
      constructor(runner, cwd, remote, branch) {
        this.cwd = cwd;
        this.remote = remote;
        this.branch = branch;
        this.runner = {
          run: (argv, options) => runner.run(argv, {
            ...options,
            ...this.activeSignal ? { signal: this.activeSignal } : {}
          })
        };
      }
      cwd;
      remote;
      branch;
      activeSignal;
      runner;
      async createIntegrationBranchWithProjectShell(input) {
        const main = oid(
          await git(this.runner, this.cwd, "rev-parse", "origin/main")
        );
        if (main !== input.fromMainOid) throw new Error("stale main setup target");
        const existing = await git(
          this.runner,
          this.cwd,
          "rev-parse",
          `origin/${input.name}`
        ).catch(() => void 0);
        if (existing) {
          const existingCard = await git(
            this.runner,
            this.cwd,
            "rev-parse",
            `${existing}:${input.cardPath}`
          ).catch(() => void 0);
          if (existingCard === oidFromBytes(input.cardBytes))
            return {
              branch: {
                name: input.name,
                headOid: oid(existing),
                provenance: "observed"
              }
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
          "Create Project Shell"
        );
        await git(
          this.runner,
          this.cwd,
          "push",
          "--force-with-lease",
          this.remote,
          `HEAD:${input.name}`
        );
        return {
          branch: {
            name: input.name,
            headOid: oid(await git(this.runner, this.cwd, "rev-parse", "HEAD")),
            provenance: "observed"
          }
        };
      }
      async readWorkspace(context) {
        this.activeSignal = context?.signal;
        await git(this.runner, this.cwd, "fetch", this.remote).catch(
          () => void 0
        );
        const remoteHead = await git(
          this.runner,
          this.cwd,
          "rev-parse",
          `origin/${this.branch}`
        ).catch(() => void 0);
        if (!remoteHead) {
          const repository = await git(
            this.runner,
            this.cwd,
            "rev-parse",
            "--is-inside-work-tree"
          ).catch(() => void 0);
          if (repository !== "true") return { status: "readFailed" };
          return { status: "ready", value: { status: "ready" } };
        }
        const head = oid(remoteHead);
        const mainOid = await git(this.runner, this.cwd, "rev-parse", "origin/main").then(oid).catch(() => void 0);
        const readmeBlobOid = oid(
          await git(this.runner, this.cwd, "rev-parse", `${head}:README.md`)
        );
        const retainedCommitOids = (await git(this.runner, this.cwd, "rev-list", head)).split("\n").filter(Boolean).map(oid);
        const parents = (await git(this.runner, this.cwd, "rev-list", "--parents", "-n", "1", head)).split(" ").slice(1).filter(Boolean).map(oid);
        const candidate = await candidateFromCommit(
          this.runner,
          this.cwd,
          head,
          readmeBlobOid,
          retainedCommitOids,
          parents,
          mainOid
        );
        return {
          status: "ready",
          value: {
            status: "ready",
            integrationHeadOid: head,
            ...candidate ? { candidate } : {},
            readmeBlobOid,
            retainedCommitOids,
            requiredParentOids: parents
          }
        };
      }
      async writeIntegrationCandidate(candidate, context) {
        this.activeSignal = context?.signal;
        try {
          const current = oid(
            await git(this.runner, this.cwd, "rev-parse", `origin/${this.branch}`)
          );
          await git(this.runner, this.cwd, "switch", "-C", this.branch, current);
          if (current !== candidate.input.expectedIntegrationHeadOid)
            return { kind: "staleLease" };
          const observedMain = oid(
            await git(this.runner, this.cwd, "rev-parse", `origin/main`)
          );
          if (observedMain !== candidate.input.observedMainOid)
            return { kind: "staleMain" };
          const existing = await this.readWorkspace().catch(() => void 0);
          if (existing?.value && await candidateMatches(
            this.runner,
            this.cwd,
            existing.value,
            candidate
          ))
            return { kind: "alreadyApplied", value: existing.value };
          if (!await isAncestor(this.runner, this.cwd, observedMain, current)) {
            await git(
              this.runner,
              this.cwd,
              "merge",
              "--no-ff",
              "--no-edit",
              candidate.input.observedMainOid
            );
          }
          const cardPath = join(this.cwd, candidate.input.cardPath);
          await mkdir(dirname(cardPath), { recursive: true });
          await writeFile(cardPath, candidate.input.cardBytes);
          await writeFile(join(this.cwd, "README.md"), candidate.input.readmeBytes);
          await git(
            this.runner,
            this.cwd,
            "rm",
            "--ignore-unmatch",
            "--",
            legacyCandidateManifestPath
          );
          await git(
            this.runner,
            this.cwd,
            "add",
            "--",
            candidate.input.cardPath,
            "README.md"
          );
          const candidateParentOid = oid(
            await git(this.runner, this.cwd, "rev-parse", "HEAD")
          );
          await git(
            this.runner,
            this.cwd,
            "commit",
            "--allow-empty",
            "--message",
            "Build candidate Card",
            "--message",
            candidateCommitTrailers(candidate, candidateParentOid)
          );
          try {
            await git(
              this.runner,
              this.cwd,
              "push",
              "--force-with-lease",
              this.remote,
              `${this.branch}:${this.branch}`
            );
          } catch {
            const readback2 = await this.readWorkspace().catch(() => void 0);
            if (readback2?.value && await candidateMatches(
              this.runner,
              this.cwd,
              readback2.value,
              candidate
            ))
              return { kind: "alreadyApplied", value: readback2.value };
            return { kind: "retryableTransport" };
          }
          const head = oid(await git(this.runner, this.cwd, "rev-parse", "HEAD"));
          const cardBlob = oid(
            await git(
              this.runner,
              this.cwd,
              "rev-parse",
              `HEAD:${candidate.input.cardPath}`
            )
          );
          const readmeBlob = oid(
            await git(this.runner, this.cwd, "rev-parse", "HEAD:README.md")
          );
          const managedCard = candidate.postconditions.managedCard ?? candidate.postconditions.cardManifest;
          if (!managedCard)
            return { kind: "policyPostcondition", detail: "missing managed Card" };
          const manifest = { ...managedCard, blobOid: cardBlob };
          if (manifest.path !== candidate.postconditions.cardManifest.path || manifest.blobOid !== candidate.postconditions.cardManifest.blobOid || manifest.githubId !== candidate.postconditions.cardManifest.githubId || manifest.sourcePrNumber !== candidate.postconditions.cardManifest.sourcePrNumber || readmeBlob !== candidate.postconditions.readmeBlobOid)
            return {
              kind: "policyPostcondition",
              detail: "blob or manifest mismatch"
            };
          const retainedCommitOids = (await git(this.runner, this.cwd, "rev-list", "HEAD")).split("\n").filter(Boolean).map(oid);
          if (!candidate.postconditions.history.retainCommitOids.every(
            (commit) => retainedCommitOids.includes(commit)
          ))
            return {
              kind: "policyPostcondition",
              detail: "retained history mismatch"
            };
          const requiredParentOids = (await git(
            this.runner,
            this.cwd,
            "rev-list",
            "--parents",
            "-n",
            "1",
            "HEAD"
          )).split(" ").slice(1).map(oid);
          if (requiredParentOids.length !== 1)
            return {
              kind: "policyPostcondition",
              detail: "candidate must have one immediate parent"
            };
          const parsedCandidate = await candidateFromCommit(
            this.runner,
            this.cwd,
            head,
            readmeBlob,
            retainedCommitOids,
            requiredParentOids,
            candidate.input.observedMainOid
          );
          if (!parsedCandidate)
            return {
              kind: "policyPostcondition",
              detail: "candidate tree or parent contract mismatch"
            };
          const readback = {
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
              requiredParentOids
            },
            readmeBlobOid: readmeBlob,
            retainedCommitOids
          };
          return { kind: "succeeded", value: readback };
        } catch (error) {
          return {
            kind: "unknownOutcome",
            ...error instanceof GitCommandError ? { detail: gitCommandFailureDetail(error) } : {}
          };
        }
      }
      async readFinalMainPostconditions(expected, context) {
        this.activeSignal = context?.signal;
        await git(this.runner, this.cwd, "fetch", this.remote, "main");
        const mainOid = oid(
          await git(this.runner, this.cwd, "rev-parse", "origin/main")
        );
        const cardBlobOid = oid(
          await git(
            this.runner,
            this.cwd,
            "rev-parse",
            `origin/main:${expected.cardManifest.path}`
          )
        );
        const cardBytes = new TextEncoder().encode(
          (await this.runner.run(
            ["show", `origin/main:${expected.cardManifest.path}`],
            { cwd: this.cwd }
          )).stdout
        );
        const readmeBytes = new TextEncoder().encode(
          (await this.runner.run(["show", "origin/main:README.md"], {
            cwd: this.cwd
          })).stdout
        );
        const retainedCommitOids = (await git(this.runner, this.cwd, "rev-list", "origin/main")).split("\n").filter(Boolean).map(oid);
        const requiredParentOids = (await git(
          this.runner,
          this.cwd,
          "rev-list",
          "--parents",
          "-n",
          "1",
          "origin/main"
        )).split(" ").slice(1).map(oid);
        const parentsOf = async (commit) => commit ? (await git(
          this.runner,
          this.cwd,
          "rev-list",
          "--parents",
          "-n",
          "1",
          commit
        )).split(" ").slice(1).filter(Boolean).map(oid) : void 0;
        const contributionMergeParentOids = await parentsOf(
          expected.sourceMergeCommitOid
        );
        const integrationMergeParentOids = await parentsOf(
          expected.integrationMergeCommitOid
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
            ...expected.sourceMergeCommitOid ? { sourceMergeCommitOid: expected.sourceMergeCommitOid } : {},
            ...expected.integrationMergeCommitOid ? { integrationMergeCommitOid: expected.integrationMergeCommitOid } : {},
            ...expected.contributionMergeParentOids ? contributionMergeParentOids ? { contributionMergeParentOids } : {} : {},
            ...expected.integrationMergeParentOids ? integrationMergeParentOids ? { integrationMergeParentOids } : {} : {}
          }
        };
      }
      async mergeNoFastForward(input) {
        const sourceRemote = input.sourceRef.split("/", 1)[0];
        if (sourceRemote && input.sourceRef.includes("/")) {
          await git(
            this.runner,
            this.cwd,
            "fetch",
            sourceRemote,
            input.sourceRef.slice(sourceRemote.length + 1)
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
          input.message
        );
        const mergeCommitOid = oid(
          await git(this.runner, this.cwd, "rev-parse", "HEAD")
        );
        const parents = (await git(
          this.runner,
          this.cwd,
          "rev-list",
          "--parents",
          "-n",
          "1",
          "HEAD"
        )).split(" ").slice(1).map(oid);
        if (parents.length !== 2)
          throw new Error("expected a two-parent no-ff merge");
        await git(
          this.runner,
          this.cwd,
          "push",
          "--force-with-lease",
          this.remote,
          `${this.branch}:${this.branch}`
        );
        return { mergeCommitOid, parents };
      }
      async publishIntegrationMerge(request, context) {
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
            `+refs/heads/${this.branch}:refs/remotes/origin/${this.branch}`
          );
          const observedMain = oid(
            await git(this.runner, this.cwd, "rev-parse", "origin/main")
          );
          const expectedTreeOid = oid(
            await git(
              this.runner,
              this.cwd,
              "rev-parse",
              `${request.expectedHeadOid}^{tree}`
            )
          );
          const existing = await findPublishedIntegrationMerge(
            this.runner,
            this.cwd,
            observedMain,
            request,
            expectedTreeOid
          );
          if (existing.kind === "exact")
            return { kind: "integrationAlreadyApplied", mainOid: existing.oid };
          if (existing.kind === "ambiguous")
            return { kind: "integrationRejected", reason: "unknownOutcome" };
          if (observedMain !== request.observedBaseOid)
            return { kind: "integrationRejected", reason: "baseMoved" };
          const observedCandidateOid = oid(
            await git(this.runner, this.cwd, "rev-parse", `origin/${this.branch}`)
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
              observedCandidateOid
            );
          } catch (error) {
            await git(this.runner, this.cwd, "merge", "--abort").catch(
              () => void 0
            );
            throw error;
          }
          const proposedMergeOid = oid(
            await git(this.runner, this.cwd, "rev-parse", "HEAD")
          );
          if (!await integrationMergeMatches(
            this.runner,
            this.cwd,
            proposedMergeOid,
            request,
            expectedTreeOid
          ))
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
              `${request.expectedHeadOid}:refs/heads/${this.branch}`
            );
          } catch (error) {
            const readback2 = await readIntegrationPublication(
              this.runner,
              this.cwd,
              this.remote,
              this.branch,
              proposedMergeOid,
              request,
              expectedTreeOid
            );
            if (readback2.kind === "applied")
              return { kind: "integrationAlreadyApplied", mainOid: readback2.oid };
            const readbackReason = integrationReadbackRejectionReason(readback2);
            return {
              kind: "integrationRejected",
              reason: readbackReason === "unknownOutcome" && error instanceof GitCommandError && isPolicyRejection(error) ? "policyRejected" : readbackReason
            };
          }
          const readback = await readIntegrationPublication(
            this.runner,
            this.cwd,
            this.remote,
            this.branch,
            proposedMergeOid,
            request,
            expectedTreeOid
          );
          if (readback.kind === "applied")
            return { kind: "integrationMerged", mainOid: readback.oid };
          return {
            kind: "integrationRejected",
            reason: integrationReadbackRejectionReason(readback)
          };
        } catch (error) {
          return {
            kind: "integrationRejected",
            reason: error instanceof GitCommandError && isPolicyRejection(error) ? "policyRejected" : "retryableTransport"
          };
        }
      }
      async isAncestor(ancestor, descendant, expectedSourceOid) {
        const remote = descendant.split("/", 1)[0];
        let resolvedDescendant = descendant;
        if (remote && descendant.includes("/"))
          await git(
            this.runner,
            this.cwd,
            "fetch",
            remote,
            descendant.slice(remote.length + 1)
          ).then(() => {
            resolvedDescendant = "FETCH_HEAD";
          });
        const sourceHeadOid = oid(
          await git(this.runner, this.cwd, "rev-parse", resolvedDescendant)
        );
        if (sourceHeadOid !== expectedSourceOid)
          return { isAncestor: false, sourceHeadOid };
        return {
          isAncestor: await isAncestor(
            this.runner,
            this.cwd,
            ancestor,
            sourceHeadOid
          ),
          sourceHeadOid
        };
      }
    };
  }
});

// src/adapters/action-context.ts
import { readFile } from "node:fs/promises";
async function createTrustedActionContext(input) {
  const env = input.env ?? process.env;
  const eventPath = required(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const eventRuntimeRef = required(env.GITHUB_REF, "GITHUB_REF");
  const ref = required(
    env.HELLO_FROM_MAIN_TRUSTED_SOURCE_REF,
    "HELLO_FROM_MAIN_TRUSTED_SOURCE_REF"
  );
  const sha = required(env.GITHUB_SHA, "GITHUB_SHA");
  if (ref !== `refs/heads/${input.defaultBranch}`)
    throw new Error("event must run from the trusted default branch");
  let event;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    throw new Error("GITHUB_EVENT_PATH is malformed or unreadable");
  }
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("GITHUB_EVENT_PATH must contain an object");
  const record = event;
  const eventRef = typeof record.ref === "string" ? record.ref : void 0;
  const eventSha = typeof record.after === "string" ? record.after : typeof record.sha === "string" ? record.sha : void 0;
  const eventRepository = record.repository && typeof record.repository === "object" ? record.repository.full_name : void 0;
  const pullRequest = asRecord(record.pull_request);
  const isPullRequestEvent = env.GITHUB_EVENT_NAME === "pull_request_target";
  if (eventRef && eventRef !== eventRuntimeRef && !isPullRequestEvent)
    throw new Error("event ref does not match trusted runtime ref");
  if (eventSha && eventSha !== sha && !isPullRequestEvent)
    throw new Error("event SHA does not match trusted runtime SHA");
  if (eventRepository && eventRepository !== repository)
    throw new Error(
      "event repository does not match trusted runtime repository"
    );
  const defaultBranch = asRecord(eventRepositoryValue(record)).default_branch;
  if (defaultBranch && defaultBranch !== input.defaultBranch)
    throw new Error("event repository default branch is not trusted");
  let sourcePullRequest;
  if (isPullRequestEvent) {
    const base = asRecord(pullRequest.base);
    const baseRepository = asRecord(base.repo).full_name;
    if (base.ref !== input.defaultBranch || baseRepository !== repository)
      throw new Error("pull request base repository is not trusted");
    const number = pullRequest.number;
    if (typeof number !== "number" || number <= 0)
      throw new Error("pull request number is required");
    const headRef = pullRequest.head && asRecord(pullRequest.head).ref;
    if (typeof headRef !== "string" || !headRef)
      throw new Error("pull request head branch is required");
    sourcePullRequest = {
      number,
      ...typeof asRecord(pullRequest.user).login === "string" ? { authorLogin: asRecord(pullRequest.user).login } : {},
      headRef,
      baseRef: input.defaultBranch,
      baseRepository: repository
    };
  }
  return {
    repository,
    ref,
    sha,
    eventPath,
    ...env.GITHUB_EVENT_NAME ? { eventName: env.GITHUB_EVENT_NAME } : {},
    ...sourcePullRequest ? { sourcePullRequest } : {}
  };
}
function eventRepositoryValue(record) {
  return record.repository && typeof record.repository === "object" ? record.repository : {};
}
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// src/entry/action-runtime.ts
init_git();

// src/adapters/octokit.ts
init_model();
var OctokitOperationError = class extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
  category;
};
function createOctokitGithubPlatform(options) {
  let lastFacts = options.initialFacts;
  let activeSignal;
  const apiOrigin = normalizeApiOrigin(options.apiOrigin);
  const repositoryId = options.repositoryId;
  const commentReadback = options.commentReadback ?? {};
  const commentLifecycle = /* @__PURE__ */ new Set();
  const commentCreatePermits = [];
  const path = (suffix) => `/repos/${options.owner}/${options.repo}${suffix}`;
  const apiCommentPath = (suffix) => path(suffix);
  const mergeIntegration = async (request) => {
    void options.lookupIntegrationMain;
    void request;
    return { kind: "integrationRejected", reason: "gateUnsupported" };
  };
  const observeRepository = async (context) => {
    activeSignal = context?.signal;
    if (options.replay && options.initialFacts) {
      lastFacts = options.initialFacts;
      return {
        status: "ready",
        provenance: "provider",
        value: options.initialFacts
      };
    }
    try {
      const mainResponse = await requestRest(
        {
          method: "GET",
          path: path("/git/ref/heads/main")
        },
        "read"
      );
      const main = asRecord2(mainResponse.data);
      const mainOid = stringValue(asRecord2(main.object).sha ?? main.sha);
      const pages = await paginatePullRequests();
      const expectedNumber = context?.expectedSourcePullRequestNumber;
      const expectedLogin = context?.expectedSourceLogin;
      const sourceCandidate = pages.find((item) => {
        const head = asRecord2(item.head);
        const user = asRecord2(item.user);
        return stringValue(head.ref).startsWith("add/") && (expectedNumber === void 0 || numberValue(item.number) === expectedNumber) && (expectedLogin === void 0 || stringValue(user.login) === expectedLogin);
      });
      if ((expectedNumber !== void 0 || expectedLogin !== void 0) && !sourceCandidate)
        throw new OctokitOperationError(
          "notVisibleYet",
          "expected source pull request is not visible"
        );
      const candidateLogin = asRecord2(sourceCandidate?.user).login;
      const expectedBranch = sourceCandidate && typeof candidateLogin === "string" ? `feature/card-${candidateLogin}-source-${numberValue(sourceCandidate.number)}` : void 0;
      let integration = expectedBranch ? pages.find(
        (item) => stringValue(asRecord2(item.head).ref) === expectedBranch && stringValue(asRecord2(item.base).ref) === "main"
      ) : void 0;
      const branchFact = integration ? void 0 : await findIntegrationBranch(expectedBranch);
      const discoveredBranch = branchFact ?? (integration ? {
        name: stringValue(asRecord2(integration.head).ref),
        headOid: oid(stringValue(asRecord2(integration.head).sha)),
        provenance: "provider"
      } : void 0);
      if (!integration && discoveredBranch)
        integration = pages.find(
          (item) => stringValue(asRecord2(item.head).ref) === discoveredBranch.name && stringValue(asRecord2(item.base).ref) === "main" && stringValue(asRecord2(item.head).sha) === discoveredBranch.headOid
        );
      const branch = discoveredBranch;
      const integrationRef = branch?.name;
      const source = sourceCandidate && (!integrationRef || stringValue(asRecord2(sourceCandidate.base).ref) === integrationRef || stringValue(asRecord2(sourceCandidate.base).ref) === "main") ? sourceCandidate : void 0;
      const sourceRead = source ? await readExactPullRequest(
        numberValue(source.number),
        "contribution",
        source
      ) : void 0;
      const sourceFact = sourceRead ? await readSourceIntake(sourceRead.record, sourceRead.fact) : void 0;
      const sourceHeadBasedOnIntegration = sourceFact ? branch && !sourceFact.merged ? await observeSourceAncestry(branch.headOid, sourceFact.headOid) : sourceFact.merged ? {
        status: "ready",
        provenance: "provider",
        value: {
          integrationHeadOid: sourceFact.baseOid,
          sourceHeadOid: sourceFact.headOid,
          isAncestor: true,
          observedOid: sourceFact.headOid,
          provenance: "provider"
        }
      } : { status: "pending", provenance: "provider" } : void 0;
      const integrationRead = integration ? await readExactPullRequest(
        numberValue(integration.number),
        "integration",
        integration
      ) : void 0;
      const integrationFact = integrationRead?.fact;
      const mainProjection = await readMainProjection(oid(mainOid));
      const facts = {
        main: {
          status: "ready",
          provenance: "provider",
          value: mainProjection
        },
        sourcePullRequest: sourceFact ? { status: "ready", provenance: "provider", value: sourceFact } : { status: "absent", provenance: "provider" },
        ...sourceHeadBasedOnIntegration ? { sourceHeadBasedOnIntegration } : {},
        integrationBranch: branch ? { status: "ready", provenance: "provider", value: branch } : { status: "absent", provenance: "provider" },
        integrationPullRequest: integrationFact ? { status: "ready", provenance: "provider", value: integrationFact } : { status: "absent", provenance: "provider" },
        candidate: sourceFact && integrationFact ? await readCandidate(sourceFact, integrationFact, oid(mainOid)) : { status: "absent", provenance: "provider" },
        eligibility: {
          checks: integrationFact ? await observeEligibility(() => readChecks(integrationFact)) : { status: "pending", provenance: "provider" },
          reviews: integrationFact ? await observeEligibility(() => readReviews(integrationFact)) : { status: "pending", provenance: "provider" },
          mergeability: integrationRead ? mergeabilityObservation(integrationRead.record) : { status: "pending", provenance: "provider" },
          baseCurrent: integrationFact ? {
            status: "ready",
            provenance: "provider",
            value: integrationFact.baseOid === oid(mainOid)
          } : { status: "pending", provenance: "provider" }
        },
        confirmations: [],
        ...options.expectedCommentOwner && sourceFact ? {
          comments: await readCommentsForTargets([
            sourceFact.number,
            ...integrationFact ? [integrationFact.number] : []
          ]),
          trustedCommentOwner: options.expectedCommentOwner
        } : {},
        publishedGithubIds: mainProjection.cardManifests.map(
          (card) => card.githubId
        ),
        activeGithubIds: activeIdentityIds(pages, source),
        protocolAnchors: {
          ...sourceFact ? {
            contribution: {
              projectShellOid: sourceFact.baseOid,
              rebasedContributorOid: sourceFact.headOid
            }
          } : {},
          ...integrationFact ? {
            integration: {
              mainBeforePublicationOid: integrationFact.baseOid,
              candidateOid: integrationFact.headOid
            }
          } : {}
        }
      };
      if (facts.candidate.value && sourceFact) {
        facts.acceptedCard = await readAcceptedCard(
          facts.candidate.value,
          sourceFact.number
        );
      }
      facts.confirmations = confirmationsFrom(facts);
      lastFacts = facts;
      return { status: "ready", provenance: "provider", value: facts };
    } catch (error) {
      const category = error instanceof OctokitOperationError ? error.category : "retryableTransport";
      return {
        status: category === "notVisibleYet" ? "notVisibleYet" : category === "notFound" ? "absent" : category === "permissionDenied" ? "conclusiveFailure" : "incomplete",
        provenance: "provider",
        error: error instanceof Error ? error.message : "provider observation failed"
      };
    }
  };
  const platform = {
    observeRepository,
    async createIntegrationBranch(input, context) {
      activeSignal = context?.signal;
      let response;
      try {
        response = await requestRest(
          {
            method: "POST",
            path: path("/git/refs"),
            parameters: {
              ref: `refs/heads/${input.name}`,
              sha: input.fromMainOid
            }
          },
          "mutation"
        );
      } catch (error) {
        if (error instanceof OctokitOperationError && error.category === "unknownOutcome") {
          try {
            const branch = await readBranch(input.name);
            return { kind: "alreadyApplied", value: { branch } };
          } catch {
          }
        }
        return operationFailure(error);
      }
      if (response.status === 201 || response.status === 200)
        return grantSetupCommentCreatePermit({
          kind: "succeeded",
          value: { branch: branchFromResponse(response.data, input.name) }
        });
      if (response.status === 422) {
        try {
          const branch = await readBranch(input.name);
          return { kind: "alreadyApplied", value: { branch } };
        } catch {
        }
      }
      return operationFailure(response);
    },
    async createIntegrationPullRequest(input, context) {
      activeSignal = context?.signal;
      let response;
      try {
        response = await requestRest(
          {
            method: "POST",
            path: path("/pulls"),
            parameters: {
              title: input.title,
              head: input.branchName,
              base: "main",
              draft: true
            }
          },
          "mutation"
        );
      } catch (error) {
        if (error instanceof OctokitOperationError && error.category === "unknownOutcome") {
          try {
            const response2 = await requestRest(
              {
                method: "GET",
                path: path("/pulls"),
                parameters: {
                  state: "all",
                  head: `${options.owner}:${input.branchName}`,
                  base: "main"
                }
              },
              "read"
            );
            const found = Array.isArray(response2.data) ? response2.data.map(asRecord2).find(
              (item) => stringValue(asRecord2(item.head).ref) === input.branchName
            ) : void 0;
            if (found)
              return grantSetupCommentCreatePermit({
                kind: "alreadyApplied",
                value: { pullRequest: pullRequestFact(found, "integration") }
              });
          } catch {
          }
        }
        return operationFailure(error);
      }
      if (response.status === 201 || response.status === 200)
        return grantSetupCommentCreatePermit({
          kind: "succeeded",
          value: { pullRequest: pullRequestFact(response.data, "integration") }
        });
      return operationFailure(response);
    },
    async updatePullRequestBase(input, context) {
      activeSignal = context?.signal;
      let response;
      try {
        response = await requestRest(
          {
            method: "PATCH",
            path: path(`/pulls/${input.pullRequestNumber}`),
            parameters: { base: input.integrationBranchName }
          },
          "mutation"
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
          value: updated
        });
      }
      return operationFailure(response);
    },
    async markPullRequestReadyForReview(input, context) {
      activeSignal = context?.signal;
      const state = options.readyState ? await options.readyState() : readyStateFromFacts(lastFacts, input);
      if (!state) return { kind: "blocked", reason: "notVisibleYet" };
      const nodeId = state.pullRequest.nodeId ?? options.pullRequestNodeIds?.get(input.pullRequestNumber);
      if (!nodeId) return { kind: "blocked", reason: "notVisibleYet" };
      if (state.pullRequest.headOid !== oid(input.expectedCandidateHeadOid))
        return {
          kind: "headChanged",
          observedHeadOid: state.pullRequest.headOid
        };
      if (!state.pullRequest.draft)
        return {
          kind: "alreadyReadyAtExpectedCandidate",
          pullRequest: state.pullRequest,
          candidate: state.candidate
        };
      const response = await requestGraphql({
        query: "mutation markPullRequestReadyForReview($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { pullRequest { id isDraft headRefOid } } }",
        variables: {
          pullRequestId: nodeId
        }
      });
      const mutation = asRecord2(
        asRecord2(response.data).markPullRequestReadyForReview
      );
      const mutationPr = asRecord2(mutation.pullRequest);
      if (response.errors?.length || Object.keys(mutationPr).length === 0)
        return { kind: "blocked", reason: graphqlCategory(response.errors) };
      const post = await readPullRequest(input.pullRequestNumber);
      if (post.headOid !== oid(input.expectedCandidateHeadOid))
        return { kind: "headChanged", observedHeadOid: post.headOid };
      if (post.draft) return { kind: "blocked", reason: "unknownOutcome" };
      const result = {
        kind: "readyAtExpectedCandidate",
        pullRequest: post,
        candidate: state.candidate
      };
      grantCommentCreatePermit({
        targetPullRequestNumber: input.pullRequestNumber,
        slot: "integration-status",
        phase: "ready-guidance",
        milestone: "ready"
      });
      return result;
    },
    async mergePullRequest(request, context) {
      activeSignal = context?.signal;
      if (request.kind === "integration") return mergeIntegration(request);
      const response = await mergeRequest(
        request.pullRequestNumber,
        request.expectedHeadOid
      );
      if (response.kind === "merged")
        return { kind: "contributionMerged", headOid: response.oid };
      return { kind: "contributionRejected", reason: response.reason };
    },
    async ensureComment(intent, context) {
      activeSignal = context?.signal;
      const expected = options.expectedCommentOwner;
      if (!expected || !validPrincipal(expected))
        return {
          kind: "capabilityUnavailable",
          detail: "expected comment principal is unavailable"
        };
      try {
        const comments = await readIssueComments(
          intent.targetPullRequestNumber
        );
        const matches = comments.filter(
          (comment) => comment.actionKey === intent.actionKey
        );
        if (comments.some(
          (comment) => comment.actionKey === intent.actionKey && comment.targetPullRequestNumber !== intent.targetPullRequestNumber
        ))
          return { kind: "ambiguousOwnership" };
        const owned = matches.filter(
          (comment) => comment.user?.id === expected.actorId && comment.user.actorType === expected.actorType
        );
        if (owned.length > 1 || matches.length > 0 && owned.length !== matches.length)
          return { kind: "ambiguousOwnership" };
        if (commentLifecycle.has(commentLifecycleKey(intent))) {
          return {
            kind: "capabilityUnavailable",
            detail: "comment creation is already reserved in this process"
          };
        }
        const current = owned[0];
        if (current) {
          const read = await readIssueComment(
            current.id,
            intent.targetPullRequestNumber
          );
          if (!sameCommentIdentity(read, current)) return { kind: "stale" };
          if (intent.observed && !sameObservedComment(read, intent.observed))
            return { kind: "stale" };
          if (read.body === intent.body) return { kind: "noOp", comment: read };
          if (!intent.observed) return { kind: "stale" };
          let patched;
          try {
            const response2 = await requestCommentRest(
              {
                method: "PATCH",
                path: apiCommentPath(`/issues/comments/${read.id}`),
                parameters: { body: intent.body }
              },
              [200]
            );
            const materialized = materializeComment(
              response2.data,
              intent.targetPullRequestNumber,
              apiCommentPath,
              true,
              apiOrigin
            );
            if (!materialized) return { kind: "unknownOutcome" };
            patched = materialized;
          } catch (error) {
            if (!isAmbiguousMutation(error)) throw error;
            const recovered = await readIssueComment(
              read.id,
              intent.targetPullRequestNumber
            );
            return sameIntendedComment(recovered, intent, expected) ? { kind: "updated", comment: recovered } : { kind: "unknownOutcome" };
          }
          if (!patched) return { kind: "unknownOutcome" };
          if (patched.body !== intent.body) return { kind: "unknownOutcome" };
          const post = await readIssueComment(
            read.id,
            intent.targetPullRequestNumber
          );
          return sameIntendedComment(post, intent, expected) ? { kind: "updated", comment: post } : { kind: "stale" };
        }
        if (!reserveCommentCreatePermit(intent))
          return {
            kind: "capabilityUnavailable",
            detail: "missing same-process durable milestone for comment creation"
          };
        let response;
        commentLifecycle.add(commentLifecycleKey(intent));
        try {
          response = await requestCommentRest(
            {
              method: "POST",
              path: apiCommentPath(
                `/issues/${intent.targetPullRequestNumber}/comments`
              ),
              parameters: { body: intent.body }
            },
            [201]
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
          apiOrigin
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
            intent.targetPullRequestNumber
          );
          commentLifecycle.delete(commentLifecycleKey(intent));
          return sameIntendedComment(post, intent, expected) ? { kind: "created", comment: post } : { kind: "stale" };
        } catch (error) {
          if (!isVisibilityUncertainty(error)) throw error;
          return await reconcileAmbiguousCreate(intent, expected, error);
        }
      } catch (error) {
        return commentFailure(error);
      }
    }
  };
  return platform;
  async function mergeRequest(number, expectedHeadOid) {
    let response;
    try {
      response = await options.transport.rest({
        method: "PUT",
        path: path(`/pulls/${number}/merge`),
        parameters: { sha: expectedHeadOid, merge_method: "merge" }
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
      const data = asRecord2(response.data);
      const mergeOid = typeof data.sha === "string" && data.sha.length > 0 ? oid(data.sha) : void 0;
      if (data.merged === true && mergeOid) {
        try {
          const readback = await requestRest(
            { method: "GET", path: path(`/pulls/${number}`) },
            "read"
          );
          const pullRequest = asRecord2(readback.data);
          if (pullRequest.merged === true && asRecord2(pullRequest).merge_commit_sha === mergeOid)
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
  async function readPullRequest(number) {
    const response = await requestRest(
      { method: "GET", path: path(`/pulls/${number}`) },
      "read"
    );
    return pullRequestFact(response.data, "integration");
  }
  async function readExactPullRequest(number, kind, summary) {
    const response = await requestRest(
      { method: "GET", path: path(`/pulls/${number}`) },
      "read"
    );
    const record = asRecord2(response.data);
    if (numberValue(record.number) !== number)
      throw new OctokitOperationError(
        "retryableTransport",
        "pull request detail returned a mismatched number"
      );
    if (summary && !samePullRequestIdentity(summary, record))
      throw new OctokitOperationError(
        "retryableTransport",
        "pull request detail does not match discovery summary"
      );
    if (kind === "integration" && (stringValue(asRecord2(record.base).ref) !== "main" || stringValue(asRecord2(record.head).ref) !== stringValue(asRecord2(summary?.head).ref)))
      throw new OctokitOperationError(
        "retryableTransport",
        "exact integration pull request does not target the expected branch and main"
      );
    const fact = pullRequestFact(record, kind, true);
    return {
      fact: fact.merged === true ? await hydrateMergeParents(fact) : fact,
      record
    };
  }
  async function observeSourceAncestry(integrationHeadOid, sourceHeadOid) {
    try {
      const comparePath = path(
        `/compare/${integrationHeadOid}...${sourceHeadOid}`
      );
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: comparePath,
          parameters: { per_page: 100, page: 1 }
        },
        "read"
      );
      const comparison = asRecord2(response.data);
      const status = comparison.status;
      const base = stringValue(asRecord2(comparison.base_commit).sha);
      const headCommitPresent = Object.hasOwn(comparison, "head_commit");
      const head = headCommitPresent ? stringValue(asRecord2(comparison.head_commit).sha) : void 0;
      const mergeBase = stringValue(asRecord2(comparison.merge_base_commit).sha);
      const commits = comparison.commits;
      const totalCommits = comparison.total_commits;
      if (base !== integrationHeadOid || headCommitPresent && head !== sourceHeadOid || !Array.isArray(commits) || typeof totalCommits !== "number" || !Number.isSafeInteger(totalCommits) || totalCommits < commits.length || totalCommits > commits.length && !response.headers?.link)
        return {
          status: "incomplete",
          provenance: "provider",
          error: "incomplete or malformed source ancestry comparison"
        };
      if (status !== "ahead" && status !== "identical" && status !== "behind" && status !== "diverged")
        return {
          status: "incomplete",
          provenance: "provider",
          error: "unknown source ancestry comparison status"
        };
      const commitOids = /* @__PURE__ */ new Set();
      if (!addCompareCommits(commits, commitOids))
        return incompleteAncestry(
          "malformed source ancestry comparison commits"
        );
      let currentPage = 1;
      let next = compareNextLink(
        response.headers?.link,
        apiOrigin,
        comparePath,
        currentPage,
        repositoryId
      );
      const seenLinks = /* @__PURE__ */ new Set();
      let pages = 1;
      while (next !== void 0) {
        if (seenLinks.has(next))
          return incompleteAncestry(
            "source ancestry comparison pagination loop"
          );
        seenLinks.add(next);
        if (++pages > 100)
          return {
            status: "incomplete",
            provenance: "provider",
            error: "source ancestry comparison pagination exceeded budget"
          };
        const nextResponse = await requestLegacyRest(
          {
            method: "GET",
            path: next
          },
          "read"
        );
        const pageComparison = asRecord2(nextResponse.data);
        if (pageComparison.status !== status || stringValue(asRecord2(pageComparison.base_commit).sha) !== base || Object.hasOwn(pageComparison, "head_commit") && stringValue(asRecord2(pageComparison.head_commit).sha) !== sourceHeadOid || stringValue(asRecord2(pageComparison.merge_base_commit).sha) !== mergeBase || pageComparison.total_commits !== totalCommits || typeof pageComparison.total_commits !== "number" || !Number.isSafeInteger(pageComparison.total_commits) || !Array.isArray(pageComparison.commits) || pageComparison.total_commits < pageComparison.commits.length || !addCompareCommits(pageComparison.commits, commitOids))
          return incompleteAncestry(
            "malformed source ancestry comparison page"
          );
        next = compareNextLink(
          nextResponse.headers?.link,
          apiOrigin,
          comparePath,
          currentPage,
          repositoryId
        );
        if (next !== void 0)
          currentPage = Number(
            new URL(`${apiOrigin.origin}${next}`).searchParams.get("page")
          );
      }
      if (commitOids.size !== totalCommits)
        return incompleteAncestry(
          "source ancestry comparison commit count mismatch"
        );
      const finalCommitOid = Array.from(commitOids).pop();
      if (!headCommitPresent && status === "ahead" && finalCommitOid !== sourceHeadOid || status === "identical" && (integrationHeadOid !== sourceHeadOid || totalCommits !== 0) || !headCommitPresent && status !== "ahead" && status !== "identical" || headCommitPresent && head !== sourceHeadOid)
        return incompleteAncestry(
          "source ancestry comparison does not prove requested source head"
        );
      return {
        status: "ready",
        provenance: "provider",
        value: {
          integrationHeadOid,
          sourceHeadOid,
          isAncestor: (status === "ahead" || status === "identical") && mergeBase === integrationHeadOid,
          observedOid: sourceHeadOid,
          provenance: "provider"
        }
      };
    } catch (error) {
      return {
        status: "incomplete",
        provenance: "provider",
        error: error instanceof Error ? error.message : "source ancestry read failed"
      };
    }
  }
  async function readMainProjection(mainOid) {
    const tree = await readTree(mainOid);
    const readme = tree.find(
      (entry) => entry.path === "README.md" && entry.type === "blob"
    );
    if (!readme)
      throw new OctokitOperationError(
        "notVisibleYet",
        "main README is not visible"
      );
    const cardEntries = tree.filter(
      (entry) => entry.type === "blob" && typeof entry.path === "string" && /^people\/[A-Za-z0-9-]+\.md$/u.test(entry.path)
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
          bytes
        };
      })
    );
    return {
      oid: mainOid,
      readmeBytes,
      cardManifests: cardPayloads.map(
        ({ bytes: _bytes, ...manifest }) => manifest
      ),
      cardPayloads
    };
  }
  async function readCandidate(source, integration, mainOid) {
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
        provenance: "provider"
      }
    };
  }
  async function readSourceIntake(source, fact) {
    const author = asRecord2(source.user);
    const head = asRecord2(source.head);
    const repository = asRecord2(head.repo);
    const authorGithubId = author.id === void 0 ? void 0 : canonicalActorId2(author.id);
    if (author.id !== void 0 && authorGithubId === void 0)
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed contributor identity"
      );
    if (typeof repository.owner !== "object" || typeof asRecord2(repository.owner).login !== "string" || typeof repository.fork !== "boolean")
      return hydrateMergeParents(fact);
    const files = await paginateChangedFiles(fact.number);
    return hydrateMergeParents({
      ...fact,
      ...authorGithubId ? { authorGithubId } : {},
      headRepositoryOwnerLogin: stringValue(asRecord2(repository.owner).login),
      headRepositoryIsFork: repository.fork === true,
      changedFiles: await Promise.all(
        files.map(async (file) => {
          const path2 = stringValue(file.filename);
          const blobOid = oid(stringValue(file.sha));
          return { path: path2, blobOid, bytes: await readBlob(blobOid) };
        })
      ),
      changedFilesComplete: true
    });
  }
  async function hydrateMergeParents(fact) {
    if (!fact.merged || !fact.mergeCommitOid) return fact;
    const response = await requestRest(
      { method: "GET", path: path(`/git/commits/${fact.mergeCommitOid}`) },
      "read"
    );
    const commit = asRecord2(response.data);
    if (stringValue(commit.sha) !== fact.mergeCommitOid)
      throw new OctokitOperationError(
        "retryableTransport",
        "merge commit response does not match pull request merge SHA"
      );
    const parents = commit.parents;
    if (!Array.isArray(parents))
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed merge parents"
      );
    const mergeParentOids = parents.map(
      (parent) => oid(stringValue(asRecord2(parent).sha))
    );
    if (mergeParentOids.length !== 2 || mergeParentOids[0] !== fact.baseOid || mergeParentOids[1] !== fact.headOid)
      throw new OctokitOperationError(
        "retryableTransport",
        "merge parents do not match pull request base and head"
      );
    return { ...fact, mergeParentOids };
  }
  async function paginateChangedFiles(number) {
    const all = [];
    let page = 1;
    for (; ; ) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path(`/pulls/${number}/files`),
          parameters: { per_page: 100, page }
        },
        "read"
      );
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed changed-files page"
        );
      const files = response.data.map(asRecord2);
      all.push(...files);
      const nextPage = legacyNextPage(response);
      if (!nextPage && files.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }
  async function readReviews(integration) {
    const reviews = await paginateRecords(
      `/pulls/${integration.number}/reviews`
    );
    const mapped = reviews.map((value) => {
      const review = asRecord2(value);
      const state = reviewState(stringValue(review.state));
      if (!state)
        throw new OctokitOperationError(
          "retryableTransport",
          "unknown review state"
        );
      return {
        pullRequestNumber: integration.number,
        prHeadOid: integration.headOid,
        reviewerLogin: stringValue(asRecord2(review.user).login),
        state,
        reviewedCommitOid: oid(stringValue(review.commit_id)),
        observedOid: integration.headOid,
        provenance: "provider"
      };
    });
    return {
      status: "ready",
      provenance: "provider",
      value: mapped
    };
  }
  async function observeEligibility(read) {
    try {
      return await read();
    } catch (error) {
      return {
        status: "incomplete",
        provenance: "provider",
        error: error instanceof Error ? error.message : "malformed eligibility fact"
      };
    }
  }
  async function readChecks(integration) {
    const checks = await paginateCheckRuns(integration.headOid);
    const states = checks.map((value) => ({
      state: checkState(asRecord2(value)),
      head: asRecord2(value).head_sha
    }));
    if (states.some(
      ({ state, head }) => state === void 0 || head !== integration.headOid
    ))
      return {
        status: "incomplete",
        provenance: "provider",
        error: "malformed check state"
      };
    return {
      status: "ready",
      provenance: "provider",
      value: states.flatMap(({ state }) => {
        if (state === void 0) return [];
        return [
          {
            pullRequestNumber: integration.number,
            prHeadOid: integration.headOid,
            state,
            observedOid: integration.headOid,
            provenance: "provider"
          }
        ];
      })
    };
  }
  async function paginateRecords(pathSuffix) {
    const all = [];
    let page = 1;
    for (; ; ) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path(pathSuffix),
          parameters: { per_page: 100, page }
        },
        "read"
      );
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed paginated page"
        );
      all.push(...response.data.map(asRecord2));
      const nextPage = legacyNextPage(response);
      if (!nextPage && response.data.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }
  async function paginateCheckRuns(headOid) {
    const all = [];
    let page = 1;
    for (; ; ) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path(`/commits/${headOid}/check-runs`),
          parameters: { per_page: 100, page }
        },
        "read"
      );
      const checks = asRecord2(response.data).check_runs;
      if (!Array.isArray(checks))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed checks"
        );
      all.push(...checks.map(asRecord2));
      const nextPage = legacyNextPage(response);
      if (!nextPage && checks.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }
  async function readTree(commitOid) {
    const response = await requestRest(
      {
        method: "GET",
        path: path(`/git/trees/${commitOid}`),
        parameters: { recursive: 1 }
      },
      "read"
    );
    const tree = asRecord2(response.data).tree;
    if (!Array.isArray(tree))
      throw new OctokitOperationError("retryableTransport", "malformed tree");
    return tree.map(asRecord2);
  }
  async function readBlob(blobOid) {
    const response = await requestRest(
      { method: "GET", path: path(`/git/blobs/${blobOid}`) },
      "read"
    );
    const raw = asRecord2(response.data);
    if (raw.encoding !== "base64")
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed blob encoding"
      );
    const content = stringValue(raw.content);
    const bytes = Buffer.from(content, "base64");
    if (bytes.length === 0 && content.length > 0)
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed blob content"
      );
    return new Uint8Array(bytes);
  }
  async function readAcceptedCard(candidate, sourcePrNumber) {
    const bytes = await readBlob(candidate.cardBlobOid);
    return {
      path: candidate.cardPath,
      bytes,
      githubId: cardMetadata(bytes).githubId,
      sourcePrNumber
    };
  }
  async function paginatePullRequests() {
    const all = [];
    const seen = /* @__PURE__ */ new Set();
    let page = 1;
    for (; ; ) {
      const response = await requestLegacyRest(
        {
          method: "GET",
          path: path("/pulls"),
          parameters: { state: "all", per_page: 100, page }
        },
        "read"
      );
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "retryableTransport",
          "malformed pagination page"
        );
      const values = response.data.map(asRecord2);
      for (const value of values) {
        const number = numberValue(value.number);
        if (seen.has(number))
          throw new OctokitOperationError(
            "retryableTransport",
            "pagination overlap"
          );
        seen.add(number);
        all.push(value);
      }
      const nextPage = legacyNextPage(response);
      if (!nextPage && values.length < 100) return all;
      page = nextPage ?? page + 1;
    }
  }
  async function readCommentsForTargets(targets) {
    const comments = await Promise.all(targets.map(readIssueComments));
    return comments.flat();
  }
  async function readIssueComments(pullRequestNumber) {
    const all = [];
    const seenUrls = /* @__PURE__ */ new Set();
    let request = {
      method: "GET",
      path: apiCommentPath(`/issues/${pullRequestNumber}/comments`),
      parameters: { per_page: 100, page: 1 },
      headers: { "cache-control": "no-cache" }
    };
    for (let page = 0; page < COMMENT_PAGE_BUDGET; page += 1) {
      const response = await requestCommentRest(request, [200], "read");
      if (!Array.isArray(response.data))
        throw new OctokitOperationError(
          "unknownOutcome",
          "malformed issue comments page"
        );
      for (const value of response.data) {
        const comment = materializeComment(
          value,
          pullRequestNumber,
          apiCommentPath,
          false,
          apiOrigin
        );
        if (comment) all.push(comment);
      }
      const next = nextCommentPage(
        response.headers?.link,
        request,
        pullRequestNumber,
        apiCommentPath,
        apiOrigin,
        repositoryId
      );
      if (next.kind === "terminal") return deduplicateComments(all);
      if (next.kind === "malformed")
        throw new OctokitOperationError(
          "unknownOutcome",
          "malformed issue comments Link header"
        );
      if (seenUrls.has(next.url))
        throw new OctokitOperationError(
          "unknownOutcome",
          "cyclic issue comments pagination"
        );
      seenUrls.add(next.url);
      request = {
        method: "GET",
        path: next.url,
        headers: { "cache-control": "no-cache" }
      };
    }
    throw new OctokitOperationError(
      "unknownOutcome",
      "issue comments pagination budget exhausted"
    );
  }
  async function readIssueComment(commentId, pullRequestNumber) {
    const response = await requestCommentRest(
      {
        method: "GET",
        path: apiCommentPath(`/issues/comments/${commentId}`),
        headers: { "cache-control": "no-cache" }
      },
      [200],
      "read"
    );
    const comment = materializeComment(
      response.data,
      pullRequestNumber,
      apiCommentPath,
      true,
      apiOrigin
    );
    if (!comment)
      throw new OctokitOperationError(
        "unknownOutcome",
        "comment is not controlled"
      );
    if (comment.id !== commentId)
      throw new OctokitOperationError(
        "unknownOutcome",
        `comment read returned ID ${comment.id}, expected ${commentId}`
      );
    return comment;
  }
  async function reconcileAmbiguousCreate(intent, expected, cause) {
    const attempts = boundedReadbackAttempts(commentReadback.attempts);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const comments = await readIssueComments(
          intent.targetPullRequestNumber
        );
        const matches = comments.filter(
          (comment) => comment.actionKey === intent.actionKey
        );
        const conflicts = matches.filter(
          (comment) => comment.body !== intent.body || comment.user?.id !== expected.actorId || comment.user.actorType !== expected.actorType || comment.targetPullRequestNumber !== intent.targetPullRequestNumber
        );
        const exact = matches.filter(
          (comment) => comment.body === intent.body && comment.user?.id === expected.actorId && comment.user.actorType === expected.actorType && comment.targetPullRequestNumber === intent.targetPullRequestNumber
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
      detail: `${cause instanceof OctokitOperationError ? cause.message : "comment response was ambiguous"}; comment may still be converging`
    };
  }
  async function requestCommentRest(request, statuses, operation = "mutation") {
    try {
      const response = await options.transport.rest({
        ...request,
        ...activeSignal ? { signal: activeSignal } : {}
      });
      if (statuses.includes(response.status)) return response;
      throw new OctokitOperationError(
        commentErrorCategory(response.status, operation, response.headers),
        `REST ${request.path} returned ${response.status}${retryMetadata(response)}`
      );
    } catch (error) {
      if (error instanceof OctokitOperationError) throw error;
      throw new OctokitOperationError(
        operation === "mutation" ? "unknownOutcome" : "retryableTransport",
        `comment ${operation} transport failed`
      );
    }
  }
  function grantSetupCommentCreatePermit(result) {
    const source = (lastFacts ?? options.initialFacts)?.sourcePullRequest.value;
    if (source)
      grantCommentCreatePermit({
        targetPullRequestNumber: source.number,
        slot: "source-status",
        phase: "setup",
        milestone: "setup"
      });
    return result;
  }
  function grantCommentCreatePermit(input) {
    const source = (lastFacts ?? options.initialFacts)?.sourcePullRequest.value;
    if (!source?.authorGithubId) return;
    commentCreatePermits.push({
      runIdentity: `source:${source.number}:${source.authorGithubId}`,
      ...input
    });
  }
  function reserveCommentCreatePermit(intent) {
    if (intent.phase === "completion") return false;
    const key2 = parseCommentActionKey(intent.actionKey);
    const index = commentCreatePermits.findIndex(
      (permit) => key2 !== void 0 && key2.runIdentity === permit.runIdentity && key2.targetPullRequestNumber === permit.targetPullRequestNumber && key2.slot === permit.slot && intent.targetPullRequestNumber === permit.targetPullRequestNumber && intent.slot === permit.slot && intent.phase === permit.phase && milestoneForCommentPhase(intent.phase) === permit.milestone
    );
    if (index < 0) return false;
    commentCreatePermits.splice(index, 1);
    return true;
  }
  async function findIntegrationBranch(expectedName) {
    const response = await requestRest(
      { method: "GET", path: path("/git/matching-refs/heads/feature/card-") },
      "read"
    );
    if (!Array.isArray(response.data))
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed branch refs"
      );
    const value = response.data.map(asRecord2).find((item) => {
      const ref2 = item.ref;
      return typeof ref2 === "string" && ref2.startsWith("refs/heads/feature/card-") && (!expectedName || ref2 === `refs/heads/${expectedName}`);
    });
    if (!value) return void 0;
    const ref = stringValue(value.ref).replace(/^refs\/heads\//u, "");
    return {
      name: ref,
      headOid: oid(stringValue(asRecord2(value.object).sha)),
      provenance: "provider"
    };
  }
  async function readBranch(name) {
    const response = await requestRest(
      { method: "GET", path: path(`/git/ref/heads/${name}`) },
      "read"
    );
    return branchFromResponse(response.data, name);
  }
  async function requestRest(request, operation) {
    try {
      const response = await options.transport.rest({
        ...request,
        ...activeSignal ? { signal: activeSignal } : {}
      });
      if (response.status >= 200 && response.status < 300) return response;
      throw new OctokitOperationError(
        errorCategory(response),
        `REST ${request.path} returned ${response.status}`
      );
    } catch (error) {
      if (error instanceof OctokitOperationError) throw error;
      if (options.replay) throw error;
      throw new OctokitOperationError(
        operation === "mutation" ? "unknownOutcome" : "retryableTransport",
        "transport failed"
      );
    }
  }
  async function requestLegacyRest(request, operation) {
    return await requestRest(request, operation);
  }
  async function requestGraphql(request) {
    try {
      return await options.transport.graphql({
        ...request,
        ...activeSignal ? { signal: activeSignal } : {}
      });
    } catch (error) {
      if (options.replay) throw error;
      throw new OctokitOperationError(
        "unknownOutcome",
        "GraphQL transport failed"
      );
    }
  }
}
function milestoneForCommentPhase(phase) {
  if (phase === "setup") return "setup";
  if (phase === "ready-guidance") return "ready";
  return void 0;
}
var COMMENT_PAGE_BUDGET = 8;
function normalizeApiOrigin(value) {
  const parsed = new URL(value ?? "https://api.github.com");
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  parsed.pathname = pathname === "/" ? "" : pathname;
  return parsed;
}
function trustedApiPath(origin) {
  return origin.pathname === "/" ? "" : origin.pathname.replace(/\/+$/u, "");
}
function boundedReadbackAttempts(value) {
  return Math.min(Math.max(value ?? 3, 1), 8);
}
function commentLifecycleKey(intent) {
  return `${intent.targetPullRequestNumber}:${intent.actionKey}`;
}
function parseCommentActionKey(value) {
  const match = /^run=([^;]+);target=([1-9][0-9]*);slot=(source-status|integration-status)$/u.exec(
    value
  );
  if (!match?.[1] || !match[2] || !match[3]) return void 0;
  const targetPullRequestNumber = Number(match[2]);
  return Number.isSafeInteger(targetPullRequestNumber) ? {
    runIdentity: match[1],
    targetPullRequestNumber,
    slot: match[3]
  } : void 0;
}
async function waitForCommentReadback(options) {
  if (!options?.sleep) return;
  await options.sleep(options.delayMs ?? 0);
}
function readyStateFromFacts(facts, input) {
  const pullRequest = facts?.integrationPullRequest.value;
  const candidate = facts?.candidate.value;
  return pullRequest && candidate && pullRequest.number === input.pullRequestNumber ? { pullRequest, candidate } : void 0;
}
function activeIdentityIds(pages, source) {
  return pages.filter(
    (item) => item !== source && stringValue(asRecord2(item.head).ref).startsWith("add/") && item.state !== "closed"
  ).map((item) => {
    const rawId = asRecord2(item.user).id;
    if (rawId === void 0) return void 0;
    const id = canonicalActorId2(rawId);
    if (id === void 0)
      throw new OctokitOperationError(
        "retryableTransport",
        "malformed active contributor identity"
      );
    return id;
  }).filter((id) => id !== void 0);
}
function legacyNextPage(response) {
  const page = response.nextPage;
  return typeof page === "number" && Number.isSafeInteger(page) && page > 0 ? page : void 0;
}
function incompleteAncestry(error) {
  return { status: "incomplete", provenance: "provider", error };
}
function addCompareCommits(commits, seen) {
  for (const item of commits) {
    const sha = asRecord2(item).sha;
    if (typeof sha !== "string" || sha.length === 0 || seen.has(sha))
      return false;
    seen.add(sha);
  }
  return true;
}
function compareNextLink(header, origin, comparePath, currentPage, repositoryId) {
  if (header === void 0) return void 0;
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
  const nextLinks = relations.flatMap(
    (entry) => entry.rels.filter((rel) => rel.toLowerCase() === "next").map(() => entry.url)
  );
  if (nextLinks.length > 1) throw new Error("malformed compare Link header");
  for (const relation of relations) {
    const url2 = new URL(relation.url, origin);
    if (url2.origin !== origin.origin || !compareLinkPath(url2.pathname, origin, comparePath, repositoryId))
      throw new Error("untrusted compare Link header");
    const page = url2.searchParams.get("page");
    const perPage = url2.searchParams.get("per_page");
    if (!page || !perPage || !/^[1-9][0-9]*$/u.test(page) || perPage !== "100" || url2.searchParams.getAll("page").length !== 1 || url2.searchParams.getAll("per_page").length !== 1 || [...url2.searchParams.keys()].some(
      (key2) => key2 !== "page" && key2 !== "per_page"
    ))
      throw new Error("malformed compare Link query");
    if (relation.rels.some((rel) => rel.toLowerCase() === "next") && Number(page) <= currentPage)
      throw new Error("nonprogressing compare Link");
  }
  if (nextLinks.length === 0) return void 0;
  const nextLink = nextLinks[0];
  if (!nextLink) return void 0;
  const url = new URL(nextLink, origin);
  const apiPath = trustedApiPath(origin);
  return `${url.pathname.slice(apiPath.length)}?${url.searchParams.toString()}`;
}
function compareLinkPath(pathname, origin, comparePath, repositoryId) {
  const apiPath = trustedApiPath(origin);
  if (pathname === `${apiPath}${comparePath}`) return true;
  if (repositoryId === void 0) return false;
  const suffix = comparePath.match(
    /^\/repos\/[^/]+\/[^/]+(\/compare\/.*)$/u
  )?.[1];
  return suffix !== void 0 && pathname === `${apiPath}/repositories/${repositoryId}${suffix}`;
}
function pullRequestFact(value, kind, exact = false) {
  const record = asRecord2(value);
  if (exact) validateExactPullRequestLifecycle(record);
  return {
    number: numberValue(record.number),
    ...typeof record.node_id === "string" ? { nodeId: record.node_id } : {},
    kind,
    headOid: oid(stringValue(asRecord2(record.head).sha)),
    baseOid: oid(stringValue(asRecord2(record.base).sha)),
    ...typeof asRecord2(record.head).ref === "string" ? { headRef: stringValue(asRecord2(record.head).ref) } : {},
    ...typeof asRecord2(record.base).ref === "string" ? { baseRef: stringValue(asRecord2(record.base).ref) } : {},
    draft: record.draft === true,
    ...record.merged === true || record.merged === false ? { merged: record.merged } : {},
    ...record.state === "closed" ? { closed: true } : {},
    ...record.merged === true && typeof record.merge_commit_sha === "string" && record.merge_commit_sha.length > 0 ? { mergeCommitOid: oid(record.merge_commit_sha) } : {},
    ...record.merged === true && Array.isArray(record.merge_commit_parents) ? {
      mergeParentOids: record.merge_commit_parents.filter((value2) => typeof value2 === "string").map(oid)
    } : {},
    ...typeof asRecord2(record.user).login === "string" ? { authorLogin: stringValue(asRecord2(record.user).login) } : {},
    ...typeof asRecord2(record.head).ref === "string" ? {
      runKey: `${stringValue(asRecord2(record.head).ref)}:${numberValue(record.number)}`
    } : {},
    observedOid: oid(stringValue(asRecord2(record.head).sha)),
    provenance: "provider"
  };
}
function samePullRequestIdentity(summary, exact) {
  return numberValue(summary.number) === numberValue(exact.number) && stringValue(asRecord2(summary.head).sha) === stringValue(asRecord2(exact.head).sha) && stringValue(asRecord2(summary.head).ref) === stringValue(asRecord2(exact.head).ref) && stringValue(asRecord2(summary.base).sha) === stringValue(asRecord2(exact.base).sha) && stringValue(asRecord2(summary.base).ref) === stringValue(asRecord2(exact.base).ref);
}
function validateExactPullRequestLifecycle(record) {
  if (record.state !== "open" && record.state !== "closed")
    throw new OctokitOperationError(
      "retryableTransport",
      "malformed pull request state"
    );
  if (typeof record.merged !== "boolean")
    throw new OctokitOperationError(
      "retryableTransport",
      "exact pull request merged state is required"
    );
  const mergedAt = record.merged_at;
  const mergeCommitSha = record.merge_commit_sha;
  if (record.state === "open" && (record.merged || !absentOrNull(mergedAt) || mergeCommitSha !== void 0 && mergeCommitSha !== null && (typeof mergeCommitSha !== "string" || mergeCommitSha.length === 0)))
    throw new OctokitOperationError(
      "retryableTransport",
      "malformed open pull request lifecycle"
    );
  if (record.state !== "closed") return;
  if (!(typeof mergedAt === "string" || mergedAt === null) || !(typeof mergeCommitSha === "string" || mergeCommitSha === null) || record.merged && (typeof mergedAt !== "string" || !validTimestamp(mergedAt) || typeof mergeCommitSha !== "string" || mergeCommitSha.length === 0) || !record.merged && (mergedAt !== null || mergeCommitSha !== null))
    throw new OctokitOperationError(
      "retryableTransport",
      "malformed closed pull request lifecycle"
    );
}
function absentOrNull(value) {
  return value === void 0 || value === null;
}
function validTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
    value
  );
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match;
  if (year === void 0 || month === void 0 || day === void 0 || hour === void 0 || minute === void 0 || second === void 0)
    return false;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const daysInMonth = new Date(
    Date.UTC(yearNumber, monthNumber, 0)
  ).getUTCDate();
  return monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1 && dayNumber <= daysInMonth && hourNumber >= 0 && hourNumber <= 23 && minuteNumber >= 0 && minuteNumber <= 59 && secondNumber >= 0 && secondNumber <= 59 && !Number.isNaN(Date.parse(value));
}
function mergeabilityObservation(record) {
  if (record.mergeable === true || record.mergeable === false)
    return {
      status: "ready",
      provenance: "provider",
      value: record.mergeable ? "mergeable" : null
    };
  return {
    status: "incomplete",
    provenance: "provider",
    error: "exact integration pull request mergeability is incomplete"
  };
}
function reviewState(value) {
  if (value.toLowerCase() === "approved") return "approved";
  if (value.toLowerCase() === "changes_requested") return "changesRequested";
  if (value.toLowerCase() === "dismissed") return "dismissed";
  if (value.toLowerCase() === "commented") return "commented";
  return void 0;
}
function checkState(check) {
  if (check.status === "queued") return "queued";
  if (check.status === "in_progress") return "inProgress";
  if (check.status !== "completed") return void 0;
  if (check.conclusion === "success") return "success";
  if (typeof check.conclusion === "string") return "failure";
  return void 0;
}
function cardMetadata(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OctokitOperationError("retryableTransport", "invalid Card UTF-8");
  }
  const githubId = /^github_id: (\d+)$/m.exec(text)?.[1];
  const sourcePr = /^source_pr: (\d+)$/m.exec(text)?.[1];
  if (!githubId || !canonicalActorId2(githubId) || !sourcePr)
    throw new OctokitOperationError(
      "retryableTransport",
      "Card metadata is required"
    );
  return { githubId, sourcePrNumber: Number(sourcePr) };
}
function confirmationsFrom(facts) {
  const source = facts.sourcePullRequest.value;
  const integration = facts.integrationPullRequest.value;
  const candidate = facts.candidate.value;
  const reviews = facts.eligibility.reviews;
  const card = facts.acceptedCard;
  if (!source?.authorLogin || !integration || !candidate || !card || reviews.status !== "ready")
    return [];
  const contributorLogin = source.authorLogin;
  return (reviews.value ?? []).filter(
    (review) => review.pullRequestNumber === integration.number && review.prHeadOid === integration.headOid && review.reviewerLogin === contributorLogin && review.state === "approved" && review.reviewedCommitOid === integration.headOid
  ).map((review) => ({
    kind: "domainConfirmation",
    contributorLogin,
    githubId: card.githubId,
    sourcePrNumber: source.number,
    integrationPrNumber: integration.number,
    reviewedCommitOid: review.reviewedCommitOid,
    cardPath: candidate.cardPath,
    cardBlobOid: candidate.cardBlobOid
  }));
}
function branchFromResponse(value, name) {
  const record = asRecord2(value);
  return {
    name,
    headOid: oid(stringValue(asRecord2(record.object).sha ?? record.sha)),
    provenance: "provider"
  };
}
function operationFailure(error) {
  if (error instanceof OctokitOperationError) {
    const kind = error.category === "gone" ? "unknownOutcome" : error.category;
    return { kind, detail: error.message };
  }
  return {
    kind: "unknownOutcome",
    detail: "provider operation failed"
  };
}
function errorCategory(response) {
  if (response.status === 403)
    return response.headers?.["x-ratelimit-remaining"] === "0" ? "rateLimited" : "permissionDenied";
  if (response.status === 404) {
    const rawMessage = asRecord2(response.data).message;
    const message = typeof rawMessage === "string" ? rawMessage : "";
    return message.toLowerCase().includes("accessible") ? "notVisibleYet" : "notFound";
  }
  if (response.status === 409) return "stalePrecondition";
  if (response.status === 405) return "policyRejected";
  if (response.status === 422) return "policyRejected";
  if (response.status === 429) return "rateLimited";
  return response.status >= 500 ? "retryableTransport" : "unknownOutcome";
}
function graphqlCategory(errors) {
  const message = errors?.map((error) => error.message).join(" ").toLowerCase() ?? "";
  if (message.includes("rate")) return "rateLimited";
  if (message.includes("permission") || message.includes("forbidden"))
    return "permissionDenied";
  if (message.includes("not found")) return "notFound";
  return "unknownOutcome";
}
function validPrincipal(value) {
  return /^[1-9][0-9]*$/u.test(value.actorId) && (value.actorType === "Bot" || value.actorType === "User");
}
function materializeComment(value, targetPullRequestNumber, repositoryPath, requireControlled, trustedOrigin) {
  const record = asRecord2(value);
  const id = safeInteger(record.id);
  const user = asRecord2(record.user);
  const userId = canonicalActorId2(user.id);
  const actorType = user.type;
  const body = record.body;
  const issueUrl = record.issue_url;
  if (id === void 0 || userId === void 0 || Object.keys(user).length === 0 || actorType !== "Bot" && actorType !== "User" || typeof body !== "string" || typeof issueUrl !== "string" || !commentTargetsPullRequest(
    issueUrl,
    targetPullRequestNumber,
    repositoryPath,
    trustedOrigin
  ))
    throw new OctokitOperationError(
      "unknownOutcome",
      "malformed or wrong-target issue comment"
    );
  const marker = /^<!-- hello-from-main: key=([^\s]+) phase=(setup|validation-feedback|validation-success|ready-guidance|completion) -->/u.exec(
    body
  );
  if (!marker?.[1]) {
    if (!requireControlled) return void 0;
    throw new OctokitOperationError(
      "unknownOutcome",
      "issue comment marker is required"
    );
  }
  let actionKey;
  try {
    actionKey = decodeURIComponent(marker[1]);
  } catch {
    throw new OctokitOperationError(
      "unknownOutcome",
      "issue comment marker is malformed"
    );
  }
  const updatedAt = typeof record.updated_at === "string" ? record.updated_at : void 0;
  return {
    id,
    user: {
      id: userId,
      actorType,
      ...typeof user.login === "string" ? { login: user.login } : {}
    },
    ownerPrincipal: { actorId: userId, actorType },
    actionKey,
    body,
    ...updatedAt ? { updatedAt } : {},
    targetPullRequestNumber
  };
}
function safeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : void 0;
}
function canonicalActorId2(value) {
  if (typeof value === "string")
    return /^[1-9][0-9]*$/u.test(value) ? value : void 0;
  const number = safeInteger(value);
  return number === void 0 ? void 0 : String(number);
}
function commentTargetsPullRequest(issueUrl, target, repositoryPath, trustedOrigin) {
  try {
    const url = new URL(issueUrl);
    return url.origin === trustedOrigin.origin && url.pathname === `${trustedApiPath(trustedOrigin)}${repositoryPath(`/issues/${target}`)}`;
  } catch {
    return false;
  }
}
function sameCommentIdentity(left, right) {
  return left.id === right.id && left.targetPullRequestNumber === right.targetPullRequestNumber && left.actionKey === right.actionKey && left.ownerPrincipal.actorId === right.ownerPrincipal.actorId && left.ownerPrincipal.actorType === right.ownerPrincipal.actorType;
}
function sameObservedComment(left, right) {
  return sameCommentIdentity(left, right) && left.body === right.body;
}
function sameIntendedComment(comment, intent, expected) {
  return comment.targetPullRequestNumber === intent.targetPullRequestNumber && comment.actionKey === intent.actionKey && comment.body === intent.body && comment.ownerPrincipal.actorId === expected.actorId && comment.ownerPrincipal.actorType === expected.actorType;
}
function deduplicateComments(comments) {
  const byId = /* @__PURE__ */ new Map();
  for (const comment of comments) {
    const existing = byId.get(comment.id);
    if (!existing) {
      byId.set(comment.id, comment);
      continue;
    }
    if (!sameObservedComment(existing, comment))
      throw new OctokitOperationError(
        "unknownOutcome",
        "conflicting duplicate issue comment"
      );
  }
  return [...byId.values()];
}
function nextCommentPage(raw, current, target, repositoryPath, trustedOrigin, repositoryId) {
  if (raw === void 0) return { kind: "terminal" };
  if (raw.trim().length === 0) return { kind: "malformed" };
  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !/^<[^<>]+>\s*;\s*rel="[^"]+"$/u.test(entry)))
    return { kind: "malformed" };
  const relations = entries.map((entry) => {
    const match = /^<([^<>]+)>\s*;\s*rel="([^"]+)"$/u.exec(entry);
    return match?.[1] && match[2] ? { url: match[1], rels: match[2].split(/\s+/u) } : void 0;
  });
  if (relations.some((entry) => !entry)) return { kind: "malformed" };
  const next = relations.flatMap(
    (entry) => entry?.rels.map((rel) => ({ url: entry.url, rel })) ?? []
  );
  const nextLinks = next.filter((entry) => entry.rel.toLowerCase() === "next");
  if (nextLinks.length === 0) return { kind: "malformed" };
  if (nextLinks.length !== 1 || !nextLinks[0]?.url)
    return { kind: "malformed" };
  if (next.some(
    (entry) => entry.rel.toLowerCase() === "next" && entry.url !== nextLinks[0]?.url
  ))
    return { kind: "malformed" };
  try {
    const url = new URL(nextLinks[0].url);
    const currentUrl = new URL(
      typeof current.path === "string" && current.path.startsWith("http") ? current.path : `${trustedOrigin.origin}${current.path.startsWith(trustedApiPath(trustedOrigin)) ? current.path : `${trustedApiPath(trustedOrigin)}${current.path}`}`
    );
    if (url.origin !== trustedOrigin.origin || currentUrl.origin !== trustedOrigin.origin || !trustedCommentListPath(
      url.pathname,
      target,
      repositoryPath,
      trustedOrigin,
      repositoryId
    ) || !positiveInteger(url.searchParams.get("page")) || !positiveInteger(currentUrl.searchParams.get("page") ?? "1") || Number(url.searchParams.get("page")) <= Number(currentUrl.searchParams.get("page") ?? "1"))
      return { kind: "malformed" };
    return { kind: "next", url: url.toString() };
  } catch {
    return { kind: "malformed" };
  }
}
function trustedCommentListPath(pathname, target, repositoryPath, trustedOrigin, repositoryId) {
  const apiPath = trustedApiPath(trustedOrigin);
  if (pathname === `${apiPath}${repositoryPath(`/issues/${target}/comments`)}`)
    return true;
  return repositoryId !== void 0 && pathname === `${apiPath}/repositories/${repositoryId}/issues/${target}/comments`;
}
function positiveInteger(value) {
  return value !== null && /^[1-9][0-9]*$/u.test(value);
}
function commentErrorCategory(status, operation, headers) {
  if (status === 429 || status === 403 && (headers?.["x-ratelimit-remaining"] === "0" || headers?.["retry-after"] !== void 0 || headers?.["x-ratelimit-reset"] !== void 0))
    return "rateLimited";
  if (status === 401 || status === 403) return "permissionDenied";
  if (status === 404)
    return operation === "mutation" ? "notFound" : "notVisibleYet";
  if (status === 410) return "gone";
  if (status === 422) return "policyRejected";
  if (status >= 500) return "retryableTransport";
  return "unknownOutcome";
}
function retryMetadata(response) {
  const headers = response.headers ?? {};
  const values = [
    "retry-after",
    "x-ratelimit-reset",
    "x-ratelimit-remaining"
  ].flatMap((key2) => headers[key2] ? [` ${key2}=${headers[key2]}`] : []);
  return values.length > 0 ? ` (${values.join(",")})` : "";
}
function isAmbiguousMutation(error) {
  return error instanceof OctokitOperationError && (error.category === "unknownOutcome" || error.category === "retryableTransport");
}
function isVisibilityUncertainty(error) {
  return error instanceof OctokitOperationError && (error.category === "notVisibleYet" || error.category === "unknownOutcome" || error.category === "retryableTransport");
}
function commentFailure(error) {
  if (error instanceof OctokitOperationError) {
    if (error.category === "permissionDenied")
      return { kind: "permissionDenied", detail: error.message };
    if (error.category === "notVisibleYet")
      return { kind: "notVisibleYet", detail: error.message };
    if (error.category === "gone" || error.category === "policyRejected")
      return { kind: "capabilityUnavailable", detail: error.message };
    if (error.category === "stalePrecondition") return { kind: "stale" };
    if (error.category === "retryableTransport" || error.category === "rateLimited")
      return { kind: "retryableTransport", detail: error.message };
    return { kind: "unknownOutcome", detail: error.message };
  }
  return { kind: "unknownOutcome", detail: "comment operation failed" };
}
function asRecord2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function stringValue(value) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("provider response string is required");
  return value;
}
function numberValue(value) {
  if (typeof value !== "number")
    throw new Error("provider response number is required");
  return value;
}

// src/render/bytes.ts
var utf8Decoder = new TextDecoder("utf-8", { fatal: true });
var utf8Encoder = new TextEncoder();
function encodeUtf8(value) {
  return utf8Encoder.encode(value);
}
function decodeUtf8(value) {
  return utf8Decoder.decode(value);
}

// src/render/card.ts
var PROJECT_SHELL_NICKNAME = "Project shell";
var PROJECT_SHELL_EXPLORING = "Git metadata";
var PROJECT_SHELL_MESSAGE = "Project source metadata";
function renderProjectShellBytes(input) {
  return renderCardBytes(
    {
      path: input.path,
      metadata: {
        github: input.github,
        githubId: input.githubId,
        sourcePr: input.sourcePr,
        avatar: input.avatar ?? `https://avatars.githubusercontent.com/u/${input.githubId}?v=4`
      },
      contributor: {
        nickname: PROJECT_SHELL_NICKNAME,
        exploring: PROJECT_SHELL_EXPLORING,
        message: PROJECT_SHELL_MESSAGE
      }
    },
    {
      fieldLimits: { nickname: 80, exploring: 200, message: 200 },
      templateTexts: [],
      isAllowedText: () => true
    }
  );
}
function reject(reason) {
  return { ok: false, error: { kind: "invalidCard", reason } };
}
function inputText(input) {
  return typeof input === "string" ? input : decodeUtf8(input);
}
function hasForbiddenText(value) {
  return hasForbiddenControlCharacters(value) || /(?:<<<<<<<|=======|>>>>>>>)/u.test(value) || /!?(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)/iu.test(value) || /<\/?[A-Za-z][^>]*>/u.test(value) || /[`*_~]/u.test(value);
}
function hasForbiddenStructure(value) {
  return hasForbiddenControlCharacters(value) || /(?:<<<<<<<|=======|>>>>>>>)/u.test(value);
}
function hasForbiddenControlCharacters(value) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== void 0 && (code >= 0 && code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code >= 127 && code <= 159 || code === 8232 || code === 8233)) {
      return true;
    }
  }
  return false;
}
function validField(value, field, policy) {
  return value.length <= policy.fieldLimits[field] && !policy.templateTexts.some((template) => value.includes(template)) && !hasForbiddenText(value) && policy.isAllowedText(value, field);
}
function validateCard(card, policy) {
  if (!/^people\/[A-Za-z0-9-]+\.md$/u.test(card.path))
    throw new Error("invalid Card path");
  if (card.path !== `people/${card.metadata.github}.md`)
    throw new Error("path/login mismatch");
  if (!/^[A-Za-z0-9-]+$/u.test(card.metadata.github))
    throw new Error("invalid github login");
  if (!/^\d+$/u.test(card.metadata.githubId))
    throw new Error("invalid github_id");
  if (!/^https:\/\//u.test(card.metadata.avatar))
    throw new Error("invalid avatar URL");
  if (!Number.isSafeInteger(card.metadata.sourcePr) || card.metadata.sourcePr < 1) {
    throw new Error("invalid source_pr");
  }
  if (!validField(card.contributor.nickname, "nickname", policy))
    throw new Error("invalid nickname");
  if (!validField(card.contributor.exploring, "exploring", policy))
    throw new Error("invalid exploring text");
  if (!validField(card.contributor.message, "message", policy))
    throw new Error("invalid message");
}
function parseCard(input, options) {
  let text;
  try {
    text = inputText(input);
  } catch {
    return reject("invalid UTF-8");
  }
  if (text.startsWith("\uFEFF")) return reject("BOM is forbidden");
  if (!text.endsWith("\n")) return reject("Card must end with LF");
  if (hasForbiddenStructure(text))
    return reject("forbidden control or conflict marker");
  const match = /^---\ngithub: ([A-Za-z0-9-]+)\ngithub_id: (\d+)\navatar: (https:\/\/[^\n]+)\nsource_pr: (\d+)\n---\n\n# ([^\n]+)\n\n最近在折腾：([^\n]+)\n\n> ([^\n]+)\n$/u.exec(
    text
  );
  if (!match) return reject("Card does not follow the fixed structure");
  const [, github, githubId, avatar, sourcePr, nickname, exploring, message] = match;
  if (!github || !githubId || !avatar || !sourcePr || !nickname || !exploring || !message) {
    return reject("Card has missing fields");
  }
  const card = {
    path: options.path,
    metadata: { github, githubId, avatar, sourcePr: Number(sourcePr) },
    contributor: { nickname, exploring, message }
  };
  try {
    validateCard(card, options.policy);
  } catch (error) {
    return reject(error instanceof Error ? error.message : "invalid Card");
  }
  return { ok: true, card };
}
function renderCard(card, policy) {
  validateCard(card, policy);
  return `---
github: ${card.metadata.github}
github_id: ${card.metadata.githubId}
avatar: ${card.metadata.avatar}
source_pr: ${card.metadata.sourcePr}
---

# ${card.contributor.nickname}

\u6700\u8FD1\u5728\u6298\u817E\uFF1A${card.contributor.exploring}

> ${card.contributor.message}
`;
}
function renderCardBytes(card, policy) {
  return encodeUtf8(renderCard(card, policy));
}

// src/render/comment.ts
init_model();
var MARKER = "hello-from-main";
function renderSetupComment(input) {
  const actionKey = key(
    input.runIdentity,
    input.sourcePullRequestNumber,
    "source-status"
  );
  return rendered(actionKey, "source-status", "setup", [
    "## Integration setup",
    `Contribution PR #${input.sourcePullRequestNumber} is connected to Integration PR #${input.integrationPullRequestNumber}.`,
    `Integration branch: \`${escapeInline(input.integrationBranchName)}\``,
    "Project automation owns the integration branch and the Integration PR; the contributor owns the Contribution PR and rebase.",
    `Run \`${escapeInline(input.rebaseCommand)}\` against the integration branch, resolve the Card yourself, then push with force-with-lease.`
  ]);
}
function renderValidationComment(input) {
  const invalid = input.result.kind === "invalid";
  const phase = invalid ? "validation-feedback" : "validation-success";
  const details = invalid && input.result.kind === "invalid" ? input.result.issues.map(
    (issue) => `- ${escapeInline(issue.category)}${issue.path ? ` (${escapeInline(issue.path)})` : ""}${issue.field ? `: ${escapeInline(issue.field)}` : ""}`
  ).join("\n") : "All current Card identity, structure, safety, and integration-base checks passed for this source head.";
  const actionKey = key(
    input.runIdentity,
    input.sourcePullRequestNumber,
    "source-status"
  );
  return rendered(actionKey, "source-status", phase, [
    invalid ? "## Card validation needs changes" : "## Card validation passed",
    `Source head: \`${escapeInline(input.sourceHeadOid)}\``,
    details,
    invalid ? "The Contribution PR remains blocked until a new head passes validation." : "The Contribution PR can proceed to automated acceptance."
  ]);
}
function renderReadyComment(input) {
  const actionKey = key(
    input.runIdentity,
    input.integrationPullRequestNumber,
    "integration-status"
  );
  return rendered(actionKey, "integration-status", "ready-guidance", [
    "## Ready for your confirmation",
    `Original Contributor: ${escapeInline(input.originalContributor)}`,
    `Integration PR #${input.integrationPullRequestNumber} candidate head: \`${escapeInline(input.candidateHeadOid)}\``,
    `Card: \`${escapeInline(input.cardPath)}\` (blob \`${escapeInline(input.cardBlobOid)}\`)`,
    "Please inspect your Card and approve this Integration PR. Approval confirms the Card only; it grants no merge permission and does not approve the generated README."
  ]);
}
function derivePublishedCardLinks(target) {
  assertPublishedCardTargetShape(target);
  return {
    cardUrl: `${target.webBaseUrl}/${target.owner}/${target.repo}/blob/${target.publishedMainOid}/${encodeURIComponent(target.cardPath)}`,
    sourcePullRequestUrl: `${target.webBaseUrl}/${target.owner}/${target.repo}/pull/${target.sourcePullRequestNumber}`
  };
}
function renderCompletionComment(input) {
  const links = derivePublishedCardLinks(input.target);
  const slot = input.slot ?? "source-status";
  const actionKey = key(input.runIdentity, input.targetPullRequestNumber, slot);
  return rendered(actionKey, slot, "completion", [
    "## Tutorial Run complete",
    `Published Card: [open Card](${links.cardUrl})`,
    `Source Contribution PR: [open PR](${links.sourcePullRequestUrl})`,
    `Published main: \`${escapeInline(input.target.publishedMainOid)}\``
  ]);
}
function key(runIdentity2, targetPullRequestNumber, slot) {
  return commentActionKey({ runIdentity: runIdentity2, targetPullRequestNumber, slot });
}
function rendered(actionKey, slot, phase, lines) {
  return {
    actionKey,
    slot,
    phase,
    body: `<!-- ${MARKER}: key=${encodeURIComponent(actionKey)} phase=${phase} -->
${lines.join("\n")}
`
  };
}
function escapeInline(value) {
  assertSafeText(value);
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function assertSafeText(value) {
  if (/[`\\[\]()!#*_~|]/u.test(value))
    throw new Error("comment text contains unsafe Markdown delimiters");
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== void 0 && (code >= 0 && code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code >= 127 && code <= 159 || code === 8232 || code === 8233))
      throw new Error("comment text contains forbidden control characters");
  }
}
function assertPublishedCardTargetShape(target) {
  if (!/^https:\/\/[^/?#]+$/u.test(target.webBaseUrl) || !/^[A-Za-z0-9._-]+$/u.test(target.owner) || !/^[A-Za-z0-9._-]+$/u.test(target.repo) || !/^[0-9a-f]{40}$/iu.test(target.publishedMainOid) || !/^[0-9a-f]{40}$/iu.test(target.expectedCardBlobOid) || !/^people\/[A-Za-z0-9._+-]+\.md$/u.test(target.cardPath) || target.cardPath.includes("..") || !Number.isSafeInteger(target.sourcePullRequestNumber) || target.sourcePullRequestNumber < 1)
    throw new Error("invalid PublishedCardTarget");
}

// src/render/readme.ts
var CARDS_START = "<!-- cards:start -->";
var CARDS_END = "<!-- cards:end -->";
function markerOffsets(readme) {
  const lines = readme.split("\n");
  let start = -1;
  let end = -1;
  let offset = 0;
  for (const line of lines) {
    if (line.includes(CARDS_START) && line !== CARDS_START || line.includes(CARDS_END) && line !== CARDS_END) {
      throw new Error("malformed README marker line");
    }
    if (line === CARDS_START) {
      if (start !== -1) throw new Error("duplicate cards:start marker");
      start = offset;
    }
    if (line === CARDS_END) {
      if (end !== -1) throw new Error("duplicate cards:end marker");
      end = offset;
    }
    offset += line.length + 1;
  }
  if (start === -1 || end === -1)
    throw new Error("README markers are required");
  if (start > end) throw new Error("README markers are reversed");
  return { start, end };
}
function assertCards(cards) {
  const paths = /* @__PURE__ */ new Set();
  const identities = /* @__PURE__ */ new Set();
  for (const card of cards) {
    if (paths.has(card.path))
      throw new Error(`duplicate Card path: ${card.path}`);
    if (identities.has(card.metadata.githubId)) {
      throw new Error(`duplicate Card identity: ${card.metadata.githubId}`);
    }
    paths.add(card.path);
    identities.add(card.metadata.githubId);
  }
}
function renderReadmeMarkers(readme, options) {
  const { start, end } = markerOffsets(readme);
  assertCards(options.cards);
  const cards = [...options.cards].sort(options.compare);
  const region = options.renderRegion(cards);
  if (region.includes("\r"))
    throw new Error("README generated region must use LF");
  if (region.includes(CARDS_START) || region.includes(CARDS_END)) {
    throw new Error("generated region contains README markers");
  }
  return `${readme.slice(0, start + CARDS_START.length)}
${region}
${readme.slice(end)}`;
}

// src/core/reconciler.ts
init_model();
function validateIntake(facts, candidatePolicy) {
  const source = facts.sourcePullRequest.value;
  const issues = [];
  const headOid = source?.headOid;
  if (!source?.authorLogin || !source.authorGithubId || source.headRepositoryOwnerLogin !== source.authorLogin || source.headRepositoryIsFork !== true)
    issues.push({ category: "intake-author-or-fork" });
  const expectedPath = source?.authorLogin ? `people/${source.authorLogin}.md` : void 0;
  if (!source?.headRef || source.headRef !== `add/${source.authorLogin ?? ""}` || source.changedFiles?.length !== 1 || source.changedFiles?.[0]?.path !== expectedPath)
    issues.push({
      category: "intake-ref-or-path",
      ...expectedPath ? { path: expectedPath } : {}
    });
  if (source?.changedFilesComplete !== true || source.changedFiles?.length !== 1)
    issues.push({ category: "change-scope" });
  const file = source?.changedFiles?.[0];
  if (!source?.authorGithubId || facts.publishedGithubIds?.includes(source.authorGithubId) || facts.activeGithubIds?.includes(source.authorGithubId) || file && (file.path !== expectedPath || !new TextDecoder().decode(file.bytes).includes(`github_id: ${source.authorGithubId}`) || !new TextDecoder().decode(file.bytes).includes(`source_pr: ${source.number}`)))
    issues.push({ category: "identity-or-metadata" });
  if (candidatePolicy && file) {
    const rawCardText = new TextDecoder().decode(file.bytes);
    const contributorText = rawCardText.split("\n---\n\n")[1] ?? rawCardText;
    const parsed = parseCard(file.bytes, {
      path: file.path,
      policy: candidatePolicy.card
    });
    if (hasUnsafeContributorText(contributorText))
      issues.push({ category: "card-safety", path: file.path });
    if (!parsed.ok) {
      const safety = /control|conflict|link|image|HTML|syntax/iu.test(
        parsed.error.reason
      );
      if (!safety || !issues.some((issue) => issue.category === "card-safety"))
        issues.push({ category: "card-grammar-or-template", path: file.path });
      else if (!issues.some((issue) => issue.category === "card-grammar-or-template"))
        issues.push({
          category: "card-grammar-or-template",
          path: file.path,
          detail: parsed.error.reason
        });
    } else if (parsed.card.metadata.github !== source?.authorLogin || parsed.card.metadata.githubId !== source?.authorGithubId || parsed.card.metadata.sourcePr !== source?.number || source.authorAvatarUrl !== void 0 && parsed.card.metadata.avatar !== source.authorAvatarUrl) {
      issues.push({ category: "identity-or-metadata", path: file.path });
    }
  }
  const branchHead = facts.integrationBranch.value?.headOid;
  const ancestry = facts.sourceHeadBasedOnIntegration;
  if (branchHead && source && !source.merged && (source.baseOid !== branchHead || ancestry?.status !== "ready" || !ancestry.value || ancestry.value.integrationHeadOid !== branchHead || ancestry.value.sourceHeadOid !== source.headOid || ancestry.value.isAncestor !== true))
    issues.push({ category: "integration-base-or-ancestry" });
  return issues.length > 0 ? {
    kind: "invalid",
    ...headOid ? { headOid } : {},
    issues,
    blocksMerge: true
  } : headOid ? { kind: "valid", headOid } : {
    kind: "invalid",
    issues: [{ category: "intake-author-or-fork" }],
    blocksMerge: true
  };
}
function hasUnsafeContributorText(value) {
  if (/(?:<<<<<<<|=======|>>>>>>>|!?(?:\[[^\]]*\]\([^)]*\)|https?:\/\/\S+)|<\/?[A-Za-z][^>]*>)/u.test(
    value
  ))
    return true;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== void 0 && (code >= 0 && code <= 8 || code === 11 || code === 12 || code >= 14 && code <= 31 || code >= 127 && code <= 159 || code === 8232 || code === 8233))
      return true;
  }
  return false;
}
function createReconciler(dependencies) {
  return {
    async reconcile({ budget, onDiagnostic }) {
      let effects = 0;
      let turn = 0;
      while (effects < budget.maxEffects) {
        turn += 1;
        let observed;
        let workspace;
        try {
          observed = await withinBudget(
            budget,
            (context) => dependencies.github.observeRepository({
              ...context,
              ...dependencies.invocationContext?.expectedSourcePullRequestNumber !== void 0 ? {
                expectedSourcePullRequestNumber: dependencies.invocationContext.expectedSourcePullRequestNumber
              } : {},
              ...dependencies.invocationContext?.expectedSourceLogin !== void 0 ? {
                expectedSourceLogin: dependencies.invocationContext.expectedSourceLogin
              } : {}
            })
          );
          workspace = await withinBudget(
            budget,
            (context) => dependencies.git.readWorkspace(context)
          );
        } catch {
          const outcome2 = {
            kind: "retryable",
            reason: "retryableTransport"
          };
          onDiagnostic?.({ turn, outcome: outcome2 });
          return outcome2;
        }
        if (observed.status !== "ready" || !observed.value) {
          const outcome2 = observationOutcome(observed.status);
          onDiagnostic?.({ turn, outcome: outcome2 });
          return outcome2;
        }
        if (workspace.status !== "ready" || !workspace.value) {
          const outcome2 = observationOutcome(workspace.status);
          onDiagnostic?.({ turn, outcome: outcome2 });
          return outcome2;
        }
        const facts = observed.value;
        const commentsSupported = typeof dependencies.github.ensureComment === "function";
        let terminal;
        try {
          terminal = await terminalPublicationOutcome(
            facts,
            dependencies.git,
            budget,
            commentsSupported
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
          let outcome2;
          try {
            outcome2 = await executeEffect(terminal, dependencies, budget);
          } catch {
            outcome2 = { kind: "retryable", reason: "unknownOutcome" };
          }
          if (!outcome2) continue;
          onDiagnostic?.({ turn, effect: terminal.kind, outcome: outcome2 });
          return outcome2;
        }
        const derived = deriveEffect(
          facts,
          workspace.value,
          dependencies.candidatePolicy,
          commentsSupported
        );
        if (derived?.kind === "awaitingExternalFact" || derived?.kind === "retryable" || derived?.kind === "terminal" || derived?.kind === "budgetExhausted") {
          onDiagnostic?.({ turn, outcome: derived });
          return derived;
        }
        const effect = derived;
        if (!effect) {
          const outcome2 = { kind: "quiescent" };
          onDiagnostic?.({ turn, outcome: outcome2 });
          return outcome2;
        }
        if (budget.deadlineMs !== void 0 && Date.now() >= budget.deadlineMs) {
          const outcome2 = {
            kind: "budgetExhausted",
            effects
          };
          onDiagnostic?.({ turn, outcome: outcome2 });
          return outcome2;
        }
        effects += 1;
        let outcome;
        try {
          outcome = await executeEffect(effect, dependencies, budget);
        } catch {
          outcome = { kind: "retryable", reason: "unknownOutcome" };
        }
        if (!outcome) continue;
        onDiagnostic?.({ turn, effect: effect.kind, outcome });
        if (outcome.kind === "terminal" || outcome.kind === "awaitingExternalFact" || outcome.kind === "retryable" || outcome.kind === "quiescent")
          return outcome;
        if (effects >= budget.maxEffects)
          return { kind: "budgetExhausted", effects };
      }
      return { kind: "budgetExhausted", effects };
    }
  };
}
function deriveEffect(facts, workspace, candidatePolicy, commentsSupported) {
  const source = facts.sourcePullRequest.value;
  const branch = facts.integrationBranch.value;
  const integration = facts.integrationPullRequest.value;
  const main = facts.main.value;
  if (!source || !main) return void 0;
  const validation = validateIntake(facts, candidatePolicy);
  if (source.closed && !source.merged)
    return { kind: "terminal", reason: "policyRejected" };
  const branchName = branch?.name ?? integration?.headRef ?? `feature/card-${source.authorLogin ?? "source"}-source-${source.number}`;
  const branchStatus = setupStatusOutcome(facts.integrationBranch.status);
  if (branchStatus) return branchStatus;
  const integrationStatus = setupStatusOutcome(
    facts.integrationPullRequest.status
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
        ...source.authorAvatarUrl ? { avatar: source.authorAvatarUrl } : {}
      })
    };
  }
  if (!integration && facts.integrationPullRequest.status === "absent")
    return { kind: "createIntegrationPr", branchName };
  if (!branchHeadOid || !integration) return void 0;
  if (!source.merged && source.baseOid !== branchHeadOid) {
    return { kind: "retarget", pullRequestNumber: source.number, branchName };
  }
  if (facts.sourceHeadBasedOnIntegration?.status !== "ready" || !facts.sourceHeadBasedOnIntegration.value)
    return sourceAncestryOutcome(facts.sourceHeadBasedOnIntegration?.status);
  if (commentsSupported && (!source.authorGithubId || !facts.trustedCommentOwner))
    return { kind: "terminal", reason: "permissionDenied" };
  const setupComment = commentsSupported ? commentEffect(
    facts,
    source.number,
    "source-status",
    "setup",
    renderSetupComment({
      runIdentity: runIdentity(source),
      sourcePullRequestNumber: source.number,
      integrationBranchName: branchName,
      integrationPullRequestNumber: integration.number,
      rebaseCommand: `git rebase upstream/${branchName}`
    })
  ) : void 0;
  if (setupComment) return setupComment;
  if (validation.kind === "invalid") {
    const feedback = commentsSupported ? commentEffect(
      facts,
      source.number,
      "source-status",
      "validation-feedback",
      renderValidationComment({
        runIdentity: runIdentity(source),
        sourcePullRequestNumber: source.number,
        sourceHeadOid: source.headOid,
        result: validation
      })
    ) : void 0;
    return feedback ?? { kind: "terminal", reason: "policyRejected" };
  }
  const validationSuccess = commentsSupported ? commentEffect(
    facts,
    source.number,
    "source-status",
    "validation-success",
    renderValidationComment({
      runIdentity: runIdentity(source),
      sourcePullRequestNumber: source.number,
      sourceHeadOid: source.headOid,
      result: validation
    })
  ) : void 0;
  if (validationSuccess) return validationSuccess;
  if (!source.merged) {
    return {
      kind: "mergeContribution",
      request: {
        kind: "contribution",
        pullRequestNumber: source.number,
        expectedHeadOid: source.headOid
      }
    };
  }
  if (!main.readmeBytes || !main.cardPayloads) return awaitingIncomplete();
  if (!workspace.retainedCommitOids || !workspace.requiredParentOids)
    return awaitingIncomplete();
  const candidate = facts.candidate.value;
  const durableCandidate = workspace.candidate;
  const confirmation = facts.confirmations.find(
    (item) => item.contributorLogin === source.authorLogin && item.integrationPrNumber === integration?.number && item.reviewedCommitOid === integration?.headOid && item.cardBlobOid === candidate?.cardBlobOid && item.cardPath === candidate?.cardPath && item.sourcePrNumber === source.number && item.githubId === facts.acceptedCard?.githubId && facts.eligibility.reviews.status === "ready" && (facts.eligibility.reviews.value?.length ?? 0) > 0 && facts.eligibility.reviews.value?.some(
      (review) => review.pullRequestNumber === integration.number && review.prHeadOid === integration.headOid && review.reviewerLogin === source.authorLogin && review.state === "approved" && review.reviewedCommitOid === integration.headOid
    )
  );
  if (facts.acceptedCard && (workspace.integrationHeadOid || branchHeadOid) && (!durableCandidate || durableCandidate.mainOid !== main.oid || durableCandidate.integrationHeadOid !== integration.headOid || durableCandidate.cardBlobOid !== gitBlobOid(facts.acceptedCard.bytes))) {
    const card = facts.acceptedCard;
    if (!workspace.retainedCommitOids || !workspace.requiredParentOids)
      return awaitingIncomplete();
    if (!candidatePolicy) return void 0;
    let readmeBytes;
    if (!candidatePolicy) readmeBytes = card.readmeBytes ?? new Uint8Array();
    else {
      const parsedCards = [...main.cardPayloads, card].map((payload) => ({
        payload,
        parsed: parseCard(payload.bytes, {
          path: payload.path,
          policy: candidatePolicy.card
        })
      }));
      if (parsedCards.some(
        ({ payload, parsed }) => !parsed.ok || parsed.ok && (parsed.card.metadata.githubId !== payload.githubId || parsed.card.metadata.sourcePr !== payload.sourcePrNumber)
      ))
        return void 0;
      try {
        readmeBytes = new TextEncoder().encode(
          renderReadmeMarkers(new TextDecoder().decode(main.readmeBytes), {
            cards: parsedCards.map(({ parsed }) => {
              if (!parsed.ok) throw new Error("invalid Card");
              return parsed.card;
            }),
            compare: candidatePolicy.compare,
            renderRegion: candidatePolicy.renderRegion
          })
        );
      } catch {
        return void 0;
      }
    }
    const preserved = confirmation?.cardBlobOid;
    return {
      kind: "writeCandidate",
      candidate: {
        input: {
          observedMainOid: main.oid,
          expectedIntegrationHeadOid: oid(
            workspace.integrationHeadOid ?? branchHeadOid
          ),
          cardPath: card.path,
          cardBytes: card.bytes,
          readmeBytes,
          ...preserved ? { preserveConfirmedCardBlobOid: preserved } : {}
        },
        postconditions: {
          managedCard: {
            path: card.path,
            githubId: card.githubId,
            sourcePrNumber: card.sourcePrNumber
          },
          cardManifest: {
            path: card.path,
            blobOid: gitBlobOid(card.bytes),
            githubId: card.githubId,
            sourcePrNumber: card.sourcePrNumber
          },
          readmeBlobOid: gitBlobOid(readmeBytes),
          history: {
            retainCommitOids: [
              .../* @__PURE__ */ new Set([
                ...workspace.retainedCommitOids,
                ...durableCandidate?.retainedCommitOids ?? [],
                oid(workspace.integrationHeadOid ?? branchHeadOid)
              ])
            ],
            requiredParentOids: durableCandidate && durableCandidate.mainOid !== main.oid ? [] : [oid(workspace.integrationHeadOid ?? branchHeadOid)]
          }
        }
      }
    };
  }
  if (durableCandidate && integration?.draft && durableCandidate.integrationHeadOid === integration.headOid) {
    if (!durableCandidate.retainedCommitOids || !durableCandidate.requiredParentOids || !workspace.retainedCommitOids || !workspace.requiredParentOids)
      return awaitingIncomplete();
    return {
      kind: "ready",
      pullRequestNumber: integration.number,
      candidateHeadOid: durableCandidate.integrationHeadOid
    };
  }
  if (durableCandidate && !integration?.draft && durableCandidate.integrationHeadOid === integration.headOid) {
    const readyComment = commentsSupported ? commentEffect(
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
        cardBlobOid: durableCandidate.cardBlobOid
      })
    ) : void 0;
    if (readyComment) return readyComment;
  }
  if (confirmation && integration && durableCandidate && durableCandidate.integrationHeadOid === integration.headOid && providerEligible(facts, integration.number, integration.headOid)) {
    if (!durableCandidate.retainedCommitOids || !durableCandidate.requiredParentOids || !workspace.retainedCommitOids || !workspace.requiredParentOids || !main.readmeBytes || !source.mergeCommitOid || !facts.protocolAnchors?.contribution)
      return awaitingIncomplete();
    const request = {
      kind: "integration",
      pullRequestNumber: integration.number,
      expectedHeadOid: integration.headOid,
      observedBaseOid: integration.baseOid,
      baseCurrentGate: "required"
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
          sourcePrNumber: confirmation.sourcePrNumber
        },
        readmeBytes: durableCandidate.readmeBytes ?? main.readmeBytes,
        retainedCommitOids: durableCandidate.retainedCommitOids,
        requiredParentOids: [main.oid, durableCandidate.integrationHeadOid],
        sourceMergeCommitOid: source.mergeCommitOid,
        integrationMergeCommitOid: integration.headOid,
        contributionMergeParentOids: [
          facts.protocolAnchors.contribution.projectShellOid,
          facts.protocolAnchors.contribution.rebasedContributorOid
        ],
        integrationMergeParentOids: [
          main.oid,
          durableCandidate.integrationHeadOid
        ]
      }
    };
  }
  return void 0;
}
function providerEligible(facts, pullRequestNumber, headOid) {
  const { checks, reviews, mergeability, baseCurrent } = facts.eligibility;
  return checks.status === "ready" && checks.value !== void 0 && checks.value.length > 0 && checks.value.every(
    (check) => check.pullRequestNumber === pullRequestNumber && check.prHeadOid === headOid && check.state === "success"
  ) && reviews.status === "ready" && reviews.value !== void 0 && !reviews.value.some(
    (review) => review.pullRequestNumber === pullRequestNumber && review.prHeadOid === headOid && (review.state === "changesRequested" || review.state === "dismissed")
  ) && mergeability.status === "ready" && mergeability.value === "mergeable" && baseCurrent.status === "ready" && baseCurrent.value === true;
}
async function terminalPublicationOutcome(facts, git2, budget, commentsSupported) {
  const integration = facts.integrationPullRequest.value;
  const main = facts.main.value;
  const source = facts.sourcePullRequest.value;
  if (!integration?.closed) return void 0;
  if (!integration.merged)
    return { kind: "terminal", reason: "policyRejected" };
  if (!main || !source?.authorLogin || !source.authorGithubId || !main.readmeBytes || !source.mergeCommitOid || !integration.mergeCommitOid || !integration.mergeParentOids || !facts.protocolAnchors?.contribution || !facts.protocolAnchors.integration)
    return awaitingIncomplete();
  const contributionParents = [
    facts.protocolAnchors.contribution.projectShellOid,
    facts.protocolAnchors.contribution.rebasedContributorOid
  ];
  const integrationParents = [
    facts.protocolAnchors.integration.mainBeforePublicationOid,
    facts.protocolAnchors.integration.candidateOid
  ];
  const manifest = main.cardManifests.find(
    (card) => card.githubId === source.authorGithubId && card.sourcePrNumber === source.number && card.path === `people/${source.authorLogin}.md`
  );
  if (!manifest) return { kind: "terminal", reason: "policyRejected" };
  const expected = {
    mainOid: main.oid,
    cardManifest: manifest,
    readmeBytes: main.readmeBytes,
    retainedCommitOids: [
      source.mergeCommitOid,
      integration.mergeCommitOid
    ].filter(
      (commit) => commit !== void 0
    ),
    // The Integration merge commit is main itself, so it is retained rather
    // than (impossibly) required as one of its own immediate parents.
    requiredParentOids: [],
    sourceMergeCommitOid: source.mergeCommitOid,
    integrationMergeCommitOid: integration.mergeCommitOid,
    contributionMergeParentOids: contributionParents,
    integrationMergeParentOids: integrationParents
  };
  if (contributionParents[0] === contributionParents[1] || integrationParents[0] === integrationParents[1])
    return { kind: "terminal", reason: "policyRejected" };
  const actual = await withinBudget(
    budget,
    (context) => git2.readFinalMainPostconditions(expected, context)
  );
  if (actual.status !== "ready" || !actual.value)
    return observationOutcome(actual.status);
  if (actual.value.mainOid !== expected.mainOid)
    return { kind: "retryable", reason: "stalePrecondition" };
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
    sourcePullRequestNumber: source.number
  });
  if (!targetResult.ok) return { kind: "terminal", reason: "policyRejected" };
  const sourceCompletion = completionEffect(
    facts,
    targetResult.target,
    source.number,
    "source-status"
  );
  if (sourceCompletion) return sourceCompletion;
  const integrationCompletion = completionEffect(
    facts,
    targetResult.target,
    integration.number,
    "integration-status"
  );
  return integrationCompletion ?? { kind: "quiescent" };
}
async function executeEffect(effect, dependencies, budget) {
  if (effect.kind === "ensureComment") {
    const result = await withinBudget(
      budget,
      (context) => dependencies.github.ensureComment(effect.intent, context)
    );
    if (result.kind === "created" || result.kind === "updated" || result.kind === "alreadyApplied" || result.kind === "noOp")
      return void 0;
    if (result.kind === "ambiguousOwnership" || result.kind === "permissionDenied")
      return { kind: "terminal", reason: "permissionDenied" };
    if (result.kind === "stale")
      return { kind: "retryable", reason: "stalePrecondition" };
    if (result.kind === "notVisibleYet")
      return { kind: "awaitingExternalFact", reason: "notVisibleYet" };
    if (result.kind === "capabilityUnavailable")
      return { kind: "terminal", reason: "capabilityUnavailable" };
    return {
      kind: "retryable",
      reason: result.kind === "unknownOutcome" ? "unknownOutcome" : "retryableTransport"
    };
  }
  if (effect.kind === "writeCandidate") {
    const result = await withinBudget(
      budget,
      (context) => context ? dependencies.git.writeIntegrationCandidate(effect.candidate, context) : dependencies.git.writeIntegrationCandidate(effect.candidate)
    );
    if (result.kind !== "succeeded" && result.kind !== "alreadyApplied")
      return candidateWriteOutcome(result);
    if (effect.candidate.input.preserveConfirmedCardBlobOid !== void 0 && result.value.candidate?.cardBlobOid !== effect.candidate.input.preserveConfirmedCardBlobOid)
      return { kind: "retryable", reason: "stalePrecondition" };
    const actual = result.value.candidate;
    const readback = result.value;
    const expected = effect.candidate.postconditions;
    if (!actual || actual.cardPath !== expected.cardManifest.path || actual.cardBlobOid !== expected.cardManifest.blobOid || actual.readmeBlobOid !== expected.readmeBlobOid || !expected.history.retainCommitOids.every(
      (commit) => readback.retainedCommitOids?.includes(commit) === true
    ))
      return { kind: "retryable", reason: "stalePrecondition" };
    return void 0;
  }
  if (effect.kind === "createBranch")
    return operationOutcome(
      await withinBudget(
        budget,
        (context) => dependencies.github.createIntegrationBranch(effect, {
          ...context,
          ...dependencies.invocationContext
        })
      )
    );
  if (effect.kind === "createIntegrationPr")
    return operationOutcome(
      await withinBudget(
        budget,
        (context) => dependencies.github.createIntegrationPullRequest(
          { branchName: effect.branchName, title: "Integration Card" },
          context
        )
      )
    );
  if (effect.kind === "retarget")
    return operationOutcome(
      await withinBudget(
        budget,
        (context) => dependencies.github.updatePullRequestBase(
          {
            pullRequestNumber: effect.pullRequestNumber,
            integrationBranchName: effect.branchName
          },
          context
        )
      )
    );
  if (effect.kind === "ready") {
    const result = await withinBudget(
      budget,
      (context) => dependencies.github.markPullRequestReadyForReview(
        {
          pullRequestNumber: effect.pullRequestNumber,
          expectedCandidateHeadOid: effect.candidateHeadOid
        },
        context
      )
    );
    return result.kind === "readyAtExpectedCandidate" || result.kind === "alreadyReadyAtExpectedCandidate" ? void 0 : result.kind === "headChanged" ? { kind: "retryable", reason: "stalePrecondition" } : operationCategoryOutcome(result.reason);
  }
  if (effect.kind === "mergeContribution")
    return mergeOutcome(
      await withinBudget(
        budget,
        (context) => dependencies.github.mergePullRequest(effect.request, context)
      )
    );
  if (effect.kind !== "mergeIntegration")
    return { kind: "terminal", reason: "policyRejected" };
  const merge = await withinBudget(
    budget,
    (context) => dependencies.github.mergePullRequest(effect.request, context)
  );
  if (merge.kind === "integrationRejected") return mergeOutcome(merge);
  return { kind: "awaitingExternalFact", reason: "pending" };
}
function isReconcileOutcome(value) {
  return value.kind === "quiescent" || value.kind === "awaitingExternalFact" || value.kind === "retryable" || value.kind === "budgetExhausted" || value.kind === "terminal";
}
function runIdentity(source) {
  if (!source.authorGithubId)
    throw new Error("immutable contributor identity is required");
  return `source:${source.number}:${source.authorGithubId}`;
}
function commentEffect(facts, targetPullRequestNumber, slot, phase, rendered2) {
  const expected = facts.trustedCommentOwner;
  const intent = {
    targetPullRequestNumber,
    slot,
    actionKey: rendered2.actionKey,
    phase,
    body: rendered2.body
  };
  const plan = planCommentMutation(intent, facts.comments ?? [], expected);
  if (plan.kind === "ambiguousOwnership")
    return { kind: "terminal", reason: "permissionDenied" };
  if (plan.kind === "stale")
    return { kind: "retryable", reason: "stalePrecondition" };
  if (plan.kind === "noOp") return void 0;
  if (plan.kind === "update" && phase !== "completion" && commentPhaseRank(commentPhase(plan.comment.body)) > commentPhaseRank(phase))
    return void 0;
  return {
    kind: "ensureComment",
    intent: plan.kind === "update" ? { ...intent, observed: plan.comment } : intent
  };
}
function commentPhase(value) {
  const phase = /\bphase=([a-z-]+)/u.exec(value)?.[1];
  return phase && isCommentPhase(phase) ? phase : void 0;
}
function isCommentPhase(value) {
  return value === "setup" || value === "validation-feedback" || value === "validation-success" || value === "ready-guidance" || value === "completion";
}
function commentPhaseRank(value) {
  if (!value) return -1;
  return {
    setup: 0,
    "validation-feedback": 1,
    "validation-success": 2,
    "ready-guidance": 3,
    completion: 4
  }[value];
}
function completionEffect(facts, target, targetPullRequestNumber, slot) {
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
      target
    })
  );
}
function awaitingIncomplete() {
  return { kind: "awaitingExternalFact", reason: "incomplete" };
}
function sourceAncestryOutcome(status) {
  if (status === "readFailed")
    return { kind: "retryable", reason: "retryableTransport" };
  if (status === "notVisibleYet")
    return { kind: "awaitingExternalFact", reason: "notVisibleYet" };
  return awaitingIncomplete();
}
function candidateWriteOutcome(result) {
  if (result.kind === "policyPostcondition")
    return { kind: "terminal", reason: "policyRejected" };
  if (result.kind === "staleLease" || result.kind === "staleMain")
    return { kind: "retryable", reason: "stalePrecondition" };
  return {
    kind: "retryable",
    reason: result.kind === "unknownOutcome" ? "unknownOutcome" : "retryableTransport"
  };
}
function setupStatusOutcome(status) {
  if (status === "ready" || status === "absent") return void 0;
  if (status === "readFailed")
    return { kind: "retryable", reason: "retryableTransport" };
  if (status === "conclusiveFailure")
    return { kind: "terminal", reason: "notFound" };
  return {
    kind: "awaitingExternalFact",
    reason: status === "notVisibleYet" ? "notVisibleYet" : status
  };
}
function observationOutcome(status) {
  if (status === "incomplete" || status === "pending")
    return { kind: "awaitingExternalFact", reason: status };
  if (status === "notVisibleYet")
    return { kind: "awaitingExternalFact", reason: status };
  if (status === "readFailed")
    return { kind: "retryable", reason: "retryableTransport" };
  return { kind: "terminal", reason: "notFound" };
}
function operationOutcome(result) {
  if (result.kind === "succeeded" || result.kind === "alreadyApplied")
    return void 0;
  return operationCategoryOutcome(result.kind);
}
function operationCategoryOutcome(category) {
  if (category === "permissionDenied" || category === "notFound" || category === "policyRejected")
    return { kind: "terminal", reason: category };
  if (category === "notVisibleYet")
    return { kind: "awaitingExternalFact", reason: category };
  return {
    kind: "retryable",
    reason: category === "stalePrecondition" ? category : category === "unknownOutcome" ? category : "retryableTransport"
  };
}
function mergeOutcome(result) {
  if (result.kind === "contributionMerged" || result.kind === "contributionAlreadyApplied" || result.kind === "integrationMerged" || result.kind === "integrationAlreadyApplied")
    return void 0;
  if (result.reason === "gateRejected" || result.reason === "gateUnsupported" || result.reason === "baseMoved")
    return { kind: "retryable", reason: "stalePrecondition" };
  return operationCategoryOutcome(
    result.reason ?? "unknownOutcome"
  );
}
function validateFinalMain(actual, expected) {
  return actual.mainOid === expected.mainOid && actual.sourceMergeCommitOid !== void 0 && actual.integrationMergeCommitOid !== void 0 && actual.contributionMergeParentOids !== void 0 && actual.integrationMergeParentOids !== void 0 && expected.sourceMergeCommitOid !== void 0 && expected.integrationMergeCommitOid !== void 0 && expected.contributionMergeParentOids !== void 0 && expected.integrationMergeParentOids !== void 0 && actual.sourceMergeCommitOid === expected.sourceMergeCommitOid && actual.integrationMergeCommitOid === expected.integrationMergeCommitOid && actual.sourceMergeCommitOid !== actual.integrationMergeCommitOid && sameOids(
    actual.contributionMergeParentOids,
    expected.contributionMergeParentOids
  ) && sameOids(
    actual.integrationMergeParentOids,
    expected.integrationMergeParentOids
  ) && actual.cardManifest.path === expected.cardManifest.path && actual.cardManifest.blobOid === expected.cardManifest.blobOid && actual.cardManifest.githubId === expected.cardManifest.githubId && actual.cardManifest.sourcePrNumber === expected.cardManifest.sourcePrNumber && bytesEqual2(actual.readmeBytes, expected.readmeBytes) && expected.retainedCommitOids.every(
    (commit) => actual.retainedCommitOids.includes(commit)
  ) && expected.requiredParentOids.every(
    (parent) => actual.requiredParentOids.includes(parent)
  );
}
function sameOids(left, right) {
  return left.length === right.length && right.every((value, index) => left[index] === value);
}
function bytesEqual2(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function withinBudget(budget, operation) {
  if (budget.deadlineMs === void 0) {
    return operation();
  }
  const remaining = budget.deadlineMs - Date.now();
  if (remaining <= 0)
    return Promise.reject(new Error("reconcile deadline elapsed"));
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ timedOut: true });
    }, remaining);
  });
  return Promise.race([
    operation({ signal: controller.signal, deadlineMs: budget.deadlineMs }),
    deadline
  ]).then((result) => {
    if (result && typeof result === "object" && "timedOut" in result)
      throw new Error("reconcile deadline elapsed");
    return result;
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// src/entry/action.ts
function createActionComposition(input) {
  if (!input.candidatePolicy) throw new Error("candidate policy is required");
  const reconciler = createReconciler(input);
  return {
    context: input.context,
    run(budget, onDiagnostic) {
      return reconciler.reconcile({
        budget,
        ...onDiagnostic ? { onDiagnostic } : {}
      });
    }
  };
}

// src/entry/policy.ts
var productionCandidatePolicy = {
  card: {
    fieldLimits: { nickname: 80, exploring: 200, message: 200 },
    templateTexts: ["Project shell", "Git metadata", "Project source metadata"],
    isAllowedText: (value) => value.trim().length > 0
  },
  compare: (left, right) => left.path.localeCompare(right.path),
  renderRegion: (cards) => cards.map(
    (card) => `[![${markdownText(card.metadata.github)}](${markdownUrl(card.metadata.avatar)})](https://github.com/${card.metadata.github})

[${markdownText(card.metadata.github)}](https://github.com/${card.metadata.github}) \xB7 **${markdownText(card.contributor.nickname)}**

\u6700\u8FD1\u5728\u6298\u817E\uFF1A${markdownText(card.contributor.exploring)}

> ${markdownText(card.contributor.message)}

[\u67E5\u770B\u5B8C\u6574 Card](${markdownUrl(card.path)})`
  ).join("\n\n---\n\n")
};
function markdownText(value) {
  return value.replace(/[\\`*_[\]<>]/g, "\\$&");
}
function markdownUrl(value) {
  return value.replace(/([()\\])/g, "\\$1");
}

// src/entry/watchdog.ts
async function discoverActiveRunAnchors(input) {
  const anchors = [];
  const integrationAnchors = [];
  const maxPages = input.maxPages ?? 100;
  const trustedApi = new URL(input.apiOrigin ?? "https://api.github.com");
  trustedApi.search = "";
  trustedApi.hash = "";
  trustedApi.pathname = trustedApi.pathname.replace(/\/+$/u, "");
  const pullsPath = `${trustedApi.pathname.replace(/\/+$/u, "")}/repos/${input.owner}/${input.repo}/pulls`;
  const seenLinks = /* @__PURE__ */ new Set();
  let pageUrl;
  let currentPage = 1;
  for (let count = 0; count < maxPages; count += 1) {
    const response = await input.transport.rest({
      method: "GET",
      path: pageUrl ?? `/repos/${input.owner}/${input.repo}/pulls`,
      ...!pageUrl ? { parameters: { state: "open", per_page: 100, page: 1 } } : {}
    });
    if (response.status !== 200 || !Array.isArray(response.data))
      return { kind: "incomplete", reason: "malformed pull request page" };
    for (const raw of response.data) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw;
      const head = item.head && typeof item.head === "object" ? item.head : {};
      const user = item.user && typeof item.user === "object" ? item.user : {};
      const number = item.number;
      const login = user.login;
      if (head.ref === `add/${login}` && typeof login === "string" && /^[A-Za-z0-9-]+$/u.test(login) && typeof number === "number" && Number.isSafeInteger(number) && number > 0)
        anchors.push({ sourcePullRequestNumber: number, sourceLogin: login });
      const integration = /^feature\/card-([A-Za-z0-9-]+)-source-([1-9][0-9]*)$/u.exec(
        typeof head.ref === "string" ? head.ref : ""
      );
      if (integration?.[1] && integration[2])
        integrationAnchors.push({
          sourceLogin: integration[1],
          sourcePullRequestNumber: Number(integration[2])
        });
    }
    const next = nextPullsLink(
      response.headers?.link,
      trustedApi,
      pullsPath,
      currentPage
    );
    if (next.kind === "invalid")
      return { kind: "incomplete", reason: next.reason };
    if (next.url) {
      if (seenLinks.has(next.url))
        return { kind: "incomplete", reason: "pagination loop" };
      seenLinks.add(next.url);
      pageUrl = next.url;
      currentPage = next.page;
      continue;
    }
    if (next.hasLinks)
      return {
        kind: "incomplete",
        reason: "missing pull request pagination continuation"
      };
    for (const anchor of integrationAnchors) {
      const source = await input.transport.rest({
        method: "GET",
        path: `/repos/${input.owner}/${input.repo}/pulls/${anchor.sourcePullRequestNumber}`
      });
      const record = asRecord3(source.data);
      const user = asRecord3(record.user);
      if (source.status !== 200 || record.number !== anchor.sourcePullRequestNumber || user.login !== anchor.sourceLogin)
        return {
          kind: "incomplete",
          reason: "Integration source anchor readback failed"
        };
      anchors.push(anchor);
    }
    return {
      kind: "ready",
      anchors: [
        ...new Map(
          anchors.map((item) => [
            `${item.sourcePullRequestNumber}:${item.sourceLogin}`,
            item
          ])
        ).values()
      ]
    };
  }
  return {
    kind: "incomplete",
    reason: "pull request pagination budget exhausted"
  };
}
function nextPullsLink(header, trustedApi, pullsPath, currentPage) {
  if (!header) return { kind: "valid", hasLinks: false };
  const links = [...header.matchAll(/<([^>]+)>;\s*rel="([^"]+)"/gu)];
  if (links.length === 0)
    return { kind: "invalid", reason: "malformed pagination Link" };
  const next = links.filter((link) => link[2] === "next");
  if (next.length > 1)
    return { kind: "invalid", reason: "duplicate next pagination Link" };
  if (next.length === 0) return { kind: "valid", hasLinks: true };
  const raw = next[0]?.[1];
  if (!raw)
    return { kind: "invalid", reason: "malformed next pagination Link" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", reason: "malformed next pagination URL" };
  }
  if (url.origin !== trustedApi.origin || url.pathname !== pullsPath)
    return {
      kind: "invalid",
      reason: `untrusted next pagination URL: actual=${url.origin}${url.pathname}; expected=${trustedApi.origin}${pullsPath}`
    };
  if (url.username || url.password || url.hash || [...url.searchParams.keys()].some(
    (key2) => !["state", "per_page", "page"].includes(key2)
  ) || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("per_page").length !== 1 || url.searchParams.getAll("page").length !== 1 || url.searchParams.get("state") !== "open" || url.searchParams.get("per_page") !== "100")
    return { kind: "invalid", reason: "malformed next pagination query" };
  const nextPage = Number(url.searchParams.get("page"));
  if (!Number.isSafeInteger(nextPage) || nextPage <= currentPage)
    return { kind: "invalid", reason: "nonprogressing pagination Link" };
  return { kind: "valid", url: url.toString(), page: nextPage, hasLinks: true };
}
function asRecord3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// src/entry/action-runtime.ts
async function runTrustedAction() {
  const defaultBranch = required2(process.env.DEFAULT_BRANCH, "DEFAULT_BRANCH");
  if (process.env.HELLO_FROM_MAIN_TEST_MODE === "1") {
    await runFixtureComposition();
    return;
  }
  const token = required2(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const workspace = required2(
    process.env.HELLO_FROM_MAIN_WORKSPACE,
    "HELLO_FROM_MAIN_WORKSPACE"
  );
  const context = await createTrustedActionContext({ defaultBranch });
  const [owner, repo] = context.repository.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  const runtimeIdentity = resolveRuntimeIdentity(process.env);
  const apiOrigin = runtimeIdentity.apiOrigin;
  const transport = createGithubTransport(token, apiOrigin);
  const discovery = context.eventName === "schedule" ? await discoverActiveRunAnchors({
    owner,
    repo,
    transport,
    apiOrigin
  }) : {
    kind: "ready",
    anchors: [
      {
        sourcePullRequestNumber: Number(
          process.env.HELLO_FROM_MAIN_SOURCE_PR_NUMBER
        ),
        sourceLogin: process.env.HELLO_FROM_MAIN_SOURCE_LOGIN ?? ""
      }
    ]
  };
  if (discovery.kind !== "ready")
    throw new Error(`watchdog discovery incomplete: ${discovery.reason}`);
  const anchors = discovery.anchors;
  if (anchors.length === 0) return;
  for (const anchor of anchors) {
    const runtime = deriveIntegrationRuntimeConfig({
      env: {
        ...process.env,
        HELLO_FROM_MAIN_SOURCE_PR_NUMBER: String(
          anchor.sourcePullRequestNumber
        ),
        HELLO_FROM_MAIN_SOURCE_LOGIN: anchor.sourceLogin
      },
      context: {},
      defaultBranch
    });
    await runProductionComposition({
      context,
      owner,
      repo,
      workspace,
      token,
      transport,
      runtime
    });
  }
}
async function runProductionComposition(input) {
  const { context, owner, repo, workspace, token, transport, runtime } = input;
  const gitAuth = await installGitAuthentication({
    root: workspace,
    token
  });
  try {
    const sourceContext = {
      signal: new AbortController().signal,
      expectedSourcePullRequestNumber: runtime.sourcePullRequestNumber,
      expectedSourceLogin: runtime.sourceLogin
    };
    let repositoryId;
    try {
      repositoryId = await trustedRepositoryId(transport, owner, repo);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          kind: "hello-from-main-diagnostic",
          stage: "pre-composition",
          outcome: "terminal",
          reason: "capabilityUnavailable"
        })}
`
      );
      throw new Error("trusted repository identity is unavailable");
    }
    const composition = createActionComposition({
      context,
      github: bindProductionSetup(
        createOctokitGithubPlatform({
          owner,
          repo,
          transport,
          ...runtime.apiOrigin ? { apiOrigin: runtime.apiOrigin } : {},
          repositoryId,
          expectedCommentOwner: runtime.commentOwner
        }),
        runtime,
        new RealGitWorkspace(
          createGitRunner({ root: workspace, env: gitAuth.env }),
          workspace,
          runtime.remote,
          runtime.branch
        )
      ),
      git: new RealGitWorkspace(
        createGitRunner({ root: workspace, env: gitAuth.env }),
        workspace,
        runtime.remote,
        runtime.branch
      ),
      candidatePolicy: productionCandidatePolicy,
      invocationContext: sourceContext
    });
    const outcome = await composition.run({ maxEffects: 8 }, (diagnostic) => {
      process.stdout.write(
        `${JSON.stringify({
          kind: "hello-from-main-diagnostic",
          turn: diagnostic.turn,
          ...diagnostic.effect ? { effect: diagnostic.effect } : {},
          outcome: diagnostic.outcome.kind,
          ...diagnostic.outcome.kind === "retryable" || diagnostic.outcome.kind === "terminal" || diagnostic.outcome.kind === "awaitingExternalFact" ? { reason: diagnostic.outcome.reason } : {}
        })}
`
      );
    });
    process.stdout.write(`${JSON.stringify(outcome)}
`);
    if (outcome.kind === "retryable" || outcome.kind === "terminal" || outcome.kind === "budgetExhausted")
      throw new Error(`Hello from Main action failed: ${outcome.kind}`);
  } finally {
    await gitAuth.dispose();
  }
}
async function trustedRepositoryId(transport, owner, repo) {
  const response = await transport.rest({
    method: "GET",
    path: `/repos/${owner}/${repo}`
  });
  const id = response.data && typeof response.data === "object" ? response.data.id : void 0;
  if (response.status !== 200 || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
    throw new Error(
      "trusted repository numeric ID is required for comment pagination"
    );
  return id;
}
function deriveIntegrationRuntimeConfig(input) {
  const number = input.context.sourcePullRequest?.number ?? Number(input.env.HELLO_FROM_MAIN_SOURCE_PR_NUMBER);
  const login = input.context.sourcePullRequest?.authorLogin ?? input.env.HELLO_FROM_MAIN_SOURCE_LOGIN;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(
      "source pull request number is required for integration configuration"
    );
  if (!login || !/^[A-Za-z0-9-]+$/u.test(login))
    throw new Error(
      "source pull request login is required for integration configuration"
    );
  if (input.defaultBranch !== "main")
    throw new Error(
      "production integration configuration requires main as default branch"
    );
  const commentOwnerId = input.env.HELLO_FROM_MAIN_COMMENT_OWNER_ID;
  const commentOwnerType = input.env.HELLO_FROM_MAIN_COMMENT_OWNER_TYPE;
  const runtimeIdentity = resolveRuntimeIdentity(input.env);
  const publicGithub = runtimeIdentity.publicGithub;
  const configuredCommentOwnerId = commentOwnerId ?? (publicGithub ? "41898282" : void 0);
  const configuredCommentOwnerType = commentOwnerType ?? (publicGithub ? "Bot" : void 0);
  if (!configuredCommentOwnerId || configuredCommentOwnerType !== "Bot" && configuredCommentOwnerType !== "User" || !/^[1-9][0-9]*$/u.test(configuredCommentOwnerId))
    throw new Error(
      "comment owner principal requires a canonical ID and exact actor type"
    );
  const commentOwner = {
    actorId: configuredCommentOwnerId,
    actorType: configuredCommentOwnerType
  };
  return {
    remote: input.env.HELLO_FROM_MAIN_REMOTE || "origin",
    branch: `feature/card-${login}-source-${number}`,
    sourcePullRequestNumber: number,
    sourceLogin: login,
    commentOwner,
    apiOrigin: runtimeIdentity.apiOrigin
  };
}
function resolveRuntimeIdentity(env) {
  const standardApi = env.GITHUB_API_URL;
  const standardServer = env.GITHUB_SERVER_URL;
  const custom = env.HELLO_FROM_MAIN_API_ORIGIN;
  const customOrigin = custom ? normalizeOrigin(custom) : void 0;
  const apiOrigin = normalizeOrigin(standardApi ?? "https://api.github.com");
  const serverOrigin = normalizeOrigin(standardServer ?? "https://github.com");
  if (!trustedApiMatchesServer(apiOrigin, serverOrigin))
    throw new Error("trusted GitHub API and server origins are not coherent");
  if (customOrigin && !sameApiOrigin(customOrigin, apiOrigin))
    throw new Error(
      "custom API origin must be coherent with the trusted runtime"
    );
  const effectiveApi = customOrigin ?? apiOrigin;
  const publicGithub = effectiveApi === "https://api.github.com" && serverOrigin === "https://github.com";
  return { apiOrigin: effectiveApi, publicGithub };
}
function normalizeOrigin(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/u, "");
}
function sameApiOrigin(left, right) {
  return left === right;
}
function trustedApiMatchesServer(apiOrigin, serverOrigin) {
  return apiOrigin === "https://api.github.com" && serverOrigin === "https://github.com" || new URL(apiOrigin).origin === serverOrigin;
}
function bindProductionSetup(github, runtime, workspace) {
  async function mergePullRequest(request, context) {
    if (request.kind === "integration")
      return workspace.publishIntegrationMerge(request, context);
    return github.mergePullRequest(request, context);
  }
  return {
    ...github,
    mergePullRequest,
    async createIntegrationBranch(input, _context) {
      if (!input.cardPath || !input.cardBytes)
        return {
          kind: "retryableTransport",
          detail: "Project Shell bytes are required"
        };
      try {
        const result = await workspace.createIntegrationBranchWithProjectShell({
          name: runtime.branch,
          fromMainOid: input.fromMainOid,
          cardPath: input.cardPath,
          cardBytes: input.cardBytes
        });
        const anchor = await github.createIntegrationBranch(
          { name: runtime.branch, fromMainOid: input.fromMainOid },
          _context
        );
        return anchor.kind === "permissionDenied" || anchor.kind === "notFound" ? anchor : { kind: "alreadyApplied", value: result };
      } catch (error) {
        return {
          kind: "retryableTransport",
          detail: gitFailureDetail(error)
        };
      }
    }
  };
}
function gitFailureDetail(error) {
  if (!(error instanceof GitCommandError))
    return "Project Shell setup failed: operation=unknown";
  const operation = error.result.argv[0] ?? "unknown";
  const category = error.result.status === 128 ? "repository-or-auth" : "command-failed";
  return `Project Shell setup failed: operation=${operation}; status=${error.result.status}; category=${category}`;
}
async function runFixtureComposition() {
  const sandbox = await (await Promise.resolve().then(() => (init_git(), git_exports))).createGitSandbox();
  const facts = {
    main: { status: "incomplete" },
    sourcePullRequest: { status: "absent" },
    integrationBranch: { status: "absent" },
    integrationPullRequest: { status: "absent" },
    candidate: { status: "absent" },
    eligibility: {
      checks: { status: "pending" },
      reviews: { status: "pending" },
      mergeability: { status: "pending" },
      baseCurrent: { status: "pending" }
    },
    confirmations: []
  };
  const composition = createActionComposition({
    context: {
      eventName: "workflow_dispatch",
      repository: "local/verification",
      ref: "refs/heads/main",
      sha: "verification",
      eventPath: "verification"
    },
    github: createOctokitGithubPlatform({
      owner: "local",
      repo: "verification",
      replay: true,
      initialFacts: facts,
      transport: {
        rest: async () => {
          throw new Error("fixture transport must not be called");
        },
        graphql: async () => {
          throw new Error("fixture transport must not be called");
        }
      }
    }),
    git: new RealGitWorkspace(
      createGitRunner({ root: sandbox.root }),
      sandbox.root,
      "origin",
      "feature/card-fixture-source-1"
    ),
    candidatePolicy: productionCandidatePolicy
  });
  const outcome = await composition.run({ maxEffects: 1 });
  process.stdout.write(`${JSON.stringify(outcome)}
`);
  await sandbox.dispose();
}
function createGithubTransport(token, apiOrigin = "https://api.github.com") {
  const base = normalizeApiBase(apiOrigin);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28"
  };
  return {
    async rest(request) {
      const query = request.parameters && request.method === "GET" ? `?${new URLSearchParams(Object.entries(request.parameters).map(([key2, value]) => [key2, String(value)])).toString()}` : "";
      const response = await fetch(
        `${request.path.startsWith("http") ? request.path : `${base.rest}${request.path.startsWith("/") ? "" : "/"}${request.path}`}${query}`,
        {
          method: request.method,
          headers: {
            ...headers,
            ...request.headers,
            ...request.method === "GET" ? {} : { "content-type": "application/json" }
          },
          ...request.method === "GET" ? {} : { body: JSON.stringify(request.parameters ?? {}) },
          ...request.signal ? { signal: request.signal } : {}
        }
      );
      return {
        status: response.status,
        data: await response.json().catch(() => ({})),
        headers: lowerCaseHeaders(response.headers)
      };
    },
    async graphql(request) {
      const response = await fetch(base.graphql, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(request),
        ...request.signal ? { signal: request.signal } : {}
      });
      if (!response.ok) throw new Error(`GraphQL returned ${response.status}`);
      return response.json();
    }
  };
}
function normalizeApiBase(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  const rest = parsed.toString().replace(/\/$/u, "");
  const graphqlPath = parsed.pathname.endsWith("/api/v3") ? `${parsed.pathname.replace(/\/api\/v3$/u, "")}/api/graphql` : `${parsed.pathname === "/" ? "" : parsed.pathname}/graphql`;
  return {
    rest,
    restPath: parsed.pathname,
    graphql: `${parsed.origin}${graphqlPath}`
  };
}
function lowerCaseHeaders(headers) {
  const result = {};
  headers.forEach((value, key2) => {
    result[key2.toLowerCase()] = value;
  });
  return result;
}
function required2(value, name) {
  if (!value)
    throw new Error(`${name} is required for trusted production composition`);
  return value;
}
if (process.env.NODE_ENV !== "test") void runTrustedAction();
export {
  bindProductionSetup,
  createGithubTransport,
  deriveIntegrationRuntimeConfig,
  gitFailureDetail,
  runTrustedAction
};
