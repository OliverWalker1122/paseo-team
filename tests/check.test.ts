import assert from "node:assert/strict";
import test from "node:test";
import {
  auditClientOrSharedSource,
  checkRepository,
  validateOverviewContent,
  validatePluginManifest,
} from "../scripts/check.mjs";

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
