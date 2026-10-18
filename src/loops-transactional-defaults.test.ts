import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import { EmailConfigurationError } from "./email-configuration-error.js";
import { EmailDeliveryUnknown } from "./email-delivery-unknown.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { EmailInvalidOptions } from "./email-invalid-options.js";
import { EmailRejected } from "./email-rejected.js";
import { defaultedLoopsTransactionalLayer } from "./loops-transactional-defaults.js";
import type { LoopsTransactionalDefaultsInput } from "./loops-transactional-defaults.js";
import { LoopsTransactionalEmail, loopsTransactionalLayer } from "./loops-transactional-email.js";

const job = {
  email: "recipient@fictional.invalid",
  transactionalId: "fictional_template",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const configuration = {
  apiKey: Redacted.make("private-defaults-provider-key"),
  attachments: "AccountEnabled",
  templateAuthority: "ProviderManaged",
} as const;

const fixtureLoopsLayer = (fixture: EmailHttpFixture) =>
  loopsTransactionalLayer(configuration, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.loops.so")),
  );

const parseWire = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

describe("owned native Loops defaults", () => {
  it.live(
    "previews without transport and sends operation-winning variables and unchanged native intent",
    () =>
      Effect.gen(function* inspectDefaultedLoopsWire() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const input = {
          ...job,
          attachments: [
            { contentBase64: "AQID", contentType: "application/pdf", filename: "file.pdf" },
          ],
          dataVariables: { empty: "", items: [{ amount: 0 }], zero: 0 },
        } as const;

        const layer = defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
          dataVariables: {
            empty: "default",
            items: [{ title: "default row" }],
            retained: "default",
            zero: 42,
          },
          idempotencyKeyPrefix: "application/",
        });

        const preview = yield* Effect.gen(function* previewThenSendDefaultedLoops() {
          const loops = yield* LoopsTransactionalEmail;
          const prepared = yield* loops.validate(input, { idempotencyKey: "event" });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert(Object.isFrozen(prepared));
          assert(Object.isFrozen(prepared.dataVariables));
          const items = prepared.dataVariables?.items;
          assert(Arr.isArray(items));
          assert(Object.isFrozen(items));
          assert(Object.isFrozen(items[0]));
          const receipt = yield* loops.send(input, { idempotencyKey: "event" });
          assert.strictEqual(receipt._tag, "Accepted");

          return prepared;
        }).pipe(Effect.provide(layer));

        assert.deepStrictEqual(preview.dataVariables, {
          empty: "",
          items: [{ amount: 0 }],
          retained: "default",
          zero: 0,
        });
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.idempotencyKey, "application/event");
        const variables = preview.dataVariables;
        assert.isDefined(variables);
        assert.deepStrictEqual(yield* parseWire(sent.body), {
          addToAudience: false,
          attachments: [{ contentType: "application/pdf", data: "AQID", filename: "file.pdf" }],
          dataVariables: variables,
          email: job.email,
          transactionalId: job.transactionalId,
        });
      }).pipe(Effect.scoped),
  );

  it.live.prop(
    "preserves generated caller overrides and escaped defaults through the real native wire",
    {
      characters: Schema.Array(Schema.Literals(["a", "Z", "0", "&", "<", "é", '"', "\\"])).check(
        Schema.isMaxLength(20),
      ),
    },
    ({ characters }) =>
      Effect.gen(function* inspectGeneratedLoopsDefaults() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        const value = characters.join("");
        yield* Effect.gen(function* sendGeneratedDefaultedLoops() {
          const loops = yield* LoopsTransactionalEmail;
          yield* loops.send({ ...job, dataVariables: { collision: value } });
        }).pipe(
          Effect.provide(
            defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
              dataVariables: { collision: "discarded default", retained: value },
            }),
          ),
        );
        assert.deepStrictEqual(yield* parseWire((yield* Queue.take(fixture.received)).body), {
          addToAudience: false,
          dataVariables: { collision: value, retained: value },
          email: job.email,
          transactionalId: job.transactionalId,
        });
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 12 } },
  );

  it.live(
    "composes outer defaults before inner defaults without re-prefixing the validation preview",
    () =>
      Effect.gen(function* inspectNestedLoopsDefaults() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const inner = defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
          dataVariables: { collision: "inner", inner: "retained", operation: "inner" },
          idempotencyKeyPrefix: "inner/",
        });

        const outer = defaultedLoopsTransactionalLayer(inner, {
          dataVariables: { collision: "outer", operation: "outer", outer: "retained" },
          idempotencyKeyPrefix: "outer/",
        });

        const preview = yield* Effect.gen(function* sendNestedDefaultedLoops() {
          const loops = yield* LoopsTransactionalEmail;
          const input = { ...job, dataVariables: { operation: "caller" } };
          const prepared = yield* loops.validate(input, { idempotencyKey: "event" });
          yield* loops.send(input, { idempotencyKey: "event" });

          return prepared;
        }).pipe(Effect.provide(outer));

        assert.deepStrictEqual(preview.dataVariables, {
          collision: "outer",
          inner: "retained",
          operation: "caller",
          outer: "retained",
        });
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.idempotencyKey, "inner/outer/event");
        assert.deepStrictEqual(yield* parseWire(sent.body), { addToAudience: false, ...preview });
      }).pipe(Effect.scoped),
  );

  it.live("owns nested defaults at acquisition without freezing caller-owned records or rows", () =>
    Effect.gen(function* inspectLoopsDefaultsOwnership() {
      const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
      const row = { title: "original private row" };

      const defaults = {
        dataVariables: { application: "original private application", items: [row] as const },
        idempotencyKeyPrefix: "original/",
      };

      yield* Effect.gen(function* mutateAcquiredLoopsDefaults() {
        const loops = yield* LoopsTransactionalEmail;
        row.title = "changed";
        defaults.dataVariables.application = "changed";
        defaults.idempotencyKeyPrefix = "changed/";
        assert.strictEqual(row.title, "changed");
        yield* loops.send(job, { idempotencyKey: "event" });
      }).pipe(
        Effect.provide(defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), defaults)),
      );
      const sent = yield* Queue.take(fixture.received);
      assert.strictEqual(sent.idempotencyKey, "original/event");
      assert.deepStrictEqual(yield* parseWire(sent.body), {
        addToAudience: false,
        ...job,
        dataVariables: {
          application: "original private application",
          items: [{ title: "original private row" }],
        },
      });
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { defaults: { idempotencyKeyPrefix: "private invalid prefix" } },
    { defaults: { dataVariables: { "private-invalid-variable!": "private value" } } },
    { defaults: { dataVariables: { name: "x".repeat(499) } } },
    {
      defaults: {
        dataVariables: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`value-${index}`, 1]),
        ),
      },
    },
  ])("refuses invalid configuration before acquiring the supplied native service", ({ defaults }) =>
    Effect.gen(function* inspectLoopsDefaultsAcquisitionFence() {
      const acquisitions = yield* Ref.make(0);

      const supplied = Layer.effect(
        LoopsTransactionalEmail,
        Ref.update(acquisitions, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("unexpected acquisition")),
        ),
      );

      const error = yield* LoopsTransactionalEmail.pipe(
        Effect.provide(defaultedLoopsTransactionalLayer(supplied, defaults)),
        Effect.flip,
      );

      assert(error instanceof EmailConfigurationError);
      assert.strictEqual(yield* Ref.get(acquisitions), 0);
      const diagnostic = JSON.stringify(error);
      assert.notInclude(diagnostic, "private invalid prefix");
      assert.notInclude(diagnostic, "private-invalid-variable!");
      assert.notInclude(diagnostic, "private value");
    }),
  );

  it.effect(
    "refuses unknown default fields instead of acquiring template or shared-key authority",
    () =>
      Effect.gen(function* inspectUnexpectedLoopsDefaults() {
        const defaults = { dataVariables: { name: "private value" } };
        Reflect.set(defaults, "transactionalId", "private_template_selector");
        Reflect.set(defaults, "idempotencyKey", "private_shared_key");

        const supplied = Layer.effect(
          LoopsTransactionalEmail,
          Effect.die("unexpected acquisition"),
        );

        const error = yield* LoopsTransactionalEmail.pipe(
          Effect.provide(defaultedLoopsTransactionalLayer(supplied, defaults)),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private_template_selector");
        assert.notInclude(JSON.stringify(error), "private_shared_key");
      }),
  );

  it.live(
    "does not generate a key and always prepends even to already-prefixed logical spellings",
    () =>
      Effect.gen(function* inspectLiteralLoopsPrefix() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        yield* Effect.gen(function* sendDistinctDefaultedLoopsKeys() {
          const loops = yield* LoopsTransactionalEmail;
          yield* loops.send(job, { idempotencyKey: "application/event" });
          yield* loops.send(job);
        }).pipe(
          Effect.provide(
            defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
              idempotencyKeyPrefix: "application/",
            }),
          ),
        );
        assert.strictEqual(
          (yield* Queue.take(fixture.received)).idempotencyKey,
          "application/application/event",
        );
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "");
      }).pipe(Effect.scoped),
  );

  it.live.each([
    { failure: EmailRejected, keyLength: 1, prefixLength: 100 },
    { failure: EmailInvalidOptions, keyLength: 90, prefixLength: 200 },
  ])(
    "preflights effective native and common key limits without transport",
    ({ prefixLength, keyLength, failure }) =>
      Effect.gen(function* inspectDefaultedLoopsKeyBudgets() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

        const error = yield* Effect.gen(function* refuseDefaultedLoopsKey() {
          return yield* (yield* LoopsTransactionalEmail)
            .send(job, { idempotencyKey: "k".repeat(keyLength) })
            .pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
              idempotencyKeyPrefix: "p".repeat(prefixLength),
            }),
          ),
        );

        assert(error instanceof failure);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.scoped),
  );

  it.live(
    "rejects invalid original options and selected fields before defaults could make them valid",
    () =>
      Effect.gen(function* inspectOriginalLoopsIntent() {
        const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
        yield* Effect.gen(function* refuseMalformedDefaultedLoopsInput() {
          const loops = yield* LoopsTransactionalEmail;
          assert(
            (yield* loops.send(job, { idempotencyKey: "" }).pipe(Effect.flip)) instanceof
              EmailInvalidOptions,
          );
          const input = { ...job };
          Reflect.set(input, "private-unrecognized-field", "private selected value");
          const invalid = yield* loops.send(input).pipe(Effect.flip);
          assert(invalid instanceof EmailInvalidMessage);
          assert.notInclude(JSON.stringify(invalid), "private selected value");
          assert.notInclude(JSON.stringify(invalid), "private-unrecognized-field");
        }).pipe(
          Effect.provide(
            defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
              idempotencyKeyPrefix: "application/",
            }),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.scoped),
  );

  it.live("enforces merged variable-name and complete scalar budgets before transport", () =>
    Effect.gen(function* inspectMergedLoopsVariableBudgets() {
      const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });

      const variables = Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [`operation-${index}`, 0]),
      );

      const nameError = yield* Effect.gen(function* refuseMergedLoopsNames() {
        return yield* (yield* LoopsTransactionalEmail)
          .send({ ...job, dataVariables: variables })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
            dataVariables: { default: 1 },
          }),
        ),
      );

      assert(nameError instanceof EmailInvalidMessage);

      const row = Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`field-${index}`, 0]),
      );

      const defaults: LoopsTransactionalDefaultsInput = {
        dataVariables: { items: [row, ...Array.from({ length: 49 }, () => row)] },
      };

      const scalarError = yield* Effect.gen(function* refuseMergedLoopsScalars() {
        return yield* (yield* LoopsTransactionalEmail)
          .send({
            ...job,
            dataVariables: Object.fromEntries(
              Array.from({ length: 25 }, (_, index) => [`extra-${index}`, 1]),
            ),
          })
          .pipe(Effect.flip);
      }).pipe(
        Effect.provide(defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), defaults)),
      );

      assert(scalarError instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }).pipe(Effect.scoped),
  );

  it.live("owns the entire batch before transport and keeps ordered qualified item failures", () =>
    Effect.gen(function* inspectQueuedLoopsDefaultsOwnership() {
      const fixture = yield* startEmailHttpFixture({
        body: "",
        hold: true,
        next: { body: '{"success":true}', status: 200 },
        status: 200,
      });

      const defaults = {
        dataVariables: { retained: "original default" },
        idempotencyKeyPrefix: "application/",
      };

      const queued = { ...job, dataVariables: { caller: "original queued" } };

      const fiber = yield* Effect.gen(function* submitDefaultedLoopsBatch() {
        return yield* (yield* LoopsTransactionalEmail).sendAll(
          [
            { job, options: { idempotencyKey: "first" } },
            {
              job: {
                ...job,
                dataVariables: Object.fromEntries(
                  Array.from({ length: 64 }, (_, index) => [`value-${index}`, 0]),
                ),
              },
            },
            { job: queued, options: { idempotencyKey: "queued" } },
          ],
          { concurrency: 1 },
        );
      }).pipe(
        Effect.provide(defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), defaults)),
        Effect.forkChild,
      );

      yield* Queue.take(fixture.received);
      queued.dataVariables.caller = "changed queued";
      defaults.dataVariables.retained = "changed default";
      defaults.idempotencyKeyPrefix = "changed/";
      fixture.server.closeAllConnections();
      const results = yield* Fiber.join(fiber);
      const [first, invalid, last] = results;
      assert.isDefined(first);
      assert.isDefined(invalid);
      assert.isDefined(last);
      assert(Result.isFailure(first));
      assert(first.failure instanceof EmailDeliveryUnknown);
      assert(Result.isFailure(invalid));
      assert(invalid.failure instanceof EmailInvalidMessage);
      assert(invalid.failure.issues.every((issue) => issue.path.startsWith("job")));
      assert(Result.isSuccess(last));
      const sent = yield* Queue.take(fixture.received);
      assert.strictEqual(sent.idempotencyKey, "application/queued");
      assert.deepStrictEqual(yield* parseWire(sent.body), {
        addToAudience: false,
        ...job,
        dataVariables: { caller: "original queued", retained: "original default" },
      });
      assert.deepStrictEqual(
        yield* Effect.gen(function* emptyDefaultedLoopsBatch() {
          return yield* (yield* LoopsTransactionalEmail).sendAll([]);
        }).pipe(Effect.provide(defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {}))),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "retains an operation deadline and aborts a held native socket without uncertain replay",
    () =>
      Effect.gen(function* inspectDefaultedLoopsDeadline() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* waitForDefaultedLoopsDeadline() {
          const loops = yield* LoopsTransactionalEmail;

          return yield* loops
            .send(job, {
              idempotencyKey: "event",
              policy: { ...policy, deadline: Duration.seconds(1) },
            })
            .pipe(Effect.result);
        }).pipe(
          Effect.provide(
            defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
              idempotencyKeyPrefix: "application/",
            }),
          ),
          Effect.forkChild,
        );

        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.idempotencyKey, "application/event");
        yield* TestClock.adjust(Duration.seconds(1));
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "timeout");
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }).pipe(Effect.scoped),
  );

  it.live("preserves interruption and closes active transport without starting a queued job", () =>
    Effect.gen(function* interruptDefaultedLoopsBatch() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

      const fiber = yield* Effect.gen(function* sendInterruptibleDefaultedLoops() {
        return yield* (yield* LoopsTransactionalEmail).sendAll([{ job }, { job }], {
          concurrency: 1,
        });
      }).pipe(
        Effect.provide(
          defaultedLoopsTransactionalLayer(fixtureLoopsLayer(fixture), {
            dataVariables: { private: "private value" },
          }),
        ),
        Effect.forkChild,
      );

      yield* Queue.take(fixture.received);
      yield* Fiber.interrupt(fiber);
      assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
      assert.strictEqual(yield* Queue.take(fixture.closed), true);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }).pipe(Effect.scoped),
  );

  it.live("preserves native defects and releases the supplied Layer exactly once", () =>
    Effect.gen(function* inspectDefaultedLoopsDefectAndLifetime() {
      const fixture = yield* startEmailHttpFixture({ body: '{"success":true}', status: 200 });
      const trace = yield* startEmailTraceFixture();
      const acquisitions = yield* Ref.make(0);
      const releases = yield* Ref.make(0);

      const lifecycle = Layer.effectDiscard(
        Effect.acquireRelease(
          Ref.update(acquisitions, (count) => count + 1),
          () => Ref.update(releases, (count) => count + 1),
        ),
      );

      const defecting = Layer.effect(
        LoopsTransactionalEmail,
        Effect.gen(function* acquireDefectingLoopsService() {
          const native = yield* LoopsTransactionalEmail;

          return LoopsTransactionalEmail.of({
            ...native,
            send: () => Effect.die("private native defect"),
          });
        }),
      ).pipe(Layer.provide(fixtureLoopsLayer(fixture)), Layer.provide(lifecycle));

      const exit = yield* Effect.gen(function* sendDefectingDefaultedLoops() {
        return yield* (yield* LoopsTransactionalEmail).sendAll([{ job }]);
      }).pipe(
        Effect.provide(
          defaultedLoopsTransactionalLayer(defecting, {
            dataVariables: { name: "private variable" },
          }),
        ),
        Effect.withTracer(trace.tracer),
        Effect.exit,
      );

      assert(Exit.hasDies(exit));
      assert.strictEqual(yield* Ref.get(acquisitions), 1);
      assert.strictEqual(yield* Ref.get(releases), 1);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
      assert.notInclude(yield* trace.diagnostics, "private native defect");
    }).pipe(Effect.scoped),
  );

  it.live(
    "preserves forwarding authority and excludes private defaults, keys and native errors from SDK spans",
    () =>
      Effect.gen(function* inspectDefaultedLoopsPrivacyAndReplay() {
        const trace = yield* startEmailTraceFixture();

        const fixture = yield* startEmailHttpFixture({
          body: '{"private":"private response"}',
          status: 503,
        });

        yield* Effect.gen(function* inspectCapturedLoopsAuthority() {
          const base = yield* LoopsTransactionalEmail;
          yield* Effect.gen(function* sendUncertainDefaultedLoops() {
            const loops = yield* LoopsTransactionalEmail;
            assert.strictEqual(loops.idempotency, base.idempotency);
            assert.strictEqual(loops.idempotency._tag, "KeyForwarding");

            const error = yield* loops
              .send(job, { idempotencyKey: "private-event" })
              .pipe(Effect.flip);

            assert(error instanceof EmailDeliveryUnknown);
          }).pipe(
            Effect.provide(
              defaultedLoopsTransactionalLayer(Layer.succeed(LoopsTransactionalEmail, base), {
                dataVariables: { private: "private variable" },
                idempotencyKeyPrefix: "private-prefix/",
              }),
            ),
          );
        }).pipe(Effect.provide(fixtureLoopsLayer(fixture)), Effect.withTracer(trace.tracer));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.idempotencyKey, "private-prefix/private-event");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const spans = yield* trace.diagnostics;
        assert.include(spans, "DefaultedLoopsTransactionalEmail.send");

        for (const value of [
          "private-defaults-provider-key",
          "private variable",
          "private-prefix",
          "private-event",
          "private response",
          job.email,
          job.transactionalId,
        ]) {
          assert.notInclude(spans, value);
        }
      }).pipe(Effect.scoped),
  );
});
