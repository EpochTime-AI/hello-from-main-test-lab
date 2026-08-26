import { describe, expect, test } from "vitest";
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
          const page = Number(request.parameters?.page);
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
                nextPage: 2,
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
    expect(result).toEqual([
      { sourcePullRequestNumber: 7, sourceLogin: "alice" },
      { sourcePullRequestNumber: 9, sourceLogin: "bob" },
    ]);
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
    ).resolves.toEqual([]);
  });
});
