import assert from "node:assert/strict";
import test from "node:test";
import {
  auditClientOrSharedSource,
  checkRepository,
  validateOverviewContent,
  validatePluginManifest,
} from "../scripts/check.mjs";
import {
  badgeColorForPercent,
  parseCoverageSummary,
  renderCoverageBadgeSvg,
} from "../scripts/coverage.mjs";

test("repository passes plugin manifest, cross-platform client audit, and markdown checks", async () => {
  assert.deepEqual(await checkRepository(), []);
  assert.deepEqual(await checkRepository(undefined, { lintOnly: true }), []);
});

test("auditClientOrSharedSource catches DOM globals, HTML tags, and server/node imports", () => {
  const badDom = `export function Bad() { return <div className="x" onClick={() => window.alert(1)}>hi</div>; }`;
  const domErrors = auditClientOrSharedSource(
    badDom,
    "client/Bad.tsx",
    "client",
  );
  assert.ok(domErrors.length > 0);

  const badNode = `import fs from "node:fs"; export const x = fs;`;
  assert.ok(
    auditClientOrSharedSource(badNode, "client/Bad.tsx", "client").length > 0,
  );
  assert.ok(
    auditClientOrSharedSource(badNode, "shared/Bad.ts", "shared").length > 0,
  );

  const badServerImport = `import { loadConfig } from "../server/config-store.ts";`;
  assert.ok(
    auditClientOrSharedSource(badServerImport, "client/Bad.tsx", "client")
      .length > 0,
  );
});

test("validatePluginManifest and validateOverviewContent enforce Paseo registry rules", () => {
  assert.ok(validatePluginManifest("{}").length > 0);
  assert.deepEqual(
    validatePluginManifest(
      JSON.stringify({
        id: "paseo-team",
        name: "Paseo Team",
        requirements: { paseo: ">=0.17.3" },
      }),
    ),
    [],
  );

  assert.ok(
    validateOverviewContent("Contains an em dash — here.").some((e: string) =>
      e.includes("em dash"),
    ),
  );
  assert.ok(
    validateOverviewContent("Run paseo plugin install foo").some((e: string) =>
      e.includes("install command"),
    ),
  );
});

test("coverage helper parses Node coverage output and renders a valid SVG badge", () => {
  const sample =
    "ℹ all files        |  84.25 |    79.96 |   73.78 |\nℹ end of coverage report\n";
  assert.deepEqual(parseCoverageSummary(sample), {
    lines: 84.25,
    branches: 79.96,
    functions: 73.78,
  });
  assert.equal(parseCoverageSummary("no table here"), null);

  assert.equal(badgeColorForPercent(92), "#4c1");
  assert.equal(badgeColorForPercent(84.2), "#97ca00");
  assert.equal(badgeColorForPercent(75), "#a4a61d");
  assert.equal(badgeColorForPercent(65), "#dfb317");
  assert.equal(badgeColorForPercent(50), "#e05d44");

  const svg = renderCoverageBadgeSvg(84.26);
  assert.match(svg, /^<svg /);
  assert.match(svg, /coverage: 84\.3%/);
  assert.match(svg, /#97ca00/);
  assert.match(svg, /<\/svg>\n$/);
});
