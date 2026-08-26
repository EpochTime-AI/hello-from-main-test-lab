import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "dist", "index.js");
await access(output);
const source = await readFile(output, "utf8");
if (!source.includes("createReconciler")) throw new Error("built artifact does not contain production Core");
if (source.includes("GITHUB_HEAD_REF"))
  throw new Error("built artifact contains an unsafe execution boundary");
if (!/expectedCommentOwner:\s*runtime\.commentOwner/u.test(source))
  throw new Error("built artifact does not wire the required comment capability");
if (!source.includes("comment owner principal requires a canonical ID and exact actor type"))
  throw new Error("built artifact permits an untrusted comment owner");
const run = promisify(execFile);
const result = await run(process.execPath, [output], {
  env: {
    ...process.env,
    GITHUB_REF: "refs/heads/main",
    DEFAULT_BRANCH: "main",
    HELLO_FROM_MAIN_TRUSTED_SOURCE_REF: "refs/heads/main",
    HELLO_FROM_MAIN_TEST_MODE: "1",
    NODE_ENV: "production",
  },
});
if (!result.stdout.includes('"kind":"retryable"'))
  throw new Error("built artifact did not execute locally");
