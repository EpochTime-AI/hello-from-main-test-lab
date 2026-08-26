import type { OctokitRequestTransport } from "../adapters/octokit.js";

export type ActiveRunAnchor = {
  sourcePullRequestNumber: number;
  sourceLogin: string;
};

/** Discovery only wakes the normal exact-anchor Core; it owns no workflow state. */
export async function discoverActiveRunAnchors(input: {
  owner: string;
  repo: string;
  transport: OctokitRequestTransport;
  maxPages?: number;
}): Promise<readonly ActiveRunAnchor[]> {
  const anchors: ActiveRunAnchor[] = [];
  const maxPages = input.maxPages ?? 4;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await input.transport.rest({
      method: "GET",
      path: `/repos/${input.owner}/${input.repo}/pulls`,
      parameters: { state: "open", per_page: 100, page },
    });
    if (!Array.isArray(response.data)) break;
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
    }
    if (!response.nextPage && response.data.length < 100) break;
  }
  return anchors;
}
