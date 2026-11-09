import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureRoot = mkdtempSync(path.join(tmpdir(), "email-sdk-lint-"));
const boundaryRule = (name) => `rat-stack-boundaries/${name}`;
const patternRule = (name) => `rat-stack-patterns/${name}`;
const fixtures = [
  {
    filename: "src/email-domain-http.ts",
    source: 'export { HttpClient } from "effect/http";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-cli.ts",
    source: 'export { Command } from "effect/cli";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-cli-command.ts",
    source: 'export * as Command from "effect/cli/Command";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-ai.ts",
    source: 'export * as Ai from "effect/ai";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-reactivity.ts",
    source: 'export * as Reactivity from "effect/reactivity";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-provider.ts",
    source: 'export { resendEmailLayer } from "./resend-email-sender.js";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-node.ts",
    source: 'export { readFileSync } from "node:fs";',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-browser.ts",
    source: "export const recipient = globalThis.window.location.href;",
    rejectedBy: [boundaryRule("no-browser-globals-on-server")],
  },
  {
    filename: "src/email-domain-browser-alias.ts",
    source: "const host = globalThis; export const { localStorage } = host;",
    rejectedBy: [boundaryRule("no-browser-globals-on-server")],
  },
  {
    filename: "src/email-domain-state.ts",
    source: "export let sent = 0;",
    rejectedBy: [patternRule("no-module-level-mutable-state")],
  },
  {
    filename: "src/email-domain-cache.ts",
    source: 'import { Effect } from "effect"; export const shared = Effect.cached(Effect.succeed(1));',
    rejectedBy: [patternRule("no-shared-pending-cache")],
  },
  {
    filename: "src/email-domain-resource.ts",
    source: 'import { Effect } from "effect"; const handle = {}; export const resource = Effect.acquireRelease(Effect.succeed(handle), () => Effect.void);',
    rejectedBy: [patternRule("acquire-release-constructs-in-acquire-body")],
  },
  {
    filename: "src/nested/email-domain-tooling.ts",
    source: 'export { default } from "../../tools/oxlint/corven/oxlint-plugin-patterns.ts";',
    rejectedBy: [boundaryRule("no-core-adapters"), boundaryRule("no-cross-layer-imports")],
  },
  {
    filename: "src/email-domain-test-import.ts",
    source: 'export { expect } from "vitest";',
    rejectedBy: [boundaryRule("no-core-adapters"), boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-domain-devtools.ts",
    source: 'export { DevTools } from "effect/devtools";',
    rejectedBy: [boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-domain-devtools-child.ts",
    source: 'export * as DevTools from "effect/devtools/DevTools";',
    rejectedBy: [boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-ai-execution.ts",
    source: 'export { DevTools } from "effect/devtools";',
    rejectedBy: [boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-cli-node.ts",
    source: 'export * as DevTools from "effect/devtools/DevTools";',
    rejectedBy: [boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-domain-testclock.ts",
    source: 'export { TestClock } from "effect/testing";',
    rejectedBy: [boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-http-response.ts",
    source: 'export { TestClock } from "effect/testing";',
    rejectedBy: [boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-cli-main.ts",
    source: 'export { fixture } from "../test/email-fixture.js";',
    rejectedBy: [boundaryRule("no-cross-layer-imports"), boundaryRule("no-devtools-in-production")],
  },
  {
    filename: "src/email-domain-dynamic.ts",
    source: 'export const adapter = () => import("./smtp-session.js");',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-require.ts",
    source: 'export const adapter = require("./smtp-session.js");',
    rejectedBy: [boundaryRule("no-core-adapters")],
  },
  {
    filename: "src/email-domain-surface.ts",
    source: 'import { HttpApi } from "effect/unstable/httpapi"; export const api = HttpApi.make("email");',
    rejectedBy: [boundaryRule("no-core-adapters"), boundaryRule("no-hand-rolled-surface")],
  },
  {
    filename: "src/smtp-email-sender.ts",
    source: "export let session = globalThis.window;",
    rejectedBy: [boundaryRule("no-browser-globals-on-server"), patternRule("no-module-level-mutable-state")],
  },
  {
    filename: "src/email-domain.ts",
    source: 'export { Schema } from "effect"; export { EmailMessageSchema } from "./email-message.js";',
    rejectedBy: [],
  },
  {
    filename: "src/email-domain-bytes.ts",
    source: 'export { Buffer } from "node:buffer";',
    rejectedBy: [],
  },
  {
    filename: "src/resend-email-sender.ts",
    source: 'export { HttpClient } from "effect/http"; export { EmailMessageSchema } from "./email-message.js";',
    rejectedBy: [],
  },
  {
    filename: "src/smtp-session.ts",
    source: 'export { connect } from "node:net";',
    rejectedBy: [],
  },
  {
    filename: "src/email-react.ts",
    source: 'export { render } from "@react-email/render"; export { createElement } from "react";',
    rejectedBy: [],
  },
  {
    filename: "src/email-native-capture.ts",
    source: 'export { LoopsTransactionalEmail } from "./loops-transactional-email.js";',
    rejectedBy: [],
  },
  {
    filename: "src/email-domain.test.ts",
    source: 'export { expect } from "vitest"; export let calls = 0;',
    rejectedBy: [],
  },
];

try {
  const pluginDirectory = path.join(fixtureRoot, "tools/oxlint/corven");
  mkdirSync(pluginDirectory, { recursive: true });
  for (const filename of [
    "oxlint-plugin-boundaries.ts",
    "oxlint-plugin-patterns.ts",
    "oxlint-plugin-no-comments.ts",
    "oxlint-plugin-effect-tests.ts",
    "sdk-lint-paths.ts",
  ]) {
    cpSync(path.join(import.meta.dirname, filename), path.join(pluginDirectory, filename));
  }
  symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
  symlinkSync(path.join(repositoryRoot, "tools/oxlint/anti-slop"), path.join(fixtureRoot, "tools/oxlint/anti-slop"), "dir");
  writeFileSync(path.join(fixtureRoot, "package.json"), '{"private":true,"type":"module"}');
  const rootConfiguration = pathToFileURL(path.join(repositoryRoot, "oxlint.config.ts")).href;
  writeFileSync(
    path.join(fixtureRoot, "oxlint.config.mjs"),
    `import configuration from ${JSON.stringify(rootConfiguration)};\nexport default { ...configuration, options: { ...configuration.options, typeAware: false } };\n`,
  );
  for (const fixture of fixtures) {
    const filename = path.join(fixtureRoot, fixture.filename);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, `${fixture.source}\n`);
  }

  const execution = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules/oxlint/bin/oxlint"),
      "--config",
      "oxlint.config.mjs",
      "--format",
      "json",
      "src",
    ],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  assert.ifError(execution.error);
  assert.ok(execution.status === 0 || execution.status === 1, execution.stderr);
  const report = JSON.parse(execution.stdout);
  assert.ok(Array.isArray(report.diagnostics), execution.stdout);
  const architectureDiagnostics = report.diagnostics.filter((diagnostic) =>
    /^rat-stack-(?:boundaries|patterns)[/(]/u.test(diagnostic.code ?? ""),
  );

  for (const fixture of fixtures) {
    const diagnostics = architectureDiagnostics.filter((diagnostic) =>
      path.resolve(fixtureRoot, diagnostic.filename) === path.join(fixtureRoot, fixture.filename),
    );
    const rules = diagnostics.map((diagnostic) =>
      diagnostic.code.replace("(", "/").replace(/\)$/u, ""),
    );
    assert.deepEqual([...new Set(rules)].sort(), [...fixture.rejectedBy].sort(), fixture.filename);
    assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "error"), fixture.filename);
  }
  assert.equal(
    architectureDiagnostics.length,
    architectureDiagnostics.filter((diagnostic) => fixtures.some((fixture) =>
      path.resolve(fixtureRoot, diagnostic.filename) === path.join(fixtureRoot, fixture.filename),
    )).length,
    "Every architecture diagnostic must belong to a known fixture",
  );
  assert.equal(execution.status, 1, "Forbidden SDK source must make the lint consumer fail");
  console.log(`SDK architecture lint fixtures passed (${fixtures.length} cases).`);
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
