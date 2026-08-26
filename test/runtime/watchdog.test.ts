import { describe, expect, test, vi } from "vitest";
import { createGithubTransport } from "../../src/entry/action-runtime.js";
import { discoverActiveRunAnchors } from "../../src/entry/watchdog.js";

describe("scheduled watchdog discovery", () => {
  test("pages bounded eligible exact anchors and ignores malformed refs", async () => {
    const pages: number[] = [];
    const result = await discoverActiveRunAnchors({
      owner: "acme",
      repo: "hello",
      maxPages: 2,
      transport: {
        rest: async (request) => {
          const page = request.path.includes("page=2") ? 2 : 1;
          pages.push(page);
          return page === 1
            ? {
                status: 200,
                data: [
                  {
                    number: 7,
                    user: { login: "alice" },
                    head: { ref: "add/alice" },
                  },
                  {
                    number: 8,
                    user: { login: "alice" },
                    head: { ref: "add/other" },
                  },
                  {
                    number: "bad",
                    user: { login: "bob" },
                    head: { ref: "add/bob" },
                  },
                ],
                headers: {
                  link: '<https://api.github.com/repos/acme/hello/pulls?state=open&per_page=100&page=2>; rel="next"',
                },
              }
            : {
                status: 200,
                data: [
                  {
                    number: 9,
                    user: { login: "bob" },
                    head: { ref: "add/bob" },
                  },
                ],
              };
        },
        graphql: async () => ({ data: {} }),
      },
    });
    expect(result).toEqual({
      kind: "ready",
      anchors: [
        { sourcePullRequestNumber: 7, sourceLogin: "alice" },
        { sourcePullRequestNumber: 9, sourceLogin: "bob" },
      ],
    });
    expect(pages).toEqual([1, 2]);
  });

  test("returns no anchors when no eligible source PR exists", async () => {
    await expect(
      discoverActiveRunAnchors({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async () => ({
            status: 200,
            data: [{ number: 1, head: { ref: "feature/card-x" } }],
          }),
          graphql: async () => ({ data: {} }),
        },
      }),
    ).resolves.toEqual({ kind: "ready", anchors: [] });
  });

  test("recovers a closed Contribution through its open Integration anchor", async () => {
    await expect(
      discoverActiveRunAnchors({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async (request) =>
            request.path.endsWith("/pulls/7")
              ? {
                  status: 200,
                  data: {
                    number: 7,
                    state: "closed",
                    user: { login: "alice" },
                  },
                }
              : {
                  status: 200,
                  data: [
                    {
                      number: 2,
                      state: "open",
                      head: { ref: "feature/card-alice-source-7" },
                    },
                  ],
                },
          graphql: async () => ({ data: {} }),
        },
      }),
    ).resolves.toEqual({
      kind: "ready",
      anchors: [{ sourcePullRequestNumber: 7, sourceLogin: "alice" }],
    });
  });

  test("fails closed instead of silently truncating after the page budget", async () => {
    await expect(
      discoverActiveRunAnchors({
        owner: "acme",
        repo: "hello",
        maxPages: 4,
        transport: {
          rest: async (_request) => ({
            status: 200,
            data: Array.from({ length: 100 }, () => ({ head: { ref: "x" } })),
            headers: {
              link: '<https://api.github.com/repos/acme/hello/pulls?state=open&per_page=100&page=5>; rel="next"',
            },
          }),
          graphql: async () => ({ data: {} }),
        },
      }),
    ).resolves.toEqual({
      kind: "incomplete",
      reason: "nonprogressing pagination Link",
    });
  });

  test("follows raw production Link headers through a GHES API base path", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("page=2"))
        return new Response(
          JSON.stringify([{ head: { ref: "feature/card-alice-source-7" } }]),
        );
      if (url.includes("/api/v3/repos/acme/hello/pulls?state=open"))
        return new Response(
          JSON.stringify(
            Array.from({ length: 100 }, () => ({ head: { ref: "unrelated" } })),
          ),
          {
            headers: {
              Link: '<https://ghe.example/api/v3/repos/acme/hello/pulls?state=open&per_page=100&page=2>; rel="next"',
            },
          },
        );
      if (url.endsWith("/api/v3/repos/acme/hello/pulls/7"))
        return new Response(
          JSON.stringify({
            number: 7,
            state: "closed",
            user: { login: "alice" },
          }),
        );
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      discoverActiveRunAnchors({
        owner: "acme",
        repo: "hello",
        apiOrigin: "https://ghe.example/api/v3",
        transport: createGithubTransport("token", "https://ghe.example/api/v3"),
      }),
    ).resolves.toEqual({
      kind: "ready",
      anchors: [{ sourcePullRequestNumber: 7, sourceLogin: "alice" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://ghe.example/api/v3/repos/acme/hello/pulls?state=open&per_page=100&page=2",
    );
    vi.unstubAllGlobals();
  });

  test.each([
    [
      '<https://api.github.com/repos/acme/other/pulls?state=open&per_page=100&page=2>; rel="next"',
      "untrusted next pagination URL: actual=https://api.github.com/repos/acme/other/pulls; expected=https://api.github.com/repos/acme/hello/pulls",
    ],
    [
      '<https://api.github.com/repos/acme/hello/pulls?state=open&per_page=100&page=1>; rel="next"',
      "nonprogressing pagination Link",
    ],
    [
      '<https://api.github.com/repos/acme/hello/pulls?page=2>; rel="last"',
      "missing pull request pagination continuation",
    ],
  ])("fails closed for malformed watchdog Link %s", async (link, reason) => {
    await expect(
      discoverActiveRunAnchors({
        owner: "acme",
        repo: "hello",
        transport: {
          rest: async () => ({
            status: 200,
            data: [{ head: { ref: "unrelated" } }],
            headers: { link },
          }),
          graphql: async () => ({ data: {} }),
        },
      }),
    ).resolves.toEqual({ kind: "incomplete", reason });
  });
});
