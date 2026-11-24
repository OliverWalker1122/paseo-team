import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import MarkdownIt from "markdown-it";
import { lint } from "markdownlint/promise";

// 只读取明确列出的公开文档与插件源码，绝不扫描或读取任何 .env 凭据文件。
export const markdownSources = Object.freeze([
  "README.md",
  "OVERVIEW.md",
  "CONTRIBUTING.md",
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
    return ["paseo-plugin.json 不是有效 JSON。"];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["paseo-plugin.json 必须是 JSON 对象。"];
  }
  if (manifest.id !== "paseo-team") {
    errors.push("paseo-plugin.json 的 id 必须为 paseo-team。");
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    errors.push("paseo-plugin.json 必须包含非空 name。");
  }
  if (
    !manifest.requirements ||
    typeof manifest.requirements !== "object" ||
    typeof manifest.requirements.paseo !== "string" ||
    !manifest.requirements.paseo.trim()
  ) {
    errors.push("paseo-plugin.json 必须声明 requirements.paseo 版本范围。");
  }
  return errors;
}

export function validateOverviewContent(source) {
  const errors = [];
  if (!source.trim()) {
    errors.push("OVERVIEW.md 不能为空。");
  }
  if (source.includes("—")) {
    errors.push("OVERVIEW.md 包含破折号（—），违反 Paseo 插件目录规范。");
  }
  if (/\bpaseo\s+plugin\s+(?:install|add)\b/i.test(source)) {
    errors.push("OVERVIEW.md 不应包含安装命令（Paseo 页面顶部自带安装栏）。");
  }
  return errors;
}

export function auditClientOrSharedSource(source, relativePath, kind) {
  const errors = [];
  if (
    /\bfrom\s+["']node:/.test(source) ||
    /\bimport\s*\(\s*["']node:/.test(source)
  ) {
    errors.push(`${relativePath}：禁止在 ${kind} 模块中导入 node:*。`);
  }
  if (kind === "client" && /\bfrom\s+["'](?:\.\.?\/)+server\//.test(source)) {
    errors.push(`${relativePath}：客户端代码禁止导入 server/ 模块。`);
  }
  if (
    kind === "shared" &&
    /\bfrom\s+["'](?:(?:\.\.?\/)+(?:client|server)\/|react|react-native)/.test(
      source,
    )
  ) {
    errors.push(
      `${relativePath}：shared/ 模块禁止依赖 client、server 或 React。`,
    );
  }
  if (kind === "client") {
    const domHit =
      /\b(?:document|window|localStorage|navigator)\.|className=|onClick=|<\/?(?:div|span|button|input|textarea|select|option|form|label|section|article|header|footer|main|nav|aside|p|a|ul|ol|li|table|thead|tbody|tr|td|th|svg|path|circle|rect|line|g|canvas|iframe|img|h[1-6])(?:\s|>|\/)/m.exec(
        source,
      );
    if (domHit) {
      errors.push(
        `${relativePath}：检测到非跨平台 DOM/HTML 用法（${domHit[0].trim()}），移动端将崩溃。`,
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
      errors.push(`链接包含无效的 URL 编码：${destination}`);
      continue;
    }
    if (!localPath) continue;
    if (
      path.isAbsolute(localPath) ||
      /^[a-z]:\//i.test(localPath) ||
      localPath.includes("\0")
    ) {
      errors.push(`本地链接必须使用仓库内的相对路径：${destination}`);
      continue;
    }

    const target = path.resolve(path.dirname(sourceFile), localPath);
    if (!isWithin(root, target)) {
      errors.push(`相对链接越出仓库：${destination}`);
      continue;
    }
    if (isSensitivePath(localPath)) {
      errors.push("文档链接指向敏感文件或凭据目录，未访问该目标。");
      continue;
    }
    try {
      const resolvedTarget = await realpath(target);
      if (!isWithin(resolvedRoot, resolvedTarget)) {
        errors.push(`相对链接通过符号链接越出仓库：${destination}`);
      } else if (isSensitivePath(resolvedTarget)) {
        errors.push("文档链接指向敏感文件或凭据目录，未读取该目标。");
      }
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        errors.push(`相对链接目标不存在：${destination}`);
      } else {
        errors.push(`无法核对相对链接目标：${destination}`);
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
        errors.push("paseo-plugin.json 越出仓库目录。");
      } else {
        errors.push(
          ...validatePluginManifest(await readFile(manifestPath, "utf8")),
        );
      }
    } catch {
      errors.push("paseo-plugin.json 不存在或不可读。");
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
        errors.push(`无法读取客户端模块：${path.relative(root, file)}`);
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
        errors.push(`${relative}：公开文档不能指向仓库之外或敏感文件。`);
        continue;
      }
      source = await readFile(sourceFile, "utf8");
    } catch {
      errors.push(`${relative}：必需文档不存在或无法读取。`);
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
        ? `通过：${markdownSources.length} 份公开文档的 Markdown lint 检查。`
        : "通过：插件清单、跨平台客户端无 DOM 审计及公开文档链接检查。",
    );
  }
}
