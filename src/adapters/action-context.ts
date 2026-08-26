import { readFile } from "node:fs/promises";

export type TrustedActionContext = {
  repository: string;
  ref: string;
  sha: string;
  eventPath: string;
  eventName?: string;
  sourcePullRequest?: {
    number: number;
    authorLogin?: string;
    headRef?: string;
    baseRef?: string;
    baseRepository?: string;
  };
};

export async function createTrustedActionContext(input: {
  env?: NodeJS.ProcessEnv;
  defaultBranch: string;
}): Promise<TrustedActionContext> {
  const env = input.env ?? process.env;
  const eventPath = required(env.GITHUB_EVENT_PATH, "GITHUB_EVENT_PATH");
  const repository = required(env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const eventRuntimeRef = required(env.GITHUB_REF, "GITHUB_REF");
  const ref = required(
    env.HELLO_FROM_MAIN_TRUSTED_SOURCE_REF,
    "HELLO_FROM_MAIN_TRUSTED_SOURCE_REF",
  );
  const sha = required(env.GITHUB_SHA, "GITHUB_SHA");
  if (ref !== `refs/heads/${input.defaultBranch}`)
    throw new Error("event must run from the trusted default branch");
  let event: unknown;
  try {
    event = JSON.parse(await readFile(eventPath, "utf8"));
  } catch {
    throw new Error("GITHUB_EVENT_PATH is malformed or unreadable");
  }
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("GITHUB_EVENT_PATH must contain an object");
  const record = event as Record<string, unknown>;
  const eventRef = typeof record.ref === "string" ? record.ref : undefined;
  const eventSha =
    typeof record.after === "string"
      ? record.after
      : typeof record.sha === "string"
        ? record.sha
        : undefined;
  const eventRepository =
    record.repository && typeof record.repository === "object"
      ? (record.repository as Record<string, unknown>).full_name
      : undefined;
  const pullRequest = asRecord(record.pull_request);
  const isPullRequestEvent = env.GITHUB_EVENT_NAME === "pull_request";
  if (eventRef && eventRef !== eventRuntimeRef && !isPullRequestEvent)
    throw new Error("event ref does not match trusted runtime ref");
  if (eventSha && eventSha !== sha && !isPullRequestEvent)
    throw new Error("event SHA does not match trusted runtime SHA");
  if (eventRepository && eventRepository !== repository)
    throw new Error(
      "event repository does not match trusted runtime repository",
    );
  const defaultBranch = asRecord(eventRepositoryValue(record)).default_branch;
  if (defaultBranch && defaultBranch !== input.defaultBranch)
    throw new Error("event repository default branch is not trusted");
  let sourcePullRequest: TrustedActionContext["sourcePullRequest"];
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
      ...(typeof asRecord(pullRequest.user).login === "string"
        ? { authorLogin: asRecord(pullRequest.user).login as string }
        : {}),
      headRef,
      baseRef: input.defaultBranch,
      baseRepository: repository,
    };
  }
  return {
    repository,
    ref,
    sha,
    eventPath,
    ...(env.GITHUB_EVENT_NAME ? { eventName: env.GITHUB_EVENT_NAME } : {}),
    ...(sourcePullRequest ? { sourcePullRequest } : {}),
  };
}

function eventRepositoryValue(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return record.repository && typeof record.repository === "object"
    ? (record.repository as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
