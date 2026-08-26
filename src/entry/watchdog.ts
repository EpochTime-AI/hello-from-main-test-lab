import type { OctokitRequestTransport } from "../adapters/octokit.js";

export type ActiveRunAnchor = {
  sourcePullRequestNumber: number;
  sourceLogin: string;
};
export type ActiveRunDiscovery =
  | { kind: "ready"; anchors: readonly ActiveRunAnchor[] }
  | { kind: "incomplete"; reason: string };

/** Discovery only wakes the normal exact-anchor Core; it owns no workflow state. */
export async function discoverActiveRunAnchors(input: {
  owner: string;
  repo: string;
  transport: OctokitRequestTransport;
  apiOrigin?: string;
  maxPages?: number;
}): Promise<ActiveRunDiscovery> {
  const anchors: ActiveRunAnchor[] = [];
  const integrationAnchors: ActiveRunAnchor[] = [];
  const maxPages = input.maxPages ?? 100;
  const trustedApi = new URL(input.apiOrigin ?? "https://api.github.com");
  trustedApi.search = "";
  trustedApi.hash = "";
  trustedApi.pathname = trustedApi.pathname.replace(/\/+$/u, "");
  const pullsPath = `${trustedApi.pathname.replace(/\/+$/u, "")}/repos/${input.owner}/${input.repo}/pulls`;
  const seenLinks = new Set<string>();
  let pageUrl: string | undefined;
  let currentPage = 1;
  for (let count = 0; count < maxPages; count += 1) {
    const response = await input.transport.rest({
      method: "GET",
      path: pageUrl ?? `/repos/${input.owner}/${input.repo}/pulls`,
      ...(!pageUrl
        ? { parameters: { state: "open", per_page: 100, page: 1 } }
        : {}),
    });
    if (response.status !== 200 || !Array.isArray(response.data))
      return { kind: "incomplete", reason: "malformed pull request page" };
    for (const raw of response.data) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const head =
        item.head && typeof item.head === "object"
          ? (item.head as Record<string, unknown>)
          : {};
      const user =
        item.user && typeof item.user === "object"
          ? (item.user as Record<string, unknown>)
          : {};
      const number = item.number;
      const login = user.login;
      if (
        head.ref === `add/${login}` &&
        typeof login === "string" &&
        /^[A-Za-z0-9-]+$/u.test(login) &&
        typeof number === "number" &&
        Number.isSafeInteger(number) &&
        number > 0
      )
        anchors.push({ sourcePullRequestNumber: number, sourceLogin: login });
      const integration =
        /^feature\/card-([A-Za-z0-9-]+)-source-([1-9][0-9]*)$/u.exec(
          typeof head.ref === "string" ? head.ref : "",
        );
      if (integration?.[1] && integration[2])
        integrationAnchors.push({
          sourceLogin: integration[1],
          sourcePullRequestNumber: Number(integration[2]),
        });
    }
    const next = nextPullsLink(
      response.headers?.link,
      trustedApi,
      pullsPath,
      currentPage,
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
        reason: "missing pull request pagination continuation",
      };
    for (const anchor of integrationAnchors) {
      const source = await input.transport.rest({
        method: "GET",
        path: `/repos/${input.owner}/${input.repo}/pulls/${anchor.sourcePullRequestNumber}`,
      });
      const record = asRecord(source.data);
      const user = asRecord(record.user);
      if (
        source.status !== 200 ||
        record.number !== anchor.sourcePullRequestNumber ||
        user.login !== anchor.sourceLogin
      )
        return {
          kind: "incomplete",
          reason: "Integration source anchor readback failed",
        };
      anchors.push(anchor);
    }
    return {
      kind: "ready",
      anchors: [
        ...new Map(
          anchors.map((item) => [
            `${item.sourcePullRequestNumber}:${item.sourceLogin}`,
            item,
          ]),
        ).values(),
      ],
    };
  }
  return {
    kind: "incomplete",
    reason: "pull request pagination budget exhausted",
  };
}

function nextPullsLink(
  header: string | undefined,
  trustedApi: URL,
  pullsPath: string,
  currentPage: number,
):
  | { url?: undefined; hasLinks: boolean; kind: "valid" }
  | { url: string; page: number; hasLinks: true; kind: "valid" }
  | { kind: "invalid"; reason: string } {
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
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "invalid", reason: "malformed next pagination URL" };
  }
  if (url.origin !== trustedApi.origin || url.pathname !== pullsPath)
    return {
      kind: "invalid",
      reason: `untrusted next pagination URL: actual=${url.origin}${url.pathname}; expected=${trustedApi.origin}${pullsPath}`,
    };
  if (
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (key) => !["state", "per_page", "page"].includes(key),
    ) ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("per_page").length !== 1 ||
    url.searchParams.getAll("page").length !== 1 ||
    url.searchParams.get("state") !== "open" ||
    url.searchParams.get("per_page") !== "100"
  )
    return { kind: "invalid", reason: "malformed next pagination query" };
  const nextPage = Number(url.searchParams.get("page"));
  if (!Number.isSafeInteger(nextPage) || nextPage <= currentPage)
    return { kind: "invalid", reason: "nonprogressing pagination Link" };
  return { kind: "valid", url: url.toString(), page: nextPage, hasLinks: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
