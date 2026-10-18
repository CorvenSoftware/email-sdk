import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Result,
  Schema,
  Scope,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import type { EmailSendError } from "./email-errors.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailMessageIdSchema, EmailReceiptSchema } from "./email-message.js";
import type { EmailReceipt } from "./email-message.js";
import {
  capturedIterableCampaignLayer,
  capturedLoopsTransactionalLayer,
  EmailCaptureSnapshotSchema,
  EmailNativeCapture,
  EmailNativeCapturePayloadSchema,
  EmailNativeCaptureRequestSchema,
  EmailCaptureOutcomeSchema,
} from "./email-native-capture.js";
import type { EmailCaptureRecord } from "./email-native-capture.js";
import { EmailRejected } from "./email-rejected.js";
import { defaultedIterableCampaignLayer } from "./iterable-campaign-defaults.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "./iterable-campaign-email.js";
import { defaultedLoopsTransactionalLayer } from "./loops-transactional-defaults.js";
import { LoopsTransactionalEmail, loopsTransactionalLayer } from "./loops-transactional-email.js";
import type { LoopsTransactionalJobInput } from "./loops-transactional-email.js";

const options = {
  capacity: 2,
  maxBytes: 1_000_000,
  privateData: "AuthorizePayloadCapture",
} as const;

const loopsJob = {
  email: "recipient@fictional.invalid",
  transactionalId: "private_template",
} as const;

const iterableJob = { campaignId: 123, recipientEmail: "recipient@fictional.invalid" } as const;

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const loopsReply = { body: '{"success":true}', status: 200 };

const iterableReply = { body: '{"code":"Success","msg":"private reply"}', status: 200 };

const loopsLayer = (fixture: EmailHttpFixture) =>
  loopsTransactionalLayer(
    {
      apiKey: Redacted.make("private-native-key"),
      attachments: "AccountEnabled",
      templateAuthority: "ProviderManaged",
    },
    policy,
  ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")));

const iterableLayer = (fixture: EmailHttpFixture) =>
  iterableCampaignLayer(
    {
      apiKey: Redacted.make("private-native-key"),
      campaignAuthority: "AuthorizeProviderManagedCampaign",
      contactWrites: "AuthorizeProfileCreation",
      dataRetention: "AuthorizePersistedSendData",
      projectIdentity: "EmailBased",
      region: "US",
      tracking: "AuthorizeCampaignTracking",
    },
    policy,
  ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.iterable.com")));

const receipt = Object.freeze(
  EmailReceiptSchema.cases.Accepted.make({
    messageId: EmailMessageIdSchema.make("private-receipt-id"),
    provider: "loops",
  }),
);

const rejected = new EmailRejected({ provider: "loops", reason: "authentication", status: 401 });

const unknown = new EmailDeliveryUnknown({ provider: "loops", reason: "transport" });

const readPayload = (record: EmailCaptureRecord) =>
  Schema.decodeEffect(Schema.fromJsonString(EmailNativeCapturePayloadSchema))(
    Redacted.value(record.payloadJson),
  );

const suppliedLoopsLayer = (
  base: Layer.Layer<LoopsTransactionalEmail, EmailConfigurationError>,
  submission: Effect.Effect<EmailReceipt, EmailSendError>,
) =>
  Layer.effect(
    LoopsTransactionalEmail,
    Effect.gen(function* acquireControlledCaptureLoops() {
      const native = yield* LoopsTransactionalEmail;

      return LoopsTransactionalEmail.of({ ...native, send: () => submission });
    }),
  ).pipe(Layer.provide(base));

describe("explicit private native operation capture", () => {
  it.effect(
    "captures owned complete Loops delegation without claiming defaults are wire intent",
    () =>
      Effect.gen(function* captureLoopsDelegation() {
        const fixture = yield* startEmailHttpFixture(loopsReply);

        const job = {
          ...loopsJob,
          attachments: [
            {
              contentBase64: "AAE=",
              contentType: "application/octet-stream",
              filename: "private.bin",
            },
          ],
          dataVariables: { items: [{ name: "private row" }], note: "private original" },
        } satisfies LoopsTransactionalJobInput;

        const escaped = yield* Effect.gen(function* inspectLoopsDelegation() {
          const loops = yield* LoopsTransactionalEmail;
          const capture = yield* EmailNativeCapture;
          yield* loops.validate(job, { idempotencyKey: "event", policy });
          assert.strictEqual((yield* capture.snapshot).records.length, 0);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert.strictEqual(loops.idempotency._tag, "KeyForwarding");
          yield* loops.send(job, { idempotencyKey: "event", policy });
          job.dataVariables.items[0] = { name: "changed" };
          const snapshot = yield* capture.snapshot;
          const [record] = snapshot.records;
          assert.isDefined(record);
          const payload = yield* readPayload(record);
          assert(
            Schema.is(EmailNativeCaptureRequestSchema.cases.LoopsTransactional)(payload.request),
          );
          assert.deepStrictEqual(payload.request.job.dataVariables, {
            items: [{ name: "private row" }],
            note: "private original",
          });
          assert.strictEqual(payload.request.job.attachments?.[0]?.filename, "private.bin");
          assert.strictEqual(payload.request.options.idempotencyKey, "event");
          assert.strictEqual(
            Duration.toMillis(payload.request.options.policy?.deadline ?? Duration.zero),
            10_000,
          );
          assert.strictEqual(payload.outcome._tag, "Receipt");
          assert.strictEqual(
            record.byteLength,
            new TextEncoder().encode(Redacted.value(record.payloadJson)).byteLength,
          );
          assert(
            Object.isFrozen(snapshot) &&
              Object.isFrozen(snapshot.records) &&
              Object.isFrozen(record),
          );
          assert.notInclude(JSON.stringify(snapshot), "private");
          assert(
            Result.isFailure(
              yield* Schema.encodeEffect(Schema.toCodecJson(EmailCaptureSnapshotSchema))(
                snapshot,
              ).pipe(Effect.result),
            ),
          );

          return { capture, record };
        }).pipe(
          Effect.provide(
            capturedLoopsTransactionalLayer(
              defaultedLoopsTransactionalLayer(loopsLayer(fixture), {
                dataVariables: { default: "private default" },
                idempotencyKeyPrefix: "host/",
              }),
              options,
            ),
          ),
        );

        const wire = yield* Queue.take(fixture.received);
        assert.strictEqual(wire.idempotencyKey, "host/event");
        assert.include(wire.body, "private default");
        assert.strictEqual((yield* escaped.capture.snapshot).closed, true);
        assert.strictEqual((yield* escaped.capture.snapshot).records.length, 0);
        assert.strictEqual((yield* readPayload(escaped.record)).request._tag, "LoopsTransactional");
      }),
  );

  it.effect(
    "captures merged Loops intent and prefixed keys when explicitly composed beneath defaults",
    () =>
      Effect.gen(function* captureEffectiveNativeDefaults() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const captured = capturedLoopsTransactionalLayer(loopsLayer(fixture), options);

        const decorated = defaultedLoopsTransactionalLayer(captured, {
          dataVariables: { note: "private default" },
          idempotencyKeyPrefix: "host/",
        }).pipe(Layer.provideMerge(captured));

        yield* Effect.gen(function* inspectEffectiveNativeCapture() {
          yield* (yield* LoopsTransactionalEmail).send(loopsJob, { idempotencyKey: "event" });
          const [record] = (yield* (yield* EmailNativeCapture).snapshot).records;
          assert.isDefined(record);
          const payload = yield* readPayload(record);
          assert(
            Schema.is(EmailNativeCaptureRequestSchema.cases.LoopsTransactional)(payload.request),
          );
          assert.strictEqual(payload.request.options.idempotencyKey, "host/event");
          assert.deepStrictEqual(payload.request.job.dataVariables, { note: "private default" });
        }).pipe(Effect.provide(decorated));
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "host/event");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "captures actual native Iterable scheduling and bounded values while refusing unsupported keys",
    () =>
      Effect.gen(function* captureIterableDelegation() {
        yield* TestClock.setTime(0);
        const fixture = yield* startEmailHttpFixture(iterableReply);

        const job = {
          ...iterableJob,
          dataFields: { empty: [], flag: false, value: null, zero: 0 },
          metadata: { note: "private metadata" },
          sendAt: "1970-01-01T00:00:01Z",
        };

        yield* Effect.gen(function* inspectIterableCapture() {
          const iterable = yield* IterableCampaignEmail;
          const capture = yield* EmailNativeCapture;
          assert.strictEqual(iterable.idempotency._tag, "None");
          yield* iterable.validate(job);

          const failed = yield* iterable
            .send(job, { idempotencyKey: "not-native" })
            .pipe(Effect.result);

          assert(Result.isFailure(failed) && failed.failure instanceof EmailRejected);
          assert.deepStrictEqual((yield* capture.snapshot).records, []);
          yield* iterable.send(job, { policy });
          const [record] = (yield* capture.snapshot).records;
          assert.isDefined(record);
          const payload = yield* readPayload(record);
          assert(
            Schema.is(EmailNativeCaptureRequestSchema.cases.IterableCampaign)(payload.request),
          );
          assert.deepStrictEqual(payload.request.job.dataFields, job.dataFields);
          assert.deepStrictEqual(payload.request.job.metadata, job.metadata);
          assert.isDefined(payload.request.job.sendAt);
          assert.strictEqual(payload.request.options.idempotencyKey, undefined);
          assert.notInclude(Redacted.value(record.payloadJson), "private-native-key");
        }).pipe(Effect.provide(capturedIterableCampaignLayer(iterableLayer(fixture), options)));
        assert.include((yield* Queue.take(fixture.received)).body, '"value":null');
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect.each([
    rejected,
    unknown,
    new EmailInvalidMessage({ issues: [] }),
    new EmailInvalidOptions({ issues: [] }),
    receipt,
  ])("preserves delegated outcome identity and excludes late local invalidity", (outcome) =>
    Effect.gen(function* preserveCapturedNativeOutcome() {
      const fixture = yield* startEmailHttpFixture(loopsReply);

      const submission = Schema.is(EmailReceiptSchema)(outcome)
        ? Effect.succeed(outcome)
        : Effect.fail(outcome);

      yield* Effect.gen(function* inspectCapturedNativeOutcome() {
        const native = yield* LoopsTransactionalEmail;
        const capture = yield* EmailNativeCapture;
        const result = yield* native.send(loopsJob).pipe(Effect.result);
        const { records } = yield* capture.snapshot;

        if (Result.isSuccess(result)) {
          assert(result.success === outcome);
          const [record] = records;
          assert.isDefined(record);
          const payload = yield* readPayload(record);
          assert(Schema.is(EmailCaptureOutcomeSchema.cases.Receipt)(payload.outcome));
          assert.deepStrictEqual(payload.outcome.receipt, receipt);

          return;
        }

        assert(result.failure === outcome);

        const expected = new Map([
          ["EmailRejected", "Rejected"],
          ["EmailDeliveryUnknown", "Unknown"],
        ]);

        const kind = expected.get(result.failure._tag);

        if (kind === undefined) {
          assert.deepStrictEqual(records, []);

          return;
        }

        const [record] = records;
        assert.isDefined(record);
        const payload = yield* readPayload(record);
        assert.strictEqual(payload.outcome._tag, kind);
        assert(
          Schema.is(EmailCaptureOutcomeSchema.cases.Rejected)(payload.outcome) ||
            Schema.is(EmailCaptureOutcomeSchema.cases.Unknown)(payload.outcome),
        );
        assert.deepStrictEqual(payload.outcome.failure, result.failure);
      }).pipe(
        Effect.provide(
          capturedLoopsTransactionalLayer(
            suppliedLoopsLayer(loopsLayer(fixture), submission),
            options,
          ),
        ),
      );
    }),
  );

  it.effect.prop(
    "owns generated private histories, exact byte totals and atomic purge gaps",
    {
      capacity: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 })),
      texts: Schema.Array(
        Schema.String.check(Schema.isMaxLength(60), Schema.isPattern(/^[a-zA-Z0-9 "\\\n\t<>é]*$/u)),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    },
    ({ capacity, texts }) =>
      Effect.gen(function* captureGeneratedNativeHistory() {
        const fixture = yield* startEmailHttpFixture(loopsReply);
        const config = { ...options, capacity, maxBytes: 1_000_000 };
        const base = suppliedLoopsLayer(loopsLayer(fixture), Effect.succeed(receipt));
        yield* Effect.gen(function* retainGeneratedNativeHistory() {
          const loops = yield* LoopsTransactionalEmail;
          const capture = yield* EmailNativeCapture;
          config.capacity = 100;
          config.maxBytes = 1;

          for (const text of texts) {
            yield* loops.send({ ...loopsJob, dataVariables: { note: text } });
          }

          const old = yield* capture.snapshot;
          const payloads = yield* Effect.forEach(readPayload)(old.records);
          assert.deepStrictEqual(
            payloads.map((payload) => {
              assert(
                Schema.is(EmailNativeCaptureRequestSchema.cases.LoopsTransactional)(
                  payload.request,
                ),
              );

              return payload.request.job.dataVariables?.note;
            }),
            texts.slice(-capacity),
          );
          assert.strictEqual(
            old.retainedBytes,
            old.records.reduce(
              (total, record) =>
                total + new TextEncoder().encode(Redacted.value(record.payloadJson)).byteLength,
              0,
            ),
          );
          assert.strictEqual(old.truncated, texts.length > capacity);

          const purges = yield* Effect.all(
            [capture.purgeRecords, capture.purgeRecords, capture.purgeRecords],
            { concurrency: "unbounded" },
          );

          assert.strictEqual(
            purges.reduce((sum, count) => sum + count, 0),
            old.records.length,
          );
          assert.deepStrictEqual((yield* capture.snapshot).records, []);
          assert.strictEqual((yield* capture.snapshot).retainedBytes, 0);
          yield* loops.send(loopsJob);
          assert.strictEqual((yield* capture.snapshot).truncated, true);
          assert.strictEqual((yield* capture.snapshot).records.length, 1);
          assert.strictEqual(old.records.length, Math.min(capacity, texts.length));
        }).pipe(Effect.provide(capturedLoopsTransactionalLayer(base, config)));
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect("skips oversized UTF-8 records without erasing earlier retained payloads", () =>
    Effect.gen(function* boundNativeCaptureBytes() {
      const fixture = yield* startEmailHttpFixture(loopsReply);
      const base = suppliedLoopsLayer(loopsLayer(fixture), Effect.succeed(receipt));
      const job = { ...loopsJob, dataVariables: { note: "é" } };

      const size = yield* Effect.gen(function* calibrateNativeCaptureSize() {
        yield* (yield* LoopsTransactionalEmail).send(job);

        return (yield* (yield* EmailNativeCapture).snapshot).retainedBytes;
      }).pipe(Effect.provide(capturedLoopsTransactionalLayer(base, options)));

      yield* Effect.gen(function* retainExactNativeByteBudget() {
        const loops = yield* LoopsTransactionalEmail;
        const capture = yield* EmailNativeCapture;
        yield* loops.send(job);
        const old = yield* capture.snapshot;
        yield* loops.send({ ...job, dataVariables: { note: "éé" } });
        const snapshot = yield* capture.snapshot;
        assert.strictEqual(snapshot.retainedBytes, size);
        assert.strictEqual(snapshot.records[0], old.records[0]);
        assert.strictEqual(snapshot.truncated, true);
        assert.strictEqual(yield* capture.purgeRecords, 1);
        yield* loops.send(job);
        assert.strictEqual((yield* capture.snapshot).retainedBytes, size);
        assert.strictEqual((yield* capture.snapshot).truncated, true);
      }).pipe(
        Effect.provide(capturedLoopsTransactionalLayer(base, { ...options, maxBytes: size })),
      );
    }),
  );

  it.effect.each(["capacity", "maxBytes", "privateData", "callback"] as const)(
    "refuses %s before base acquisition",
    (field) =>
      Effect.gen(function* refuseNativeCaptureConfiguration() {
        const config = { ...options };

        const invalid = new Map<string, number | string>([
          ["capacity", 0],
          ["maxBytes", 0],
          ["privateData", "unauthorized"],
          ["callback", "private callback"],
        ]);

        Reflect.set(config, field, invalid.get(field));

        const supplied = Layer.effect(
          LoopsTransactionalEmail,
          Effect.die("unexpected acquisition"),
        );

        const error = yield* LoopsTransactionalEmail.pipe(
          Effect.provide(capturedLoopsTransactionalLayer(supplied, config)),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private callback");
      }),
  );

  it.effect("owns queued batches and omits scheduling invalidated before its slot", () =>
    Effect.gen(function* captureQueuedNativeJobs() {
      yield* TestClock.setTime(0);

      const fixture = yield* startEmailHttpFixture({
        body: "",
        hold: true,
        next: iterableReply,
        status: 200,
      });

      const queued = { ...iterableJob, dataFields: { note: "original" } };
      yield* Effect.gen(function* inspectQueuedNativeCapture() {
        const iterable = yield* IterableCampaignEmail;
        const capture = yield* EmailNativeCapture;

        const batch = yield* iterable
          .sendAll(
            [
              { job: iterableJob },
              { job: { ...iterableJob, sendAt: "1970-01-01T00:00:01Z" } },
              { job: queued },
            ],
            { concurrency: 1 },
          )
          .pipe(Effect.forkChild);

        yield* Queue.take(fixture.received);
        queued.dataFields.note = "changed";
        yield* TestClock.adjust(Duration.seconds(2));
        fixture.server.closeAllConnections();
        const [first, expired, last] = yield* Fiber.join(batch);
        assert.isDefined(first);
        assert.isDefined(expired);
        assert.isDefined(last);
        assert(Result.isFailure(first));
        assert(Result.isFailure(expired) && expired.failure instanceof EmailInvalidMessage);
        assert(Result.isSuccess(last));
        const { records } = yield* capture.snapshot;
        const payloads = yield* Effect.forEach(readPayload)(records);
        assert.deepStrictEqual(
          payloads.map((payload) => payload.outcome._tag),
          ["Unknown", "Receipt"],
        );
        const final = payloads.at(-1);
        assert.isDefined(final);
        assert(Schema.is(EmailNativeCaptureRequestSchema.cases.IterableCampaign)(final.request));
        assert.deepStrictEqual(final.request.job.dataFields, { note: "original" });
      }).pipe(
        Effect.provide(
          capturedIterableCampaignLayer(
            defaultedIterableCampaignLayer(iterableLayer(fixture), {
              metadata: { note: "default" },
            }),
            options,
          ),
        ),
      );
    }),
  );

  it.effect("records safe aborted flags on cancellation and never starts queued native work", () =>
    Effect.gen(function* interruptCapturedNativeBatch() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
      yield* Effect.gen(function* inspectInterruptedNativeCapture() {
        const loops = yield* LoopsTransactionalEmail;
        const capture = yield* EmailNativeCapture;

        const pending = yield* loops
          .sendAll([{ job: loopsJob }, { job: loopsJob }], { concurrency: 1 })
          .pipe(Effect.forkChild);

        yield* Queue.take(fixture.received);
        yield* Fiber.interrupt(pending);
        assert(Exit.hasInterrupts(yield* Fiber.await(pending)));
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const [record] = (yield* capture.snapshot).records;
        assert.isDefined(record);
        const payload = yield* readPayload(record);
        assert(Schema.is(EmailCaptureOutcomeSchema.cases.Aborted)(payload.outcome));
        assert.strictEqual(payload.outcome.interrupted, true);
        assert.strictEqual(payload.outcome.defect, false);
      }).pipe(Effect.provide(capturedLoopsTransactionalLayer(loopsLayer(fixture), options)));
    }),
  );

  it.effect("captures one modeled deadline without changing key-forwarding replay authority", () =>
    Effect.gen(function* expireCapturedNativeOperation() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
      yield* Effect.gen(function* inspectTimedOutNativeCapture() {
        const loops = yield* LoopsTransactionalEmail;
        const capture = yield* EmailNativeCapture;

        const pending = yield* loops
          .send(loopsJob, {
            idempotencyKey: "event",
            policy: { ...policy, deadline: Duration.seconds(1) },
          })
          .pipe(Effect.result, Effect.forkChild);

        yield* Queue.take(fixture.received);
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(pending);
        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const [record] = (yield* capture.snapshot).records;
        assert.isDefined(record);
        assert.strictEqual((yield* readPayload(record)).outcome._tag, "Unknown");
      }).pipe(Effect.provide(capturedLoopsTransactionalLayer(loopsLayer(fixture), options)));
    }),
  );

  it.effect("allows pending completions after purge but cannot reopen a scope-closed capture", () =>
    Effect.gen(function* closePendingNativeCapture() {
      const fixture = yield* startEmailHttpFixture(loopsReply);
      const entered = yield* Queue.unbounded<boolean>();
      const release = yield* Queue.unbounded<boolean>();

      const submission = Queue.offer(entered, true).pipe(
        Effect.andThen(Queue.take(release)),
        Effect.as(receipt),
      );

      const scope = yield* Scope.make();

      const context = yield* Layer.buildWithScope(
        capturedLoopsTransactionalLayer(
          suppliedLoopsLayer(loopsLayer(fixture), submission),
          options,
        ),
        scope,
      );

      const loops = Context.get(context, LoopsTransactionalEmail);
      const capture = Context.get(context, EmailNativeCapture);
      const first = yield* loops.send(loopsJob).pipe(Effect.forkChild);
      yield* Queue.take(entered);
      assert.strictEqual(yield* capture.purgeRecords, 0);
      yield* Queue.offer(release, true);
      yield* Fiber.join(first);
      const old = yield* capture.snapshot;
      assert.strictEqual(yield* capture.purgeRecords, 1);
      const second = yield* loops.send(loopsJob).pipe(Effect.forkChild);
      yield* Queue.take(entered);
      yield* Queue.offer(release, true);
      yield* Fiber.join(second);
      assert.strictEqual((yield* capture.snapshot).records.length, 1);
      const last = yield* loops.send(loopsJob).pipe(Effect.forkChild);
      yield* Queue.take(entered);
      yield* Scope.close(scope, Exit.void);
      yield* Queue.offer(release, true);
      assert.strictEqual(yield* Fiber.join(last), receipt);
      const closed = yield* capture.snapshot;
      assert.deepStrictEqual(closed.records, []);
      assert.strictEqual(closed.closed, true);
      assert.strictEqual(closed.truncated, true);
      assert.strictEqual(yield* capture.purgeRecords, 0);
      assert.strictEqual(old.records.length, 1);
    }),
  );

  it.effect("preserves mixed local failures and defects without retaining private causes", () =>
    Effect.gen(function* preserveNativeCapturePrivacy() {
      const fixture = yield* startEmailHttpFixture(loopsReply);
      const released = yield* Deferred.make<boolean>();
      const trace = yield* startEmailTraceFixture();

      const lifecycle = Layer.effectDiscard(
        Effect.acquireRelease(Effect.void, () => Deferred.succeed(released, true)),
      );

      const base = suppliedLoopsLayer(
        loopsLayer(fixture),
        Effect.fail(new EmailInvalidOptions({ issues: [] })).pipe(
          Effect.ensuring(Effect.die("private original defect")),
        ),
      ).pipe(Layer.provide(lifecycle));

      yield* Effect.gen(function* inspectDefectiveNativeCapture() {
        const exit = yield* (yield* LoopsTransactionalEmail).send(loopsJob).pipe(Effect.exit);
        assert(Exit.hasDies(exit));
        assert.include(JSON.stringify(exit), "private original defect");
        const capture = yield* EmailNativeCapture;
        const [record] = (yield* capture.snapshot).records;
        assert.isDefined(record);
        const payload = yield* readPayload(record);
        assert(Schema.is(EmailCaptureOutcomeSchema.cases.Aborted)(payload.outcome));
        assert.strictEqual(payload.outcome.defect, true);
        assert.notInclude(Redacted.value(record.payloadJson), "private original defect");
        yield* capture.purgeRecords;
      }).pipe(
        Effect.provide(capturedLoopsTransactionalLayer(base, options)),
        Effect.withTracer(trace.tracer),
      );
      assert.strictEqual(yield* Deferred.await(released), true);
      const diagnostics = yield* trace.diagnostics;
      assert.include(diagnostics, "CapturedLoopsTransactionalEmail.send");
      assert.include(diagnostics, "EmailNativeCapture.purgeRecords");
      assert.notInclude(diagnostics, "private original defect");
      assert.notInclude(diagnostics, loopsJob.email);
      assert.notInclude(diagnostics, loopsJob.transactionalId);
    }),
  );

  it.effect("retains concurrent native records in completion order, not start order", () =>
    Effect.gen(function* orderNativeCaptureCompletions() {
      const fixture = yield* startEmailHttpFixture({
        body: "",
        hold: true,
        next: loopsReply,
        status: 200,
      });

      yield* Effect.gen(function* inspectConcurrentNativeCapture() {
        const loops = yield* LoopsTransactionalEmail;
        const capture = yield* EmailNativeCapture;

        const pending = yield* loops
          .send({ ...loopsJob, dataVariables: { note: "first" } })
          .pipe(Effect.result, Effect.forkChild);

        yield* Queue.take(fixture.received);
        yield* loops.send({ ...loopsJob, dataVariables: { note: "second" } });
        fixture.server.closeAllConnections();
        assert(Result.isFailure(yield* Fiber.join(pending)));
        const payloads = yield* Effect.forEach(readPayload)((yield* capture.snapshot).records);
        assert.deepStrictEqual(
          payloads.map((payload) => {
            assert(
              Schema.is(EmailNativeCaptureRequestSchema.cases.LoopsTransactional)(payload.request),
            );

            return payload.request.job.dataVariables?.note;
          }),
          ["second", "first"],
        );
      }).pipe(Effect.provide(capturedLoopsTransactionalLayer(loopsLayer(fixture), options)));
    }),
  );

  it.effect("isolates simultaneously acquired native capture views", () =>
    Effect.gen(function* isolateNativeCaptureScopes() {
      const fixture = yield* startEmailHttpFixture(loopsReply);
      const layer = capturedLoopsTransactionalLayer(loopsLayer(fixture), options);

      const firstScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );

      const secondScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );

      const first = yield* Layer.buildWithScope(layer, firstScope);
      const second = yield* Layer.buildWithScope(layer, secondScope);
      yield* Context.get(first, LoopsTransactionalEmail).send(loopsJob);
      assert.deepStrictEqual((yield* Context.get(second, EmailNativeCapture).snapshot).records, []);
      yield* Context.get(second, LoopsTransactionalEmail).send(loopsJob);
      assert.strictEqual(
        (yield* Context.get(first, EmailNativeCapture).snapshot).records.length,
        1,
      );
      assert.strictEqual(
        (yield* Context.get(second, EmailNativeCapture).snapshot).records.length,
        1,
      );
      yield* Context.get(first, EmailNativeCapture).purgeRecords;
      assert.strictEqual(
        (yield* Context.get(second, EmailNativeCapture).snapshot).records.length,
        1,
      );
    }),
  );

  it.effect("marks an encoding gap instead of replacing an already returned receipt", () =>
    Effect.gen(function* retainNativeEncodingGap() {
      const fixture = yield* startEmailHttpFixture(loopsReply);

      const invalid = EmailReceiptSchema.cases.Recorded.make({ sequence: 1 });

      Reflect.set(invalid, "sequence", Number.NaN);
      yield* Effect.gen(function* inspectNativeEncodingGap() {
        assert.strictEqual(yield* (yield* LoopsTransactionalEmail).send(loopsJob), invalid);
        const capture = yield* EmailNativeCapture;
        const snapshot = yield* capture.snapshot;
        assert.deepStrictEqual(snapshot.records, []);
        assert.strictEqual(snapshot.truncated, true);
        assert.strictEqual(yield* capture.purgeRecords, 0);
        assert.strictEqual((yield* capture.snapshot).truncated, true);
      }).pipe(
        Effect.provide(
          capturedLoopsTransactionalLayer(
            suppliedLoopsLayer(loopsLayer(fixture), Effect.succeed(invalid)),
            options,
          ),
        ),
      );
    }),
  );
});
