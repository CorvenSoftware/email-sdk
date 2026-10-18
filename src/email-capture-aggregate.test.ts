import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Result,
  Schema,
} from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailRejected,
  EmailRouter,
  emailLayer,
  emailRouterLayer,
  capturedEmailRouterLayer,
} from "./index.js";
import {
  EmailCaptureAggregate,
  EmailCaptureAggregateError,
  EmailCaptureAggregateSnapshotSchema,
  EmailCapturePayloadSchema,
  EmailCaptureSnapshotSchema,
  EmailSubmissionCapture,
  aggregatedEmailCaptureLayer,
  capturedEmailSenderLayer,
} from "./email-submission-capture.js";
import type { IEmailSubmissionCapture } from "./email-submission-capture.js";
import {
  EmailNativeCapturePayloadSchema,
  capturedLoopsTransactionalLayer,
} from "./email-native-capture.js";
import { LoopsTransactionalEmail, loopsTransactionalLayer } from "./loops-transactional-email.js";
import { failingSenderLayer, recordingSenderLayer } from "./email-testing.js";

const options = { capacity: 2, maxBytes: 100_000, privateData: "AuthorizePayloadCapture" } as const;

const message = {
  body: { text: "private-aggregate-body" },
  from: "sender@example.test",
  subject: "Private aggregate",
  to: "recipient@example.test",
};

const recordingAccount = (capacity = 2) =>
  emailLayer().pipe(
    Layer.provideMerge(
      capturedEmailSenderLayer(Layer.fresh(recordingSenderLayer), { ...options, capacity }),
    ),
  );

const decodeSubmission = (payload: Redacted.Redacted) =>
  Schema.decodeEffect(Schema.fromJsonString(EmailCapturePayloadSchema))(Redacted.value(payload));

describe("explicit private capture aggregation", () => {
  it.effect("owns routed capture stores and their closure from one account declaration", () =>
    Effect.gen(function* assembleCapturedRoutes() {
      const accounts = capturedEmailRouterLayer(
        [
          { layer: recordingAccount(), name: "primary" },
          { layer: recordingAccount(), name: "backup" },
        ],
        { primary: "primary" },
      );

      const escaped = yield* Effect.gen(function* submitToOwnedCaptureStores() {
        yield* (yield* Email).send(message);
        const backup = yield* (yield* EmailRouter).select({ primary: "backup" });
        yield* backup.send({ ...message, subject: "Backup intent" });
        const aggregate = yield* EmailCaptureAggregate;
        const snapshot = yield* aggregate.snapshot;
        assert.strictEqual(snapshot.retainedRecords, 2);
        const [first, second] = snapshot.sources;
        assert.isDefined(second);
        const [primaryRecord] = first.snapshot.records;
        const [backupRecord] = second.snapshot.records;
        assert.isDefined(primaryRecord);
        assert.isDefined(backupRecord);
        assert.strictEqual(
          (yield* decodeSubmission(primaryRecord.payloadJson)).submission.message.subject,
          message.subject,
        );
        assert.strictEqual(
          (yield* decodeSubmission(backupRecord.payloadJson)).submission.message.subject,
          "Backup intent",
        );

        return { aggregate, snapshot };
      }).pipe(Effect.provide(accounts));

      const closed = yield* escaped.aggregate.snapshot;
      assert(closed.sources.every((source) => source.snapshot.closed));
      assert.strictEqual(closed.retainedRecords, 0);
      assert.strictEqual(escaped.snapshot.retainedRecords, 2);
    }),
  );

  it.effect.each(["Plan", "Extra"] as const)(
    "rejects invalid assembled %s before acquiring capture stores",
    (mode) =>
      Effect.gen(function* validateCapturedRouteAssembly() {
        const account = recordingAccount().pipe(
          Layer.provide(Layer.effectDiscard(Effect.die("unexpected account acquisition"))),
        );

        const binding = { layer: account, name: "account" };

        if (mode === "Extra") {
          Reflect.set(binding, "private-field", "private-value");
        }

        const error = yield* EmailCaptureAggregate.pipe(
          Effect.provide(
            capturedEmailRouterLayer([binding], {
              primary: mode === "Plan" ? "missing" : "account",
            }),
          ),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private");
      }),
  );

  it.effect.each(["Rejected", "Unknown"] as const)(
    "reads the actual routed sources without changing %s fallback authority",
    (mode) =>
      Effect.gen(function* aggregateRealRouting() {
        const failures = {
          Rejected: new EmailRejected({ provider: "fixture", reason: "authentication" }),
          Unknown: new EmailDeliveryUnknown({ provider: "fixture", reason: "transport" }),
        };

        const primary = emailLayer().pipe(
          Layer.provideMerge(capturedEmailSenderLayer(failingSenderLayer(failures[mode]), options)),
        );

        const backup = recordingAccount();

        const primaryBinding = { kind: "Submission", layer: primary, name: "primary" } as const;

        const aggregate = aggregatedEmailCaptureLayer([
          primaryBinding,
          { kind: "Submission", layer: backup, name: "backup" },
        ]);

        const router = emailRouterLayer(
          [
            { layer: primary, name: "primary" },
            { layer: backup, name: "backup" },
          ],
          { fallbacks: ["backup"], primary: "primary" },
        );

        yield* Effect.gen(function* submitThenQueryRouteSources() {
          Reflect.set(primaryBinding, "name", "changed-after-acquisition");
          Reflect.set(primaryBinding, "kind", "Native");
          const result = yield* (yield* Email).send(message).pipe(Effect.result);

          if (mode === "Rejected") {
            assert(Result.isSuccess(result));
          } else {
            assert(Result.isFailure(result));
            assert(result.failure instanceof EmailDeliveryUnknown);
          }

          const view = yield* EmailCaptureAggregate;
          const first = yield* view.snapshot;
          const [a, b] = first.sources;
          assert.isDefined(b);
          assert.strictEqual(a.name, "primary");
          assert.strictEqual(b.name, "backup");
          assert.strictEqual(a.unit, "SenderInvocation");
          assert.strictEqual(first.retainedRecords, mode === "Rejected" ? 2 : 1);
          assert.strictEqual(b.snapshot.records.length, mode === "Rejected" ? 1 : 0);
          const [record] = a.snapshot.records;
          assert.isDefined(record);
          const payload = yield* decodeSubmission(record.payloadJson);
          assert.strictEqual(payload.outcome._tag, mode);
          assert.strictEqual(payload.submission.message.body.text, message.body.text);
          assert.strictEqual((yield* view.snapshot).retainedRecords, first.retainedRecords);
          assert(Object.isFrozen(first.sources));
          assert(Object.isFrozen(a.snapshot.records));
        }).pipe(Effect.provide(Layer.mergeAll(router, aggregate)));
      }),
  );

  it.effect(
    "keeps common sender invocations and native operations separate without exposing payload JSON",
    () =>
      Effect.gen(function* aggregateMixedUnits() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const common = recordingAccount();

        const native = capturedLoopsTransactionalLayer(
          loopsTransactionalLayer({
            apiKey: Redacted.make("fictional-unused-key"),
            attachments: "Disabled",
            templateAuthority: "ProviderManaged",
          }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so"))),
          options,
        );

        const aggregate = aggregatedEmailCaptureLayer([
          { kind: "Submission", layer: common, name: "common" },
          { kind: "Native", layer: native, name: "native" },
        ]);

        yield* Effect.gen(function* submitMixedCaptureUnits() {
          yield* (yield* Email).send(message);
          yield* (yield* LoopsTransactionalEmail).send({
            dataVariables: { code: "private-native-value" },
            email: "recipient@example.test",
            transactionalId: "fictional-template",
          });
          const snapshot = yield* (yield* EmailCaptureAggregate).snapshot;
          const [sender, job] = snapshot.sources;
          assert.isDefined(job);
          assert.strictEqual(sender.unit, "SenderInvocation");
          assert.strictEqual(job.unit, "NativeOperation");
          assert.strictEqual(snapshot.retainedRecords, 2);
          assert.strictEqual(
            snapshot.retainedBytes,
            sender.snapshot.retainedBytes + job.snapshot.retainedBytes,
          );
          const [record] = job.snapshot.records;
          assert.isDefined(record);

          const payload = yield* Schema.decodeEffect(
            Schema.fromJsonString(EmailNativeCapturePayloadSchema),
          )(Redacted.value(record.payloadJson));

          assert.strictEqual(payload.request._tag, "LoopsTransactional");
          assert.notInclude(JSON.stringify(snapshot), "private-native-value");
          assert.notInclude(JSON.stringify(snapshot), message.body.text);

          const encoded = yield* Schema.encodeEffect(
            Schema.toCodecJson(EmailCaptureAggregateSnapshotSchema),
          )(snapshot).pipe(Effect.result);

          assert(Result.isFailure(encoded));
        }).pipe(Effect.provide(Layer.mergeAll(common, native, aggregate)));
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }).pipe(Effect.scoped),
  );

  it.effect.prop(
    "preserves each source's retained suffix and gap instead of inventing a global history",
    {
      firstCount: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 0 })),
      secondCount: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 0 })),
    },
    ({ firstCount, secondCount }) =>
      Effect.gen(function* aggregateRetainedSources() {
        const first = recordingAccount(2);
        const second = recordingAccount(3);

        const router = emailRouterLayer(
          [
            { layer: first, name: "first" },
            { layer: second, name: "second" },
          ],
          { primary: "first" },
        );

        const aggregate = aggregatedEmailCaptureLayer([
          { kind: "Submission", layer: first, name: "first" },
          { kind: "Submission", layer: second, name: "second" },
        ]);

        yield* Effect.gen(function* queryGeneratedRetainedSuffixes() {
          const routes = yield* EmailRouter;
          const a = yield* routes.select({ primary: "first" });
          const b = yield* routes.select({ primary: "second" });
          const firstSubjects = Array.from({ length: firstCount }, (_, index) => `First ${index}`);

          const secondSubjects = Array.from(
            { length: secondCount },
            (_, index) => `Second ${index}`,
          );

          yield* Effect.forEach(firstSubjects, (subject) => a.send({ ...message, subject }), {
            concurrency: 1,
          });
          yield* Effect.forEach(secondSubjects, (subject) => b.send({ ...message, subject }), {
            concurrency: 1,
          });
          const snapshot = yield* (yield* EmailCaptureAggregate).snapshot;
          const [left, right] = snapshot.sources;
          assert.isDefined(right);

          const leftPayloads = yield* Effect.forEach(
            left.snapshot.records,
            (record) => decodeSubmission(record.payloadJson),
            { concurrency: 1 },
          );

          const rightPayloads = yield* Effect.forEach(
            right.snapshot.records,
            (record) => decodeSubmission(record.payloadJson),
            { concurrency: 1 },
          );

          assert.deepStrictEqual(
            leftPayloads.map((payload) => payload.submission.message.subject),
            firstSubjects.slice(-2),
          );
          assert.deepStrictEqual(
            rightPayloads.map((payload) => payload.submission.message.subject),
            secondSubjects.slice(-3),
          );
          assert.strictEqual(snapshot.truncated, firstCount > 2 || secondCount > 3);
          assert.strictEqual(
            snapshot.retainedRecords,
            Math.min(firstCount, 2) + Math.min(secondCount, 3),
          );
        }).pipe(Effect.provide(Layer.mergeAll(router, aggregate)));
      }),
  );

  it.effect(
    "reflects purge and closure while old aggregate snapshots retain only caller-owned references",
    () =>
      Effect.gen(function* reflectCaptureRetention() {
        const account = recordingAccount();

        const aggregate = aggregatedEmailCaptureLayer([
          { kind: "Submission", layer: account, name: "account" },
        ]);

        const escaped = yield* Effect.gen(function* inspectScopedAggregate() {
          const email = yield* Email;
          const capture = yield* EmailSubmissionCapture;
          const view = yield* EmailCaptureAggregate;
          const first = yield* email.send(message, { idempotencyKey: "original-key" });
          const old = yield* view.snapshot;
          assert.strictEqual(yield* capture.purgeRecords, 1);
          const purged = yield* view.snapshot;
          assert.strictEqual(purged.retainedRecords, 0);
          assert.strictEqual(purged.truncated, true);
          assert.strictEqual(yield* email.send(message, { idempotencyKey: "original-key" }), first);
          assert.strictEqual((yield* view.snapshot).retainedRecords, 1);

          return { old, view };
        }).pipe(Effect.provide(Layer.mergeAll(account, aggregate)));

        const closed = yield* escaped.view.snapshot;
        assert.strictEqual(closed.retainedRecords, 0);
        assert.strictEqual(closed.sources[0].snapshot.closed, true);
        assert.strictEqual(escaped.old.retainedRecords, 1);
        const [record] = escaped.old.sources[0].snapshot.records;
        assert.isDefined(record);
        assert.strictEqual(
          (yield* decodeSubmission(record.payloadJson)).submission.message.body.text,
          message.body.text,
        );
      }),
  );

  it.effect(
    "reports sequential source reads honestly when purge and new completions interleave",
    () =>
      Effect.gen(function* inspectNonAtomicAggregate() {
        const waiting = yield* Deferred.make<boolean>();
        const release = yield* Deferred.make<boolean>();
        const first = recordingAccount();
        const base = capturedEmailSenderLayer(Layer.fresh(recordingSenderLayer), options);

        const delayed = Layer.effect(
          EmailSubmissionCapture,
          Effect.gen(function* delaySecondCaptureRead() {
            const view = yield* EmailSubmissionCapture;

            return EmailSubmissionCapture.of({
              ...view,
              snapshot: Deferred.succeed(waiting, true).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(view.snapshot),
              ),
            });
          }),
        ).pipe(Layer.provideMerge(base));

        const second = emailLayer().pipe(Layer.provideMerge(delayed));

        const router = emailRouterLayer(
          [
            { layer: first, name: "first" },
            { layer: second, name: "second" },
          ],
          { primary: "first" },
        );

        const aggregate = aggregatedEmailCaptureLayer([
          { kind: "Submission", layer: first, name: "first" },
          { kind: "Submission", layer: second, name: "second" },
        ]);

        yield* Effect.gen(function* interleaveSourceReads() {
          const routes = yield* EmailRouter;
          const a = yield* routes.select({ primary: "first" });
          const b = yield* routes.select({ primary: "second" });
          yield* a.send({ ...message, subject: "First before purge" });
          yield* b.send({ ...message, subject: "Second before query" });
          const view = yield* EmailCaptureAggregate;
          const query = yield* view.snapshot.pipe(Effect.forkScoped);
          yield* Deferred.await(waiting);
          const firstContext = yield* Layer.build(first);
          assert.strictEqual(
            yield* Context.get(firstContext, EmailSubmissionCapture).purgeRecords,
            1,
          );
          yield* b.send({ ...message, subject: "Second during query" });
          yield* Deferred.succeed(release, true);
          const mixed = yield* Fiber.join(query);
          assert.strictEqual(mixed.retainedRecords, 3);
          assert.strictEqual(mixed.sources[0].snapshot.records.length, 1);
          const current = yield* view.snapshot;
          assert.strictEqual(current.retainedRecords, 2);
          assert.strictEqual(current.sources[0].snapshot.records.length, 0);
          assert.strictEqual(current.truncated, true);
        }).pipe(Effect.provide(Layer.mergeAll(router, aggregate)));
      }).pipe(Effect.scoped),
  );

  it.effect("refuses source collections beyond the local bound before acquisition", () =>
    Effect.gen(function* boundCaptureSourceCollection() {
      const source = Layer.effect(
        EmailSubmissionCapture,
        Effect.die("private-unexpected-acquisition"),
      );

      const first = { kind: "Submission", layer: source, name: "first" } as const;

      const rest = Array.from({ length: 16 }, (_, index) => ({
        ...first,
        name: `source_${index}`,
      }));

      const error = yield* EmailCaptureAggregate.pipe(
        Effect.provide(aggregatedEmailCaptureLayer([first, ...rest])),
        Effect.flip,
      );

      assert(error instanceof EmailConfigurationError);
    }),
  );

  it.effect.each(["Name", "Duplicate", "Extra"] as const)(
    "refuses %s metadata before acquiring source code and hides private configuration",
    (mode) =>
      Effect.gen(function* validateAggregateBeforeAcquisition() {
        const source = Layer.effect(
          EmailSubmissionCapture,
          Effect.die("private-unexpected-acquisition"),
        );

        const first = { kind: "Submission", layer: source, name: "first" } as const;
        const second = { kind: "Submission", layer: source, name: "second" } as const;

        const corrupt = {
          Duplicate: () => Reflect.set(second, "name", "first"),
          Extra: () => Reflect.set(second, "private-config-field", "private-config-value"),
          Name: () => Reflect.set(second, "name", "private invalid name"),
        };

        corrupt[mode]();

        const error = yield* EmailCaptureAggregate.pipe(
          Effect.provide(aggregatedEmailCaptureLayer([first, second])),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private-config");
        assert.notInclude(JSON.stringify(error), "private invalid name");
      }),
  );

  it.effect(
    "rejects aliases of one acquired view and releases the source rather than double-counting it",
    () =>
      Effect.gen(function* refuseDuplicateCaptureView() {
        const acquired = yield* Queue.unbounded<IEmailSubmissionCapture>();
        const base = capturedEmailSenderLayer(Layer.fresh(recordingSenderLayer), options);

        const source = Layer.effect(
          EmailSubmissionCapture,
          Effect.gen(function* inspectAcquiredView() {
            const view = yield* EmailSubmissionCapture;
            yield* Queue.offer(acquired, view);

            return view;
          }),
        ).pipe(Layer.provide(base));

        const error = yield* EmailCaptureAggregate.pipe(
          Effect.provide(
            aggregatedEmailCaptureLayer([
              { kind: "Submission", layer: source, name: "first" },
              { kind: "Submission", layer: source, name: "alias" },
            ]),
          ),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        const view = yield* Queue.take(acquired);
        assert.strictEqual(yield* Queue.size(acquired), 0);
        assert.strictEqual((yield* view.snapshot).closed, true);
      }),
  );

  it.effect.each(["Bytes", "Closed", "Extra"] as const)(
    "returns a fixed private-data-free error for %s source data",
    (mode) =>
      Effect.gen(function* rejectMalformedCaptureSource() {
        const data = EmailCaptureSnapshotSchema.make({
          closed: false,
          records: [],
          retainedBytes: 0,
          truncated: false,
        });

        const corrupt = {
          Bytes: () => Reflect.set(data, "retainedBytes", 1),
          Closed: () => {
            Reflect.set(data, "closed", true);
            Reflect.set(data, "records", [
              { byteLength: 1, payloadJson: Redacted.make("private-source-payload") },
            ]);
            Reflect.set(data, "retainedBytes", 1);
          },
          Extra: () => Reflect.set(data, "private-source-field", "private-source-value"),
        };

        corrupt[mode]();

        const source = Layer.succeed(
          EmailSubmissionCapture,
          EmailSubmissionCapture.of({
            purgeRecords: Effect.succeed(0),
            snapshot: Effect.succeed(data),
          }),
        );

        const failure = yield* EmailCaptureAggregate.pipe(
          Effect.flatMap((view) => view.snapshot),
          Effect.provide(
            aggregatedEmailCaptureLayer([{ kind: "Submission", layer: source, name: "source" }]),
          ),
          Effect.flip,
        );

        assert(failure instanceof EmailCaptureAggregateError);
        assert.strictEqual(failure.reason, "invalid-source");
        assert.notInclude(JSON.stringify(failure), "private-source");
      }),
  );

  it.effect.each(["Defect", "Interrupt"] as const)(
    "propagates source %s and keeps original causes out of SDK spans",
    (mode) =>
      Effect.gen(function* preserveCaptureQueryCause() {
        const trace = yield* startEmailTraceFixture();
        const entered = yield* Deferred.make<boolean>();
        const outcomes = { Defect: Effect.die("private-query-defect"), Interrupt: Effect.never };

        const source = Layer.succeed(
          EmailSubmissionCapture,
          EmailSubmissionCapture.of({
            purgeRecords: Effect.succeed(0),
            snapshot: Deferred.succeed(entered, true).pipe(Effect.andThen(outcomes[mode])),
          }),
        );

        const fiber = yield* EmailCaptureAggregate.pipe(
          Effect.flatMap((view) => view.snapshot),
          Effect.provide(
            aggregatedEmailCaptureLayer([{ kind: "Submission", layer: source, name: "source" }]),
          ),
          Effect.withTracer(trace.tracer),
          Effect.forkScoped,
        );

        yield* Deferred.await(entered);

        if (mode === "Interrupt") {
          yield* Fiber.interrupt(fiber);
        }

        const exit = yield* Fiber.await(fiber);
        assert(Exit.isFailure(exit));
        assert.strictEqual(Exit.hasDies(exit), mode === "Defect");
        assert.strictEqual(Exit.hasInterrupts(exit), mode === "Interrupt");
        assert.notInclude(yield* trace.diagnostics, "private-query-defect");
      }).pipe(Effect.scoped),
  );
});
