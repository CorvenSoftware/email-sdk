# Review and verification

Read this for public API/package changes, final handoff, or instruction changes. Checks prove specific properties of specific content; neither a passing subset nor an old receipt is a passing completion gate.

## Choose focused checks

Run commands from the repository root. [package.json](../../package.json) owns scripts, [tsconfig.json](../../tsconfig.json) owns typechecking scope, and [vitest.config.ts](../../vitest.config.ts) owns runtime discovery. Inspect them when changing tooling rather than maintaining another configuration inventory here.

| Changed boundary                                    | Focused evidence                                                                                                                         | What it does not establish                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Runtime behavior                                    | `pnpm exec vitest run <files>` for affected public-interface suites; use [testing principles](testing-principles.md) to select fixtures. | Unselected suites, installed exports or live providers.                      |
| Public types, errors or requirements                | `pnpm typecheck`, including real calls in `test/email-contracts.tst.ts`.                                                                 | Shipped declarations in an independent consumer.                             |
| Example usage                                       | `pnpm check:examples`.                                                                                                                   | Runtime execution; examples compile but do not send or authenticate.         |
| Exports, peers, packaging or executable entrypoints | `pnpm check:package` and inspection of its affected consumer templates.                                                                  | Other runtime/bundler support, publication or live delivery.                 |
| Instructions or contributor docs                    | Formatting, local paths/anchors, source/configuration checks and the routing scenarios below.                                            | That a runtime suite has validated prose or that self-review is independent. |

`pnpm check` composes lint, typechecking and example checks; do not immediately rerun its components for unchanged content. Reuse focused results only while their inputs remain unchanged. The [root completion gate](../../AGENTS.md#completion) still applies to final content; focused selection is for iteration, not a waiver.

For package work, [check-package.sh](../../scripts/check-package.sh) builds and packs, installs into isolated consumers with scripts disabled, and checks declarations and synthetic runtime behavior. Consumer installs are offline by default; CI explicitly sets `PACKAGE_CHECK_ALLOW_NETWORK=1` to fetch missing public transitive dependencies without changing the frozen root build graph. It separately compiles ESM/CommonJS consumers, checks optional integration isolation/interoperation and executes the installed CLI. Preserve strict consumer checking and private export fences. A CommonJS consumer loading ESM is not evidence of a separate CommonJS distribution or arbitrary runtime support. `dist/` is rebuilt from source, not edited to repair a consumer.

## Review the task, not the whole dirty worktree

Establish which tracked changes and new files belong to the request. Preserve unrelated edits. Inspect the complete task-owned content against the original requirement, including source surrounding the changed boundary, not just the latest patch or a successful test log.

Review semantic risk rather than line count. Trust/replay, private diagnostics, credentials, cancellation/shared lifetimes and package exports are high-risk boundaries. Seek an independent read-only reviewer when available; provide:

- The original request and supported scope.
- The complete task-owned diff and new-file contents.
- Relevant surrounding source and exact focused-check results/limits.

Keep reviewed content stable while review runs. Validate findings against supported behavior, fix substantive issues, rerun affected checks and obtain affected re-review. A self-check is useful but cannot be called independent review. State reviewer unavailability rather than implying approval. Do not import a heavyweight review packet or require a new permanent report for routine work.

## Check instruction routing as behavior

For changed agent-facing guidance, walk these scenarios from the root pointer before accepting it:

| Scenario                                              | Expected route and decision                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Add a retry deadline case                             | Testing guide; virtual time plus an entry signal, not a real sleep.                                 |
| Adapt an API example from another Effect release      | Effect guide; verify installed/reference versions, resolve mismatches without upgrading implicitly. |
| Handle an unknown send followed by a rejection        | Submission-safety guide; earlier uncertainty cannot become fallback permission.                     |
| Add or remove a public export                         | This guide; source call sites plus independent installed declarations/runtime evidence.             |
| Delete a slow wire property                           | Testing guide; identify the protected behavior and retain meaningful coverage before removal.       |
| Treat a Mailgun signature as authenticated event data | Submission-safety guide; challenge proof does not authenticate the event body.                      |
| Run a real authentication probe                       | Root permission guard and submission-safety guide; obtain exact approval first.                     |

Verify every changed local link/anchor and named executable path. Check that the root trigger reaches the needed guide without loading unrelated branches. Do not add runtime tests that snapshot prose, file inventories or doc counts as a substitute for this review.

Keep each policy in one owning guide. Add prose only for a decision, cross-boundary constraint or non-obvious failure mode that source alone does not explain. When it changes, rewrite/remove the existing guidance; do not append a new account of current behavior. Versions, provider capabilities, numeric limits and test counts stay in their executable owners. Plans, scratch material and historical verification logs are not shipped documentation.

## Handoff with limits intact

Report what changed, commands actually run, failures/cancellations/skipped checks, unavailable independent review and remaining requested scope. If an unrelated worktree error blocks a gate, identify it without repairing unrelated work or weakening checks. A cancelled test task is not a passing suite. Compiler suggestions and errors are different outcomes; do not silently reclassify either.

Synthetic behavior, actual loopback wire, installed consumers, live authentication, acceptance and delivery are separate evidence levels. Keep claims within the observed level. Passing an increment does not establish full feature parity, release readiness or authority to publish.
