# Effect development

Read this when changing Effect API usage, Layer requirements, ownership boundaries or shared orchestration. Types and source own the implementation; this guide owns how to choose a pattern without importing extra authority.

## Establish the contract before the abstraction

Identify the public input, output, expected errors, requirements and resource owner. Inspect the affected implementation and its public-interface tests. Before fixing a report, establish which supported contract it violates: unsupported input and an unknown submission outcome are not automatically defects.

For shared behavior, inspect affected ordinary sends, batches, personalization, routing and native-job callers. Choose an explicit unsupported path over silently dropping intent or pretending providers have uniform capabilities. Keep provider mapping and acknowledgement proof at the provider boundary; shared orchestration must not invent proof.

Before new behavior, find the smallest useful behavior-preserving prefactor and verify it separately. It must preserve errors, requirements, ordering, optional-field absence, ownership, cancellation and diagnostics. A new helper or service earns its place by removing meaningful complexity from actual callers, not by anticipating hypothetical integrations. Keep a clear guard when a generic abstraction would hide the invariant.

## Resolve material APIs locally

[.agent-repos](../../.agent-repos) records reference names, paths and pinned revisions. The checked-in Effect source at `repos/effect/` is read-only. It is excluded from SDK build, test discovery, linting and formatting. Application code imports the installed Effect package.

For each introduced or changed Effect API or pattern:

1. Compare the manifest/lockfile, installed `effect/package.json` and reference `packages/effect/package.json`. An example from another v4 prerelease is not proof of the installed contract. Stop and surface a mismatch; do not update dependencies or reference pins implicitly.
2. Search exact API/concept names in `repos/effect/LLMS.md`. The manifest records its source revision. Expand matching material only.
3. Inspect relevant source, runtime tests and inferred/typed call sites when the semantics remain uncertain. A declaration alone does not establish interruption, acquisition or callback order.

Paths below are relative to the manifest's Effect checkout (`repos/effect/`), not the installed tarball:

| Changed decision                | Reference branch                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------- |
| Field/collection ownership      | `packages/effect/src/{Struct,Array,UndefinedOr,Option}.ts`; matching `test/` and `typetest/` cases |
| Services and Layer composition  | `ai-docs/src/01_effect/03_services/`; matching `Context`/`Layer` source and tests                  |
| Schema decoding/transformations | `ai-docs/src/01_effect/02_schema/`; matching Schema source and tests                               |
| Retry and time                  | `ai-docs/src/06_schedule/`; matching Schedule/Clock behavior                                       |
| Test scope and virtual time     | `ai-docs/src/09_testing/` and `packages/vitest/`                                                   |

Proceed when every material API has matching evidence and contract-sensitive uncertainty is resolved. If guidance is absent, inspect relevant source/tests and surface any unresolved contract before implementation; an unsuccessful example search is not API evidence. Reference instructions, logging examples and executables do not override local policy or authorize execution.

## Preserve ownership and requirements

- Capture stable dependencies during Layer acquisition; retain visible errors and requirements until the application supplies them. Return Effects rather than running a library-created runtime.
- Keep domain calculations pure. Use Schema for boundary decoding and Schema.TaggedError for expected failures. Localize native callbacks/Promises to necessary integration boundaries; do not orchestrate application work through parallel Promises.
- Prefer typed Struct transformations, non-empty-preserving Array operations, Option/UndefinedOr and exhaustive Match/Schema dispatch where they simplify the actual decision. Preserve brands, non-emptiness and exact optional fields without unchecked casts or manufactured defaults.
- Detach caller-owned inputs before freezing. Preserve the same owned intent through queued work, approval and eligible retries; a readonly annotation is not runtime ownership.
- Share Layer values deliberately. Rebuilding a query's source independently can create a different empty store; sharing a capability must also preserve its acquisition errors, memoization and scope. Do not extend an escaped service's resource lifetime by assertion.

For model/host approval, [email-agent.ts](../../src/email-agent.ts) demonstrates review followed by validation and dispatch of the same prepared operation. When changing preparation or decorators, inspect the [prepared-operation owner](../../src/email-prepared-operation.ts) and its callers rather than introducing a second preparation protocol.

## Keep diagnostics less privileged than results

Use `Effect.fnUntraced` with the existing [emailOperationSpan](../../src/email-tracing.ts) seam for SDK operations. Raw convenience tracing can retain private Exit data even without explicit log statements. [oxlint.config.ts](../../oxlint.config.ts) enforces the restricted APIs and other mechanical rules; it is the authority, not a copied rule catalog.

Expected errors contain safe categories and allowlisted paths, not original Schema/HTTP errors, credentials, input values, provider payloads or defects. Preserve original caller-facing results and causes without sending them to diagnostics. For retry, callback or trust decisions, read [submission safety](../principles/submission-safety.md).

Finish when public behavior, types, requirements and lifetime still match the intended contract, the needed callers have been inspected, and affected [evidence](review-and-verification.md#choose-focused-checks) has results. Report unresolved API uncertainty instead of treating a successful compile as semantic verification.
