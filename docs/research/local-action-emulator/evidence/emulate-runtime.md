# `vercel-labs/emulate` Runtime Evidence Cache

## Scope And Revision

- Upstream: `https://github.com/vercel-labs/emulate`
- Local checkout: `/tmp/opencode/hello-main-emulate-spike`
- Exact commit: `d0219d05818adca4c12bb76ec79a7562c1766a3d`
- Revision metadata: `v0.10.0`, `2026-08-19T10:14:18-05:00`, subject `feat(cli): deliver generated secrets securely (#204)`
- Runtime: Node `v24.5.0`; upstream requires Node `>=24` and pnpm `>=11 <12` (`package.json:26-30`).

## Attempted Commands

| Command | Result | Evidence boundary |
| --- | --- | --- |
| `git rev-parse HEAD && git status --short && git log -1 --format='%cI %D %s' && node --version && pnpm --version` | Commit and Node version were read successfully. Corepack then downloaded pnpm `11.2.2`; the command exceeded the 120-second bound before returning pnpm version. | No package execution occurred. |
| `pnpm --filter @emulators/github test && pnpm --filter @emulators/core test` | pnpm invoked its lockfile dependency check, attempted `pnpm install`, then ended with `SIGTERM` after registry `ECONNRESET` and connection-timeout retries. | GitHub/core tests did not start. |
| `pnpm --filter @emulators/github build && pnpm --filter @emulators/core build && pnpm --filter @emulators/adapter-next build && pnpm --filter emulate build` | Same automatic install/check did not finish inside the 120-second command bound. | No `dist/` directory was produced. |
| `pnpm install --frozen-lockfile` | Retried with a 600-second bound. Registry requests repeatedly failed or retried (`error (23)`, slow package metadata/download requests); the command exceeded the bound. | No `node_modules/` or built packages exist in the checkout. |

No real GitHub credential, GitHub API call, or external repository was used.

## Source-Confirmed Runtime Shape

### Server And CLI

`createServer()` allocates a new `Store` and `WebhookDispatcher` every time (`packages/@emulators/core/src/server.ts:24-31`). `emulate start` calls `createServer`, seeds that fresh store, starts `serve`, and resets every store on `SIGINT`/`SIGTERM` (`packages/emulate/src/commands/start.ts:155-183`, `334-345`, `253-269`). Its public option set contains port, service, seed, base URL, portless, and generated-secrets file, but no state/persistence path (`packages/emulate/src/index.ts:32-68`).

**Classification:** CLI persistence is `unsupported`, not merely unexercised. A YAML/JSON seed is startup input, not a loaded post-mutation snapshot.

### Persistence-Capable Embedded Modes

`@emulators/adapter-next` and `@emulators/adapter-nuxt` accept a `PersistenceAdapter`, load JSON on first initialization, restore Store and token snapshots, and queue a snapshot after every mutating HTTP method (`packages/@emulators/adapter-next/src/index.ts:30-33`, `169-188`, `212-239`, `288-290`; `packages/@emulators/adapter-nuxt/src/index.ts:33-36`, `288-308`, `332-359`, `410-412`).

The supplied `filePersistence(path)` is only `readFile`/`writeFile`; it creates the parent directory but uses neither atomic rename nor file locking (`packages/@emulators/core/src/persistence.ts:9-22`). Adapter persistence errors are caught and logged, after the mutating response is already returned (`adapter-next/src/index.ts:177-188`, `283-292`). Webhook subscriptions and deliveries live in `WebhookDispatcher` arrays, outside `Store.snapshot()`, so they are not included in the embedded snapshot (`core/src/webhooks.ts:52-57`, `103-157`; `adapter-next/src/index.ts:66-81`).

**Classification:** embedded Store state can plausibly survive two handler instances with the same file, but the requested two-process comment/PR/ref/object readback was not executable because dependencies could not install. Persistence is asynchronous and not a write-acknowledged durability boundary; concurrent processes can overwrite each other's whole-file snapshots.

### Smart Git And GraphQL Source Scan

All commands below were run in `/tmp/opencode/hello-main-emulate-spike` at `d0219d05818adca4c12bb76ec79a7562c1766a3d`. The scope intentionally includes the GitHub service, shared core, and CLI runtime, but excludes examples, generated dependencies, and unrelated service packages. Each `NO_MATCHES` line is emitted only when `rg` exits `1`; any other nonzero exit exits the command.

| Scan purpose | Exact command | Captured output and interpretation |
| --- | --- | --- |
| Smart HTTP upload/receive pack routes and media types | `rg -n -i --glob '*.{ts,tsx,js,mjs,cjs}' 'git-upload-pack|git-receive-pack|application/x-git-(upload|receive)-pack|info/refs\?service=git-' packages/@emulators/github/src packages/@emulators/core/src packages/emulate/src; code=$?; if [ "$code" -eq 1 ]; then printf 'NO_MATCHES\n'; else exit "$code"; fi` | `NO_MATCHES`. No scoped source implements smart HTTP discovery, upload-pack, receive-pack, or their Git media types. |
| SSH server/runtime | `rg -n -i --glob '*.{ts,tsx,js,mjs,cjs}' 'ssh\.createServer|createServer\([^)]*ssh|ssh2|node:net|from "net"|from '\''net'\''|git@|ssh://' packages/@emulators/github/src packages/@emulators/core/src packages/emulate/src; code=$?; if [ "$code" -eq 1 ]; then printf 'NO_MATCHES\n'; else exit "$code"; fi` | Three incidental matches: `packages/emulate/src/__tests__/start-generated-secrets.test.ts:2` imports `node:net` for a test; `packages/@emulators/github/src/helpers.ts:273` formats an `ssh_url`; `packages/@emulators/github/src/routes/contents.ts:121` parses GitHub-hosted SSH URLs as input. None creates an SSH listener or accepts Git protocol traffic. |
| Git subprocess and repository/object storage | `rg -n -i --glob '*.{ts,tsx,js,mjs,cjs}' 'child_process|node:child_process|exec(File|Sync)?\(|spawn(Sync)?\(|git\s+(init|clone|fetch|push|update-ref|receive-pack|upload-pack)|git-dir|bare repository|objects/' packages/@emulators/github/src packages/@emulators/core/src packages/emulate/src; code=$?; if [ "$code" -eq 1 ]; then printf 'NO_MATCHES\n'; else exit "$code"; fi` | Incidental matches only: `packages/emulate/src/generated-secrets-file.ts:2,65` uses `spawnSync` for file ACL commands, and `packages/emulate/src/portless.ts:1,9,25,50,71,95` invokes the `portless` utility. Test mocks/imports also match. No result invokes a Git executable, opens a bare repository, or writes Git objects/refs. `core/src/http.ts:421` and `github/src/routes/search.ts` are regex uses caused by the broad `exec` term, not subprocesses. |
| GitHub GraphQL route/runtime | `rg -n -i --glob '*.{ts,tsx,js,mjs,cjs}' 'app\.(get|post|put|patch|delete)\("/graphql|/graphql|from "graphql"|from '\''graphql'\''|\bgraphql\(' packages/@emulators/github/src packages/@emulators/core/src packages/emulate/src; code=$?; if [ "$code" -eq 1 ]; then printf 'NO_MATCHES\n'; else exit "$code"; fi` | `NO_MATCHES`. There is no scoped GitHub/core/CLI GraphQL route, GraphQL import, or GraphQL execution call. |

The GitHub plugin explicitly registers REST route families at `packages/@emulators/github/src/index.ts:533-577`; REST Git Data is stored in emulator collections through `routes/branches.ts:683-1085`. `formatRepo` emits URL-shaped `git_url`, `ssh_url`, and `clone_url` fields at `helpers.ts:272-274`, but the scans show no corresponding protocol server. The separate Linear service has its own GraphQL router outside this scan scope, which demonstrates that a GraphQL endpoint would require explicit registration rather than arising from the shared server.

**Classification:** source confirms no scoped smart HTTP implementation and no GitHub GraphQL endpoint at this revision. The SSH/subprocess scans are not zero-result scans; their known incidental matches are distinguished above and do not implement Git serving or storage. URL fields must not be treated as evidence of Git connectivity.

## Required Runtime Matrix Status

| Matrix operation | Runtime result | Source result |
| --- | --- | --- |
| Issue comment create, update, list, get | `unknown`: server could not be built/started | Implemented as stateful collection mutations and reads: `comments.ts:88-148`, `427-517`. |
| Two-process server/API persistence | `unknown`: no runnable server and core server accepts no persistence adapter | Programmatic core server creates a new Store; no persistence attachment is exposed by `createServer`. |
| Two-process embedded persistence | `unknown`: no runnable adapter build | Snapshot/load/save implementation exists; atomicity and concurrent-writer safety are absent. |
| CLI two-process persistence | `unsupported` | CLI option and lifecycle source prove it always starts a fresh Store. |
| `git ls-remote`, clone, fetch, push against emulator | `unknown`: no runnable listening process | `not synchronized`: no smart Git protocol, SSH server, Git subprocess, or repository store in source. |
| REST Git Data mutation visible to a Git client | `unknown`: no runnable listening process | `not synchronized`: REST Git objects are Store collections only. |
| Real bare remote push visible through emulator API | `unknown`: no runnable listening process | `not synchronized`: no Git remote watcher, Git subprocess, or repository importer exists. |
| Emulator restart preserves Git/API identity | `unknown`: no runnable server | CLI loses Store state; embedded only restores Store JSON and has no real-Git identity. |
| Current `OctokitGithubPlatform` and Action transport against emulator | `not exercised`: no emulator process | `src/entry/action-runtime.ts:253-303` hardcodes both real-GitHub hosts. Upstream source has no GitHub GraphQL route, but no actual request, 404, URL capture, or no-fallback capture exists. |

## Reproducible Follow-Up Commands

After a successful frozen install, run these only against local temporary paths:

```bash
pnpm --filter @emulators/github test
pnpm --filter @emulators/core test
pnpm --filter @emulators/github build
pnpm --filter @emulators/core build
pnpm --filter @emulators/adapter-next build
pnpm --filter emulate build
pnpm --filter emulate exec emulate start --service github --port 4411 --seed /tmp/opencode/hello-main-emulate-spike/github-seed.yaml
git ls-remote http://127.0.0.1:4411/acme/hello.git
git clone http://127.0.0.1:4411/acme/hello.git /tmp/opencode/hello-main-emulate-spike/git-client
xh -I GET 'http://127.0.0.1:4411/acme/hello.git/info/refs?service=git-upload-pack'
xh -I POST http://127.0.0.1:4411/acme/hello.git/git-upload-pack
xh -I POST http://127.0.0.1:4411/acme/hello.git/git-receive-pack
```

The CLI command must be repeated with a declared state-file option if one is added. Reusing a seed file does not test persistence.
