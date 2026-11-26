import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BADGE_PATH = path.join(REPO_ROOT, ".github", "badges", "coverage.svg");

const TEST_FILES = [
  "tests/check.test.ts",
  "tests/task-store.test.ts",
  "tests/quality-gate.test.ts",
  "tests/run-check.test.ts",
  "tests/handoff.test.ts",
  "tests/prompts.test.ts",
  "tests/client-ui.test.ts",
  "tests/hooks.integration.test.ts",
];

export function parseCoverageSummary(output) {
  const match =
    /all files\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)\s*\|\s*([0-9]+(?:\.[0-9]+)?)/i.exec(
      output,
    );
  if (!match) return null;
  return {
    lines: Number(match[1]),
    branches: Number(match[2]),
    functions: Number(match[3]),
  };
}

export function badgeColorForPercent(percent) {
  if (percent >= 90) return "#4c1";
  if (percent >= 80) return "#97ca00";
  if (percent >= 70) return "#a4a61d";
  if (percent >= 60) return "#dfb317";
  return "#e05d44";
}

export function renderCoverageBadgeSvg(linesPercent) {
  const rounded = Math.round(linesPercent * 10) / 10;
  const label = "coverage";
  const value = `${rounded.toFixed(1)}%`;
  const color = badgeColorForPercent(rounded);
  const labelWidth = 62;
  const valueWidth = Math.max(46, value.length * 7 + 12);
  const totalWidth = labelWidth + valueWidth;
  const labelX = Math.round(labelWidth * 5);
  const valueX = Math.round((labelWidth + valueWidth / 2) * 10);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">`,
    `  <title>${label}: ${value}</title>`,
    `  <linearGradient id="s" x2="0" y2="100%">`,
    `    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>`,
    `    <stop offset="1" stop-opacity=".1"/>`,
    `  </linearGradient>`,
    `  <clipPath id="r">`,
    `    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>`,
    `  </clipPath>`,
    `  <g clip-path="url(#r)">`,
    `    <rect width="${labelWidth}" height="20" fill="#555"/>`,
    `    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`,
    `    <rect width="${totalWidth}" height="20" fill="url(#s)"/>`,
    `  </g>`,
    `  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">`,
    `    <text aria-hidden="true" x="${labelX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${label}</text>`,
    `    <text x="${labelX}" y="140" transform="scale(.1)">${label}</text>`,
    `    <text aria-hidden="true" x="${valueX}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)">${value}</text>`,
    `    <text x="${valueX}" y="140" transform="scale(.1)">${value}</text>`,
    `  </g>`,
    `</svg>`,
    "",
  ].join("\n");
}

function parseMinLines(argv) {
  const flag = argv.find((a) => a.startsWith("--min-lines="));
  if (!flag) return 80;
  const n = Number(flag.slice("--min-lines=".length));
  return Number.isFinite(n) ? n : 80;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const writeBadge = process.argv.includes("--write-badge");
  const minLines = parseMinLines(process.argv.slice(2));

  const env = {
    ...process.env,
    SKIP_DOTENV: "true",
    DOTENV_CONFIG_PATH: "/dev/null",
  };
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--test",
      "--experimental-test-coverage",
      "--test-coverage-exclude=tests/**",
      "--test-coverage-exclude=scripts/**",
      ...TEST_FILES,
    ],
    {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  const combined = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);

  if (run.status !== 0) {
    process.exit(run.status ?? 1);
  }

  const summary = parseCoverageSummary(combined);
  if (!summary) {
    console.error("Failed to parse Node test coverage summary.");
    process.exit(1);
  }

  if (writeBadge) {
    mkdirSync(path.dirname(BADGE_PATH), { recursive: true });
    writeFileSync(BADGE_PATH, renderCoverageBadgeSvg(summary.lines), "utf8");
    console.log(
      `Updated ${path.relative(REPO_ROOT, BADGE_PATH)} (${summary.lines.toFixed(1)}% lines, ${summary.branches.toFixed(1)}% branches, ${summary.functions.toFixed(1)}% funcs).`,
    );
  }

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    appendFileSync(
      stepSummaryPath,
      [
        "### Test Coverage (L1 + L2)",
        "",
        "| Metric | Coverage |",
        "| --- | ---: |",
        `| Lines | **${summary.lines.toFixed(2)}%** |`,
        `| Branches | ${summary.branches.toFixed(2)}% |`,
        `| Functions | ${summary.functions.toFixed(2)}% |`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  if (summary.lines < minLines) {
    console.error(
      `Line coverage ${summary.lines.toFixed(2)}% is below threshold ${minLines}%.`,
    );
    process.exit(1);
  }
}
