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
mkdir -- "$stage/consumer"
node --input-type=module - "$stage" <<'MANIFEST'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const stage = process.argv[2];
writeFileSync(join(stage, "consumer", "package.json"), JSON.stringify({
  private: true,
  type: "module",
  dependencies: { "@corvencore/email-sdk": "file:../email-sdk.tgz", effect: "4.0.3" },
  devDependencies: { "@types/node": "24.13.6", typescript: "7.0.2" },
}));
writeFileSync(join(stage, "consumer", "tsconfig.json"), JSON.stringify({
  compilerOptions: {
    target: "ES2024", lib: ["ES2024", "DOM", "ESNext.Disposable"], types: ["node"],
    module: "NodeNext", moduleResolution: "NodeNext",
    strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
    verbatimModuleSyntax: true, skipLibCheck: false, noEmit: true,
  },
  include: ["consumer.ts", "docs-examples/*.ts"],
}));
writeFileSync(join(stage, "consumer", "tsconfig.commonjs.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-commonjs" },
  include: ["consumer.cts"],
}));
MANIFEST

cp -- "$root/scripts/package-consumer.ts.template" "$stage/consumer/consumer.ts"
cp -- "$root/scripts/package-commonjs-consumer.cts.template" "$stage/consumer/consumer.cts"
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
const readmeExample = readFileSync(join(process.argv[3], "README.md"), "utf8")
  .match(/```ts\n(?<example>[\s\S]*?)\n```/u)?.groups?.example;
if (readmeExample === undefined) throw new Error("README requires a TypeScript recording example.");
writeFileSync(join(process.argv[2], "readme-recording.ts"), `${readmeExample}
import assert from "node:assert/strict";
assert.equal(result.receipt._tag, "Recorded");
assert.equal(result.messages.length, 1);
`);
README_EXAMPLE
pnpm --dir "$stage/consumer" install "$install_mode" --ignore-scripts
pnpm --dir "$stage/consumer" exec tsc --noEmit
node "$stage/consumer/consumer.ts"
node "$stage/consumer/docs-runtime.mjs"
node "$stage/consumer/docs-examples/readme-recording.ts"
pnpm --dir "$stage/consumer" exec tsc -p tsconfig.commonjs.json
node "$stage/consumer/compiled-commonjs/consumer.cjs"
test ! -d "$stage/consumer/node_modules/ai"
test ! -d "$stage/consumer/node_modules/react"
test ! -d "$stage/consumer/node_modules/react-dom"
test ! -d "$stage/consumer/node_modules/@react-email/render"
cp -- "$root/scripts/package-cli-runtime.mjs.template" "$stage/consumer/cli.mjs"
node "$stage/consumer/cli.mjs"
cp -- "$root/scripts/package-author-consumer.ts.template" "$stage/consumer/author.ts"
cp -- "$root/scripts/package-provider-consumer.ts.template" "$stage/consumer/providers.ts"
cp -- "$root/scripts/package-provider-commonjs-consumer.cts.template" "$stage/consumer/providers.cts"
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
ai_version="$(node -p "require('./package.json').devDependencies.ai")"
pnpm --dir "$stage/consumer" add "$install_mode" --ignore-scripts --save-exact "ai@$ai_version"
cp -- "$root/scripts/package-ai-runtime.mjs.template" "$stage/consumer/native-ai.mjs"
node "$stage/consumer/native-ai.mjs"
cp -- "$root/scripts/package-react-consumer.ts.template" "$stage/consumer/react.ts"
cp -- "$root/scripts/package-react-commonjs-consumer.cts.template" "$stage/consumer/react.cts"
node --input-type=module - "$root/package.json" "$stage/consumer" "$install_mode" <<'REACT_CONFIG'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const source = JSON.parse(readFileSync(process.argv[2], "utf8"));
const dependencies = ["@react-email/render", "react", "react-dom", "@types/react"].map(
  (dependency) => `${dependency}@${source.devDependencies[dependency]}`,
);
const installation = spawnSync("pnpm", [
  "--dir", process.argv[3], "add", process.argv[4], "--ignore-scripts", "--save-exact", ...dependencies,
], { stdio: "inherit" });
if (installation.error) throw installation.error;
if (installation.status !== 0) process.exit(installation.status ?? 1);
writeFileSync(join(process.argv[3], "tsconfig.react.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-react" },
  include: ["react.ts", "react.cts"],
}));
REACT_CONFIG
mkdir -- "$stage/consumer/docs-react"
for example in "$root/docs/user/content/_examples/"react-*.ts.template; do
  cp -- "$example" "$stage/consumer/docs-react/$(basename -- "$example" .template)"
done
node --input-type=module - "$stage/consumer" <<'DOCS_REACT_CONFIG'
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.argv[2], "tsconfig.docs-react.json"), JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, outDir: "compiled-docs-react", rootDir: "docs-react" },
  include: ["docs-react/*.ts"],
}));
DOCS_REACT_CONFIG
pnpm --dir "$stage/consumer" exec tsc -p tsconfig.docs-react.json
cp -- "$root/scripts/package-docs-react-runtime.mjs.template" "$stage/consumer/docs-react-runtime.mjs"
node "$stage/consumer/docs-react-runtime.mjs"
pnpm --dir "$stage/consumer" exec tsc -p tsconfig.react.json
for format in js cjs; do
  if ! node "$stage/consumer/compiled-react/react.$format" >> "$stage/react.stdout" 2>> "$stage/react.stderr"; then
    printf 'Packed React %s consumer failed; private captured diagnostics were not emitted.\n' "$format" >&2
    exit 1
  fi
done
if test -s "$stage/react.stdout" || test -s "$stage/react.stderr"; then
  printf 'Packed React consumers emitted unexpected native diagnostics.\n' >&2
  exit 1
fi
printf 'Packed consumers: core/providers/provider-authoring/tool/CLI without AI or React, strict ESM/CommonJS SDK declarations/runtimes, independent AI/React interoperation and private export fences passed.\n'
