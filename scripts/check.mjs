import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { lint } from "markdownlint/promise";

// Reads only the listed public docs and plugin sources; never scans or reads .env credential files.
export const markdownSources = Object.freeze([
  "README.md",
  "README.zh-CN.md",
  "OVERVIEW.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "CHANGELOG.md",
]);

const markdown = new MarkdownIt();
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const markdownLintConfig = Object.freeze({
  default: true,
  MD013: false,
  MD024: { siblings_only: true },
  MD033: false,
  MD036: false,
  MD041: false,
  MD060: false,
});

export async function validateMarkdownStyle(source, name = "document.md") {
  const result = await lint({
    strings: { [name]: source },
    config: markdownLintConfig,
  });
  return result[name];
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function isSensitivePath(target) {
  return target
    .replaceAll("\\", "/")
    .split("/")
    .some(
      (segment) =>
        /^\.env(?:\.|$)/i.test(segment) ||
        [".aws", ".ssh", ".gnupg", ".credentials", ".paseo"].includes(
          segment,
        ) ||
        /\.(?:pem|key|p12|pfx)$/i.test(segment),
    );
}

export function validatePluginManifest(source) {
  const errors = [];
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return ["paseo-plugin.json is not valid JSON."];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["paseo-plugin.json must be a JSON object."];
  }
  if (manifest.id !== "paseo-team") {
    errors.push("paseo-plugin.json id must be paseo-team.");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    errors.push("paseo-plugin.json must have a non-empty name.");
  }
  if (
    !manifest.requirements ||
    typeof manifest.requirements !== "object" ||
    typeof manifest.requirements.paseo !== "string" ||
    !manifest.requirements.paseo.trim()
  ) {
    errors.push(
      "paseo-plugin.json must declare a requirements.paseo version range.",
    );
  }
  return errors;
}

export function validateOverviewContent(source) {
  const errors = [];
  if (!source.trim()) {
    errors.push("OVERVIEW.md must not be empty.");
  }
  if (source.includes("—")) {
    errors.push(
      "OVERVIEW.md contains an em dash (—), which the Paseo plugin directory does not allow.",
    );
  }
  if (/\bpaseo\s+plugin\s+(?:install|add)\b/i.test(source)) {
    errors.push(
      "OVERVIEW.md must not contain an install command (the Paseo page already shows one).",
    );
  }
  return errors;
}

export function auditClientOrSharedSource(source, relativePath, kind) {
  const errors = [];
  if (
    /\bfrom\s+["']node:/.test(source) ||
    /\bimport\s*\(\s*["']node:/.test(source)
  ) {
    errors.push(`${relativePath}: ${kind} modules must not import node:*.`);
  }
  if (kind === "client" && /\bfrom\s+["'](?:\.\.?\/)+server\//.test(source)) {
    errors.push(
      `${relativePath}: client code must not import server/ modules.`,
    );
  }
  if (
    kind === "shared" &&
    /\bfrom\s+["'](?:(?:\.\.?\/)+(?:client|server)\/|react|react-native)/.test(
      source,
    )
  ) {
    errors.push(
      `${relativePath}: shared/ modules must not depend on client, server or React.`,
    );
  }
  if (kind === "client") {
    const domHit =
      /\b(?:document|window|localStorage|navigator)\.|className=|onClick=|<\/?(?:div|span|button|input|textarea|select|option|form|label|section|article|header|footer|main|nav|aside|p|a|ul|ol|li|table|thead|tbody|tr|td|th|svg|path|circle|rect|line|g|canvas|iframe|img|h[1-6])(?:\s|>|\/)/m.exec(
        source,
      );
    if (domHit) {
      errors.push(
        `${relativePath}: DOM/HTML usage (${domHit[0].trim()}) is not cross-platform and will crash on mobile.`,
      );
    }
  }
  return errors;
}

function collectDestinations(tokens, result = []) {
  for (const token of tokens) {
    if (token.type === "link_open") {
      result.push(token.attrGet("href"));
    } else if (token.type === "image") {
      result.push(token.attrGet("src"));
    }
    if (token.children) {
      collectDestinations(token.children, result);
    }
  }
  return result;
}

export async function validateMarkdownLinks(source, sourceFile, root) {
  const errors = [];
  const resolvedRoot = await realpath(root);
  for (const destination of new Set(
    collectDestinations(markdown.parse(source, {})),
  )) {
    if (!destination || destination.startsWith("#")) continue;
    if (
      /^[a-z][a-z\d+.-]*:/i.test(destination) &&
      !/^[a-z]:[\\/]/i.test(destination)
    ) {
      continue;
    }
    if (destination.startsWith("//")) continue;

    let localPath;
    try {
      localPath = decodeURIComponent(
        destination.split(/[?#]/, 1)[0],
      ).replaceAll("\\", "/");
    } catch {
      errors.push(`Link has invalid URL encoding: ${destination}`);
      continue;
    }
    if (!localPath) continue;
    if (
      path.isAbsolute(localPath) ||
      /^[a-z]:\//i.test(localPath) ||
      localPath.includes("\0")
    ) {
      errors.push(
        `Local links must be relative paths inside the repository: ${destination}`,
      );
      continue;
    }

    const target = path.resolve(path.dirname(sourceFile), localPath);
    if (!isWithin(root, target)) {
      errors.push(
        `Relative link points outside the repository: ${destination}`,
      );
      continue;
    }
    if (isSensitivePath(localPath)) {
      errors.push(
        "Doc link points to a sensitive file or credential directory; target not accessed.",
      );
      continue;
    }
    try {
      const resolvedTarget = await realpath(target);
      if (!isWithin(resolvedRoot, resolvedTarget)) {
        errors.push(
          `Relative link escapes the repository through a symlink: ${destination}`,
        );
      } else if (isSensitivePath(resolvedTarget)) {
        errors.push(
          "Doc link points to a sensitive file or credential directory; target not read.",
        );
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        errors.push(`Relative link target does not exist: ${destination}`);
      } else {
        errors.push(`Could not verify relative link target: ${destination}`);
      }
    }
  }
  return errors;
}

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (/\.(?:ts|tsx)$/.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

export async function checkRepository(
  root = repositoryRoot,
  { lintOnly = false } = {},
) {
  const errors = [];
  const resolvedRoot = await realpath(root);

  if (!lintOnly) {
    try {
      const manifestPath = path.join(root, "paseo-plugin.json");
      const resolvedManifest = await realpath(manifestPath);
      if (!isWithin(resolvedRoot, resolvedManifest)) {
        errors.push("paseo-plugin.json resolves outside the repository.");
      } else {
        errors.push(
          ...validatePluginManifest(await readFile(manifestPath, "utf8")),
        );
      }
    } catch {
      errors.push("paseo-plugin.json is missing or unreadable.");
    }

    const clientEntry = path.join(root, "index.client.tsx");
    const clientFiles = [
      clientEntry,
      ...(await listTsFiles(path.join(root, "client")).catch(() => [])),
    ];
    for (const file of clientFiles) {
      try {
        const rel = path.relative(root, file).replaceAll("\\", "/");
        if (isSensitivePath(rel)) continue;
        const text = await readFile(file, "utf8");
        errors.push(...auditClientOrSharedSource(text, rel, "client"));
      } catch {
        errors.push(
          `Could not read client module: ${path.relative(root, file)}`,
        );
      }
    }

    const sharedFiles = await listTsFiles(path.join(root, "shared")).catch(
      () => [],
    );
    for (const file of sharedFiles) {
      const rel = path.relative(root, file).replaceAll("\\", "/");
      if (isSensitivePath(rel)) continue;
      const text = await readFile(file, "utf8");
      errors.push(...auditClientOrSharedSource(text, rel, "shared"));
    }
  }

  for (const relative of markdownSources) {
    const sourceFile = path.resolve(root, relative);
    let source;
    try {
      const resolvedFile = await realpath(sourceFile);
      if (
        !isWithin(resolvedRoot, resolvedFile) ||
        isSensitivePath(resolvedFile)
      ) {
        errors.push(
          `${relative}: public docs must not point outside the repository or at sensitive files.`,
        );
        continue;
      }
      source = await readFile(sourceFile, "utf8");
    } catch {
      errors.push(`${relative}: required doc is missing or unreadable.`);
      continue;
    }

    if (lintOnly) {
      for (const issue of await validateMarkdownStyle(source, relative)) {
        errors.push(
          `${relative}:${issue.lineNumber} ${issue.ruleNames[0]} ${issue.ruleDescription}`,
        );
      }
      continue;
    }

    if (relative === "OVERVIEW.md") {
      errors.push(
        ...validateOverviewContent(source).map((m) => `${relative}：${m}`),
      );
    }

    errors.push(
      ...(await validateMarkdownLinks(source, sourceFile, root)).map(
        (m) => `${relative}：${m}`,
      ),
    );
  }
  return errors;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const lintOnly = process.argv.includes("--lint");
  const errors = await checkRepository(repositoryRoot, { lintOnly });
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
  } else {
    console.log(
      lintOnly
        ? `OK: Markdown lint passed for ${markdownSources.length} public docs.`
        : "OK: plugin manifest, cross-platform client audit and doc links.",
    );
  }
}
