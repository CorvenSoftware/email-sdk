# Testing principles

Read this when adding, changing or removing tests, choosing a fixture, or investigating slow or flaky coverage. The decision is which boundary can expose a plausible incorrect behavior, not which test style is most elaborate.

## Decide whether coverage is missing

Before adding a case, identify the caller-visible behavior, a plausible incorrect implementation, the independent reason for the expected result, and the gap in existing coverage.

- **Tautological tests are harmful.** Reject assertions that verify declarations against themselves, copy production logic, or compute the expected result with the same operation being tested. The assertion needs an independent oracle.
- **Change-detector tests are harmful.** Reject assertions that pin private structure, incidental call counts or implementation snapshots without protecting a caller-visible contract. A behavior-preserving refactor should not require changing those expectations.
- **Do not create regression tests for bug fixes unless there is a genuine gap in behavioral testing.** If existing coverage already detects the defect, fix the implementation and reuse that coverage. When a gap exists, strengthen the owning workflow before adding a separate case.

Proceed with a new case only when its assertion can detect the identified incorrect behavior and the existing suite does not already protect that contract.

## Choose the evidence

| Boundary                                                   | Use when                                                                                                                                                                                      | Avoid when / limitation                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pure public value or Schema API                            | Decoding, normalization, ownership or bounds can be observed without a service.                                                                                                               | The claim concerns retries, transport or resource lifetime. Comparing a Schema with itself proves nothing.           |
| Email with explicit recording/failing/custom sender Layers | The workflow concerns preparation, replay, routing, ordered results or caller mutation. Extend the relevant service/routing suite.                                                            | Claiming that a real provider request was encoded or accepted. Synthetic receipts establish only synthetic behavior. |
| HTTP loopback                                              | The claim concerns provider method/path/headers/body, acknowledgement classification, redirects or physical request cleanup. Use the affected provider suite and shared conformance coverage. | Repeating pure input rejection across every provider when common boundary coverage already owns it.                  |
| SMTP TLS loopback                                          | The claim depends on negotiation, command order, DATA bytes, recipient partitions or socket cleanup.                                                                                          | Replacing the TLS peer with a fake sender while claiming protocol evidence.                                          |
| Real typed call sites                                      | Inference, brands, readonly values, optionality, errors or Layer requirements are the contract. Extend `test/email-contracts.tst.ts`.                                                         | Runtime tests of type declarations, alias identity or compiler guarantees.                                           |
| Installed tarball consumer                                 | Exports, optional-peer isolation, shipped declarations, executable CLI or runtime loading are affected. Use `pnpm check:package`.                                                             | Treating source imports or compiled examples as proof that the installed package works.                              |

For fixture acquisition and actual request queues, inspect [email-http-fixture.ts](../../test/email-http-fixture.ts) or [smtp-loopback-fixture.ts](../../test/smtp-loopback-fixture.ts). For cross-provider transport guarantees, inspect [email-http-conformance.test.ts](../../src/email-http-conformance.test.ts). Read the branch that applies, not every suite.

## Keep the oracle independent

| Weak assertion                                                 | Caller-visible alternative                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A provider factory was called a fixed number of times.         | An unknown submission neither retries without authority nor reaches the backup transport.                         |
| Expected wire data is produced by the same encoder under test. | Check captured bytes against independently justified protocol requirements, including an unsupported-intent case. |
| A callback type equals a copied alias.                         | A real call site accepts supported callbacks and rejects an invalid requirement/error contract.                   |
| A snapshot changes whenever implementation structure changes.  | Assert the relevant receipt, error, wire intent, ownership or lifecycle outcome.                                  |

Before deleting a case, identify its protected behavior and show where that behavior remains covered, or explain the intentionally retired contract. A slow test is a diagnosis target, not evidence that its assertions lack value.

## Own time, ordering and resources

- Use `it.effect` from `@effect/vitest` for Effect workflows and ordinary tests for pure synchronous calculations. Keep dependencies explicit in Layers; do not introduce module mocks or nested runtimes.
- Use `TestClock` for deadlines, schedules and retries. A real loopback server still needs an explicit request/connection signal; advancing virtual time does not establish that native I/O started.
- Use Deferred/Queue gates to establish entry, release, completion and finalization. Await the signal before advancing a deadline or interrupting. Real sleeps and polling do not prove ordering.
- Acquire fixture resources lazily and release them with their owning scope. Keep setup visible in the workflow; reusable fixture factories may hide mechanics, not shared mutable scenario state.
- Check defects/interruption as causes, not ordinary failed batch items. When typed recovery or callbacks change, consult [submission safety](../principles/submission-safety.md#callbacks-and-failure-causes).

[The service suite](../../src/email-service.test.ts) contains backoff/mutation and deadline/cancellation workflows; search their test names rather than copying a complete test harness.

## Spend generated cases on invariants

Use properties for meaningful families such as normalization, escaping, ownership and retention. Every property assertion needs an oracle independent of the implementation. Use explicit cases for a finite decision table or a few protocol branches.

Before optimizing a wire property, count the fixture acquisitions and submissions inside each generated run. Retain boundary and branch coverage when replacing redundant sampling. Compare the same focused command on unchanged surroundings; a single timing sample is not a stable benchmark. Preserve isolation, timeout policy and diagnostic severity rather than weakening them to obtain a pass.

Production dependencies must serve production behavior. Keep test helpers in tests or `test/`; do not export private internals, add test-only options or change production behavior based on a test environment. Public recording/failing utilities are intentional caller-facing simulation capabilities, not permission to add private reset hooks.

## Run and finish

From the repository root, select an actual colocated suite:

```sh
pnpm exec vitest run src/email-service.test.ts
```

[vitest.config.ts](../../vitest.config.ts) owns discovery and execution settings. This repository does not use Kody's suffix-selected Workers/MCP projects. [package.json](../../package.json) owns full-suite scripts; [verification](review-and-verification.md#choose-focused-checks) explains the separate type/example/package checks.

Finish when every changed behavior or type contract has meaningful existing or extended coverage, affected checks have results, and any removed coverage or unavailable evidence is explicit. The [root completion gate](../../AGENTS.md#completion) still applies. Tests use fictional inputs and local fixtures, never live credentials or providers.

The decision-table structure is inspired by [Kody's testing principles](https://github.com/kody-hq/kody/blob/810eb557127e7db01d6f3a33947a4902683053e1/docs/contributing/testing-principles.md); its harness, mocking and disposal conventions are not adopted here.
