import { describe, expect, test, vi } from "vitest";
import {
  createGithubTransport,
  deriveIntegrationRuntimeConfig,
} from "../../src/entry/action-runtime.js";

describe("production integration runtime configuration", () => {
  test("derives the branch and required trusted comment principal from configuration", () => {
    expect(
      deriveIntegrationRuntimeConfig({
        env: {
          HELLO_FROM_MAIN_COMMENT_OWNER_ID: "42",
          HELLO_FROM_MAIN_COMMENT_OWNER_TYPE: "Bot",
        },
        defaultBranch: "main",
        context: {
          sourcePullRequest: { number: 42, authorLogin: "alice" },
        },
      }),
    ).toEqual({
      remote: "origin",
      branch: "feature/card-alice-source-42",
      sourcePullRequestNumber: 42,
      sourceLogin: "alice",
      commentOwner: { actorId: "42", actorType: "Bot" },
      apiOrigin: "https://api.github.com",
      webBaseUrl: "https://github.com",
    });
  });

  test("fails closed when the required comment principal is absent", () => {
    expect(() =>
      deriveIntegrationRuntimeConfig({
        env: {
          HELLO_FROM_MAIN_API_ORIGIN:
            "https://github.enterprise.example/api/v3",
          GITHUB_API_URL: "https://github.enterprise.example/api/v3",
          GITHUB_SERVER_URL: "https://github.enterprise.example",
        },
        defaultBranch: "main",
        context: {
          sourcePullRequest: { number: 42, authorLogin: "alice" },
        },
      }),
    ).toThrow("comment owner principal");
  });

  test("uses the public GitHub Actions principal only on the public API host", () => {
    const base = {
      defaultBranch: "main",
      context: { sourcePullRequest: { number: 42, authorLogin: "alice" } },
    };
    expect(
      deriveIntegrationRuntimeConfig({
        ...base,
        env: {
          GITHUB_API_URL: "https://api.github.com",
          GITHUB_SERVER_URL: "https://github.com",
        },
      }),
    ).toMatchObject({
      commentOwner: { actorId: "41898282", actorType: "Bot" },
    });
    expect(() =>
      deriveIntegrationRuntimeConfig({
        ...base,
        env: {
          HELLO_FROM_MAIN_API_ORIGIN:
            "https://github.enterprise.example/api/v3",
        },
      }),
    ).toThrow("coherent");
    expect(
      deriveIntegrationRuntimeConfig({
        ...base,
        env: {
          HELLO_FROM_MAIN_COMMENT_OWNER_ID: "42",
          HELLO_FROM_MAIN_COMMENT_OWNER_TYPE: "Bot",
        },
      }),
    ).toMatchObject({ commentOwner: { actorId: "42", actorType: "Bot" } });
  });

  test("uses standard GHES identity, rejects public fallback, and permits only coherent custom origins", () => {
    const base = {
      defaultBranch: "main",
      context: { sourcePullRequest: { number: 42, authorLogin: "alice" } },
    };
    const ghes = {
      GITHUB_API_URL: "https://github.enterprise.example/api/v3",
      GITHUB_SERVER_URL: "https://github.enterprise.example",
    };
    expect(() =>
      deriveIntegrationRuntimeConfig({ ...base, env: ghes }),
    ).toThrow("comment owner principal");
    expect(
      deriveIntegrationRuntimeConfig({
        ...base,
        env: {
          ...ghes,
          HELLO_FROM_MAIN_COMMENT_OWNER_ID: "42",
          HELLO_FROM_MAIN_COMMENT_OWNER_TYPE: "Bot",
          HELLO_FROM_MAIN_API_ORIGIN:
            "https://github.enterprise.example/api/v3/",
        },
      }),
    ).toMatchObject({
      apiOrigin: "https://github.enterprise.example/api/v3",
      webBaseUrl: "https://github.enterprise.example",
      commentOwner: { actorId: "42", actorType: "Bot" },
    });
    expect(() =>
      deriveIntegrationRuntimeConfig({
        ...base,
        env: {
          ...ghes,
          HELLO_FROM_MAIN_COMMENT_OWNER_ID: "42",
          HELLO_FROM_MAIN_COMMENT_OWNER_TYPE: "Bot",
          HELLO_FROM_MAIN_API_ORIGIN: "https://api.github.com",
        },
      }),
    ).toThrow("coherent");
    expect(() =>
      deriveIntegrationRuntimeConfig({
        ...base,
        env: {
          GITHUB_API_URL: "https://api.github.com",
          GITHUB_SERVER_URL: "https://github.enterprise.example",
        },
      }),
    ).toThrow("coherent");
  });

  test("rejects untrusted public and GHES origin shapes before composition", () => {
    const base = {
      defaultBranch: "main",
      context: { sourcePullRequest: { number: 42, authorLogin: "alice" } },
    };
    for (const env of [
      {
        GITHUB_API_URL: "http://github.enterprise.example/api/v3",
        GITHUB_SERVER_URL: "http://github.enterprise.example",
      },
      {
        GITHUB_API_URL: "https://user@githu b.enterprise.example/api/v3",
        GITHUB_SERVER_URL: "https://github.enterprise.example",
      },
      {
        GITHUB_API_URL: "https://github.enterprise.example/api/v3",
        GITHUB_SERVER_URL: "https://github.enterprise.example/root",
      },
      {
        GITHUB_API_URL: "https://github.enterprise.example/not-github",
        GITHUB_SERVER_URL: "https://github.enterprise.example",
      },
      {
        GITHUB_API_URL: "https://github.enterprise.example/api/v3?x=1",
        GITHUB_SERVER_URL: "https://github.enterprise.example",
      },
      {
        GITHUB_API_URL: "https://github.com/api/v3",
        GITHUB_SERVER_URL: "https://github.com",
      },
    ])
      expect(() =>
        deriveIntegrationRuntimeConfig({
          ...base,
          env: {
            ...env,
            HELLO_FROM_MAIN_COMMENT_OWNER_ID: "42",
            HELLO_FROM_MAIN_COMMENT_OWNER_TYPE: "Bot",
          },
        }),
      ).toThrow("trusted GitHub");
  });

  test("sends no-cache only when the adapter requests a fresh comment read", async () => {
    let headers: HeadersInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL, init?: RequestInit) => {
        headers = init?.headers;
        return new Response("{}", { status: 200 });
      }),
    );
    await createGithubTransport("token").rest({
      method: "GET",
      path: "/repos/acme/hello/issues/7/comments",
      headers: { "cache-control": "no-cache" },
    });
    expect(new Headers(headers).get("cache-control")).toBe("no-cache");
    vi.unstubAllGlobals();
  });

  test("fails closed when source PR identity cannot be derived", () => {
    expect(() =>
      deriveIntegrationRuntimeConfig({
        env: {},
        defaultBranch: "main",
        context: {},
      }),
    ).toThrow("source pull request number");
  });

  test("derives a lossless expected comment principal from explicit configuration", () => {
    expect(
      deriveIntegrationRuntimeConfig({
        env: {
          HELLO_FROM_MAIN_COMMENT_OWNER_ID: "9007199254740991",
          HELLO_FROM_MAIN_COMMENT_OWNER_TYPE: "Bot",
        },
        defaultBranch: "main",
        context: {
          sourcePullRequest: { number: 42, authorLogin: "alice" },
        },
      }),
    ).toMatchObject({
      commentOwner: { actorId: "9007199254740991", actorType: "Bot" },
    });
  });

  test("rejects incomplete or non-canonical comment principal configuration", () => {
    expect(() =>
      deriveIntegrationRuntimeConfig({
        env: { HELLO_FROM_MAIN_COMMENT_OWNER_ID: "42.0" },
        defaultBranch: "main",
        context: {
          sourcePullRequest: { number: 42, authorLogin: "alice" },
        },
      }),
    ).toThrow("comment owner principal");
  });

  test("uses one GHES REST base path for comments and the matching GraphQL endpoint", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        urls.push(String(input));
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: {} }),
        };
      }),
    );
    const transport = createGithubTransport(
      "token",
      "https://github.enterprise.example/api/v3/",
    );
    await transport.rest({
      method: "GET",
      path: "/repos/acme/hello/issues/7/comments",
    });
    await transport.rest({
      method: "POST",
      path: "/repos/acme/hello/issues/7/comments",
      parameters: { body: "body" },
    });
    await transport.rest({
      method: "GET",
      path: "/repos/acme/hello/issues/comments/123",
    });
    await transport.rest({
      method: "PATCH",
      path: "/repos/acme/hello/issues/comments/123",
      parameters: { body: "body" },
    });
    await transport.graphql({ query: "query", variables: {} });
    expect(urls).toEqual([
      "https://github.enterprise.example/api/v3/repos/acme/hello/issues/7/comments",
      "https://github.enterprise.example/api/v3/repos/acme/hello/issues/7/comments",
      "https://github.enterprise.example/api/v3/repos/acme/hello/issues/comments/123",
      "https://github.enterprise.example/api/v3/repos/acme/hello/issues/comments/123",
      "https://github.enterprise.example/api/graphql",
    ]);
    vi.unstubAllGlobals();
  });

  test("keeps public GitHub GraphQL at the public endpoint", async () => {
    let url = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        url = String(input);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ data: {} }),
        };
      }),
    );
    const transport = createGithubTransport("token");
    await transport.graphql({ query: "query", variables: {} });
    expect(url).toBe("https://api.github.com/graphql");
    vi.unstubAllGlobals();
  });

  test("preserves lowercased wire response headers for REST replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("{}", {
            status: 403,
            headers: {
              Link: '<https://api.github.com/next?page=2>; rel="next"',
              "Retry-After": "12",
              "X-RateLimit-Reset": "123",
              "X-RateLimit-Remaining": "0",
            },
          }),
      ),
    );
    const response = await createGithubTransport("token").rest({
      method: "GET",
      path: "/repos/acme/hello/issues/7/comments",
    });
    expect(response.headers).toMatchObject({
      link: '<https://api.github.com/next?page=2>; rel="next"',
      "retry-after": "12",
      "x-ratelimit-reset": "123",
      "x-ratelimit-remaining": "0",
    });
    vi.unstubAllGlobals();
  });
});
