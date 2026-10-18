import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Tracer,
} from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailReceiptSchema,
  EmailRejected,
} from "./index.js";
import {
  LoopsTransactionalEmail,
  LoopsTransactionalRequestSchema,
  loopsTransactionalLayer,
} from "./loops-transactional-email.js";

const configuration = {
  apiKey: Redacted.make("private-loops-key"),
  attachments: "AccountEnabled",
  templateAuthority: "ProviderManaged",
} as const;

const job = { email: "recipient@fictional.invalid", transactionalId: "private-template" } as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const BatchWire = Schema.Struct({
  addToAudience: Schema.Boolean,
  attachments: Schema.Array(
    Schema.Struct({ contentType: Schema.String, data: Schema.String, filename: Schema.String }),
  ),
  dataVariables: Schema.Struct({ items: Schema.Array(Schema.Struct({ value: Schema.String })) }),
  email: Schema.String,
  transactionalId: Schema.String,
});

describe("Loops ordered native-template batches", () => {
  it.live(
    "bounds actual submissions, settles in input order and owns queued intent and policy before the first transport",
    () =>
      Effect.gen(function* sendOwnedLoopsBatch() {
        const fixture = yield* startEmailHttpFixture({
          body: "private-server-reason",
          next: { body: '{"success":true}', status: 200 },
          status: 503,
        });

        const started = yield* Queue.unbounded<string>();
        const firstGate = yield* Deferred.make<true>();
        const secondGate = yield* Deferred.make<true>();
        const thirdGate = yield* Deferred.make<true>();
        const active = yield* Ref.make(0);
        const peak = yield* Ref.make(0);

        const gatedClient = Layer.effect(
          HttpClient.HttpClient,
          Effect.gen(function* gateLoopsTransport() {
            const client = yield* HttpClient.HttpClient;

            return client.pipe(
              HttpClient.transform((response, request) =>
                Effect.gen(function* waitForBatchSlotRelease() {
                  const key = request.headers["idempotency-key"] ?? "";
                  const current = yield* Ref.updateAndGet(active, (count) => count + 1);
                  yield* Ref.update(peak, (maximum) => Math.max(maximum, current));
                  yield* Queue.offer(started, key);

                  const gate = Match.value(key).pipe(
                    Match.when("first", () => firstGate),
                    Match.when("second", () => secondGate),
                    Match.orElse(() => thirdGate),
                  );

                  yield* Deferred.await(gate);

                  return yield* response;
                }).pipe(Effect.ensuring(Ref.update(active, (count) => count - 1))),
              ),
            );
          }),
        ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")));

        const requests = ["first", "second", "third"].map((key) => ({
          job: {
            ...job,
            attachments: [
              {
                contentBase64: "AP+ACg==",
                contentType: "application/pdf",
                filename: "private-file.pdf",
              },
            ] as const,
            dataVariables: { items: [{ value: key }] as const },
          },
          options: { idempotencyKey: key, policy: { ...policy } },
        }));

        const invalidJob = { job: { ...job, email: "private-invalid-recipient" } };
        const invalidOptions = { job, options: { idempotencyKey: "private invalid key" } };
        const unsupportedWrapper = { job, "private-wrapper-field": "private-value" };
        const unsupportedJob = { job: { ...job, "private-job-field": "private-value" } };
        const unsupportedKey = { job, options: { idempotencyKey: "x".repeat(101) } };
        const trace = yield* startEmailTraceFixture();

        const fiber = yield* Effect.gen(function* sendMixedLoopsBatch() {
          const loops = yield* LoopsTransactionalEmail;

          return yield* loops.sendAll(
            [
              ...requests,
              invalidJob,
              invalidOptions,
              unsupportedWrapper,
              unsupportedJob,
              unsupportedKey,
            ],
            { concurrency: 2 },
          );
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer(configuration, policy).pipe(Layer.provide(gatedClient)),
          ),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.forkScoped,
        );

        const initial = [yield* Queue.take(started), yield* Queue.take(started)];
        assert.deepStrictEqual(new Set(initial), new Set(["first", "second"]));
        const queued = requests.find((request) => request.options.idempotencyKey === "third");
        assert.isDefined(queued);
        Reflect.set(queued.job, "email", "changed@fictional.invalid");
        Reflect.set(queued.job.dataVariables.items[0], "value", "private-mutated-variable");
        Reflect.set(queued.job.attachments[0], "contentBase64", "AQ==");
        Reflect.set(queued.options, "idempotencyKey", "private-mutated-key");
        Reflect.set(queued.options.policy, "deadline", Duration.zero);
        Reflect.set(queued.options.policy, "maxAttempts", 0);
        yield* Deferred.succeed(secondGate, true);
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "second");
        assert.strictEqual(yield* Queue.take(started), "third");
        yield* Deferred.succeed(thirdGate, true);
        const queuedWire = yield* Queue.take(fixture.received);
        assert.strictEqual(queuedWire.idempotencyKey, "third");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(BatchWire))(queuedWire.body);
        assert.strictEqual(wire.email, job.email);
        assert.strictEqual(wire.transactionalId, job.transactionalId);
        assert.strictEqual(wire.dataVariables.items[0]?.value, "third");
        assert.strictEqual(wire.attachments[0]?.contentType, "application/pdf");
        assert.deepStrictEqual(
          [...Buffer.from(wire.attachments[0]?.data ?? "", "base64")],
          [0, 255, 128, 10],
        );
        assert.isFalse(wire.addToAudience);
        yield* Deferred.succeed(firstGate, true);
        const results = yield* Fiber.join(fiber);
        const [first, second, third, invalid, badOptions, wrapper, badJob, badKey] = results;
        assert.isDefined(first);
        assert.isDefined(second);
        assert.isDefined(third);
        assert(Result.isSuccess(first) && EmailReceiptSchema.guards.Accepted(first.success));
        assert(Result.isFailure(second) && second.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(second.failure.reason, "server-error");
        assert(Result.isSuccess(third) && EmailReceiptSchema.guards.Accepted(third.success));
        assert.isDefined(invalid);
        assert(Result.isFailure(invalid) && invalid.failure instanceof EmailInvalidMessage);
        assert.strictEqual(invalid.failure.issues[0]?.path, "job.email");
        assert.isDefined(badOptions);
        assert(Result.isFailure(badOptions) && badOptions.failure instanceof EmailInvalidOptions);
        assert.strictEqual(badOptions.failure.issues[0]?.path, "options.idempotencyKey");
        assert.isDefined(wrapper);
        assert(Result.isFailure(wrapper) && wrapper.failure instanceof EmailInvalidOptions);
        assert.isDefined(badJob);
        assert(Result.isFailure(badJob) && badJob.failure instanceof EmailInvalidMessage);
        assert.strictEqual(badJob.failure.issues[0]?.path, "job.<unsupported>");
        assert.isDefined(badKey);
        assert(Result.isFailure(badKey) && badKey.failure instanceof EmailRejected);
        assert.strictEqual(badKey.failure.reason, "unsupported-idempotency");
        assert.notInclude(
          JSON.stringify([invalid, badOptions, wrapper, badJob, badKey]),
          "private-",
        );
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "first");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.strictEqual(yield* Queue.size(started), 0);
        assert.strictEqual(yield* Ref.get(peak), 2);
        assert.strictEqual(yield* Ref.get(active), 0);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Loops.sendAll");

        for (const value of [
          job.email,
          job.transactionalId,
          "private-loops-key",
          "private-file.pdf",
          "AP+ACg==",
          "private-server-reason",
          "private-mutated-variable",
          "private-invalid-recipient",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );

  it.effect.each([0, 33, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid concurrency %s even for an empty batch before any submission",
    (concurrency) =>
      Effect.gen(function* refuseInvalidLoopsBatchBound() {
        const loops = yield* LoopsTransactionalEmail;

        for (const requests of [[], [{ job }]]) {
          const result = yield* loops.sendAll(requests, { concurrency }).pipe(Effect.result);
          assert(Result.isFailure(result) && result.failure instanceof EmailInvalidOptions);
          assert.strictEqual(result.failure.issues[0]?.path, "concurrency");
        }
      }).pipe(
        Effect.provide(
          loopsTransactionalLayer(configuration).pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("Unexpected invalid-batch transport")),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "accepts empty native batches and rejects a shared batch key rather than silently ignoring it",
    () =>
      Effect.gen(function* refuseSharedLoopsBatchIdentity() {
        const loops = yield* LoopsTransactionalEmail;
        assert.deepStrictEqual(yield* loops.sendAll([]), []);
        const options = { concurrency: 32, idempotencyKey: "private-shared-key" };

        for (const requests of [[], [{ job }]]) {
          const result = yield* loops.sendAll(requests, options).pipe(Effect.result);
          assert(Result.isFailure(result) && result.failure instanceof EmailInvalidOptions);
          assert.notInclude(JSON.stringify(result.failure), "private-shared-key");
        }
      }).pipe(
        Effect.provide(
          loopsTransactionalLayer(configuration).pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("Unexpected empty/invalid-batch transport")),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "qualifies native capability, policy and nested-option failures without any transport",
    () =>
      Effect.gen(function* qualifyLoopsBatchFailures() {
        const loops = yield* LoopsTransactionalEmail;

        const requests = [
          {
            job: {
              ...job,
              attachments: [
                { contentBase64: "AQID", contentType: "text/plain", filename: "private-file.txt" },
              ] as const,
            },
          },
          { job, options: { policy: { ...policy, maxAttempts: 0 } } },
          { job, options: { idempotencyKey: "per-job-key", "private-option": "private-value" } },
        ];

        const results = yield* loops.sendAll(requests);
        const [capability, invalidPolicy, unsupported] = results;
        assert.isDefined(capability);
        assert(Result.isFailure(capability) && capability.failure instanceof EmailInvalidMessage);
        assert.strictEqual(capability.failure.issues[0]?.path, "job.attachments");
        assert.isDefined(invalidPolicy);
        assert(
          Result.isFailure(invalidPolicy) && invalidPolicy.failure instanceof EmailInvalidOptions,
        );
        assert.strictEqual(invalidPolicy.failure.issues[0]?.path, "options.policy.maxAttempts");
        assert.isDefined(unsupported);
        assert(Result.isFailure(unsupported) && unsupported.failure instanceof EmailInvalidOptions);
        assert.strictEqual(unsupported.failure.issues[0]?.path, "options.<unsupported>");
        assert.notInclude(JSON.stringify(results), "private-");
      }).pipe(
        Effect.provide(
          loopsTransactionalLayer({ ...configuration, attachments: "Disabled" }).pipe(
            Layer.provide(
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("Unexpected invalid-request transport")),
              ),
            ),
          ),
        ),
      ),
  );

  it.effect(
    "starts each deadline only after its batch slot opens and does not replay either uncertain keyed job",
    () =>
      Effect.gen(function* deadlineQueuedLoopsJobs() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* sendSlowLoopsBatch() {
          const loops = yield* LoopsTransactionalEmail;

          return yield* loops.sendAll(
            [
              {
                job,
                options: {
                  idempotencyKey: "first",
                  policy: { ...policy, deadline: Duration.seconds(1) },
                },
              },
              {
                job,
                options: {
                  idempotencyKey: "second",
                  policy: { ...policy, deadline: Duration.seconds(2) },
                },
              },
            ],
            { concurrency: 1 },
          );
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer(configuration, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
            ),
          ),
          Effect.forkScoped,
        );

        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "first");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "second");
        yield* TestClock.adjust(Duration.seconds(1));
        assert.strictEqual(yield* Queue.size(fixture.closed), 0);
        yield* TestClock.adjust(Duration.seconds(1));
        const results = yield* Fiber.join(fiber);
        assert.strictEqual(results.length, 2);

        for (const result of results) {
          assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
          assert.strictEqual(result.failure.reason, "timeout");
        }

        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "caller interruption aborts every in-flight socket without starting a queued job or returning settled success",
    () =>
      Effect.gen(function* interruptLoopsBatch() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* sendInterruptedLoopsBatch() {
          return yield* (yield* LoopsTransactionalEmail).sendAll(
            ["first", "second", "queued"].map((key) => ({ job, options: { idempotencyKey: key } })),
            { concurrency: 2 },
          );
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer(configuration, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
            ),
          ),
          Effect.forkScoped,
        );

        const initial = [
          (yield* Queue.take(fixture.received)).idempotencyKey,
          (yield* Queue.take(fixture.received)).idempotencyKey,
        ];

        assert.deepStrictEqual(new Set(initial), new Set(["first", "second"]));
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live(
    "a transport defect remains a defect, cancels its active peer and never submits queued intent",
    () =>
      Effect.gen(function* preserveLoopsBatchDefect() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
        const fail = yield* Deferred.make<true>();

        const client = Layer.effect(
          HttpClient.HttpClient,
          Effect.gen(function* defectingLoopsClient() {
            const http = yield* HttpClient.HttpClient;

            return http.pipe(
              HttpClient.transform((response, request) =>
                request.headers["idempotency-key"] === "broken"
                  ? Deferred.await(fail).pipe(Effect.andThen(Effect.die("private-batch-defect")))
                  : response,
              ),
            );
          }),
        ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")));

        const trace = yield* startEmailTraceFixture();

        const fiber = yield* Effect.gen(function* sendDefectingLoopsBatch() {
          return yield* (yield* LoopsTransactionalEmail).sendAll(
            ["active", "broken", "queued"].map((key) => ({
              job,
              options: { idempotencyKey: key },
            })),
            { concurrency: 2 },
          );
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer(configuration, policy).pipe(Layer.provide(client)),
          ),
          Effect.provideService(Tracer.Tracer, trace.tracer),
          Effect.forkScoped,
        );

        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "active");
        yield* Deferred.succeed(fail, true);
        assert(Exit.hasDies(yield* Fiber.await(fiber)));
        assert.isTrue(yield* Queue.take(fixture.closed));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        assert.notInclude(yield* trace.diagnostics, "private-batch-defect");
      }),
  );

  it.live(
    "reuses a publicly decoded native request without changing variables or key identity",
    () =>
      Effect.gen(function* reuseParsedLoopsRequest() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const request = yield* Schema.decodeEffect(LoopsTransactionalRequestSchema)({
          job: { ...job, dataVariables: { value: 0 } },
          options: { idempotencyKey: "parsed-key" },
        });

        const results = yield* Effect.gen(function* sendParsedLoopsRequest() {
          return yield* (yield* LoopsTransactionalEmail).sendAll([request]);
        }).pipe(
          Effect.provide(
            loopsTransactionalLayer(configuration, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
            ),
          ),
        );

        assert.strictEqual(results.length, 1);
        assert(results.every(Result.isSuccess));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.idempotencyKey, "parsed-key");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({ dataVariables: Schema.Struct({ value: Schema.Finite }) }),
          ),
        )(sent.body);

        assert.strictEqual(wire.dataVariables.value, 0);
      }),
  );
});
