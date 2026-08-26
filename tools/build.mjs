import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, "dist", "index.js");
await mkdir(dirname(output), { recursive: true });
await build({ entryPoints: [join(root, "..", "src", "entry", "action-runtime.ts")], bundle: true, platform: "node", target: "node24", format: "esm", outfile: output, banner: { js: "#!/usr/bin/env node" } });
await readFile(output, "utf8");
