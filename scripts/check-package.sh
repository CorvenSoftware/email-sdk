#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
case "${PACKAGE_CHECK_ALLOW_NETWORK:-0}" in
  0) install_mode=--offline ;;
  1) install_mode=--prefer-offline ;;
  *) printf 'Package verification requires PACKAGE_CHECK_ALLOW_NETWORK to be 0 or 1.\n' >&2; exit 1 ;;
esac
stage="$(mktemp -d "${TMPDIR:-/tmp}/corven-email-sdk-package.XXXXXXXX")"
# SAFETY: stage is a fresh mktemp directory owned only by this verification run.
trap 'rm -rf -- "$stage"' EXIT

if [ "$#" -gt 1 ]; then
  printf 'Usage: pnpm check:package [tarball]\n' >&2
  exit 1
fi

if [ "$#" -eq 1 ]; then
  if [ ! -f "$1" ]; then
    printf 'Packed-consumer verification requires an existing tarball: %s\n' "$1" >&2
    exit 1
  fi
  cp -- "$1" "$stage/email-sdk.tgz"
else
  cd -- "$root"
  pnpm build
  pnpm pack --out "$stage/email-sdk.tgz"
fi
cd -- "$root"
mkdir -- "$stage/consumer" "$stage/ai-consumer" "$stage/react-consumer"
node --input-type=module - "$stage" "$root/package.json" <<'MANIFEST'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const stage = process.argv[2];
const source = JSON.parse(readFileSync(process.argv[3], "utf8"));
for (const [directory, integrations] of [
  ["consumer", []],
  ["ai-consumer", ["ai"]],
  ["react-consumer", ["@react-email/render", "react", "react-dom", "@types/react"]],
]) {
  writeFileSync(join(stage, directory, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@corvencore/email-sdk": "file:../email-sdk.tgz",
      effect: source.devDependencies.effect,
      ...Object.fromEntries(integrations.map((dependency) => [dependency, source.devDependencies[dependency]])),
    },
    devDependencies: {
      "@types/node": source.devDependencies["@types/node"],
      typescript: source.devDependencies.typescript,
    },
  }));
  writeFileSync(join(stage, directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2024", lib: ["ES2024", "DOM", "ESNext.Disposable"], types: ["node"],
      module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      noImplicitOverride: true, noFallthroughCasesInSwitch: true,
      verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true,
    },
    include: ["consumer.ts", "docs-examples/*.ts"],
  }));
}
writeFileSync(join(stage, "consumer", "tsconfig.core.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-core" },
  include: ["consumer.ts", "consumer.cts"],
}));
MANIFEST

cp -- "$root/scripts/package-consumer.ts.template" "$stage/consumer/consumer.ts"
cp -- "$root/scripts/package-commonjs-consumer.cts.template" "$stage/consumer/consumer.cts"
cp -- "$root/scripts/package-core-scenarios.ts.template" "$stage/consumer/core-scenarios.ts"
cp -- "$root/scripts/package-private-exports.ts.template" "$stage/consumer/private-exports.ts"
mkdir -- "$stage/consumer/docs-examples"
for example in "$root/docs/user/content/_examples/"*.ts.template; do
  case "$(basename -- "$example")" in
    react-*) continue ;;
  esac
  cp -- "$example" "$stage/consumer/docs-examples/$(basename -- "$example" .template)"
done
cp -- "$root/scripts/package-docs-runtime.mjs.template" "$stage/consumer/docs-runtime.mjs"
node --input-type=module - "$stage/consumer/docs-examples" "$root" <<'README_EXAMPLE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const readmeExamples = Array.from(
  readFileSync(join(process.argv[3], "README.md"), "utf8")
    .matchAll(/```ts\n(?<example>[\s\S]*?)\n```/gu),
  (match) => match.groups.example,
);
const [readmeExample, ...readmeCompileExamples] = readmeExamples;
if (readmeExample === undefined) throw new Error("README requires a TypeScript recording example.");
readmeCompileExamples.forEach((example, index) => {
  writeFileSync(join(process.argv[2], `readme-example-${index + 2}.ts`), example);
});
writeFileSync(join(process.argv[2], "readme-recording.ts"), `${readmeExample}
import assert from "node:assert/strict";
assert.equal(result.receipt._tag, "Recorded");
assert.equal(result.messages.length, 1);
`);
README_EXAMPLE
pnpm --dir "$stage/consumer" install "$install_mode" --ignore-scripts
pnpm --dir "$stage/consumer" exec tsc --noEmit
pnpm --dir "$stage/consumer" exec tsc -p tsconfig.core.json
node "$stage/consumer/compiled-core/consumer.js"
node "$stage/consumer/compiled-core/consumer.cjs"
node "$stage/consumer/docs-runtime.mjs"
node "$stage/consumer/docs-examples/readme-recording.ts"
test ! -d "$stage/consumer/node_modules/ai"
test ! -d "$stage/consumer/node_modules/react"
test ! -d "$stage/consumer/node_modules/react-dom"
test ! -d "$stage/consumer/node_modules/@react-email/render"
cp -- "$root/scripts/package-cli-runtime.mjs.template" "$stage/consumer/cli.mjs"
node "$stage/consumer/cli.mjs"
cp -- "$root/scripts/package-author-consumer.ts.template" "$stage/consumer/author.ts"
cp -- "$root/scripts/package-provider-consumer.ts.template" "$stage/consumer/providers.ts"
cp -- "$root/scripts/package-provider-commonjs-consumer.cts.template" "$stage/consumer/providers.cts"
cp -- "$root/scripts/package-provider-scenarios.ts.template" "$stage/consumer/provider-scenarios.ts"
node --input-type=module - "$stage/consumer" <<'PROVIDER_CONFIG'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "tsconfig.providers.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-providers" },
  include: ["providers.ts", "providers.cts"],
}));
PROVIDER_CONFIG
pnpm --dir "$stage/consumer" exec tsc -p tsconfig.providers.json
node "$stage/consumer/compiled-providers/providers.js"
node "$stage/consumer/compiled-providers/providers.cjs"
cp -- "$root/scripts/package-ai-consumer.ts.template" "$stage/consumer/ai.ts"
cp -- "$root/scripts/package-ai-commonjs-consumer.cts.template" "$stage/consumer/ai.cts"
cp -- "$root/scripts/package-ai-scenarios.ts.template" "$stage/consumer/ai-scenarios.ts"
node --input-type=module - "$stage/consumer" <<'AI_CONFIG'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "tsconfig.ai.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-ai" },
  include: ["ai.ts", "ai.cts"],
}));
AI_CONFIG
pnpm --dir "$stage/consumer" exec tsc -p tsconfig.ai.json
node "$stage/consumer/compiled-ai/ai.js"
node "$stage/consumer/compiled-ai/ai.cjs"
test ! -d "$stage/consumer/node_modules/ai"
test ! -d "$stage/consumer/node_modules/react"
test ! -d "$stage/consumer/node_modules/react-dom"
test ! -d "$stage/consumer/node_modules/@react-email/render"

pnpm --dir "$stage/ai-consumer" install "$install_mode" --ignore-scripts
test ! -d "$stage/ai-consumer/node_modules/react"
test ! -d "$stage/ai-consumer/node_modules/react-dom"
test ! -d "$stage/ai-consumer/node_modules/@react-email/render"
cp -- "$root/scripts/package-ai-runtime.mjs.template" "$stage/ai-consumer/native-ai.mjs"
node "$stage/ai-consumer/native-ai.mjs"

pnpm --dir "$stage/react-consumer" install "$install_mode" --ignore-scripts
test ! -d "$stage/react-consumer/node_modules/ai"
cp -- "$root/scripts/package-react-consumer.ts.template" "$stage/react-consumer/react.ts"
cp -- "$root/scripts/package-react-commonjs-consumer.cts.template" "$stage/react-consumer/react.cts"
cp -- "$root/scripts/package-react-scenarios.ts.template" "$stage/react-consumer/react-scenarios.ts"
node --input-type=module - "$stage/react-consumer" <<'REACT_CONFIG'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "tsconfig.react.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-react" },
  include: ["react.ts", "react.cts"],
}));
writeFileSync(join(process.argv[2], "tsconfig.docs-react.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-docs-react", rootDir: "docs-react" },
  include: ["docs-react/*.ts"],
}));
REACT_CONFIG
mkdir -- "$stage/react-consumer/docs-react"
for example in "$root/docs/user/content/_examples/"react-*.ts.template; do
  cp -- "$example" "$stage/react-consumer/docs-react/$(basename -- "$example" .template)"
done
pnpm --dir "$stage/react-consumer" exec tsc -p tsconfig.docs-react.json
cp -- "$root/scripts/package-docs-react-runtime.mjs.template" "$stage/react-consumer/docs-react-runtime.mjs"
node "$stage/react-consumer/docs-react-runtime.mjs"
pnpm --dir "$stage/react-consumer" exec tsc -p tsconfig.react.json
for format in js cjs; do
  if ! node "$stage/react-consumer/compiled-react/react.$format" >> "$stage/react.stdout" 2>> "$stage/react.stderr"; then
    printf 'Packed React %s consumer failed; private captured diagnostics were not emitted.\n' "$format" >&2
    exit 1
  fi
done
if test -s "$stage/react.stdout" || test -s "$stage/react.stderr"; then
  printf 'Packed React consumers emitted unexpected native diagnostics.\n' >&2
  exit 1
fi
printf 'Packed consumers: core/providers/provider-authoring/tool/CLI without AI or React, strict ESM/CommonJS SDK declarations/runtimes, independent AI/React interoperation and private export fences passed.\n'
