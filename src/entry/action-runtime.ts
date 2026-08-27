import { createTrustedActionContext } from "../adapters/action-context.js";
import {
  createGitRunner,
  GitCommandError,
  installGitAuthentication,
  RealGitWorkspace,
} from "../adapters/git.js";
import {
  bindProductionSetupAuthority,
  createOctokitGithubPlatform,
  type OctokitIntegrationPublicationRecorder,
  type OctokitRequestTransport,
} from "../adapters/octokit.js";
import type {
  ContributionMergeRequest,
  ContributionMergeResult,
  IntegrationMergeRequest,
  IntegrationMergeResult,
  RepositoryFacts,
  TrustedPrincipal,
} from "../core/model.js";
import type {
  GithubPlatform,
  InvocationContext,
} from "../ports/github-platform.js";
import { createActionComposition } from "./action.js";
import { productionCandidatePolicy } from "./policy.js";
import { discoverActiveRunAnchors } from "./watchdog.js";

/**
 * Trusted default-branch entry. Production wiring supplies real adapters at
 * deployment; the self-contained test mode proves the bundled artifact enters
 * the same Core composition without ever reading Fork content.
 */
export async function runTrustedAction(): Promise<void> {
  const defaultBranch = required(process.env.DEFAULT_BRANCH, "DEFAULT_BRANCH");
  if (process.env.HELLO_FROM_MAIN_TEST_MODE === "1") {
    await runFixtureComposition();
    return;
  }
  const token = required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN");
  const workspace = required(
    process.env.HELLO_FROM_MAIN_WORKSPACE,
    "HELLO_FROM_MAIN_WORKSPACE",
  );
  const context = await createTrustedActionContext({ defaultBranch });
  const [owner, repo] = context.repository.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  const runtimeIdentity = resolveRuntimeIdentity(process.env);
  const apiOrigin = runtimeIdentity.apiOrigin;
  const transport = createGithubTransport(token, apiOrigin);
  const discovery =
    context.eventName === "schedule"
      ? await discoverActiveRunAnchors({
          owner,
          repo,
          transport,
          apiOrigin,
        })
      : {
          kind: "ready" as const,
          anchors: [
            {
              sourcePullRequestNumber: Number(
                process.env.HELLO_FROM_MAIN_SOURCE_PR_NUMBER,
              ),
              sourceLogin: process.env.HELLO_FROM_MAIN_SOURCE_LOGIN ?? "",
            },
          ],
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
          anchor.sourcePullRequestNumber,
        ),
        HELLO_FROM_MAIN_SOURCE_LOGIN: anchor.sourceLogin,
      },
      context: {},
      defaultBranch,
    });
    await runProductionComposition({
      context,
      owner,
      repo,
      workspace,
      token,
      transport,
      runtime,
    });
  }
}

async function runProductionComposition(input: {
  context: Awaited<ReturnType<typeof createTrustedActionContext>>;
  owner: string;
  repo: string;
  workspace: string;
  token: string;
  transport: OctokitRequestTransport;
  runtime: IntegrationRuntimeConfig;
}): Promise<void> {
  const { context, owner, repo, workspace, token, transport, runtime } = input;
  const gitAuth = await installGitAuthentication({
    root: workspace,
    token,
  });
  try {
    const sourceContext: InvocationContext = {
      signal: new AbortController().signal,
      expectedSourcePullRequestNumber: runtime.sourcePullRequestNumber,
      expectedSourceLogin: runtime.sourceLogin,
    };
    let repositoryId: number;
    try {
      repositoryId = await trustedRepositoryId(transport, owner, repo);
    } catch {
      process.stdout.write(
        `${JSON.stringify({
          kind: "hello-from-main-diagnostic",
          stage: "pre-composition",
          outcome: "terminal",
          reason: "capabilityUnavailable",
        })}\n`,
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
          ...(runtime.apiOrigin ? { apiOrigin: runtime.apiOrigin } : {}),
          ...(runtime.webBaseUrl ? { webBaseUrl: runtime.webBaseUrl } : {}),
          repositoryId,
          expectedCommentOwner: runtime.commentOwner,
        }),
        runtime,
        new RealGitWorkspace(
          createGitRunner({ root: workspace, env: gitAuth.env }),
          workspace,
          runtime.remote,
          runtime.branch,
        ),
      ),
      git: new RealGitWorkspace(
        createGitRunner({ root: workspace, env: gitAuth.env }),
        workspace,
        runtime.remote,
        runtime.branch,
      ),
      candidatePolicy: productionCandidatePolicy,
      invocationContext: sourceContext,
    });
    const outcome = await composition.run({ maxEffects: 12 }, (diagnostic) => {
      process.stdout.write(
        `${JSON.stringify({
          kind: "hello-from-main-diagnostic",
          turn: diagnostic.turn,
          ...(diagnostic.effect ? { effect: diagnostic.effect } : {}),
          outcome: diagnostic.outcome.kind,
          ...(diagnostic.outcome.kind === "retryable" ||
          diagnostic.outcome.kind === "terminal" ||
          diagnostic.outcome.kind === "awaitingExternalFact"
            ? { reason: diagnostic.outcome.reason }
            : {}),
        })}\n`,
      );
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (
      outcome.kind === "retryable" ||
      outcome.kind === "terminal" ||
      outcome.kind === "budgetExhausted"
    )
      throw new Error(`Hello from Main action failed: ${outcome.kind}`);
  } finally {
    await gitAuth.dispose();
  }
}

async function trustedRepositoryId(
  transport: OctokitRequestTransport,
  owner: string,
  repo: string,
): Promise<number> {
  const response = await transport.rest({
    method: "GET",
    path: `/repos/${owner}/${repo}`,
  });
  const id =
    response.data && typeof response.data === "object"
      ? (response.data as { id?: unknown }).id
      : undefined;
  if (
    response.status !== 200 ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id < 1
  )
    throw new Error(
      "trusted repository numeric ID is required for comment pagination",
    );
  return id;
}

export type IntegrationRuntimeConfig = {
  remote: string;
  branch: string;
  sourcePullRequestNumber: number;
  sourceLogin: string;
  commentOwner: TrustedPrincipal;
  apiOrigin?: string;
  webBaseUrl?: string;
};

export function deriveIntegrationRuntimeConfig(input: {
  env: NodeJS.ProcessEnv;
  context: { sourcePullRequest?: { number: number; authorLogin?: string } };
  defaultBranch: string;
}): IntegrationRuntimeConfig {
  const number =
    input.context.sourcePullRequest?.number ??
    Number(input.env.HELLO_FROM_MAIN_SOURCE_PR_NUMBER);
  const login =
    input.context.sourcePullRequest?.authorLogin ??
    input.env.HELLO_FROM_MAIN_SOURCE_LOGIN;
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new Error(
      "source pull request number is required for integration configuration",
    );
  if (!login || !/^[A-Za-z0-9-]+$/u.test(login))
    throw new Error(
      "source pull request login is required for integration configuration",
    );
  if (input.defaultBranch !== "main")
    throw new Error(
      "production integration configuration requires main as default branch",
    );
  const commentOwnerId = input.env.HELLO_FROM_MAIN_COMMENT_OWNER_ID;
  const commentOwnerType = input.env.HELLO_FROM_MAIN_COMMENT_OWNER_TYPE;
  const runtimeIdentity = resolveRuntimeIdentity(input.env);
  const publicGithub = runtimeIdentity.publicGithub;
  const configuredCommentOwnerId =
    commentOwnerId ?? (publicGithub ? "41898282" : undefined);
  const configuredCommentOwnerType =
    commentOwnerType ?? (publicGithub ? "Bot" : undefined);
  if (
    !configuredCommentOwnerId ||
    (configuredCommentOwnerType !== "Bot" &&
      configuredCommentOwnerType !== "User") ||
    !/^[1-9][0-9]*$/u.test(configuredCommentOwnerId)
  )
    throw new Error(
      "comment owner principal requires a canonical ID and exact actor type",
    );
  const commentOwner: TrustedPrincipal = {
    actorId: configuredCommentOwnerId,
    actorType: configuredCommentOwnerType,
  };
  return {
    remote: input.env.HELLO_FROM_MAIN_REMOTE || "origin",
    branch: `feature/card-${login}-source-${number}`,
    sourcePullRequestNumber: number,
    sourceLogin: login,
    commentOwner,
    apiOrigin: runtimeIdentity.apiOrigin,
    webBaseUrl: runtimeIdentity.webBaseUrl,
  };
}

function resolveRuntimeIdentity(env: NodeJS.ProcessEnv): {
  apiOrigin: string;
  webBaseUrl: string;
  publicGithub: boolean;
} {
  const standardApi = env.GITHUB_API_URL;
  const standardServer = env.GITHUB_SERVER_URL;
  const custom = env.HELLO_FROM_MAIN_API_ORIGIN;
  const apiOrigin = trustedUrl(standardApi ?? "https://api.github.com", "API");
  const serverOrigin = trustedUrl(
    standardServer ?? "https://github.com",
    "server",
  );
  if (!trustedApiMatchesServer(apiOrigin, serverOrigin))
    throw new Error("trusted GitHub API and server origins are not coherent");
  const customOrigin = custom ? trustedUrl(custom, "API") : undefined;
  if (customOrigin && !sameApiOrigin(customOrigin, apiOrigin))
    throw new Error(
      "custom API origin must be coherent with the trusted runtime",
    );
  const effectiveApi = customOrigin ?? apiOrigin;
  const publicGithub =
    effectiveApi === "https://api.github.com" &&
    serverOrigin === "https://github.com";
  return { apiOrigin: effectiveApi, webBaseUrl: serverOrigin, publicGithub };
}

function trustedUrl(value: string, kind: "API" | "server"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("trusted GitHub origin has an invalid URL shape");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (kind === "server" && url.pathname !== "/")
  )
    throw new Error("trusted GitHub origin has an invalid URL shape");
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  if (kind === "API" && pathname !== "/" && pathname !== "/api/v3")
    throw new Error("trusted GitHub origin has an invalid URL shape");
  return `${url.origin}${pathname === "/" ? "" : pathname}`;
}

function sameApiOrigin(left: string, right: string): boolean {
  return left === right;
}

function trustedApiMatchesServer(
  apiOrigin: string,
  serverOrigin: string,
): boolean {
  if (serverOrigin === "https://github.com")
    return apiOrigin === "https://api.github.com";
  return (
    (apiOrigin === "https://api.github.com" &&
      serverOrigin === "https://github.com") ||
    (new URL(apiOrigin).origin === serverOrigin &&
      (new URL(apiOrigin).pathname === "/api/v3" ||
        new URL(apiOrigin).pathname === ""))
  );
}

export function bindProductionSetup(
  github: GithubPlatform,
  runtime: IntegrationRuntimeConfig,
  workspace: RealGitWorkspace,
): GithubPlatform {
  const setupGithub = bindProductionSetupAuthority(
    github as GithubPlatform & OctokitIntegrationPublicationRecorder,
    workspace,
    runtime,
  );
  function mergePullRequest(
    request: ContributionMergeRequest,
    context?: InvocationContext,
  ): Promise<ContributionMergeResult>;
  function mergePullRequest(
    request: IntegrationMergeRequest,
    context?: InvocationContext,
  ): Promise<IntegrationMergeResult>;
  async function mergePullRequest(
    request: ContributionMergeRequest | IntegrationMergeRequest,
    context?: InvocationContext,
  ): Promise<ContributionMergeResult | IntegrationMergeResult> {
    if (request.kind === "integration") {
      const result = await workspace.publishIntegrationMerge(request, context);
      if (
        result.kind === "integrationMerged" ||
        (result.kind === "integrationAlreadyApplied" &&
          result.publicationEstablishedByCurrentOperation)
      )
        (
          github as GithubPlatform &
            Partial<
              import("../adapters/octokit.js").OctokitIntegrationPublicationRecorder
            >
        ).recordIntegrationPublication?.(request, result);
      return result;
    }
    return github.mergePullRequest(request, context);
  }
  return {
    ...setupGithub,
    mergePullRequest,
  };
}

export function gitFailureDetail(error: unknown): string {
  if (!(error instanceof GitCommandError))
    return "Project Shell setup failed: operation=unknown";
  const operation = error.result.argv[0] ?? "unknown";
  const category =
    error.result.status === 128 ? "repository-or-auth" : "command-failed";
  return `Project Shell setup failed: operation=${operation}; status=${error.result.status}; category=${category}`;
}

async function runFixtureComposition(): Promise<void> {
  const sandbox = await (await import("../adapters/git.js")).createGitSandbox();
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
      baseCurrent: { status: "pending" },
    },
    confirmations: [],
  } satisfies RepositoryFacts;
  const composition = createActionComposition({
    context: {
      eventName: "workflow_dispatch",
      repository: "local/verification",
      ref: "refs/heads/main",
      sha: "verification",
      eventPath: "verification",
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
        },
      },
    }),
    git: new RealGitWorkspace(
      createGitRunner({ root: sandbox.root }),
      sandbox.root,
      "origin",
      "feature/card-fixture-source-1",
    ),
    candidatePolicy: productionCandidatePolicy,
  });
  const outcome = await composition.run({ maxEffects: 1 });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  await sandbox.dispose();
}

export function createGithubTransport(
  token: string,
  apiOrigin = "https://api.github.com",
): OctokitRequestTransport {
  const base = normalizeApiBase(apiOrigin);
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
  return {
    async rest(request) {
      const query =
        request.parameters && request.method === "GET"
          ? `?${new URLSearchParams(Object.entries(request.parameters).map(([key, value]) => [key, String(value)])).toString()}`
          : "";
      const response = await fetch(
        `${request.path.startsWith("http") ? request.path : `${base.rest}${request.path.startsWith("/") ? "" : "/"}${request.path}`}${query}`,
        {
          method: request.method,
          headers: {
            ...headers,
            ...request.headers,
            ...(request.method === "GET"
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(request.method === "GET"
            ? {}
            : { body: JSON.stringify(request.parameters ?? {}) }),
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
      return {
        status: response.status,
        data: await response.json().catch(() => ({})),
        headers: lowerCaseHeaders(response.headers),
      };
    },
    async graphql(request) {
      const response = await fetch(base.graphql, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(request),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      if (!response.ok) throw new Error(`GraphQL returned ${response.status}`);
      return response.json() as Promise<{
        data?: unknown;
        errors?: readonly { message: string }[];
      }>;
    },
  };
}

function normalizeApiBase(value: string): {
  rest: string;
  restPath: string;
  graphql: string;
} {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "");
  const rest = parsed.toString().replace(/\/$/u, "");
  const graphqlPath = parsed.pathname.endsWith("/api/v3")
    ? `${parsed.pathname.replace(/\/api\/v3$/u, "")}/api/graphql`
    : `${parsed.pathname === "/" ? "" : parsed.pathname}/graphql`;
  return {
    rest,
    restPath: parsed.pathname,
    graphql: `${parsed.origin}${graphqlPath}`,
  };
}

function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value;
  });
  return result;
}

function required(value: string | undefined, name: string): string {
  if (!value)
    throw new Error(`${name} is required for trusted production composition`);
  return value;
}

if (process.env.NODE_ENV !== "test") void runTrustedAction();
