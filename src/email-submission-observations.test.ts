import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Queue,
  Ref,
  Result,
  Schema,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { validateEmailCapabilities } from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailMessageIdSchema, EmailReceiptSchema, parseEmailMessage } from "./email-message.js";
import type { EmailMessageInput } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import type { EmailSendError } from "./email-errors.js";
import { emailRouterLayer } from "./email-routing.js";
import { Email, emailLayer } from "./email-service.js";
import {
  EmailSubmissionObservationSchema,
  EmailSubmissionObservationSnapshotSchema,
  EmailSubmissionObservations,
  EmailSubmissionStartingSchema,
  observedEmailSenderLayer,
} from "./email-submission-observations.js";
import type {
  EmailSubmissionObservation,
  EmailSubmissionStarting,
  EmailSubmissionStartingObserver,
} from "./email-submission-observations.js";
import {
  recordingSenderLayer,
  recordingEmailLayer,
  recordingEmailCapabilities,
} from "./recording-email-sender.js";

const message: EmailMessageInput = {
  body: { text: "private-message-body" },
  from: "private-sender@fictional.invalid",
  subject: "private-subject",
  to: ["private-recipient@fictional.invalid"],
};

const receipt = Object.freeze(
  EmailReceiptSchema.cases.Accepted.make({
    messageId: EmailMessageIdSchema.make("private-message-id"),
    provider: "fixture",
  }),
);

const senderLayer = (submit: IEmailSender["submit"]) =>
  Layer.succeed(
    EmailSender,
    EmailSender.of({
      capabilities: recordingEmailCapabilities,
      idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
      provider: "fixture",
      submit,
      validate: (input) => validateEmailCapabilities(input, recordingEmailCapabilities),
    }),
  );

const oneAttempt = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(1),
  maxAttempts: 1,
};

const withEmail = <E, R>(sender: Layer.Layer<EmailSender | EmailSubmissionObservations, E, R>) =>
  emailLayer(oneAttempt).pipe(Layer.provideMerge(sender));

describe("explicit bounded settled sender observations", () => {
  it.effect(
    "awaits a frozen starting fact before delegation without recording premature settlement or retaining intent",
    () =>
      Effect.gen(function* awaitStartingSenderFact() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const submitted = yield* Queue.unbounded<string>();
        const starts: EmailSubmissionStarting[] = [];
        const phases: string[] = [];
        const input = { ...message, subject: "private-original-subject" };
        const trace = yield* startEmailTraceFixture();

        const starting: EmailSubmissionStartingObserver = (fact) =>
          Effect.gen(function* holdSenderStart() {
            starts.push(fact);
            phases.push("Starting");
            yield* Deferred.succeed(entered, true);
            yield* Deferred.await(release);
          });

        const raw = senderLayer((submission) =>
          Queue.offer(submitted, submission.message.subject).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                phases.push("Delegated");
              }),
            ),
            Effect.as(receipt),
          ),
        );

        yield* Effect.gen(function* submitAfterStartingObserver() {
          const email = yield* Email;
          const view = yield* EmailSubmissionObservations;
          const fiber = yield* email.send(input).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          assert.strictEqual(yield* Queue.size(submitted), 0);
          assert.strictEqual((yield* view.snapshot).observations.length, 0);
          input.subject = "private-mutated-subject";
          const [fact] = starts;
          assert.isDefined(fact);
          assert.isFrozen(fact);
          yield* Schema.decodeEffect(EmailSubmissionStartingSchema)(fact);
          assert.strictEqual(fact.provider, "fixture");
          yield* Deferred.succeed(release, true);
          assert.strictEqual(yield* Fiber.join(fiber), receipt);
          assert.strictEqual(yield* Queue.take(submitted), "private-original-subject");
          assert.strictEqual((yield* view.snapshot).observations.length, 1);
        }).pipe(
          Effect.provide(
            withEmail(
              observedEmailSenderLayer(
                raw,
                {},
                () =>
                  Effect.sync(() => {
                    phases.push("Settled");
                  }),
                starting,
              ),
            ),
          ),
          Effect.withTracer(trace.tracer),
        );
        assert.deepStrictEqual(phases, ["Starting", "Delegated", "Settled"]);
        assert.strictEqual(starts.length, 1);
        assert.notInclude(JSON.stringify(starts), "private");
        const diagnostics = yield* trace.diagnostics;
        assert.notInclude(diagnostics, "private-original-subject");
        assert.notInclude(diagnostics, "private-mutated-subject");
      }),
  );

  it.effect.each(["Cancellation", "Deadline"] as const)(
    "interrupts a pending starting observer before delegation under %s",
    (termination) =>
      Effect.gen(function* interruptStartingSenderObserver() {
        const entered = yield* Deferred.make<boolean>();
        const released = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);

        const starting: EmailSubmissionStartingObserver = () =>
          Effect.gen(function* awaitCancelledSenderStart() {
            yield* Deferred.succeed(entered, true);

            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(released, true)));

        yield* Effect.gen(function* cancelBeforeDelegation() {
          const email = yield* Email;
          const view = yield* EmailSubmissionObservations;
          const fiber = yield* email.send(message).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* termination === "Cancellation"
            ? Fiber.interrupt(fiber)
            : TestClock.adjust(Duration.seconds(10));
          yield* Deferred.await(released);
          const outcome = yield* Fiber.await(fiber);
          assert(Exit.isFailure(outcome));

          if (termination === "Cancellation") {
            assert.isTrue(Exit.hasInterrupts(outcome));
          } else {
            assert.isTrue(
              outcome.cause.reasons.some(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  reason.error instanceof EmailDeliveryUnknown &&
                  reason.error.reason === "timeout",
              ),
            );
          }

          assert.strictEqual((yield* view.snapshot).observations.length, 0);
        }).pipe(
          Effect.provide(
            withEmail(
              observedEmailSenderLayer(
                senderLayer(() => Ref.update(calls, (count) => count + 1).pipe(Effect.as(receipt))),
                {},
                undefined,
                starting,
              ),
            ),
          ),
        );
        assert.strictEqual(yield* Ref.get(calls), 0);
      }),
  );

  for (const mode of ["Direct", "Batch", "Personalized", "Routed"] as const) {
    it.effect.each(["Defect", "Interruption"] as const)(
      `a starting %s never delegates, retries, falls back or settles in ${mode}`,
      (fault) =>
        Effect.gen(function* preserveStartingObserverFault() {
          const calls = yield* Ref.make(0);
          const backups = yield* Ref.make(0);
          const starts = yield* Ref.make(0);
          const settled = yield* Ref.make(0);
          const defect = new Error("private starting observer defect");

          const starting: EmailSubmissionStartingObserver = () =>
            Ref.update(starts, (count) => count + 1).pipe(
              Effect.andThen(
                fault === "Defect" ? Effect.die(defect) : Effect.failCause(Cause.interrupt(123)),
              ),
            );

          const primary = emailLayer({ ...oneAttempt, maxAttempts: 3 }).pipe(
            Layer.provide(
              observedEmailSenderLayer(
                senderLayer(() => Ref.update(calls, (count) => count + 1).pipe(Effect.as(receipt))),
                {},
                () => Ref.update(settled, (count) => count + 1),
                starting,
              ),
            ),
          );

          const backup = emailLayer().pipe(
            Layer.provide(
              senderLayer(() => Ref.update(backups, (count) => count + 1).pipe(Effect.as(receipt))),
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

          const trace = yield* startEmailTraceFixture();

          const outcome = yield* Effect.gen(function* submitStartingFault() {
            const email = yield* Email;

            const operations: Record<typeof mode, () => Effect.Effect<unknown, EmailSendError>> = {
              Batch: () => email.sendAll([{ message }]),
              Direct: () => email.send(message),
              Personalized: () =>
                email.sendPersonalized({
                  message: {
                    body: { text: "%recipient.name%" },
                    from: message.from,
                    subject: message.subject,
                  },
                  recipients: [
                    { to: "recipient@fictional.invalid", variables: { name: "private-variable" } },
                  ],
                }),
              Routed: () => email.send(message),
            };

            return yield* operations[mode]();
          }).pipe(Effect.provide(selected), Effect.withTracer(trace.tracer), Effect.exit);

          assert(Exit.isFailure(outcome));
          assert.isTrue(fault === "Defect" ? Exit.hasDies(outcome) : Exit.hasInterrupts(outcome));
          assert.strictEqual(yield* Ref.get(calls), 0);
          assert.strictEqual(yield* Ref.get(backups), 0);
          assert.strictEqual(yield* Ref.get(starts), 1);
          assert.strictEqual(yield* Ref.get(settled), 0);
          assert.notInclude(yield* trace.diagnostics, "private starting observer defect");
        }),
    );
  }

  it.effect.each(["Defect", "Interruption"] as const)(
    "keeps earlier unknown evidence when the next starting callback ends in %s",
    (fault) =>
      Effect.gen(function* preserveUnknownBeforeStartingFault() {
        const refused = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);
        const starts = yield* Ref.make(0);
        const facts: EmailSubmissionObservation[] = [];
        const unknown = new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" });

        const raw = Layer.effect(
          EmailSender,
          Effect.gen(function* acquireNativeStartingSender() {
            const sender = yield* EmailSender;

            return EmailSender.of({
              ...sender,
              idempotency: EmailSenderIdempotencySchema.cases.Native.make({
                retention: Duration.hours(24),
              }),
            });
          }),
        ).pipe(
          Layer.provide(
            senderLayer(() =>
              Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(Effect.fail(unknown))),
            ),
          ),
        );

        const callbackFault =
          fault === "Defect"
            ? Effect.die("private later starting fault")
            : Effect.failCause(Cause.interrupt(123));

        const starting: EmailSubmissionStartingObserver = () =>
          Ref.updateAndGet(starts, (count) => count + 1).pipe(
            Effect.flatMap((count) => (count === 2 ? callbackFault : Effect.void)),
          );

        const primary = emailLayer({ ...oneAttempt, maxAttempts: 3 }).pipe(
          Layer.provide(
            observedEmailSenderLayer(
              raw,
              {},
              (fact) =>
                Effect.sync(() => {
                  facts.push(fact);
                }).pipe(Effect.andThen(Deferred.succeed(refused, true)), Effect.asVoid),
              starting,
            ),
          ),
        );

        const router = emailRouterLayer(
          [
            { layer: primary, name: "primary" },
            { layer: recordingEmailLayer, name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        yield* Effect.gen(function* stopUncertainRouteBeforeSecondDelegate() {
          const email = yield* Email;

          const fiber = yield* email
            .send(message, { idempotencyKey: "private-stable-key" })
            .pipe(Effect.forkScoped);

          yield* Deferred.await(refused);
          yield* TestClock.adjust(Duration.millis(100));
          const result = yield* Fiber.await(fiber);
          assert(Exit.isFailure(result));
          assert.isTrue(fault === "Defect" ? Exit.hasDies(result) : Exit.hasInterrupts(result));
        }).pipe(Effect.provide(router));
        assert.strictEqual(yield* Ref.get(calls), 1);
        assert.strictEqual(yield* Ref.get(starts), 2);
        assert.strictEqual(facts.length, 1);
        assert.strictEqual(facts[0]?._tag, "Unknown");
      }),
  );

  it.effect(
    "delivers the retained frozen fact without private receipt data on every invocation",
    () =>
      Effect.gen(function* deliverSettledSenderFacts() {
        const delivered = yield* Queue.unbounded<EmailSubmissionObservation>();

        yield* Effect.gen(function* invokeObservedSender() {
          const email = yield* Email;
          assert.strictEqual(yield* email.send(message), receipt);
          const first = yield* Queue.take(delivered);
          assert.strictEqual(
            first,
            (yield* (yield* EmailSubmissionObservations).snapshot).observations[0],
          );
          assert.isFrozen(first);
          assert.notInclude(JSON.stringify(first), "private-message-id");
          assert.notInclude(JSON.stringify(first), "private-subject");
          assert.strictEqual(yield* email.send(message), receipt);
          const second = yield* Queue.take(delivered);
          assert.strictEqual(
            second,
            (yield* (yield* EmailSubmissionObservations).snapshot).observations[0],
          );
          assert.strictEqual(yield* Queue.size(delivered), 0);
        }).pipe(
          Effect.provide(
            withEmail(
              observedEmailSenderLayer(
                senderLayer(() => Effect.succeed(receipt)),
                { capacity: 1 },
                (fact) => Queue.offer(delivered, fact).pipe(Effect.asVoid),
              ),
            ),
          ),
        );
      }),
  );

  it.effect.each(["Complete", "Interrupt"] as const)(
    "appends the fact before an interruptible observer finishes: %s",
    (mode) =>
      Effect.gen(function* awaitSenderObserver() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const returned = yield* Deferred.make<boolean>();
        const calls = yield* Ref.make(0);

        const observed = observedEmailSenderLayer(
          senderLayer(() => Ref.update(calls, (count) => count + 1).pipe(Effect.as(receipt))),
          {},
          () =>
            Deferred.succeed(entered, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.asVoid,
            ),
        );

        yield* Effect.gen(function* inspectPendingObserver() {
          const email = yield* Email;

          const fiber = yield* email.send(message).pipe(
            Effect.tap(() => Deferred.succeed(returned, true)),
            Effect.forkScoped,
          );

          yield* Deferred.await(entered);
          assert.strictEqual(yield* Deferred.isDone(returned), false);
          const view = yield* EmailSubmissionObservations;
          assert.strictEqual((yield* view.snapshot).observations[0]?._tag, "Receipt");

          if (mode === "Complete") {
            yield* Deferred.succeed(release, true);
            assert.strictEqual(yield* Fiber.join(fiber), receipt);
          } else {
            yield* Fiber.interrupt(fiber);
            assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
          }

          assert.strictEqual(yield* Ref.get(calls), 1);
          assert.strictEqual((yield* view.snapshot).observations.length, 1);
        }).pipe(Effect.provide(withEmail(observed)));
      }),
  );

  it.effect.each(["Receipt", "Rejected", "Unknown"] as const)(
    "propagates observer defects after %s without retrying and preserves original typed evidence",
    (kind) =>
      Effect.gen(function* preserveObserverDefectEvidence() {
        const calls = yield* Ref.make(0);

        const failure =
          kind === "Unknown"
            ? new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" })
            : new EmailRejected({ provider: "fixture", reason: "rate-limited" });

        const defect = new Error("private-observer-defect");
        const trace = yield* startEmailTraceFixture();
        const source = kind === "Receipt" ? Effect.succeed(receipt) : Effect.fail(failure);

        const observed = observedEmailSenderLayer(
          senderLayer(() => Ref.update(calls, (count) => count + 1).pipe(Effect.andThen(source))),
          {},
          () => Effect.die(defect),
        );

        yield* Effect.gen(function* inspectFailedObserver() {
          const exit = yield* (yield* Email).send(message).pipe(Effect.exit);
          assert(Exit.isFailure(exit));
          assert(Exit.hasDies(exit));
          const found = Cause.findDefect(exit.cause);
          assert(Result.isSuccess(found));
          assert.strictEqual(found.success, defect);

          if (kind !== "Receipt") {
            const retained = exit.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect)
              .find(Cause.isCause);

            assert.isDefined(retained);
            assert(Cause.isCause(retained));
            const original = Cause.findError(retained);
            assert(Result.isSuccess(original));
            assert.strictEqual(original.success, failure);
          }

          assert.strictEqual(yield* Ref.get(calls), 1);
          assert.strictEqual(
            (yield* (yield* EmailSubmissionObservations).snapshot).observations[0]?._tag,
            kind,
          );
        }).pipe(
          Effect.provide(
            emailLayer({ ...oneAttempt, maxAttempts: 3 }).pipe(Layer.provideMerge(observed)),
          ),
          Effect.withTracer(trace.tracer),
        );
        assert.notInclude(yield* trace.diagnostics, "private-observer-defect");
      }),
  );

  it.effect("does not call the observer for local input failure or a sender defect", () =>
    Effect.gen(function* excludeUnsettledObserverEvents() {
      const callbacks = yield* Ref.make(0);
      const starts = yield* Ref.make(0);

      const observed = observedEmailSenderLayer(
        senderLayer(() => Effect.die("private sender defect")),
        {},
        () => Ref.update(callbacks, (count) => count + 1),
        () => Ref.update(starts, (count) => count + 1),
      );

      yield* Effect.gen(function* invokeUnsettledSender() {
        const email = yield* Email;
        const invalid = yield* email.send({ ...message, subject: "" }).pipe(Effect.result);
        assert(Result.isFailure(invalid));
        assert.strictEqual(yield* Ref.get(starts), 0);
        const defect = yield* email.send(message).pipe(Effect.exit);
        assert(Exit.hasDies(defect));
        assert.strictEqual(yield* Ref.get(starts), 1);
        assert.strictEqual(yield* Ref.get(callbacks), 0);
        assert.deepStrictEqual(
          (yield* (yield* EmailSubmissionObservations).snapshot).observations,
          [],
        );
      }).pipe(Effect.provide(withEmail(observed)));
    }),
  );

  it.effect(
    "returns the original receipt and captures only a terminal kind without private payloads or keys",
    () =>
      Effect.gen(function* observeOriginalEmailReceipt() {
        const email = yield* Email;
        const observations = yield* EmailSubmissionObservations;
        const before = yield* observations.snapshot;
        assert.deepStrictEqual(before.observations, []);
        const result = yield* email.send(message);
        assert.strictEqual(result, receipt);
        const after = yield* observations.snapshot;
        const [observation] = after.observations;
        assert.isDefined(observation);
        assert(EmailSubmissionObservationSchema.guards.Receipt(observation));
        assert.strictEqual(observation.receiptKind, "Accepted");
        assert.strictEqual(observation.provider, "fixture");
        assert.isFalse(after.truncated);
        assert.deepStrictEqual(before.observations, []);
        assert(Object.isFrozen(after));
        assert(Object.isFrozen(after.observations));
        assert(Object.isFrozen(observation));

        for (const value of [
          "private-message-id",
          "private-message-body",
          "private-subject",
          "private-recipient",
          "private-sender",
        ]) {
          assert.notInclude(JSON.stringify(after), value);
        }
      }).pipe(
        Effect.provide(
          withEmail(observedEmailSenderLayer(senderLayer(() => Effect.succeed(receipt)))),
        ),
      ),
  );

  it.effect.each([
    new EmailRejected({
      provider: "fixture",
      reason: "rate-limited",
      retryAfterMillis: 100,
      status: 429,
    }),
    new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
  ])(
    "retains original typed failure identity and captures its category without granting replay %#",
    (failure) =>
      Effect.gen(function* observeUnchangedEmailFailure() {
        const email = yield* Email;
        const observations = yield* EmailSubmissionObservations;
        const result = yield* email.send(message).pipe(Effect.result);
        assert(Result.isFailure(result));
        assert.strictEqual(result.failure, failure);
        const snapshot = yield* observations.snapshot;
        const [observation] = snapshot.observations;
        assert.isDefined(observation);

        const expectedKind = Match.value(failure).pipe(
          Match.tag("EmailRejected", () => "Rejected" as const),
          Match.tag("EmailDeliveryUnknown", () => "Unknown" as const),
          Match.exhaustive,
        );

        assert(EmailSubmissionObservationSchema.guards[expectedKind](observation));

        assert.strictEqual(snapshot.observations.length, 1);
        assert.notInclude(JSON.stringify(snapshot), "transport");
        assert.notInclude(JSON.stringify(snapshot), "rate-limited");
      }).pipe(Effect.provide(withEmail(observedEmailSenderLayer(senderLayer(() => failure))))),
  );

  it.effect(
    "does not create observations from validation or invalid local message/options preflight",
    () =>
      Effect.gen(function* observeOnlySenderInvocations() {
        const email = yield* Email;
        const observations = yield* EmailSubmissionObservations;
        yield* email.validate(message);

        const invalid = yield* email
          .send({ ...message, to: "private-invalid-recipient" })
          .pipe(Effect.result);

        assert(Result.isFailure(invalid));

        const incompatible = yield* email
          .send(message, { idempotencyKey: "private-key" })
          .pipe(Effect.result);

        assert(Result.isFailure(incompatible));
        assert.deepStrictEqual((yield* observations.snapshot).observations, []);
      }).pipe(
        Effect.provide(
          withEmail(observedEmailSenderLayer(senderLayer(() => Effect.succeed(receipt)))),
        ),
      ),
  );

  it.effect(
    "bounds recent completion order, exposes truncation and leaves earlier snapshots immutable",
    () =>
      Effect.gen(function* retainRecentEmailObservations() {
        const calls = yield* Ref.make(0);

        const outcomesBySequence = new Map<number, ReturnType<IEmailSender["submit"]>>([
          [2, Effect.fail(new EmailRejected({ provider: "fixture", reason: "rejected" }))],
          [3, Effect.fail(new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }))],
        ]);

        const raw = senderLayer(() =>
          Effect.gen(function* numberedEmailSubmission() {
            const sequence = yield* Ref.updateAndGet(calls, (value) => value + 1);

            return yield* outcomesBySequence.get(sequence) ?? Effect.succeed(receipt);
          }),
        );

        yield* Effect.gen(function* fillEmailObservationWindow() {
          const email = yield* Email;
          const observations = yield* EmailSubmissionObservations;
          yield* email.send(message);
          const old = yield* observations.snapshot;
          yield* email.send(message).pipe(Effect.result);
          const full = yield* observations.snapshot;
          assert.isFalse(full.truncated);
          yield* email.send(message).pipe(Effect.result);
          const replaced = yield* observations.snapshot;
          assert.isTrue(replaced.truncated);
          assert.strictEqual(replaced.observations.length, 2);
          const [first, second] = replaced.observations;
          assert.isDefined(first);
          assert.isDefined(second);
          assert(EmailSubmissionObservationSchema.guards.Rejected(first));
          assert(EmailSubmissionObservationSchema.guards.Unknown(second));
          assert.strictEqual(old.observations.length, 1);
          assert.isFalse(old.truncated);
          assert.strictEqual(full.observations.length, 2);
          yield* email.send(message);
          assert.isTrue((yield* observations.snapshot).truncated);
        }).pipe(Effect.provide(withEmail(observedEmailSenderLayer(raw, { capacity: 2 }))));
        assert.strictEqual(yield* Ref.get(calls), 4);
      }),
  );

  it.effect.each([0, -1, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid capacity %s before acquiring the supplied sender",
    (capacity) =>
      Effect.gen(function* validateObservationCapacityBeforeAcquisition() {
        const acquisitions = yield* Ref.make(0);

        const raw = Layer.effect(
          EmailSender,
          Effect.gen(function* acquireCountedSender() {
            yield* Ref.update(acquisitions, (count) => count + 1);

            return EmailSender.of({
              capabilities: recordingEmailCapabilities,
              idempotency: EmailSenderIdempotencySchema.cases.None.make({}),
              provider: "fixture",
              submit: () => Effect.succeed(receipt),
              validate: () => Effect.void,
            });
          }),
        );

        const result = yield* EmailSender.pipe(
          Effect.provide(observedEmailSenderLayer(raw, { capacity })),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Ref.get(acquisitions), 0);
        assert.include(
          result.failure.issues.map((issue) => issue.path),
          "capacity",
        );
      }),
  );

  it.effect("owns numeric capacity at acquisition and accepts both supported endpoints", () =>
    Effect.gen(function* ownObservationCapacity() {
      for (const capacity of [1, 10_000]) {
        const options = { capacity };
        yield* Effect.gen(function* useCapturedObservationCapacity() {
          options.capacity = 0;
          const email = yield* Email;
          const observations = yield* EmailSubmissionObservations;
          yield* email.send(message);
          yield* email.send(message);
          const snapshot = yield* observations.snapshot;
          assert.strictEqual(snapshot.observations.length, capacity === 1 ? 1 : 2);
          assert.strictEqual(snapshot.truncated, capacity === 1);
        }).pipe(
          Effect.provide(
            withEmail(
              observedEmailSenderLayer(
                senderLayer(() => Effect.succeed(receipt)),
                options,
              ),
            ),
          ),
        );
      }

      const unsupportedOptions = {
        capacity: 2,
        onReceipt: () => Effect.void,
        privateValue: "private-option-data",
      };

      const invalid = yield* EmailSender.pipe(
        Effect.provide(
          observedEmailSenderLayer(
            senderLayer(() => Effect.succeed(receipt)),
            unsupportedOptions,
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(invalid) && invalid.failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(invalid.failure), "private-option-data");
    }),
  );

  it.effect(
    "uses a bounded hundred-entry default without introducing callbacks or extra sender calls",
    () =>
      Effect.gen(function* boundDefaultObservationWindow() {
        const email = yield* Email;
        const observations = yield* EmailSubmissionObservations;

        const results = yield* email.sendAll(
          Array.from({ length: 101 }, () => ({ message })),
          { concurrency: 1 },
        );

        assert.strictEqual(results.length, 101);
        assert(results.every(Result.isSuccess));
        const snapshot = yield* observations.snapshot;
        assert.strictEqual(snapshot.observations.length, 100);
        assert.isTrue(snapshot.truncated);
      }).pipe(
        Effect.provide(
          withEmail(observedEmailSenderLayer(senderLayer(() => Effect.succeed(receipt)))),
        ),
      ),
  );

  it.effect.prop(
    "retains exactly the most recent generated settled categories under bounded capacity",
    {
      capacity: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 })),
      verdicts: Schema.Array(Schema.Literals(["Receipt", "Rejected", "Unknown"])).check(
        Schema.isMaxLength(16),
      ),
    },
    ({ capacity, verdicts }) =>
      Effect.gen(function* observeGeneratedOutcomeWindow() {
        const remaining = yield* Ref.make(verdicts);

        const outcomesByKind = {
          Receipt: Effect.succeed(receipt),
          Rejected: Effect.fail(new EmailRejected({ provider: "fixture", reason: "rejected" })),
          Unknown: Effect.fail(
            new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
          ),
        } satisfies Readonly<Record<(typeof verdicts)[number], ReturnType<IEmailSender["submit"]>>>;

        const raw = senderLayer(() =>
          Effect.gen(function* submitGeneratedOutcome() {
            const [kind] = yield* Ref.getAndUpdate(remaining, (current) => current.slice(1));
            assert.isDefined(kind);

            return yield* outcomesByKind[kind];
          }),
        );

        yield* Effect.gen(function* inspectGeneratedOutcomeWindow() {
          const email = yield* Email;
          const observations = yield* EmailSubmissionObservations;

          const results = yield* email.sendAll(
            verdicts.map(() => ({ message })),
            { concurrency: 1 },
          );

          assert.strictEqual(results.length, verdicts.length);
          const snapshot = yield* observations.snapshot;
          assert.deepStrictEqual(
            snapshot.observations.map((observation) => observation._tag),
            verdicts.slice(-capacity),
          );
          assert.strictEqual(snapshot.truncated, verdicts.length > capacity);
        }).pipe(Effect.provide(withEmail(observedEmailSenderLayer(raw, { capacity }))));
      }),
  );

  it.effect(
    "records actual settlement order under concurrent sends without changing ordered batch Results",
    () =>
      Effect.gen(function* observeConcurrentCompletionOrder() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const raw = senderLayer((submission) =>
          submission.message.subject === "slow"
            ? Effect.gen(function* slowObservedSubmission() {
                yield* Deferred.succeed(entered, true);
                yield* Deferred.await(release);

                return receipt;
              })
            : Effect.succeed(EmailReceiptSchema.cases.Simulated.make({ provider: "fixture" })),
        );

        yield* Effect.gen(function* settleObservedBatch() {
          const email = yield* Email;
          const observations = yield* EmailSubmissionObservations;
          const slow = yield* email.send({ ...message, subject: "slow" }).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const fast = yield* email.sendAll([{ message }]);
          const [firstFast] = fast;
          assert.isDefined(firstFast);
          assert(Result.isSuccess(firstFast));
          let snapshot = yield* observations.snapshot;
          const [first] = snapshot.observations;
          assert.isDefined(first);
          assert(EmailSubmissionObservationSchema.guards.Receipt(first));
          assert.strictEqual(first.receiptKind, "Simulated");
          yield* Deferred.succeed(release, true);
          assert.strictEqual(yield* Fiber.join(slow), receipt);
          snapshot = yield* observations.snapshot;
          const last = snapshot.observations.at(-1);
          assert.isDefined(last);
          assert(EmailSubmissionObservationSchema.guards.Receipt(last));
          assert.strictEqual(last.receiptKind, "Accepted");
        }).pipe(Effect.provide(withEmail(observedEmailSenderLayer(raw))));
      }),
  );

  it.effect(
    "does not reset or replace underlying native replay when the observation window fills",
    () =>
      Effect.gen(function* preserveObservedNativeReplay() {
        const email = yield* Email;
        const observations = yield* EmailSubmissionObservations;
        const options = { idempotencyKey: "private-replay-key" };
        const first = yield* email.send(message, options);
        yield* email.send(message, options);

        const different = yield* email
          .send({ ...message, subject: "different" }, options)
          .pipe(Effect.result);

        assert(Result.isFailure(different) && Schema.is(EmailRejected)(different.failure));
        assert.strictEqual(different.failure.reason, "idempotency-conflict");
        const repeated = yield* email.send(message, options);
        assert.strictEqual(repeated, first);
        const snapshot = yield* observations.snapshot;
        assert.isTrue(snapshot.truncated);
        assert.strictEqual(snapshot.observations.length, 1);
        const [recorded] = snapshot.observations;
        assert.isDefined(recorded);
        assert(EmailSubmissionObservationSchema.guards.Receipt(recorded));
        assert.strictEqual(recorded.receiptKind, "Recorded");
        assert.notInclude(JSON.stringify(snapshot), options.idempotencyKey);
      }).pipe(
        Effect.provide(withEmail(observedEmailSenderLayer(recordingSenderLayer, { capacity: 1 }))),
      ),
  );

  it.effect("records each known-rejection retry but never drives retry policy itself", () =>
    Effect.gen(function* observeExistingRetryPolicy() {
      const starts = yield* Ref.make(0);
      const refused = yield* Deferred.make<boolean>();
      const calls = yield* Ref.make(0);

      const raw = senderLayer(() =>
        Effect.gen(function* rateLimitedObservedSender() {
          const count = yield* Ref.updateAndGet(calls, (current) => current + 1);

          return yield* Match.value(count).pipe(
            Match.when(1, () =>
              Deferred.succeed(refused, true).pipe(
                Effect.andThen(
                  Effect.fail(
                    new EmailRejected({
                      provider: "fixture",
                      reason: "rate-limited",
                      retryAfterMillis: 1000,
                    }),
                  ),
                ),
              ),
            ),
            Match.orElse(() => Effect.succeed(receipt)),
          );
        }),
      );

      yield* Effect.gen(function* observeRetriedEmail() {
        const email = yield* Email;
        const observations = yield* EmailSubmissionObservations;
        const pending = yield* email.send(message).pipe(Effect.forkChild);
        yield* Deferred.await(refused);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(yield* Fiber.join(pending), receipt);
        const snapshot = yield* observations.snapshot;
        assert.strictEqual(snapshot.observations.length, 2);
      }).pipe(
        Effect.provide(
          emailLayer({
            deadline: Duration.seconds(5),
            initialDelay: Duration.millis(1),
            maxAttempts: 2,
          }).pipe(
            Layer.provideMerge(
              observedEmailSenderLayer(raw, {}, undefined, () =>
                Ref.update(starts, (count) => count + 1),
              ),
            ),
          ),
        ),
      );
      assert.strictEqual(yield* Ref.get(calls), 2);
      assert.strictEqual(yield* Ref.get(starts), 2);
    }),
  );

  it.effect(
    "preserves interruption/defects without fabricating a settled rejection or leaking defect data",
    () =>
      Effect.gen(function* preserveObservedSenderExits() {
        const entered = yield* Deferred.make<boolean>();
        const interrupted = yield* Ref.make(false);

        const raw = senderLayer((submission) =>
          submission.message.subject === "defect"
            ? Effect.die("private-original-defect")
            : Effect.gen(function* awaitObservedCancellation() {
                yield* Deferred.succeed(entered, true);

                return yield* Effect.never;
              }).pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
        );

        const trace = yield* startEmailTraceFixture();
        yield* Effect.gen(function* inspectUnsettledObservationExits() {
          const email = yield* Email;
          const observations = yield* EmailSubmissionObservations;
          const pending = yield* email.send(message).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(pending);
          assert(Exit.hasInterrupts(yield* Fiber.await(pending)));
          const defect = yield* email.send({ ...message, subject: "defect" }).pipe(Effect.exit);
          assert(Exit.hasDies(defect));
          assert.include(JSON.stringify(defect), "private-original-defect");
          assert.deepStrictEqual((yield* observations.snapshot).observations, []);
        }).pipe(
          Effect.provide(withEmail(observedEmailSenderLayer(raw))),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );
        assert.isTrue(yield* Ref.get(interrupted));
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "ObservedEmailSender.submit");
        assert.notInclude(diagnostics, "private-original-defect");
        assert.notInclude(diagnostics, "private-message-body");
      }),
  );

  it.effect(
    "forwards underlying acquisition requirements/errors and releases its scoped resource once",
    () =>
      Effect.gen(function* preserveObservedSenderScope() {
        const acquired = yield* Ref.make(0);
        const released = yield* Ref.make(0);

        const raw = Layer.effect(
          EmailSender,
          Effect.acquireRelease(
            Effect.gen(function* acquireObservedFixtureResource() {
              yield* Ref.update(acquired, (count) => count + 1);

              return yield* EmailSender;
            }),
            () => Ref.update(released, (count) => count + 1),
          ),
        );

        const provider = senderLayer(() => Effect.succeed(receipt));
        yield* Effect.gen(function* submitScopedObservedMessage() {
          const sender = yield* EmailSender;
          yield* sender.submit({ message: yield* parseEmailMessage(message) });
          assert.strictEqual(yield* Ref.get(released), 0);
        }).pipe(Effect.provide(observedEmailSenderLayer(raw).pipe(Layer.provide(provider))));
        assert.strictEqual(yield* Ref.get(acquired), 1);
        assert.strictEqual(yield* Ref.get(released), 1);

        const original = new EmailConfigurationError({
          issues: [{ path: "<root>", problem: "configuration unavailable" }],
        });

        const unavailable = Layer.effect(EmailSender, original);

        const failed = yield* EmailSender.pipe(
          Effect.provide(observedEmailSenderLayer(unavailable)),
          Effect.result,
        );

        assert(Result.isFailure(failed));
        assert.strictEqual(failed.failure, original);
      }),
  );

  it.effect(
    "creates independent views for separate acquisitions and supports public observation data Schema reuse",
    () =>
      Effect.gen(function* acquireIndependentEmailObservationWindows() {
        const layer = withEmail(
          observedEmailSenderLayer(senderLayer(() => Effect.succeed(receipt))),
        );

        const first = yield* Effect.gen(function* captureFirstWindow() {
          yield* (yield* Email).send(message);

          return yield* (yield* EmailSubmissionObservations).snapshot;
        }).pipe(Effect.provide(layer));

        const second = yield* EmailSubmissionObservations.pipe(
          Effect.flatMap((view) => view.snapshot),
          Effect.provide(layer),
        );

        assert.strictEqual(first.observations.length, 1);
        assert.strictEqual(second.observations.length, 0);
        const stored = yield* Schema.encodeEffect(EmailSubmissionObservationSnapshotSchema)(first);

        const decoded = yield* Schema.decodeEffect(EmailSubmissionObservationSnapshotSchema)(
          stored,
        );

        assert.deepStrictEqual(decoded, first);
      }),
  );
});
