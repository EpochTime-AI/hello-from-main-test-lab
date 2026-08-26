import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
function stripComment(value) {
  let quote;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote && value[index - 1] !== "\\") quote = undefined;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(value[index - 1])))
      return value.slice(0, index).trimEnd();
  }
  return value;
}

function splitFlowItems(value, lineNumber) {
  if (!value.startsWith("[") || !value.endsWith("]"))
    throw new Error(`line ${lineNumber}: invalid flow sequence`);
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const items = [];
  let start = 0;
  let quote;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (character === quote && body[index - 1] !== "\\") quote = undefined;
    } else if (character === "'" || character === '"') quote = character;
    else if (character === ",") {
      items.push(parseScalar(body.slice(start, index).trim(), lineNumber));
      start = index + 1;
    }
  }
  items.push(parseScalar(body.slice(start).trim(), lineNumber));
  return items;
}

function parseScalar(value, lineNumber) {
  if (value.startsWith("[") || value.endsWith("]"))
    return splitFlowItems(value, lineNumber);
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`line ${lineNumber}: invalid double-quoted scalar`);
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'"))
      throw new Error(`line ${lineNumber}: invalid single-quoted scalar`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (!value) return null;
  return value;
}

function parseYaml(source, file) {
  const lines = source.split(/\r?\n/).map((text, index) => {
    if (text.includes("\t")) throw new Error(`${file}:${index + 1}: tabs are not valid indentation`);
    const content = stripComment(text);
    return {
      number: index + 1,
      indent: content.match(/^ */u)?.[0].length ?? 0,
      text: content.trim(),
    };
  }).filter((line) => line.text);

  function parseBlock(position, indent) {
    const first = lines[position];
    if (!first || first.indent !== indent)
      throw new Error(`${file}:${first?.number ?? "?"}: expected indentation of ${indent}`);
    return first.text.startsWith("-")
      ? parseSequence(position, indent)
      : parseMapping(position, indent);
  }

  function parseMapping(position, indent) {
    const mapping = {};
    while (position < lines.length && lines[position].indent === indent) {
      const line = lines[position];
      if (line.text.startsWith("-"))
        throw new Error(`${file}:${line.number}: sequence item is not a mapping entry`);
      const match = line.text.match(/^([^:#][^:]*):(?:\s+(.*))?$/u);
      if (!match) throw new Error(`${file}:${line.number}: invalid mapping entry`);
      const key = match[1].trim();
      if (!key || Object.hasOwn(mapping, key))
        throw new Error(`${file}:${line.number}: duplicate or empty mapping key ${key}`);
      const value = match[2] ?? "";
      position += 1;
      if (value === "") {
        if (position < lines.length && lines[position].indent > indent) {
          if (lines[position].indent !== indent + 2)
            throw new Error(`${file}:${lines[position].number}: unexpected indentation`);
          const parsed = parseBlock(position, lines[position].indent);
          mapping[key] = parsed.value;
          position = parsed.position;
        } else mapping[key] = null;
      } else if (value === "|" || value === ">") {
        throw new Error(`${file}:${line.number}: multiline scalars are not supported`);
      } else {
        mapping[key] = parseScalar(value, line.number);
      }
      if (position < lines.length && lines[position].indent < indent) break;
      if (position < lines.length && lines[position].indent > indent)
        throw new Error(`${file}:${lines[position].number}: unexpected indentation`);
    }
    return { value: mapping, position };
  }

  function parseSequence(position, indent) {
    const sequence = [];
    while (position < lines.length && lines[position].indent === indent) {
      const line = lines[position];
      if (!line.text.startsWith("-"))
        throw new Error(`${file}:${line.number}: mapping entry is not a sequence item`);
      const remainder = line.text.slice(1).trim();
      if (!remainder) throw new Error(`${file}:${line.number}: empty sequence item`);
      const match = remainder.match(/^([^:#][^:]*):(?:\s+(.*))?$/u);
      if (!match) {
        sequence.push(parseScalar(remainder, line.number));
        position += 1;
        continue;
      }
      const item = {};
      const key = match[1].trim();
      item[key] = match[2] ? parseScalar(match[2], line.number) : null;
      position += 1;
      if (position < lines.length && lines[position].indent > indent) {
        if (lines[position].indent !== indent + 2)
          throw new Error(`${file}:${lines[position].number}: unexpected indentation`);
        const parsed = parseMapping(position, lines[position].indent);
        Object.assign(item, parsed.value);
        position = parsed.position;
      }
      sequence.push(item);
    }
    return { value: sequence, position };
  }

  if (!lines.length) throw new Error(`${file}: document is empty`);
  const parsed = parseBlock(0, lines[0].indent);
  if (parsed.position !== lines.length)
    throw new Error(`${file}:${lines[parsed.position].number}: unparsed YAML content`);
  return parsed.value;
}

function parseArguments(argv) {
  const options = {
    workflowsDir: join(repository, ".github", "workflows"),
    action: join(repository, "action.yml"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--workflows-dir") options.workflowsDir = argv[++index];
    else if (argument === "--action") options.action = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const files = (await readdir(options.workflowsDir)).filter((file) =>
  /\.ya?ml$/.test(file),
);
for (const file of files) {
  const path = join(options.workflowsDir, file);
  const source = await readFile(path, "utf8");
  parseYaml(source, path);
  if (source.includes("pull_request_target") || source.includes("GITHUB_HEAD_REF"))
    throw new Error(`${file} uses an untrusted PR execution boundary`);
  if (/uses:\s+(?!\.:)[^\s]+/.test(source) && !source.includes("actions/checkout@v4"))
    throw new Error(`${file} must not invoke third-party Actions in this offline scaffold`);
  if (!source.includes("concurrency:") || !source.includes("cancel-in-progress:"))
    throw new Error(`${file} must declare repository concurrency policy`);
  if (file === "controller.yml" || file === "watchdog.yml") {
    for (const name of [
      "HELLO_FROM_MAIN_COMMENT_OWNER_ID",
      "HELLO_FROM_MAIN_COMMENT_OWNER_TYPE",
    ])
      if (!source.includes(`${name}: \${{ vars.${name} }}`))
        throw new Error(`${file} must wire ${name} from a repository variable`);
  }
}

const actionSource = await readFile(options.action, "utf8");
const action = parseYaml(actionSource, options.action);
const actionKeys = new Set([
  "name",
  "description",
  "author",
  "branding",
  "inputs",
  "outputs",
  "runs",
]);
if (!action || typeof action !== "object" || Array.isArray(action))
  throw new Error(`${options.action} has invalid Action metadata: root must be a mapping`);
const unsupported = Object.keys(action).filter((key) => !actionKeys.has(key));
if (unsupported.length)
  throw new Error(`${options.action} has invalid Action metadata: unsupported top-level keys: ${unsupported.join(", ")}`);
if (!Object.hasOwn(action, "runs"))
  throw new Error(`${options.action} must define Action runtime metadata`);
