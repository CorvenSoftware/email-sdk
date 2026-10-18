import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Redacted,
  Ref,
  Result,
  Schema,
  Scope,
  Tracer,
} from "effect";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { validateEmailCapabilities } from "./email-capabilities.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { defaultedEmailLayer } from "./email-defaults.js";
import { EmailMessageIdSchema, EmailReceiptSchema, parseEmailMessage } from "./email-message.js";
import type { EmailMessageInput } from "./email-message.js";
import { EmailRejected } from "./email-rejected.js";
import { EmailSender, EmailSenderIdempotencySchema } from "./email-sender.js";
import type { IEmailSender } from "./email-sender.js";
import { Email, emailLayer } from "./email-service.js";
import {
  capturedEmailSenderLayer,
  EmailCaptureOutcomeSchema,
  EmailCapturePayloadSchema,
  EmailCaptureSnapshotSchema,
  EmailSubmissionCapture,
} from "./email-submission-capture.js";
import type { EmailCaptureOptions, EmailCaptureRecord } from "./email-submission-capture.js";
import { recordingEmailCapabilities, recordingSenderLayer } from "./recording-email-sender.js";

const message: EmailMessageInput = {
  attachments: [
    {
      contentBase64: "AQID",
      contentType: "application/octet-stream",
      filename: "private-file.bin",
    },
  ],
  bcc: "private-copy@fictional.invalid",
  body: { html: "<p>private-body 🦉</p>", text: "private-text" },
  from: { address: "private-sender@fictional.invalid", name: "Private sender" },
  headers: [{ name: "X-Private", value: "private-header" }],
  metadata: { scope: "private-metadata" },
  replyTo: "private-reply@fictional.invalid",
  sendAt: "2030-01-02T03:04:05.000Z",
  subject: "private-subject",
  tags: [{ name: "purpose", value: "private-tag" }],
  to: "private-recipient@fictional.invalid",
};

const options: EmailCaptureOptions = {
  capacity: 10,
  maxBytes: 1_000_000,
  privateData: "AuthorizePayloadCapture",
};

const receipt = EmailReceiptSchema.cases.Accepted.make({
  messageId: EmailMessageIdSchema.make("private-provider-id"),
  provider: "fixture",
});

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

const withEmail = <E, R>(sender: Layer.Layer<EmailSender | EmailSubmissionCapture, E, R>) =>
  emailLayer({
    deadline: Duration.seconds(5),
    initialDelay: Duration.millis(1),
    maxAttempts: 1,
  }).pipe(Layer.provideMerge(sender));

const readCapturedPayload = (record: EmailCaptureRecord) =>
  Schema.decodeEffect(Schema.fromJsonString(EmailCapturePayloadSchema))(
    Redacted.value(record.payloadJson),
  );

const captureOne = Effect.gen(function* captureOneEmail() {
  yield* (yield* Email).send(message);
  const snapshot = yield* (yield* EmailSubmissionCapture).snapshot;
  const [record] = snapshot.records;
  assert.isDefined(record);

  return record;
});

describe("explicit private submission capture", () => {
  it.effect(
    "captures complete owned intent and acknowledgement behind redaction without changing receipt identity",
    () =>
      Effect.gen(function* capturePrivateEmail() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;
        const before = yield* capture.snapshot;
        assert.strictEqual(yield* email.send(message), receipt);
        const snapshot = yield* capture.snapshot;
        const [record] = snapshot.records;
        assert.isDefined(record);
        const payload = yield* readCapturedPayload(record);
        assert.deepStrictEqual(payload.submission.message, yield* parseEmailMessage(message));
        assert(EmailCaptureOutcomeSchema.guards.Receipt(payload.outcome));
        assert.deepStrictEqual(payload.outcome.receipt, receipt);
        assert(DateTime.isDateTime(payload.submission.message.sendAt));
        assert.strictEqual(
          snapshot.retainedBytes,
          new TextEncoder().encode(Redacted.value(record.payloadJson)).byteLength,
        );
        assert(
          Object.isFrozen(snapshot) && Object.isFrozen(snapshot.records) && Object.isFrozen(record),
        );
        assert.notInclude(JSON.stringify(snapshot), "private-");
        assert.strictEqual(before.records.length, 0);

        const stored = yield* Schema.encodeEffect(Schema.toCodecJson(EmailCaptureSnapshotSchema))(
          snapshot,
        ).pipe(Effect.result);

        assert(Result.isFailure(stored));
      }).pipe(
        Effect.provide(
          withEmail(
            capturedEmailSenderLayer(
              senderLayer(() => Effect.succeed(receipt)),
              options,
            ),
          ),
        ),
      ),
  );

  it.effect.each([
    new EmailRejected({
      provider: "fixture",
      providerCode: 401,
      reason: "authentication",
      status: 401,
    }),
    new EmailDeliveryUnknown({
      provider: "fixture",
      reason: "server-error",
      retryAfterMillis: 100,
      status: 503,
    }),
  ])(
    "retains typed failure identity and does not convert captured uncertainty into permission to retry %#",
    (failure) =>
      Effect.gen(function* captureTypedFailure() {
        const result = yield* (yield* Email).send(message).pipe(Effect.result);
        assert(Result.isFailure(result));
        assert.strictEqual(result.failure, failure);
        const snapshot = yield* (yield* EmailSubmissionCapture).snapshot;
        assert.strictEqual(snapshot.records.length, 1);
        const [record] = snapshot.records;
        assert.isDefined(record);
        const payload = yield* readCapturedPayload(record);
        assert(
          EmailCaptureOutcomeSchema.guards.Rejected(payload.outcome) ||
            EmailCaptureOutcomeSchema.guards.Unknown(payload.outcome),
        );
        assert.strictEqual(payload.outcome.failure.reason, failure.reason);
        assert.strictEqual(payload.outcome.failure.status, failure.status);
        assert.notInclude(Redacted.value(record.payloadJson), "stack");
      }).pipe(
        Effect.provide(
          withEmail(
            capturedEmailSenderLayer(
              senderLayer(() => failure),
              options,
            ),
          ),
        ),
      ),
  );

  it.effect("does not capture pure validation or inputs refused before sender invocation", () =>
    Effect.gen(function* excludeEmailPreflight() {
      const email = yield* Email;
      yield* email.validate(message);
      yield* email.send({ ...message, to: "invalid" }).pipe(Effect.result);
      yield* email.send(message, { idempotencyKey: "unsupported-key" }).pipe(Effect.result);
      assert.strictEqual((yield* (yield* EmailSubmissionCapture).snapshot).records.length, 0);
    }).pipe(
      Effect.provide(
        withEmail(
          capturedEmailSenderLayer(
            senderLayer(() => Effect.succeed(receipt)),
            options,
          ),
        ),
      ),
    ),
  );

  it.effect("owns request JSON before waiting and receipt JSON before later source mutation", () =>
    Effect.gen(function* ownPrivateCapture() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();
      const rawMessage = yield* parseEmailMessage(message);
      const mutableMessage = { ...rawMessage, body: { text: "original-body" } };

      const mutableReceipt = EmailReceiptSchema.cases.AcceptedWithIds.make({
        messageIds: [EmailMessageIdSchema.make("original-id")],
        provider: "fixture",
      });

      const raw = senderLayer(() =>
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(mutableReceipt),
        ),
      );

      yield* Effect.gen(function* observeDetachedCapture() {
        const sender = yield* EmailSender;
        const capture = yield* EmailSubmissionCapture;
        const pending = yield* sender.submit({ message: mutableMessage }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        mutableMessage.body.text = "changed-body";
        assert.strictEqual((yield* capture.snapshot).records.length, 0);
        yield* Deferred.succeed(release, true);
        assert.strictEqual(yield* Fiber.join(pending), mutableReceipt);
        Reflect.set(mutableReceipt.messageIds, 0, "changed-id");
        const [record] = (yield* capture.snapshot).records;
        assert.isDefined(record);
        const payload = yield* readCapturedPayload(record);
        assert.strictEqual(payload.submission.message.body.text, "original-body");
        assert(EmailCaptureOutcomeSchema.guards.Receipt(payload.outcome));
        assert(EmailReceiptSchema.guards.AcceptedWithIds(payload.outcome.receipt));
        assert.strictEqual(payload.outcome.receipt.messageIds.join(","), "original-id");
      }).pipe(Effect.provide(capturedEmailSenderLayer(raw, options)));
    }),
  );

  it.effect("purges lazily while preserving escaped snapshots and permanent history gaps", () =>
    Effect.gen(function* purgePrivateCaptureRecords() {
      const email = yield* Email;
      const capture = yield* EmailSubmissionCapture;
      const purge = capture.purgeRecords;
      assert.strictEqual(yield* purge, 0);
      assert.isFalse((yield* capture.snapshot).truncated);
      assert.strictEqual(yield* email.send(message), receipt);
      const old = yield* capture.snapshot;
      assert.strictEqual(yield* email.send(message), receipt);
      assert.strictEqual(yield* purge, 2);
      const empty = yield* capture.snapshot;
      assert.deepStrictEqual(empty.records, []);
      assert.strictEqual(empty.retainedBytes, 0);
      assert.isTrue(empty.truncated);
      assert.isFalse(empty.closed);
      assert(Object.isFrozen(empty) && Object.isFrozen(empty.records));
      assert.strictEqual(yield* purge, 0);
      assert.isTrue((yield* capture.snapshot).truncated);
      const [retained] = old.records;
      assert.isDefined(retained);
      assert.isFalse(old.truncated);
      assert.strictEqual(
        (yield* readCapturedPayload(retained)).submission.message.subject,
        message.subject,
      );
      assert.strictEqual(yield* email.send(message), receipt);
      const resumed = yield* capture.snapshot;
      assert.strictEqual(resumed.records.length, 1);
      assert.isTrue(resumed.truncated);
      assert.strictEqual(resumed.retainedBytes, retained.byteLength);
    }).pipe(
      Effect.provide(
        withEmail(
          capturedEmailSenderLayer(
            senderLayer(() => Effect.succeed(receipt)),
            options,
          ),
        ),
      ),
    ),
  );

  it.effect.prop(
    "concurrent capture purges account for generated completions once and release their byte budget",
    {
      count: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 1 })),
    },
    ({ count }) =>
      Effect.gen(function* purgeGeneratedCaptureCompletions() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;

        const completed = yield* email.sendAll(
          Array.from({ length: count }, (_, index) => ({
            message: { ...message, subject: `private-completion-${index}` },
          })),
          { concurrency: 4 },
        );

        assert(completed.every(Result.isSuccess));
        const old = yield* capture.snapshot;

        const removed = yield* Effect.all(
          [capture.purgeRecords, capture.purgeRecords, capture.purgeRecords],
          { concurrency: 3 },
        );

        assert.strictEqual(
          removed.reduce((total, value) => total + value, 0),
          count,
        );
        const empty = yield* capture.snapshot;
        assert.strictEqual(empty.records.length, 0);
        assert.strictEqual(empty.retainedBytes, 0);
        assert.isTrue(empty.truncated);
        assert.strictEqual(old.records.length, count);
        assert.strictEqual(yield* email.send(message), receipt);
        const resumed = yield* capture.snapshot;
        const [record] = resumed.records;
        assert.isDefined(record);
        assert.strictEqual(resumed.records.length, 1);
        assert.strictEqual(resumed.retainedBytes, record.byteLength);
        assert.isTrue(resumed.truncated);
      }).pipe(
        Effect.provide(
          withEmail(
            capturedEmailSenderLayer(
              senderLayer(() => Effect.succeed(receipt)),
              options,
            ),
          ),
        ),
      ),
    { arbitrary: { runs: 12 } },
  );

  it.effect("does not cancel pending work or suppress completions that arrive after purge", () =>
    Effect.gen(function* purgeBeforeCaptureCompletion() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const raw = senderLayer((submission) =>
        submission.message.subject === "pending"
          ? Deferred.succeed(entered, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(receipt),
            )
          : Effect.succeed(receipt),
      );

      yield* Effect.gen(function* captureAfterExplicitPurge() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;
        yield* email.send(message);

        const pending = yield* email
          .send({ ...message, subject: "pending" })
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        assert.strictEqual(yield* capture.purgeRecords, 1);
        assert.strictEqual((yield* capture.snapshot).retainedBytes, 0);
        yield* Deferred.succeed(release, true);
        assert.strictEqual(yield* Fiber.join(pending), receipt);
        const snapshot = yield* capture.snapshot;
        const [record] = snapshot.records;
        assert.isDefined(record);
        assert.strictEqual(snapshot.records.length, 1);
        assert.isTrue(snapshot.truncated);
        assert.isFalse(snapshot.closed);
        assert.strictEqual(
          (yield* readCapturedPayload(record)).submission.message.subject,
          "pending",
        );
      }).pipe(Effect.provide(withEmail(capturedEmailSenderLayer(raw, options))));
    }),
  );

  it.effect(
    "retains recent completions by capacity without resetting keys or exposing them in snapshots",
    () =>
      Effect.gen(function* preserveCapturedReplay() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;
        const first = yield* email.send(message, { idempotencyKey: "private-stable-key" });
        const old = yield* capture.snapshot;
        assert.strictEqual(yield* capture.purgeRecords, 1);
        assert.strictEqual((yield* capture.snapshot).retainedBytes, 0);
        yield* email.send({ ...message, subject: "different" });

        const conflict = yield* email
          .send({ ...message, subject: "different" }, { idempotencyKey: "private-stable-key" })
          .pipe(Effect.result);

        assert(Result.isFailure(conflict) && conflict.failure instanceof EmailRejected);
        assert.strictEqual(conflict.failure.reason, "idempotency-conflict");
        assert.strictEqual(
          yield* email.send(message, { idempotencyKey: "private-stable-key" }),
          first,
        );
        const snapshot = yield* capture.snapshot;
        assert.strictEqual(snapshot.records.length, 1);
        assert.isTrue(snapshot.truncated);
        assert.isFalse(old.truncated);
        const [record] = snapshot.records;
        assert.isDefined(record);
        assert.strictEqual(
          (yield* readCapturedPayload(record)).submission.idempotencyKey,
          "private-stable-key",
        );
        assert.notInclude(JSON.stringify(snapshot), "private-stable-key");
      }).pipe(
        Effect.provide(
          withEmail(capturedEmailSenderLayer(recordingSenderLayer, { ...options, capacity: 1 })),
        ),
      ),
  );

  it.effect(
    "accounts exact UTF-8 payload bytes, evicts for byte pressure and skips oversized records without losing outcomes",
    () =>
      Effect.gen(function* boundPrivateCaptureBytes() {
        const raw = senderLayer(() => Effect.succeed(receipt));

        const first = yield* captureOne.pipe(
          Effect.provide(withEmail(capturedEmailSenderLayer(raw, options))),
        );

        yield* Effect.gen(function* fillCaptureByteBudget() {
          const email = yield* Email;
          const capture = yield* EmailSubmissionCapture;
          assert.strictEqual(yield* email.send(message), receipt);
          assert.isFalse((yield* capture.snapshot).truncated);
          assert.strictEqual(yield* email.send(message), receipt);
          const snapshot = yield* capture.snapshot;
          assert.strictEqual(snapshot.records.length, 1);
          assert.strictEqual(snapshot.retainedBytes, first.byteLength);
          assert.isTrue(snapshot.truncated);
          assert.strictEqual(yield* capture.purgeRecords, 1);
          assert.strictEqual((yield* capture.snapshot).retainedBytes, 0);
          assert.strictEqual(yield* email.send(message), receipt);
          assert.strictEqual((yield* capture.snapshot).retainedBytes, first.byteLength);
          assert.isTrue((yield* capture.snapshot).truncated);
        }).pipe(
          Effect.provide(
            withEmail(capturedEmailSenderLayer(raw, { ...options, maxBytes: first.byteLength })),
          ),
        );
        yield* Effect.gen(function* rejectOnlyCaptureOverflow() {
          assert.strictEqual(yield* (yield* Email).send(message), receipt);
          const snapshot = yield* (yield* EmailSubmissionCapture).snapshot;
          assert.strictEqual(snapshot.records.length, 0);
          assert.strictEqual(snapshot.retainedBytes, 0);
          assert.isTrue(snapshot.truncated);
        }).pipe(
          Effect.provide(
            withEmail(
              capturedEmailSenderLayer(raw, { ...options, maxBytes: first.byteLength - 1 }),
            ),
          ),
        );
      }),
  );

  it.effect.each([
    ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].flatMap((bound) => [
      { ...options, capacity: bound },
      { ...options, maxBytes: bound },
    ]),
    { ...options, capacity: 10_001 },
    { ...options, maxBytes: 67_108_865 },
  ])("refuses invalid bounds before acquiring the underlying sender %#", (invalid) =>
    Effect.gen(function* rejectCaptureBoundsBeforeAcquisition() {
      const acquired = yield* Ref.make(0);

      const raw = Layer.effect(
        EmailSender,
        Ref.update(acquired, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("Unexpected capture sender acquisition")),
        ),
      );

      const result = yield* EmailSender.pipe(
        Effect.provide(capturedEmailSenderLayer(raw, invalid)),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);

      assert.strictEqual(yield* Ref.get(acquired), 0);
    }),
  );

  it.effect("requires explicit host permission and rejects unrecognized callback controls", () =>
    Effect.gen(function* rejectImplicitPrivateCapture() {
      const mutableOptions = { ...options };
      Reflect.deleteProperty(mutableOptions, "privateData");

      const missing = yield* EmailSender.pipe(
        Effect.provide(capturedEmailSenderLayer(recordingSenderLayer, mutableOptions)),
        Effect.result,
      );

      assert(Result.isFailure(missing) && missing.failure instanceof EmailConfigurationError);
      assert.strictEqual(missing.failure.issues[0]?.path, "privateData");
      const extra = { ...options, privateCallback: "private-control-value" };

      const invalid = yield* EmailSender.pipe(
        Effect.provide(capturedEmailSenderLayer(recordingSenderLayer, extra)),
        Effect.result,
      );

      assert(Result.isFailure(invalid));
      assert.notInclude(JSON.stringify(invalid), "private-control-value");
    }),
  );

  it.effect(
    "captures safe aborted categories, propagates original causes and never leaks payloads into spans",
    () =>
      Effect.gen(function* preservePrivateCaptureExits() {
        const entered = yield* Deferred.make<boolean>();
        const trace = yield* startEmailTraceFixture();

        const raw = senderLayer((submission) =>
          submission.message.subject === "defect"
            ? Effect.die("private-original-defect")
            : Deferred.succeed(entered, true).pipe(Effect.andThen(Effect.never)),
        );

        yield* Effect.gen(function* inspectCapturedExits() {
          const email = yield* Email;
          const capture = yield* EmailSubmissionCapture;
          const pending = yield* email.send(message).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(pending);
          assert(Exit.hasInterrupts(yield* Fiber.await(pending)));
          const defect = yield* email.send({ ...message, subject: "defect" }).pipe(Effect.exit);
          assert(Exit.hasDies(defect));
          assert.include(JSON.stringify(defect), "private-original-defect");
          const [interrupted, died] = (yield* capture.snapshot).records;
          assert.isDefined(interrupted);
          assert.isDefined(died);
          assert.deepStrictEqual(
            (yield* readCapturedPayload(interrupted)).outcome,
            EmailCaptureOutcomeSchema.cases.Aborted.make({ defect: false, interrupted: true }),
          );
          assert.deepStrictEqual(
            (yield* readCapturedPayload(died)).outcome,
            EmailCaptureOutcomeSchema.cases.Aborted.make({ defect: true, interrupted: false }),
          );
          assert.notInclude(Redacted.value(died.payloadJson), "private-original-defect");
          assert.strictEqual(yield* capture.purgeRecords, 2);
          assert.strictEqual((yield* capture.snapshot).retainedBytes, 0);
        }).pipe(
          Effect.provide(withEmail(capturedEmailSenderLayer(raw, options))),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "CapturedEmailSender.submit");
        assert.include(diagnostics, "EmailSubmissionCapture.snapshot");
        assert.include(diagnostics, "EmailSubmissionCapture.purgeRecords");
        assert.notInclude(diagnostics, "private-");
      }),
  );

  it.effect(
    "closes its retained view and cannot repopulate it from work completing after scope closure",
    () =>
      Effect.gen(function* closeCaptureDuringSubmission() {
        const entered = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();

        const raw = senderLayer(() =>
          Deferred.succeed(entered, true).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(receipt),
          ),
        );

        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(capturedEmailSenderLayer(raw, options), scope);
        const sender = Context.get(context, EmailSender);
        const capture = Context.get(context, EmailSubmissionCapture);

        const pending = yield* sender
          .submit({ message: yield* parseEmailMessage(message) })
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        yield* Scope.close(scope, Exit.void);
        assert.strictEqual(yield* capture.purgeRecords, 0);
        assert.isTrue((yield* capture.snapshot).closed);
        yield* Deferred.succeed(release, true);
        assert.strictEqual(yield* Fiber.join(pending), receipt);
        const closed = yield* capture.snapshot;
        assert.isTrue(closed.closed);
        assert.strictEqual(closed.retainedBytes, 0);
        assert.strictEqual(closed.records.length, 0);
        assert.strictEqual(
          yield* sender.submit({ message: yield* parseEmailMessage(message) }),
          receipt,
        );
        assert.strictEqual((yield* capture.snapshot).records.length, 0);
      }),
  );

  it.effect(
    "leaves escaped old snapshots caller-owned while releasing its own records and sender resource once",
    () =>
      Effect.gen(function* releasePrivateCaptureScope() {
        const releases = yield* Ref.make(0);
        const base = senderLayer(() => Effect.succeed(receipt));

        const resource = Layer.effect(
          EmailSender,
          Effect.acquireRelease(EmailSender, () => Ref.update(releases, (count) => count + 1)),
        ).pipe(Layer.provide(base));

        const scope = yield* Scope.make();

        const context = yield* Layer.buildWithScope(
          withEmail(capturedEmailSenderLayer(resource, options)),
          scope,
        );

        yield* Context.get(context, Email).send(message);
        const capture = Context.get(context, EmailSubmissionCapture);
        const old = yield* capture.snapshot;
        assert.strictEqual(yield* capture.purgeRecords, 1);
        assert.strictEqual(yield* Ref.get(releases), 0);
        assert.isFalse((yield* capture.snapshot).closed);
        yield* Scope.close(scope, Exit.void);
        assert.strictEqual(yield* capture.purgeRecords, 0);
        assert.strictEqual(yield* Ref.get(releases), 1);
        assert.strictEqual((yield* capture.snapshot).records.length, 0);
        const [record] = old.records;
        assert.isDefined(record);
        assert.strictEqual(
          (yield* readCapturedPayload(record)).submission.message.subject,
          message.subject,
        );
      }),
  );

  it.effect("preserves original acquisition failures", () =>
    Effect.gen(function* preserveCaptureAcquisitionFailure() {
      const failure = new EmailConfigurationError({
        issues: [{ path: "<root>", problem: "unavailable" }],
      });

      const result = yield* EmailSender.pipe(
        Effect.provide(capturedEmailSenderLayer(Layer.effect(EmailSender, failure), options)),
        Effect.result,
      );

      assert(Result.isFailure(result));
      assert.strictEqual(result.failure, failure);
    }),
  );

  it.effect("records actual concurrent completion order, not ordered batch position", () =>
    Effect.gen(function* orderPrivateCaptureCompletions() {
      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const raw = senderLayer((submission) =>
        submission.message.subject === "slow"
          ? Deferred.succeed(entered, true).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(receipt),
            )
          : Effect.succeed(receipt),
      );

      yield* Effect.gen(function* captureOverlappingEmails() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;
        const slow = yield* email.send({ ...message, subject: "slow" }).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const batch = yield* email.sendAll([{ message }]);
        const [item] = batch;
        assert.isDefined(item);
        assert(Result.isSuccess(item));
        yield* Deferred.succeed(release, true);
        yield* Fiber.join(slow);
        const [first, last] = (yield* capture.snapshot).records;
        assert.isDefined(first);
        assert.isDefined(last);
        assert.strictEqual(
          (yield* readCapturedPayload(first)).submission.message.subject,
          message.subject,
        );
        assert.strictEqual((yield* readCapturedPayload(last)).submission.message.subject, "slow");
      }).pipe(Effect.provide(withEmail(capturedEmailSenderLayer(raw, options))));
    }),
  );

  it.effect("retains acquisition-owned limits despite later configuration mutation", () =>
    Effect.gen(function* ownCaptureConfiguration() {
      const mutableOptions = { ...options, capacity: 1 };
      const captured = capturedEmailSenderLayer(recordingSenderLayer, mutableOptions);
      yield* Effect.gen(function* fillOwnedCaptureWindow() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;
        mutableOptions.capacity = 100;
        mutableOptions.maxBytes = 1;
        yield* email.send(message);
        yield* email.send({ ...message, subject: "later" });
        const snapshot = yield* capture.snapshot;
        assert.strictEqual(snapshot.records.length, 1);
        assert.isTrue(snapshot.truncated);
        const [record] = snapshot.records;
        assert.isDefined(record);
        assert.strictEqual(
          (yield* readCapturedPayload(record)).submission.message.subject,
          "later",
        );
      }).pipe(Effect.provide(withEmail(captured)));
    }),
  );

  it.effect(
    "captures effective defaults and transformed keys at the sender seam without augmenting twice",
    () =>
      Effect.gen(function* captureEffectiveEmailIntent() {
        const captured = capturedEmailSenderLayer(recordingSenderLayer, options);

        const decorated = defaultedEmailLayer(emailLayer().pipe(Layer.provide(captured)), {
          headers: [{ name: "X-Default", value: "private-default" }],
          idempotencyKeyPrefix: "scope/",
        }).pipe(Layer.provideMerge(captured));

        yield* Effect.gen(function* inspectEffectiveCapturedIntent() {
          yield* (yield* Email).send(message, { idempotencyKey: "logical-key" });
          const [record] = (yield* (yield* EmailSubmissionCapture).snapshot).records;
          assert.isDefined(record);
          const payload = yield* readCapturedPayload(record);
          assert.strictEqual(payload.submission.idempotencyKey, "scope/logical-key");
          const { headers } = payload.submission.message;
          assert.isDefined(headers);
          assert.strictEqual(headers.length, 2);
          assert.strictEqual(headers[0].value, "private-default");
        }).pipe(Effect.provide(decorated));
      }),
  );

  it.effect.prop(
    "keeps generated escaped private bodies intact in a bounded recent view",
    {
      capacity: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 })),
      texts: Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(8),
      ),
    },
    ({ capacity, texts }) =>
      Effect.gen(function* fillGeneratedCaptureHistory() {
        const email = yield* Email;
        const capture = yield* EmailSubmissionCapture;

        for (const text of texts) {
          yield* email.send({ ...message, body: { text: `private-body:${text}` } });
        }

        const snapshot = yield* capture.snapshot;

        const payloads = yield* Effect.forEach(readCapturedPayload)(snapshot.records);

        assert.deepStrictEqual(
          payloads.map((payload) => payload.submission.message.body.text),
          texts.slice(-capacity).map((text) => `private-body:${text}`),
        );
        assert.strictEqual(snapshot.truncated, texts.length > capacity);
        assert.notInclude(JSON.stringify(snapshot), "private-body:");
      }).pipe(
        Effect.provide(
          withEmail(
            capturedEmailSenderLayer(
              senderLayer(() => Effect.succeed(receipt)),
              { ...options, capacity },
            ),
          ),
        ),
      ),
    { arbitrary: { runs: 12 } },
  );

  it.effect("does not replace an already returned receipt when its capture encoding fails", () =>
    Effect.gen(function* preserveReceiptAcrossCaptureGap() {
      const invalidReceipt = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });
      Reflect.set(invalidReceipt, "sequence", Number.NaN);
      yield* Effect.gen(function* inspectFailedReceiptCapture() {
        assert.strictEqual(yield* (yield* Email).send(message), invalidReceipt);
        const snapshot = yield* (yield* EmailSubmissionCapture).snapshot;
        assert.isTrue(snapshot.truncated);
        assert.strictEqual(snapshot.records.length, 0);
      }).pipe(
        Effect.provide(
          withEmail(
            capturedEmailSenderLayer(
              senderLayer(() => Effect.succeed(invalidReceipt)),
              options,
            ),
          ),
        ),
      );
    }),
  );

  it.effect(
    "treats unencodable capture as an explicit gap, never a replacement submission failure",
    () =>
      Effect.gen(function* preserveOutcomeAcrossCaptureGap() {
        const sender = yield* EmailSender;
        const original = yield* parseEmailMessage(message);
        assert.strictEqual(
          yield* sender.submit({ message: { ...original, body: { text: "" } } }),
          receipt,
        );
        const snapshot = yield* (yield* EmailSubmissionCapture).snapshot;
        assert.isTrue(snapshot.truncated);
        assert.strictEqual(snapshot.records.length, 0);
      }).pipe(
        Effect.provide(
          capturedEmailSenderLayer(
            senderLayer(() => Effect.succeed(receipt)),
            options,
          ),
        ),
      ),
  );
});
