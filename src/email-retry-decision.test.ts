import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Random,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailMessageIdSchema,
  EmailReceiptSchema,
  EmailRejected,
  EmailRetryDecisionSchema,
  EmailRetryCandidateSchema,
  EmailSender,
  EmailSenderIdempotencySchema,
  emailLayer,
  emailRouterLayer,
} from "./index.js";
import type {
  EmailRetryDecision,
  EmailRetryCandidate,
  EmailRetryObserver,
  EmailRetryRestriction,
  EmailSendError,
  EmailSubmissionError,
  IEmail,
  IEmailSender,
} from "./index.js";
import { recordingEmailCapabilities } from "./recording-email-sender.js";

const message = {
  body: { text: "private body" },
  from: "sender@fictional.invalid",
  subject: "private subject",
  to: "recipient@fictional.invalid",
};

const policy = { deadline: Duration.seconds(10), initialDelay: Duration.millis(1), maxAttempts: 3 };

const receipt = EmailReceiptSchema.cases.Accepted.make({
  messageId: EmailMessageIdSchema.make("private-receipt"),
  provider: "fixture",
});

const native = EmailSenderIdempotencySchema.cases.Native.make({ retention: Duration.hours(24) });

const modes = ["Direct", "Batch", "Personalized", "Routed"] as const;

type RetryMode = (typeof modes)[number];

const suppliedSender = (
  submit: IEmailSender["submit"],
  idempotency: IEmailSender["idempotency"] = native,
) =>
  Layer.succeed(
    EmailSender,
    EmailSender.of({
      capabilities: recordingEmailCapabilities,
      idempotency,
      provider: "fixture",
      submit,
      validate: () => Effect.void,
    }),
  );

const unwrapRetryBatch = (
  results: readonly Result.Result<unknown, EmailSendError>[],
): Effect.Effect<unknown, EmailSendError> => {
  const [result] = results;
  assert.isDefined(result);

  return Result.match(result, { onFailure: Effect.fail, onSuccess: Effect.succeed });
};

const submitRetryOperation = (
  email: IEmail,
  mode: RetryMode,
  key?: string,
): Effect.Effect<unknown, EmailSendError> => {
  const options = key === undefined ? undefined : { idempotencyKey: key };
  const request = options === undefined ? { message } : { message, options };
  const recipient = { to: message.to, variables: { name: "private-variable" } };
  const keyedRecipient = key === undefined ? recipient : { ...recipient, idempotencyKey: key };

  const operations = {
    Batch: () => email.sendAll([request]).pipe(Effect.flatMap(unwrapRetryBatch)),
    Direct: () => email.send(message, options),
    Personalized: () =>
      email
        .sendPersonalized({
          message: {
            body: { text: "%recipient.name%" },
            from: message.from,
            subject: message.subject,
          },
          recipients: [keyedRecipient],
        })
        .pipe(Effect.flatMap(unwrapRetryBatch)),
    Routed: () => email.send(message, options),
  };

  return operations[mode]();
};

const variants = Schema.Struct({
  authority: Schema.Literals(["Native", "KeyForwarding", "None"]),
  eligible: Schema.Boolean,
  keyed: Schema.Boolean,
  maxAttempts: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
  uncertainty: Schema.Boolean,
});

describe("explicit email retry-decision observers", () => {
  for (const mode of modes) {
    it.effect.prop(
      `restricts only eligible retries without changing authority or attempt limits in ${mode}`,
      {
        allowedAttempts: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
        variant: variants,
      },
      ({ variant, allowedAttempts }) =>
        Effect.gen(function* restrictEligibleEmailRetries() {
          const calls = yield* Ref.make(0);
          const entered = yield* Deferred.make<boolean>();
          const offered: EmailRetryCandidate[] = [];
          const notified: EmailRetryDecision[] = [];
          const trace = yield* startEmailTraceFixture();

          const failure: EmailSubmissionError = variant.uncertainty
            ? new EmailDeliveryUnknown({
                provider: "fixture",
                reason: variant.eligible ? "transport" : "invalid-response",
                retryAfterMillis: 2,
              })
            : new EmailRejected({
                provider: "fixture",
                reason: variant.eligible ? "rate-limited" : "invalid-message",
                retryAfterMillis: 2,
              });

          const authority = {
            KeyForwarding: EmailSenderIdempotencySchema.cases.KeyForwarding.make({}),
            Native: native,
            None: EmailSenderIdempotencySchema.cases.None.make({}),
          }[variant.authority];

          const key = variant.keyed && variant.authority !== "None" ? "private-key" : undefined;

          const eligible =
            variant.eligible &&
            (!variant.uncertainty || (variant.authority === "Native" && key !== undefined));

          const expectedAttempts = eligible ? Math.min(variant.maxAttempts, allowedAttempts) : 1;

          const restriction: EmailRetryRestriction = (decision) =>
            Effect.sync(() => {
              offered.push(decision);

              return decision.nextAttempt <= allowedAttempts;
            });

          const observer: EmailRetryObserver = (decision) =>
            Effect.sync(() => {
              assert.strictEqual(decision.attempt, offered.at(-1)?.attempt);
              assert.strictEqual(decision.delayMillis, offered.at(-1)?.delayMillis);
              notified.push(decision);
            });

          const primary = emailLayer(
            { ...policy, maxAttempts: variant.maxAttempts },
            Effect.succeed(observer),
            Effect.succeed(restriction),
          ).pipe(
            Layer.provide(
              suppliedSender(
                () =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(Deferred.succeed(entered, true)),
                    Effect.andThen(Effect.fail(failure)),
                  ),
                authority,
              ),
            ),
          );

          const selected =
            mode === "Routed"
              ? emailRouterLayer([{ layer: primary, name: "primary" }], { primary: "primary" })
              : primary;

          const fiber = yield* Effect.gen(function* submitRestrictedRetry() {
            return yield* submitRetryOperation(yield* Email, mode, key);
          }).pipe(
            Effect.provide(selected),
            Effect.withTracer(trace.tracer),
            Effect.ensuring(Deferred.succeed(entered, true)),
            Effect.result,
            Effect.forkScoped,
          );

          yield* Deferred.await(entered);
          yield* TestClock.adjust(1000);
          const result = yield* Fiber.join(fiber);
          assert(Result.isFailure(result));
          assert.strictEqual(result.failure, failure);
          assert.strictEqual(yield* Ref.get(calls), expectedAttempts);
          assert.strictEqual(notified.length, expectedAttempts - 1);
          assert.strictEqual(
            offered.length,
            eligible ? Math.min(variant.maxAttempts - 1, allowedAttempts) : 0,
          );
          yield* Effect.forEach((decision: EmailRetryCandidate, index: number) =>
            Effect.gen(function* inspectRestrictedDecision() {
              assert.isFrozen(decision);
              yield* Schema.decodeEffect(EmailRetryCandidateSchema)(decision);
              assert.strictEqual(decision.attempt, index + 1);
              assert.strictEqual(decision.provider, "fixture");
              assert(decision.delayMillis !== "Infinite");
              assert.isAtLeast(decision.delayMillis, 2);
            }),
          )(offered);
          const diagnostics = yield* trace.diagnostics;

          for (const privateValue of [
            "private-key",
            "private body",
            "private subject",
            "private-variable",
            "private-receipt",
          ]) {
            assert.notInclude(JSON.stringify({ notified, offered }), privateValue);
            assert.notInclude(diagnostics, privateValue);
          }
        }),
      { arbitrary: { runs: 16 } },
    );

    it.effect.prop(
      `notifies only approved upcoming retries with scoped immutable minimal facts in ${mode}`,
      { variant: variants },
      ({ variant }) =>
        Effect.gen(function* observeEligibleRetryDecisions() {
          const calls = yield* Ref.make(0);
          const entered = yield* Deferred.make<boolean>();
          const decisions: EmailRetryDecision[] = [];
          const trace = yield* startEmailTraceFixture();

          const failure: EmailSubmissionError = variant.uncertainty
            ? new EmailDeliveryUnknown({
                provider: "fixture",
                reason: variant.eligible ? "transport" : "invalid-response",
                retryAfterMillis: 2,
              })
            : new EmailRejected({
                provider: "fixture",
                reason: variant.eligible ? "rate-limited" : "invalid-message",
                retryAfterMillis: 2,
                status: 429,
              });

          const authority = {
            KeyForwarding: EmailSenderIdempotencySchema.cases.KeyForwarding.make({}),
            Native: native,
            None: EmailSenderIdempotencySchema.cases.None.make({}),
          }[variant.authority];

          const key = variant.keyed && variant.authority !== "None" ? "private-key" : undefined;

          const replayable =
            variant.eligible &&
            (!variant.uncertainty || (variant.authority === "Native" && key !== undefined));

          const expectedAttempts = replayable ? variant.maxAttempts : 1;

          const observer: EmailRetryObserver = (decision) =>
            Effect.sync(() => {
              decisions.push(decision);
            });

          const primary = emailLayer(
            { ...policy, maxAttempts: variant.maxAttempts },
            observer,
          ).pipe(
            Layer.provide(
              suppliedSender(
                () =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(Deferred.succeed(entered, true)),
                    Effect.andThen(Effect.fail(failure)),
                  ),
                authority,
              ),
            ),
          );

          const selected =
            mode === "Routed"
              ? emailRouterLayer([{ layer: primary, name: "primary" }], { primary: "primary" })
              : primary;

          const operation = Effect.gen(function* submitObservedRetryOperation() {
            return yield* submitRetryOperation(yield* Email, mode, key);
          }).pipe(
            Effect.provide(selected),
            Effect.withTracer(trace.tracer),
            Effect.ensuring(Deferred.succeed(entered, true)),
            Effect.exit,
          );

          const fiber = yield* operation.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* TestClock.adjust(1000);
          const outcome = yield* Fiber.join(fiber);
          assert(Exit.isFailure(outcome));
          assert.strictEqual(yield* Ref.get(calls), expectedAttempts);
          assert.strictEqual(decisions.length, expectedAttempts - 1);
          yield* Effect.forEach((decision: EmailRetryDecision, index: number) =>
            Effect.gen(function* inspectRetryDecision() {
              assert.isTrue(Object.isFrozen(decision));
              yield* Schema.decodeEffect(EmailRetryDecisionSchema)(decision);
              assert.strictEqual(decision.attempt, index + 1);
              assert.strictEqual(decision.nextAttempt, index + 2);
              assert.strictEqual(decision.provider, "fixture");
              assert.strictEqual(
                decision._tag,
                variant.uncertainty ? "UnknownRetry" : "RejectedRetry",
              );
              assert.strictEqual(decision.reason, failure.reason);
              assert.isNumber(decision.delayMillis);
              assert(decision.delayMillis !== "Infinite");
              assert.isAtLeast(decision.delayMillis, 2);
            }),
          )(decisions);
          const serialized = JSON.stringify(decisions);
          const diagnostics = yield* trace.diagnostics;

          for (const privateValue of [
            "private-key",
            "private body",
            "private subject",
            "private-variable",
            "private-receipt",
          ]) {
            assert.notInclude(serialized, privateValue);
            assert.notInclude(diagnostics, privateValue);
          }
        }),
      { arbitrary: { runs: 12 } },
    );

    it.effect.prop(
      `retains the triggering failure and never retries, falls back or settles callback faults in ${mode}`,
      {
        callbackRole: Schema.Literals(["Observer", "Restriction"]),
        interrupt: Schema.Boolean,
        uncertainty: Schema.Boolean,
      },
      ({ uncertainty, interrupt, callbackRole }) =>
        Effect.gen(function* protectRetryObserverFault() {
          const calls = yield* Ref.make(0);
          const backups = yield* Ref.make(0);
          const decisions: (EmailRetryDecision | EmailRetryCandidate)[] = [];

          const failure: EmailSubmissionError = uncertainty
            ? new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" })
            : new EmailRejected({ provider: "fixture", reason: "rate-limited" });

          const defect = new Error("private retry observer defect");

          const observer: EmailRetryObserver = (decision) =>
            Effect.sync(() => {
              decisions.push(decision);
            }).pipe(
              Effect.andThen(
                interrupt ? Effect.failCause(Cause.interrupt(123)) : Effect.die(defect),
              ),
            );

          const restriction: EmailRetryRestriction = (candidate) =>
            Effect.sync(() => {
              decisions.push(candidate);
            }).pipe(
              Effect.andThen(
                interrupt ? Effect.failCause(Cause.interrupt(123)) : Effect.die(defect),
              ),
            );

          const primary = emailLayer(
            policy,
            callbackRole === "Observer" ? observer : undefined,
            callbackRole === "Restriction" ? restriction : undefined,
          ).pipe(
            Layer.provide(
              suppliedSender(() =>
                Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.fail(failure))),
              ),
            ),
          );

          const backup = emailLayer(policy).pipe(
            Layer.provide(
              suppliedSender(() =>
                Ref.update(backups, (count) => count + 1).pipe(Effect.as(receipt)),
              ),
            ),
          );

          const selected =
            mode === "Routed"
              ? emailRouterLayer(
                  [
                    { layer: primary, name: "primary" },
                    { layer: backup, name: "backup" },
                  ],
                  { fallbacks: ["backup"], primary: "primary" },
                )
              : primary;

          const outcome = yield* Effect.gen(function* submitFaultingRetryOperation() {
            return yield* submitRetryOperation(yield* Email, mode, "private-key");
          }).pipe(Effect.provide(selected), Effect.exit);

          assert(Exit.isFailure(outcome));
          assert.strictEqual(yield* Ref.get(calls), 1);
          assert.strictEqual(yield* Ref.get(backups), 0);
          assert.strictEqual(decisions.length, 1);
          assert.isTrue(Exit.hasDies(outcome));

          if (interrupt) {
            assert.isTrue(Exit.hasInterrupts(outcome));
          }

          const retained = outcome.cause.reasons
            .filter(Cause.isDieReason)
            .map((reason) => reason.defect)
            .find(Cause.isCause);

          assert.isDefined(retained);
          assert.isTrue(
            retained.reasons.some(
              (reason) => Cause.isFailReason(reason) && reason.error === failure,
            ),
          );

          if (!interrupt) {
            assert.isTrue(
              outcome.cause.reasons.some(
                (reason) => Cause.isDieReason(reason) && reason.defect === defect,
              ),
            );
          }
        }),
      { arbitrary: { runs: 16 } },
    );
  }

  it.effect.each(["Observer", "Restriction"] as const)(
    "awaits the %s before backoff, owns intent and keeps operation policy overrides",
    (callbackRole) =>
      Effect.gen(function* awaitRetryObserver() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);
        const submitted: string[] = [];
        const decisions: (EmailRetryCandidate | EmailRetryDecision)[] = [];
        const input = { ...message, subject: "private-original" };

        const sender = suppliedSender((submission) =>
          Effect.gen(function* attemptOwnedObservedEmail() {
            submitted.push(submission.message.subject);
            const count = yield* Ref.updateAndGet(calls, (value) => value + 1);

            return count === 1
              ? yield* new EmailRejected({
                  provider: "fixture",
                  reason: "rate-limited",
                  retryAfterMillis: 2000,
                })
              : receipt;
          }),
        );

        const pendingObserver = (decision: EmailRetryCandidate | EmailRetryDecision) =>
          Effect.gen(function* holdRetryNotification() {
            decisions.push(decision);
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release);
          });

        const notified: EmailRetryDecision[] = [];

        const observer: EmailRetryObserver =
          callbackRole === "Observer"
            ? pendingObserver
            : (decision) =>
                Effect.sync(() => {
                  notified.push(decision);
                });

        const restriction: EmailRetryRestriction | undefined =
          callbackRole === "Restriction"
            ? (decision) => pendingObserver(decision).pipe(Effect.as(true))
            : undefined;

        const fiber = yield* Effect.gen(function* sendOwnedObservedEmail() {
          return yield* (yield* Email).send(input, { policy: { ...policy, maxAttempts: 2 } });
        }).pipe(
          Effect.provide(
            emailLayer({ ...policy, maxAttempts: 1 }, observer, restriction).pipe(
              Layer.provide(sender),
            ),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);
        input.subject = "private-mutated";
        assert.strictEqual(notified.length, 0);
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Ref.get(calls), 1);
        yield* Deferred.succeed(release, true);
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Ref.get(calls), 1);
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Fiber.join(fiber), receipt);
        assert.deepStrictEqual(submitted, ["private-original", "private-original"]);
        assert.strictEqual(decisions.length, 1);
        assert.strictEqual(decisions[0]?.delayMillis, 2000);
        assert.strictEqual(notified.length, callbackRole === "Restriction" ? 1 : 0);
      }),
  );

  it.effect.each(["Cancellation", "Deadline"] as const)(
    "keeps a waiting retry observer interruptible under %s",
    (termination) =>
      Effect.gen(function* interruptRetryObserver() {
        const entered = yield* Deferred.make<boolean>();
        const released = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);
        const decisions: EmailRetryDecision[] = [];

        const observer: EmailRetryObserver = (decision) =>
          Effect.gen(function* waitInRetryObserver() {
            decisions.push(decision);
            yield* Deferred.succeed(entered, true);

            return yield* Effect.never.pipe(Effect.ensuring(Deferred.succeed(released, true)));
          });

        const fiber = yield* Effect.gen(function* submitWaitingRetryObserver() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            emailLayer({ ...policy, deadline: Duration.millis(100) }, observer).pipe(
              Layer.provide(
                suppliedSender(() =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(
                      new EmailRejected({ provider: "fixture", reason: "rate-limited" }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);

        yield* termination === "Cancellation" ? Fiber.interrupt(fiber) : TestClock.adjust(100);
        yield* Deferred.await(released);
        const outcome = yield* Fiber.await(fiber);
        assert(Exit.isFailure(outcome));

        const expectedTermination =
          termination === "Cancellation"
            ? Exit.hasInterrupts(outcome)
            : outcome.cause.reasons.some(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  reason.error instanceof EmailDeliveryUnknown &&
                  reason.error.reason === "timeout",
              );

        assert.isTrue(expectedTermination);
        assert.strictEqual(yield* Ref.get(calls), 1);
        assert.strictEqual(decisions.length, 1);
      }),
  );

  it.effect.each(["Cancellation", "Deadline"] as const)(
    "keeps a waiting retry restriction interruptible under %s",
    (termination) =>
      Effect.gen(function* interruptRetryRestriction() {
        const entered = yield* Deferred.make<boolean>();
        const released = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);
        const observations = yield* Ref.make(0);

        const restriction: EmailRetryRestriction = () =>
          Effect.gen(function* waitInRetryRestriction() {
            yield* Deferred.succeed(entered, true);

            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(released, true)));

        const fiber = yield* Effect.gen(function* submitWaitingRetryRestriction() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            emailLayer(
              { ...policy, deadline: Duration.millis(100) },
              () => Ref.update(observations, (count) => count + 1),
              restriction,
            ).pipe(
              Layer.provide(
                suppliedSender(() =>
                  Ref.update(calls, (count) => count + 1).pipe(
                    Effect.andThen(
                      new EmailRejected({ provider: "fixture", reason: "rate-limited" }),
                    ),
                  ),
                ),
              ),
            ),
          ),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);
        yield* termination === "Cancellation" ? Fiber.interrupt(fiber) : TestClock.adjust(100);
        yield* Deferred.await(released);
        const outcome = yield* Fiber.await(fiber);
        assert(Exit.isFailure(outcome));
        assert.isTrue(
          termination === "Cancellation"
            ? Exit.hasInterrupts(outcome)
            : outcome.cause.reasons.some(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  reason.error instanceof EmailDeliveryUnknown &&
                  reason.error.reason === "timeout",
              ),
        );
        assert.strictEqual(yield* Ref.get(calls), 1);
        assert.strictEqual(yield* Ref.get(observations), 0);
      }),
  );

  it.effect.each(["Rejected", "Unknown", "UnknownThenRejected"] as const)(
    "a retry veto preserves %s evidence and existing fallback authority",
    (history) =>
      Effect.gen(function* vetoRetryWithoutInventingAuthority() {
        const calls = yield* Ref.make(0);
        const backups = yield* Ref.make(0);
        const entered = yield* Deferred.make<boolean>();
        const observations: EmailRetryDecision[] = [];
        const offered: EmailRetryCandidate[] = [];
        const unknown = new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" });
        const rejected = new EmailRejected({ provider: "fixture", reason: "rate-limited" });

        const restriction: EmailRetryRestriction = (decision) =>
          Effect.sync(() => {
            offered.push(decision);

            return history === "UnknownThenRejected" && decision.attempt === 1;
          });

        const primary = emailLayer(
          policy,
          (decision) =>
            Effect.sync(() => {
              observations.push(decision);
            }),
          restriction,
        ).pipe(
          Layer.provide(
            suppliedSender(() =>
              Effect.gen(function* submitVetoedHistory() {
                const count = yield* Ref.updateAndGet(calls, (value) => value + 1);
                yield* Deferred.succeed(entered, true);

                return yield* history !== "Rejected" && count === 1 ? unknown : rejected;
              }),
            ),
          ),
        );

        const backup = emailLayer(policy).pipe(
          Layer.provide(
            suppliedSender(() =>
              Ref.update(backups, (count) => count + 1).pipe(Effect.as(receipt)),
            ),
          ),
        );

        const fiber = yield* Effect.gen(function* submitVetoedRoute() {
          return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: primary, name: "primary" },
                { layer: backup, name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.result,
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);
        yield* TestClock.adjust(1000);
        const result = yield* Fiber.join(fiber);

        if (history === "Rejected") {
          assert(Result.isSuccess(result));
        } else {
          assert(Result.isFailure(result));
          assert.strictEqual(result.failure, unknown);
        }

        assert.strictEqual(yield* Ref.get(calls), history === "UnknownThenRejected" ? 2 : 1);
        assert.strictEqual(yield* Ref.get(backups), history === "Rejected" ? 1 : 0);
        assert.strictEqual(observations.length, history === "UnknownThenRejected" ? 1 : 0);
        assert.strictEqual(offered.length, history === "UnknownThenRejected" ? 2 : 1);
      }),
  );

  it.effect("preserves earlier uncertainty after observing later definite rejection", () =>
    Effect.gen(function* retainObservedUncertainty() {
      const calls = yield* Ref.make(0);
      const backups = yield* Ref.make(0);
      const entered = yield* Deferred.make<boolean>();
      const decisions: EmailRetryDecision[] = [];
      const unknown = new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" });

      const observer: EmailRetryObserver = (decision) =>
        Effect.sync(() => {
          decisions.push(decision);
        });

      const primary = emailLayer(policy, observer).pipe(
        Layer.provide(
          suppliedSender(() =>
            Effect.gen(function* submitMixedObservedOutcomes() {
              const count = yield* Ref.updateAndGet(calls, (value) => value + 1);
              yield* Deferred.succeed(entered, true);

              if (count === 1) {
                return yield* unknown;
              }

              return yield* new EmailRejected({
                provider: "fixture",
                reason: count === 2 ? "rate-limited" : "invalid-message",
              });
            }),
          ),
        ),
      );

      const backup = emailLayer(policy).pipe(
        Layer.provide(
          suppliedSender(() => Ref.update(backups, (count) => count + 1).pipe(Effect.as(receipt))),
        ),
      );

      const fiber = yield* Effect.gen(function* submitObservedUncertainRoute() {
        return yield* (yield* Email).send(message, { idempotencyKey: "private-key" });
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: primary, name: "primary" },
              { layer: backup, name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.result,
        Effect.forkScoped,
      );

      yield* Deferred.await(entered);
      yield* TestClock.adjust(1000);
      const outcome = yield* Fiber.join(fiber);
      assert(Result.isFailure(outcome));
      assert.strictEqual(outcome.failure, unknown);
      assert.strictEqual(yield* Ref.get(calls), 3);
      assert.strictEqual(yield* Ref.get(backups), 0);
      assert.deepStrictEqual(
        decisions.map((decision) => [decision._tag, decision.attempt, decision.nextAttempt]),
        [
          ["UnknownRetry", 1, 2],
          ["RejectedRetry", 2, 3],
        ],
      );
    }),
  );

  it.effect("serializes overflowed backoff truthfully without promising another attempt", () =>
    Effect.gen(function* observeInfiniteRetryBackoff() {
      const candidates: EmailRetryCandidate[] = [];
      const entered = yield* Deferred.make<boolean>();
      const calls = yield* Ref.make(0);
      const decisions: EmailRetryDecision[] = [];

      const observer: EmailRetryObserver = (decision) =>
        Effect.sync(() => {
          decisions.push(decision);
        }).pipe(Effect.andThen(Deferred.succeed(entered, true)), Effect.asVoid);

      const sender = suppliedSender(() =>
        Ref.update(calls, (count) => count + 1).pipe(
          Effect.andThen(new EmailRejected({ provider: "fixture", reason: "rate-limited" })),
        ),
      );

      const fiber = yield* Effect.gen(function* submitOverflowedBackoff() {
        return yield* (yield* Email).send(message);
      }).pipe(
        Effect.provide(
          emailLayer(
            {
              deadline: Duration.millis(100),
              initialDelay: Duration.millis(Number.MAX_VALUE),
              maxAttempts: 2,
            },
            observer,
            (candidate) =>
              Effect.sync(() => {
                candidates.push(candidate);

                return true;
              }),
          ).pipe(Layer.provide(sender)),
        ),
        Random.withSeed("example"),
        Effect.result,
        Effect.forkScoped,
      );

      yield* Deferred.await(entered);
      const [candidate] = candidates;
      assert.isDefined(candidate);
      assert.isFrozen(candidate);
      assert.strictEqual(candidate._tag, "RejectedRetryCandidate");
      assert.strictEqual(candidate.delayMillis, "Infinite");
      yield* Schema.decodeEffect(EmailRetryCandidateSchema)(candidate);
      const [decision] = decisions;
      assert.isDefined(decision);
      assert.strictEqual(decision.delayMillis, "Infinite");
      const encoded = yield* Schema.encodeEffect(EmailRetryDecisionSchema)(decision);
      assert.include(JSON.stringify(encoded), '"Infinite"');
      yield* Schema.decodeEffect(EmailRetryDecisionSchema)(encoded);
      yield* TestClock.adjust(100);
      const outcome = yield* Fiber.join(fiber);
      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "timeout");
      assert.strictEqual(yield* Ref.get(calls), 1);
      assert.strictEqual(decisions.length, 1);
    }),
  );

  it.effect("does not notify for acceptance or local invalidity", () =>
    Effect.gen(function* skipNonRetryOutcomes() {
      const calls = yield* Ref.make(0);
      const notifications = yield* Ref.make(0);
      const restrictions = yield* Ref.make(0);
      const observer: EmailRetryObserver = () => Ref.update(notifications, (count) => count + 1);
      yield* Effect.gen(function* submitNonRetryOutcomes() {
        const email = yield* Email;
        assert.strictEqual(yield* email.send(message), receipt);
        const invalid = yield* email.send({ ...message, to: "not-an-address" }).pipe(Effect.result);
        assert(Result.isFailure(invalid));
        assert.strictEqual(invalid.failure._tag, "EmailInvalidMessage");
      }).pipe(
        Effect.provide(
          emailLayer(policy, observer, () =>
            Ref.update(restrictions, (count) => count + 1).pipe(Effect.as(true)),
          ).pipe(
            Layer.provide(
              suppliedSender(() =>
                Ref.update(calls, (count) => count + 1).pipe(Effect.as(receipt)),
              ),
            ),
          ),
        ),
      );
      assert.strictEqual(yield* Ref.get(calls), 1);
      assert.strictEqual(yield* Ref.get(notifications), 0);
      assert.strictEqual(yield* Ref.get(restrictions), 0);
    }),
  );
});
