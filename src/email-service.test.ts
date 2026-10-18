import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
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
} from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailRejected,
  EmailReceiptSchema,
  EmailSender,
  EmailSenderIdempotencySchema,
  EmailConfigurationError,
  emailLayer,
  formatEmailMailbox,
} from "./index.js";
import type {
  EmailAttachmentInput,
  EmailMessageInput,
  EmailReceipt,
  EmailSubmission,
} from "./index.js";
import {
  RecordedEmails,
  recordingEmailLayer,
  recordingEmailCapabilities,
} from "./recording-email-sender.js";

const message: EmailMessageInput = {
  body: { text: "A fictional notification." },
  from: "sender@example.test",
  subject: "Synthetic example",
  to: ["recipient@example.test"],
};

const fixtureMessageSupport = {
  capabilities: recordingEmailCapabilities,
  validate: () => Effect.void,
};

const recordedReceipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

const nativeIdempotency = EmailSenderIdempotencySchema.cases.Native.make({
  retention: Duration.hours(24),
});

const noIdempotency = EmailSenderIdempotencySchema.cases.None.make({});

const keyForwarding = EmailSenderIdempotencySchema.cases.KeyForwarding.make({});

const shortPolicy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

describe("Recorded message retention", () => {
  it.effect("purges lazily, keeps escaped snapshots readable and never reuses a sequence", () =>
    Effect.gen(function* purgeRecordedMessageView() {
      const email = yield* Email;
      const records = yield* RecordedEmails;
      const purge = records.purgeMessages;
      yield* email.send(message);
      yield* email.send(message);
      const snapshot = yield* records.messages;
      assert.strictEqual(yield* purge, 2);
      assert.deepStrictEqual(yield* records.messages, []);
      assert.strictEqual(yield* purge, 0);
      assert.strictEqual(snapshot.length, 2);
      assert.strictEqual(snapshot[0]?.body.text, message.body.text);
      const next = yield* email.send(message);
      assert(EmailReceiptSchema.guards.Recorded(next));
      assert.strictEqual(next.sequence, 3);
      assert.strictEqual((yield* records.messages).length, 1);
      assert.strictEqual(yield* purge, 1);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "retains original keyed receipts and conflicts without repopulating purged messages",
    () =>
      Effect.gen(function* retainPurgedRecordingReplay() {
        const email = yield* Email;
        const records = yield* RecordedEmails;
        const options = { idempotencyKey: "private-original-key" };
        const original = yield* email.send(message, options);
        assert.strictEqual(yield* records.purgeMessages, 1);
        assert.strictEqual(yield* email.send(message, options), original);

        const conflict = yield* email
          .send({ ...message, subject: "Different private intent" }, options)
          .pipe(Effect.result);

        assert(Result.isFailure(conflict));
        assert(conflict.failure instanceof EmailRejected);
        assert.strictEqual(conflict.failure.reason, "idempotency-conflict");
        assert.deepStrictEqual(yield* records.messages, []);
        const next = yield* email.send(message, { idempotencyKey: "different-key" });
        assert(EmailReceiptSchema.guards.Recorded(next));
        assert.strictEqual(next.sequence, 2);
        assert.strictEqual((yield* records.messages).length, 1);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect.prop(
    "concurrent purges remove each visible record once without forgetting generated keyed intent",
    {
      count: Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 1 })),
    },
    ({ count }) =>
      Effect.gen(function* purgeGeneratedRecordingHistory() {
        const email = yield* Email;
        const records = yield* RecordedEmails;

        const requests = Array.from({ length: count }, (_, index) => ({
          message: { ...message, subject: `Generated notification ${index}` },
          options: { idempotencyKey: `event-${index}` },
        }));

        const initial = yield* email.sendAll(requests, { concurrency: 4 });
        assert(initial.every(Result.isSuccess));

        const removed = yield* Effect.all(
          [records.purgeMessages, records.purgeMessages, records.purgeMessages],
          { concurrency: 3 },
        );

        assert.strictEqual(
          removed.reduce((total, value) => total + value, 0),
          count,
        );
        assert.deepStrictEqual(yield* records.messages, []);
        const replayed = yield* email.sendAll(requests, { concurrency: 4 });
        assert.deepStrictEqual(replayed, initial);
        assert.deepStrictEqual(yield* records.messages, []);
        const next = yield* email.send(message);
        assert(EmailReceiptSchema.guards.Recorded(next));
        assert.strictEqual(next.sequence, count + 1);
      }).pipe(Effect.provide(recordingEmailLayer)),
    { arbitrary: { runs: 12 } },
  );

  it.effect("does not cancel a pending submission or hide a commit that occurs after purge", () =>
    Effect.gen(function* purgeBeforePendingRecordingCommit() {
      const email = yield* Email;
      const sender = yield* EmailSender;
      const records = yield* RecordedEmails;
      const started = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const original = yield* email.send(message, { idempotencyKey: "original" });

      const delayed = EmailSender.of({
        ...sender,
        submit: Effect.fnUntraced(function* submitHeldRecording(submission: EmailSubmission) {
          yield* Deferred.succeed(started, true);
          yield* Deferred.await(release);

          return yield* sender.submit(submission);
        }),
      });

      const pending = yield* Effect.gen(function* sendPendingRecording() {
        return yield* (yield* Email).send(
          { ...message, subject: "Pending recording" },
          { idempotencyKey: "pending" },
        );
      }).pipe(
        Effect.provide(emailLayer()),
        Effect.provideService(EmailSender, delayed),
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      assert.strictEqual(yield* records.purgeMessages, 1);
      assert.deepStrictEqual(yield* records.messages, []);
      yield* Deferred.succeed(release, true);
      const receipt = yield* Fiber.join(pending);
      assert(EmailReceiptSchema.guards.Recorded(receipt));
      assert.strictEqual(receipt.sequence, 2);
      assert.deepStrictEqual(
        (yield* records.messages).map((entry) => entry.subject),
        ["Pending recording"],
      );
      assert.strictEqual(yield* email.send(message, { idempotencyKey: "original" }), original);
      assert.strictEqual((yield* records.messages).length, 1);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "preserves native replay when messages are purged after commit but before an uncertain retry",
    () =>
      Effect.gen(function* purgeDuringUncertainRecordingReplay() {
        const sender = yield* EmailSender;
        const records = yield* RecordedEmails;
        const committed = yield* Deferred.make<EmailReceipt>();
        const attempts = yield* Ref.make(0);

        const uncertain = EmailSender.of({
          ...sender,
          submit: Effect.fnUntraced(function* submitUncertainRecording(
            submission: EmailSubmission,
          ) {
            const receipt = yield* sender.submit(submission);
            const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);

            if (attempt === 1) {
              yield* Deferred.succeed(committed, receipt);

              return yield* new EmailDeliveryUnknown({
                provider: "recording",
                reason: "transport",
              });
            }

            return receipt;
          }),
        });

        const pending = yield* Effect.gen(function* retryUncertainRecording() {
          return yield* (yield* Email).send(message, { idempotencyKey: "stable-event" });
        }).pipe(
          Effect.provide(emailLayer(shortPolicy)),
          Effect.provideService(EmailSender, uncertain),
          Effect.forkChild,
        );

        const original = yield* Deferred.await(committed);
        assert.strictEqual(yield* records.purgeMessages, 1);
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(yield* Fiber.join(pending), original);
        assert.strictEqual(yield* Ref.get(attempts), 2);
        assert.deepStrictEqual(yield* records.messages, []);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "purges only the selected Layer while independently acquired recorders retain their own keys",
    () =>
      Effect.gen(function* purgeIsolatedRecordingLayer() {
        const email = yield* Email;
        const records = yield* RecordedEmails;
        const original = yield* email.send(message, { idempotencyKey: "shared-spelling" });
        yield* Effect.gen(function* purgeIndependentRecorder() {
          const independent = yield* Email;
          const independentRecords = yield* RecordedEmails;
          yield* independent.send(
            { ...message, subject: "Independent intent" },
            { idempotencyKey: "shared-spelling" },
          );
          assert.strictEqual(yield* independentRecords.purgeMessages, 1);
          assert.deepStrictEqual(yield* independentRecords.messages, []);
        }).pipe(Effect.provide(Layer.fresh(recordingEmailLayer)));
        assert.strictEqual((yield* records.messages).length, 1);
        assert.strictEqual(
          yield* email.send(message, { idempotencyKey: "shared-spelling" }),
          original,
        );
        assert.strictEqual(yield* records.purgeMessages, 1);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect(
    "exposes purge status without retaining private messages or keys in NativeSpan exits",
    () =>
      Effect.gen(function* inspectRecordingPurgePrivacy() {
        const trace = yield* startEmailTraceFixture();
        yield* Effect.gen(function* traceRecordingPurge() {
          const email = yield* Email;
          const records = yield* RecordedEmails;
          yield* email.send(
            { ...message, body: { text: "private-purge-body" }, subject: "private-purge-subject" },
            { idempotencyKey: "private-purge-key" },
          );
          assert.strictEqual(yield* records.purgeMessages, 1);
          assert.deepStrictEqual(yield* records.messages, []);
        }).pipe(Effect.withTracer(trace.tracer));
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "RecordedEmails.purgeMessages");

        for (const privateValue of [
          "private-purge-subject",
          "private-purge-body",
          "private-purge-key",
          "sender@example.test",
        ]) {
          assert.notInclude(diagnostics, privateValue);
        }
      }).pipe(Effect.provide(recordingEmailLayer)),
  );
});

describe("Email submission contract", () => {
  it.effect("records keyed duplicates once and rejects a different message under that key", () =>
    Effect.gen(function* recordAndDeduplicate() {
      const email = yield* Email;
      const records = yield* RecordedEmails;
      const options = { idempotencyKey: "welcome/event-1" };

      const receipts = yield* email.sendAll(
        [
          { message, options },
          { message, options },
          { message: { ...message, subject: "A different notification" }, options },
        ],
        { concurrency: 3 },
      );

      const [first, duplicate, conflicting] = receipts;

      assert.isDefined(first);
      assert.isDefined(duplicate);
      assert.isDefined(conflicting);
      assert.deepStrictEqual(first, duplicate);
      assert(Result.isSuccess(first));
      assert(EmailReceiptSchema.guards.Recorded(first.success));
      assert.strictEqual(first.success.sequence, 1);
      assert(Result.isFailure(conflicting));
      assert(Schema.is(EmailRejected)(conflicting.failure));
      assert.strictEqual(conflicting.failure.reason, "idempotency-conflict");
      assert.strictEqual((yield* records.messages).length, 1);
      Reflect.set(first.success, "sequence", 999);

      const observedAgain = yield* email.send(message, options);

      assert(EmailReceiptSchema.guards.Recorded(observedAgain));
      assert.strictEqual(observedAgain.sequence, 1);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect.prop(
    "deduplicates equivalent messages independently of property insertion order",
    [
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
    ],
    ([text, html]) =>
      Effect.gen(function* deduplicateEquivalentBodies() {
        const email = yield* Email;

        const first = yield* email.send(
          { ...message, body: { html, text } },
          { idempotencyKey: "event-1" },
        );

        const reorderedBody = { text };
        Reflect.set(reorderedBody, "html", html);

        const duplicate = yield* email.send(
          { ...message, body: reorderedBody },
          { idempotencyKey: "event-1" },
        );

        const records = yield* (yield* RecordedEmails).messages;

        assert.deepStrictEqual(duplicate, first);
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0]?.body.text, text);
        assert.strictEqual(records[0]?.body.html, html);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect.each([
    { field: "from", input: { ...message, from: "private-address\r\n@example.test" } },
    { field: "from", input: { ...message, from: "private..recipient@example.test" } },
    { field: "from", input: { ...message, from: `private${"x".repeat(64)}@example.test` } },
    { field: "subject", input: { ...message, subject: "private subject\nInjected" } },
    { field: "<unsupported>", input: { ...message, scheduledAt: "private schedule" } },
  ])(
    "rejects invalid or unsupported $field before submission without disclosing values",
    ({ field, input }) =>
      Effect.gen(function* rejectUnsafeMessage() {
        const email = yield* Email;
        const error = yield* email.send(input).pipe(Effect.flip);

        assert(Schema.is(EmailInvalidMessage)(error));
        assert(error.issues.some((issue) => issue.path === field));
        assert.notInclude(JSON.stringify(error), "private");
        assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
      }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect("rejects an invalid batch bound before starting any message", () =>
    Effect.gen(function* rejectUnboundedBatch() {
      const email = yield* Email;
      const error = yield* email.sendAll([{ message }], { concurrency: 0 }).pipe(Effect.flip);

      assert(Schema.is(EmailInvalidOptions)(error));
      assert.strictEqual(error.issues[0]?.path, "concurrency");
      assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
    }).pipe(Effect.provide(recordingEmailLayer)),
  );

  it.effect.each([
    { failures: 1, idempotency: "none", key: undefined, retries: 0, succeeds: false },
    { failures: 1, idempotency: "native", key: undefined, retries: 0, succeeds: false },
    { failures: 1, idempotency: "forwarding", key: "stable-event", retries: 0, succeeds: false },
    { failures: 1, idempotency: "native", key: "stable-event", retries: 1, succeeds: true },
    { failures: 10, idempotency: "native", key: "stable-event", retries: 2, succeeds: false },
  ] as const)(
    "bounds ambiguous replay and requires native deduplication plus a key: $idempotency/$key/$failures",
    (scenario) =>
      Effect.gen(function* requireReplayAuthority() {
        const attempts = yield* Ref.make(0);
        const started = yield* Deferred.make<true>();

        const sender = EmailSender.of({
          ...fixtureMessageSupport,
          idempotency: Match.value(scenario.idempotency).pipe(
            Match.when("native", () => nativeIdempotency),
            Match.when("forwarding", () => keyForwarding),
            Match.when("none", () => noIdempotency),
            Match.exhaustive,
          ),
          provider: "fixture",
          submit: Effect.fnUntraced(function* submitFixture() {
            const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);

            yield* Deferred.succeed(started, true);

            if (attempt <= scenario.failures) {
              return yield* new EmailDeliveryUnknown({
                provider: "fixture",
                reason: attempt === 1 ? "transport" : "server-error",
              });
            }

            return recordedReceipt;
          }),
        });

        const options = scenario.key === undefined ? {} : { idempotencyKey: scenario.key };

        const operation = Effect.gen(function* submitThroughEmail() {
          return yield* (yield* Email).send(message, options);
        }).pipe(
          Effect.provide(
            emailLayer(shortPolicy).pipe(Layer.provide(Layer.succeed(EmailSender, sender))),
          ),
        );

        const fiber = yield* operation.pipe(Effect.result, Effect.forkScoped);

        yield* Deferred.await(started);
        yield* TestClock.adjust(1000);

        assert.strictEqual(yield* Ref.get(attempts), 1 + scenario.retries);

        const outcome = yield* Fiber.join(fiber);

        assert.strictEqual(Result.isSuccess(outcome), scenario.succeeds);

        if (Result.isFailure(outcome)) {
          assert(Schema.is(EmailDeliveryUnknown)(outcome.failure));
          assert.strictEqual(
            outcome.failure.reason,
            scenario.retries === 0 ? "transport" : "server-error",
          );
        }
      }),
  );

  it.effect(
    "owns key-forwarding bounds without permitting caller mutation to grant ambiguous replay",
    () =>
      Effect.gen(function* ownKeyForwardingAuthority() {
        const authority = EmailSenderIdempotencySchema.cases.KeyForwarding.make({
          keyFormat: "AlphanumericDotUnderscoreHyphen",
          keyRequirement: "Required",
          maxKeyLength: 16,
        });

        const attempts = yield* Ref.make(0);

        const sender = EmailSender.of({
          ...fixtureMessageSupport,
          idempotency: authority,
          provider: "fixture",
          submit: Effect.fnUntraced(function* submitForwardedKey() {
            yield* Ref.update(attempts, (count) => count + 1);

            return yield* new EmailDeliveryUnknown({ provider: "fixture", reason: "server-error" });
          }),
        });

        yield* Effect.gen(function* inspectOwnedForwardingService() {
          const email = yield* Email;
          Reflect.set(authority, "keyFormat", "Opaque");
          Reflect.set(authority, "maxKeyLength", 256);
          Reflect.set(authority, "keyRequirement", "Optional");
          Reflect.set(authority, "_tag", "Native");
          Reflect.set(authority, "retention", Duration.infinity);

          const missing = yield* email.send(message).pipe(Effect.result);
          assert(Result.isFailure(missing) && missing.failure instanceof EmailRejected);
          assert.strictEqual(missing.failure.reason, "unsupported-idempotency");
          assert.strictEqual(yield* Ref.get(attempts), 0);

          const invalid = yield* email
            .send(message, { idempotencyKey: "k".repeat(17) })
            .pipe(Effect.result);

          assert(Result.isFailure(invalid) && invalid.failure instanceof EmailRejected);
          assert.strictEqual(invalid.failure.reason, "unsupported-idempotency");
          assert.strictEqual(yield* Ref.get(attempts), 0);

          const unsupported = yield* email
            .send(message, { idempotencyKey: "synthetic/key" })
            .pipe(Effect.result);

          assert(Result.isFailure(unsupported) && unsupported.failure instanceof EmailRejected);
          assert.strictEqual(unsupported.failure.reason, "unsupported-idempotency");
          assert.strictEqual(yield* Ref.get(attempts), 0);

          const outcome = yield* email
            .send(message, { idempotencyKey: "k".repeat(16) })
            .pipe(Effect.result);

          assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
          assert.strictEqual(yield* Ref.get(attempts), 1);
        }).pipe(
          Effect.provide(
            emailLayer(shortPolicy).pipe(Layer.provide(Layer.succeed(EmailSender, sender))),
          ),
        );
      }),
  );

  it.effect.each([
    { location: "layer", maxAttempts: 1 },
    { location: "layer", maxAttempts: 2 },
    { location: "operation", maxAttempts: 1 },
    { location: "operation", maxAttempts: 2 },
  ] as const)(
    "requires a deduplication window covering automatic replay, but not a single attempt: $location/$maxAttempts",
    ({ location, maxAttempts }) =>
      Effect.gen(function* requireReplayWindow() {
        const attempts = yield* Ref.make(0);

        const sender = EmailSender.of({
          ...fixtureMessageSupport,
          idempotency: EmailSenderIdempotencySchema.cases.Native.make({
            retention: Duration.millis(500),
          }),
          provider: "fixture",
          submit: () => Ref.update(attempts, (count) => count + 1).pipe(Effect.as(recordedReceipt)),
        });

        const candidate = { ...shortPolicy, deadline: Duration.seconds(1), maxAttempts };

        const outcome = yield* Effect.gen(function* submitWithWindowPolicy() {
          return yield* (yield* Email).send(
            message,
            location === "layer"
              ? { idempotencyKey: "stable-event" }
              : { idempotencyKey: "stable-event", policy: candidate },
          );
        }).pipe(
          Effect.provide(
            emailLayer(location === "layer" ? candidate : { ...candidate, maxAttempts: 1 }).pipe(
              Layer.provide(Layer.succeed(EmailSender, sender)),
            ),
          ),
          Effect.result,
        );

        if (maxAttempts === 1) {
          assert(Result.isSuccess(outcome));
          assert.strictEqual(yield* Ref.get(attempts), 1);
        } else {
          assert(Result.isFailure(outcome));
          assert(
            location === "layer"
              ? Schema.is(EmailConfigurationError)(outcome.failure)
              : Schema.is(EmailInvalidOptions)(outcome.failure),
          );
          assert.strictEqual(yield* Ref.get(attempts), 0);
        }
      }),
  );

  it.effect("honors provider backoff and reuses the original message despite caller mutation", () =>
    Effect.gen(function* respectBackoffAndOwnership() {
      const submissions = yield* Queue.unbounded<EmailSubmission>();
      const attempts = yield* Ref.make(0);

      const sender = EmailSender.of({
        ...fixtureMessageSupport,
        idempotency: noIdempotency,
        provider: "fixture",
        submit: Effect.fnUntraced(function* rateLimitedSubmission(submission: EmailSubmission) {
          const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1);

          yield* Queue.offer(submissions, submission);

          if (attempt === 1) {
            return yield* new EmailRejected({
              provider: "fixture",
              reason: "rate-limited",
              retryAfterMillis: 2000,
              status: 429,
            });
          }

          return recordedReceipt;
        }),
      });

      const recipients: [string, ...string[]] = ["original@example.test"];
      const body = { text: "Original body" };

      const attachment = {
        contentBase64: "AP+ACg==",
        contentType: "application/octet-stream",
        filename: "original.bin",
      };

      const attachments: [EmailAttachmentInput, ...EmailAttachmentInput[]] = [attachment];
      const sendAt = DateTime.toDateUtc(DateTime.makeUnsafe(60_000));
      const input = { ...message, attachments, body, sendAt, to: recipients };
      const operationPolicy = { ...shortPolicy, maxAttempts: 2 };

      const operation = Effect.gen(function* sendOwnedMessage() {
        return yield* (yield* Email).send(input, { policy: operationPolicy });
      }).pipe(
        Effect.provide(
          emailLayer({ ...shortPolicy, maxAttempts: 1 }).pipe(
            Layer.provide(Layer.succeed(EmailSender, sender)),
          ),
        ),
      );

      const fiber = yield* operation.pipe(Effect.forkScoped);
      const first = yield* Queue.take(submissions);

      operationPolicy.maxAttempts = 1;
      operationPolicy.deadline = Duration.millis(1);
      operationPolicy.initialDelay = Duration.seconds(10);
      recipients[0] = "changed@example.test";
      body.text = "Changed body";
      sendAt.setTime(1);
      attachment.contentBase64 = "AQ==";
      attachment.contentType = "text/plain";
      attachment.filename = "changed.txt";
      attachments.push(attachment);
      const firstAttachment = first.message.attachments?.[0];
      assert.isDefined(firstAttachment);
      Reflect.set(firstAttachment, "contentBase64", "Ag==");
      yield* TestClock.adjust(1000);
      assert.strictEqual(yield* Ref.get(attempts), 1);
      yield* TestClock.adjust(1000);

      const replay = yield* Queue.take(submissions);

      assert.strictEqual(formatEmailMailbox(replay.message.to[0]), "original@example.test");
      assert.strictEqual(replay.message.body.text, "Original body");
      assert.isDefined(replay.message.sendAt);
      assert.strictEqual(DateTime.toEpochMillis(replay.message.sendAt), 60_000);
      assert.strictEqual(replay.message.attachments?.length, 1);
      assert.strictEqual(replay.message.attachments?.[0].contentBase64, "AP+ACg==");
      assert.strictEqual(replay.message.attachments?.[0].filename, "original.bin");
      assert.strictEqual(replay.message.attachments?.[0].contentType, "application/octet-stream");
      assert.deepStrictEqual(replay, first);
      assert.deepStrictEqual(yield* Fiber.join(fiber), recordedReceipt);
    }),
  );

  it.effect.each(["deadline", "cancellation"] as const)(
    "releases submission work on $0 without replaying",
    (termination) =>
      Effect.gen(function* releaseSubmissionWork() {
        const started = yield* Deferred.make<true>();
        const finalized = yield* Ref.make(0);
        const attempts = yield* Ref.make(0);

        const sender = EmailSender.of({
          ...fixtureMessageSupport,
          idempotency: nativeIdempotency,
          provider: "fixture",
          submit: Effect.fnUntraced(function* waitForAcknowledgement() {
            yield* Ref.update(attempts, (count) => count + 1);
            yield* Deferred.succeed(started, true);

            return yield* Effect.never.pipe(
              Effect.ensuring(Ref.update(finalized, (count) => count + 1)),
            );
          }),
        });

        const operation = Effect.gen(function* awaitSubmission() {
          return yield* (yield* Email).send(message, { idempotencyKey: "stable-event" });
        }).pipe(
          Effect.provide(
            emailLayer({ ...shortPolicy, deadline: Duration.seconds(2) }).pipe(
              Layer.provide(Layer.succeed(EmailSender, sender)),
            ),
          ),
        );

        const fiber = yield* operation.pipe(Effect.forkScoped);

        yield* Deferred.await(started);

        if (termination === "deadline") {
          yield* TestClock.adjust(2000);

          const error = yield* Fiber.join(fiber).pipe(Effect.flip);

          assert(Schema.is(EmailDeliveryUnknown)(error));
          assert.strictEqual(error.reason, "timeout");
        } else {
          yield* Fiber.interrupt(fiber);

          assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        }

        assert.strictEqual(yield* Ref.get(finalized), 1);
        assert.strictEqual(yield* Ref.get(attempts), 1);
      }),
  );

  it.effect("bounds batch work, preserves input order, and isolates expected item failures", () =>
    Effect.gen(function* boundBatchSubmissions() {
      const started = yield* Queue.unbounded<string>();
      const releaseFirst = yield* Deferred.make<true>();
      const releaseSecond = yield* Deferred.make<true>();
      const releaseThird = yield* Deferred.make<true>();
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);

      const completionFor = (subject: string) =>
        Match.value(subject).pipe(
          Match.when("first", () => releaseFirst),
          Match.when("second", () => releaseSecond),
          Match.orElse(() => releaseThird),
        );

      const sender = EmailSender.of({
        ...fixtureMessageSupport,
        idempotency: noIdempotency,
        provider: "fixture",
        submit: Effect.fnUntraced(function* submitBatchItem(submission: EmailSubmission) {
          const current = yield* Ref.updateAndGet(active, (count) => count + 1);

          yield* Ref.update(peak, (maximum) => Math.max(maximum, current));
          assert.strictEqual(submission.message.attachments?.[0].contentBase64, "AP+ACg==");
          yield* Queue.offer(started, submission.message.subject);

          const wait = completionFor(submission.message.subject);

          return yield* Effect.gen(function* finishBatchItem() {
            yield* Deferred.await(wait);

            if (submission.message.subject === "second") {
              return yield* new EmailRejected({
                provider: "fixture",
                reason: "authentication",
                status: 401,
              });
            }

            return EmailReceiptSchema.cases.Recorded.make({
              sequence: submission.message.subject === "first" ? 1 : 3,
            });
          }).pipe(Effect.ensuring(Ref.update(active, (count) => count - 1)));
        }),
      });

      const validSubjects = ["first", "second", "third"];

      const batchAttachment: EmailAttachmentInput = {
        contentBase64: "AP+ACg==",
        contentType: "application/octet-stream",
        filename: "sample.dat",
      };

      const requests = [...validSubjects, "invalid\nsubject"].map((subject) => ({
        message: { ...message, attachments: [{ ...batchAttachment }] as const, subject },
      }));

      const unsupportedRequest = {
        message: {
          ...message,
          attachments: [batchAttachment] as const,
          subject: "unsupported-wrapper",
        },
        "private-feature-name": "private-feature-value",
      };

      const invalidOptionsRequest = {
        message: {
          ...message,
          attachments: [batchAttachment] as const,
          subject: "invalid-options",
        },
        options: { idempotencyKey: "private invalid key" },
      };

      const invalidAttachmentRequest = {
        message: {
          ...message,
          attachments: [{ ...batchAttachment, contentBase64: "private-invalid-content" }] as const,
          subject: "invalid-attachment",
        },
      };

      requests.push(unsupportedRequest, invalidOptionsRequest, invalidAttachmentRequest);

      const operation = Effect.gen(function* sendBoundedBatch() {
        return yield* (yield* Email).sendAll(requests, { concurrency: 2 });
      }).pipe(
        Effect.provide(
          emailLayer(shortPolicy).pipe(Layer.provide(Layer.succeed(EmailSender, sender))),
        ),
      );

      const fiber = yield* operation.pipe(Effect.forkScoped);

      const initiallyStarted = [yield* Queue.take(started), yield* Queue.take(started)];

      assert(initiallyStarted.every((subject) => validSubjects.includes(subject)));
      assert.strictEqual(new Set(initiallyStarted).size, 2);

      const pendingSubject = validSubjects.find((subject) => !initiallyStarted.includes(subject));

      assert.isDefined(pendingSubject);

      const pendingRequest = requests.find((request) => request.message.subject === pendingSubject);
      const firstToFinish = initiallyStarted.includes("third") ? "third" : "second";
      const heldSubject = initiallyStarted.find((subject) => subject !== firstToFinish);

      assert.isDefined(pendingRequest);
      assert.isDefined(heldSubject);
      pendingRequest.message.subject = "Changed while waiting for a batch slot";
      Reflect.set(pendingRequest.message.attachments[0], "contentBase64", "AQ==");
      yield* Deferred.succeed(completionFor(firstToFinish), true);
      assert.strictEqual(yield* Queue.take(started), pendingSubject);
      yield* Deferred.succeed(completionFor(pendingSubject), true);
      yield* Deferred.succeed(completionFor(heldSubject), true);

      const outcomes = yield* Fiber.join(fiber);

      const [first, second, third, invalid, unsupported, invalidOptions, invalidAttachment] =
        outcomes;

      assert.isDefined(first);
      assert.isDefined(second);
      assert.isDefined(third);
      assert.isDefined(invalid);
      assert(Result.isFailure(invalid));
      assert(Schema.is(EmailInvalidMessage)(invalid.failure));
      assert.isDefined(unsupported);
      assert(Result.isFailure(unsupported));
      assert(Schema.is(EmailInvalidOptions)(unsupported.failure));
      assert.notInclude(JSON.stringify(unsupported.failure), "private-");
      assert.isDefined(invalidOptions);
      assert(Result.isFailure(invalidOptions));
      assert(Schema.is(EmailInvalidOptions)(invalidOptions.failure));
      assert.notInclude(JSON.stringify(invalidOptions.failure), "private");
      assert.isDefined(invalidAttachment);
      assert(Result.isFailure(invalidAttachment));
      assert(Schema.is(EmailInvalidMessage)(invalidAttachment.failure));
      assert(
        invalidAttachment.failure.issues.some(
          (issue) => issue.path === "message.attachments.0.contentBase64",
        ),
      );
      assert.notInclude(JSON.stringify(invalidAttachment.failure), "private");
      assert.strictEqual(yield* Queue.size(started), 0);
      assert(Result.isSuccess(first));
      assert(Result.isFailure(second));
      assert(Result.isSuccess(third));
      assert(EmailReceiptSchema.guards.Recorded(first.success));
      assert.strictEqual(first.success.sequence, 1);
      assert(Schema.is(EmailRejected)(second.failure));
      assert.strictEqual(second.failure.reason, "authentication");
      assert(EmailReceiptSchema.guards.Recorded(third.success));
      assert.strictEqual(third.success.sequence, 3);
      assert.strictEqual(yield* Ref.get(peak), 2);
      assert.strictEqual(yield* Ref.get(active), 0);
    }),
  );
});
