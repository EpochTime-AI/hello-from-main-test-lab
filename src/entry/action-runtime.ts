import { createTrustedActionContext } from "../adapters/action-context.js";
import {
  createGitRunner,
  installGitAuthentication,
  RealGitWorkspace,
} from "../adapters/git.js";
import {
  createOctokitGithubPlatform,
  type OctokitRequestTransport,
} from "../adapters/octokit.js";
import type { RepositoryFacts, TrustedPrincipal } from "../core/model.js";
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
  const apiOrigin = process.env.HELLO_FROM_MAIN_API_ORIGIN;
  const transport = createGithubTransport(token, apiOrigin);
  const anchors =
    context.eventName === "schedule"
      ? await discoverActiveRunAnchors({ owner, repo, transport })
      : [
          {
            sourcePullRequestNumber: Number(
              process.env.HELLO_FROM_MAIN_SOURCE_PR_NUMBER,
            ),
            sourceLogin: process.env.HELLO_FROM_MAIN_SOURCE_LOGIN ?? "",
          },
        ];
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
  const sourceContext: InvocationContext = {
    signal: new AbortController().signal,
    expectedSourcePullRequestNumber: runtime.sourcePullRequestNumber,
    expectedSourceLogin: runtime.sourceLogin,
  };
  const composition = createActionComposition({
    context,
    github: bindProductionSetup(
      createOctokitGithubPlatform({
        owner,
        repo,
        transport,
        ...(runtime.apiOrigin ? { apiOrigin: runtime.apiOrigin } : {}),
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
  try {
    const outcome = await composition.run({ maxEffects: 8 });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } finally {
    await gitAuth.dispose();
  }
}

export type IntegrationRuntimeConfig = {
  remote: string;
  branch: string;
  sourcePullRequestNumber: number;
  sourceLogin: string;
  commentOwner: TrustedPrincipal;
  apiOrigin?: string;
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
  const apiOrigin = input.env.HELLO_FROM_MAIN_API_ORIGIN;
  if (
    !commentOwnerId ||
    (commentOwnerType !== "Bot" && commentOwnerType !== "User") ||
    !/^[1-9][0-9]*$/u.test(commentOwnerId)
  )
    throw new Error(
      "comment owner principal requires a canonical ID and exact actor type",
    );
  const commentOwner: TrustedPrincipal = {
    actorId: commentOwnerId,
    actorType: commentOwnerType,
  };
  return {
    remote: input.env.HELLO_FROM_MAIN_REMOTE || "origin",
    branch: `feature/card-${login}-source-${number}`,
    sourcePullRequestNumber: number,
    sourceLogin: login,
    commentOwner,
    ...(apiOrigin ? { apiOrigin } : {}),
  };
}

function bindProductionSetup(
  github: GithubPlatform,
  runtime: IntegrationRuntimeConfig,
  workspace: RealGitWorkspace,
): GithubPlatform {
  return {
    ...github,
    async createIntegrationBranch(input, _context) {
      // The RealGitWorkspace is authoritative for the shell commit. The provider
      // ref call remains the durable anchor/readback path and is idempotent when
      // the shell push won the race or the previous response was lost.
      if (!input.cardPath || !input.cardBytes)
        return {
          kind: "retryableTransport",
          detail: "Project Shell bytes are required",
        };
      try {
        const result = await workspace.createIntegrationBranchWithProjectShell({
          name: runtime.branch,
          fromMainOid: input.fromMainOid as import("../core/model.js").Oid,
          cardPath: input.cardPath,
          cardBytes: input.cardBytes,
        });
        const anchor = await github.createIntegrationBranch(
          { name: runtime.branch, fromMainOid: input.fromMainOid },
          _context,
        );
        return anchor.kind === "permissionDenied" || anchor.kind === "notFound"
          ? anchor
          : { kind: "alreadyApplied", value: result };
      } catch {
        return {
          kind: "retryableTransport",
          detail: "Project Shell setup did not complete",
        };
      }
    },
  };
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
