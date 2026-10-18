import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  DateTime,
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
import { defaultedIterableCampaignLayer } from "./iterable-campaign-defaults.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "./iterable-campaign-email.js";

const job = { campaignId: 123, recipientEmail: "recipient@fictional.invalid" } as const;

const configuration = {
  apiKey: Redacted.make("private-iterable-defaults-key"),
  campaignAuthority: "AuthorizeProviderManagedCampaign",
  contactWrites: "AuthorizeProfileCreation",
  dataRetention: "AuthorizePersistedSendData",
  projectIdentity: "EmailBased",
  region: "US",
  tracking: "AuthorizeCampaignTracking",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 3,
};

const reply = { body: '{"code":"Success","msg":"private acknowledgement"}', status: 200 };

const fixtureIterableLayer = (fixture: EmailHttpFixture) =>
  iterableCampaignLayer(configuration, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.iterable.com")),
  );

const parseWire = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));

describe("owned native Iterable defaults", () => {
  it.effect(
    "previews without HTTP and sends shallow operation-winning values with unchanged campaign identity and scheduling",
    () =>
      Effect.gen(function* inspectDefaultedIterableWire() {
        yield* TestClock.setTime(0);
        const fixture = yield* startEmailHttpFixture(reply);

        const input = {
          ...job,
          dataFields: { empty: "", enabled: false, items: [], nullable: null, zero: 0 },
          metadata: { override: "" },
          sendAt: "1970-01-01T00:01:00Z",
        };

        const preview = yield* Effect.gen(function* previewAndSendDefaultedIterable() {
          const iterable = yield* IterableCampaignEmail;
          const prepared = yield* iterable.validate(input);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          assert(
            Object.isFrozen(prepared) &&
              Object.isFrozen(prepared.dataFields) &&
              Object.isFrozen(prepared.metadata),
          );
          const items = prepared.dataFields?.items;
          assert(Arr.isArray(items) && Object.isFrozen(items));
          assert.isDefined(prepared.sendAt);
          assert.strictEqual(DateTime.formatIso(prepared.sendAt), "1970-01-01T00:01:00.000Z");
          assert.strictEqual((yield* iterable.send(input))._tag, "Accepted");

          return prepared;
        }).pipe(
          Effect.provide(
            defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {
              dataFields: {
                empty: "default",
                enabled: true,
                items: ["default"],
                nullable: "default",
                retained: "private default",
                zero: 99,
              },
              metadata: { override: "default", retained: "private metadata" },
            }),
          ),
        );

        assert.deepStrictEqual(preview.dataFields, {
          empty: "",
          enabled: false,
          items: [],
          nullable: null,
          retained: "private default",
          zero: 0,
        });
        const wire = yield* Queue.take(fixture.received);
        assert.strictEqual(wire.path, "/api/email/target");
        assert.strictEqual(wire.apiKey, "private-iterable-defaults-key");
        assert.deepStrictEqual<unknown>(yield* parseWire(wire.body), {
          ...job,
          allowRepeatMarketingSends: false,
          dataFields: preview.dataFields,
          metadata: { override: "", retained: "private metadata" },
          sendAt: "1970-01-01 00:01:00",
        });
      }),
  );

  it.effect.prop(
    "preserves generated escaped overrides and complete array replacement through native HTTP",
    {
      characters: Schema.Array(Schema.Literals(["a", "Z", "0", "é", "🦉", '"', "\\", "\n"])).check(
        Schema.isMaxLength(20),
      ),
    },
    ({ characters }) =>
      Effect.gen(function* sendGeneratedIterableDefaults() {
        const value = characters.join("");
        const fixture = yield* startEmailHttpFixture(reply);
        yield* Effect.gen(function* submitGeneratedIterableDefaults() {
          yield* (yield* IterableCampaignEmail).send({
            ...job,
            dataFields: { collision: value, items: [value] },
            metadata: { collision: value },
          });
        }).pipe(
          Effect.provide(
            defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {
              dataFields: { collision: "discarded", items: [null, false, 0], retained: value },
              metadata: { collision: "discarded", retained: value },
            }),
          ),
        );
        assert.deepStrictEqual(yield* parseWire((yield* Queue.take(fixture.received)).body), {
          ...job,
          allowRepeatMarketingSends: false,
          dataFields: { collision: value, items: [value], retained: value },
          metadata: { collision: value, retained: value },
        });
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect("composes outer defaults before inner defaults while operations beat both", () =>
    Effect.gen(function* composeIterableDefaults() {
      const fixture = yield* startEmailHttpFixture(reply);

      const inner = defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {
        dataFields: { collision: "inner", inner: true, operation: "inner" },
        metadata: { collision: "inner", inner: "retained", operation: "inner" },
      });

      const outer = defaultedIterableCampaignLayer(inner, {
        dataFields: { collision: "outer", operation: "outer", outer: true },
        metadata: { collision: "outer", operation: "outer", outer: "retained" },
      });

      const preview = yield* Effect.gen(function* sendNestedIterableDefaults() {
        const iterable = yield* IterableCampaignEmail;

        const input = {
          ...job,
          dataFields: { operation: false },
          metadata: { operation: "caller" },
        };

        const prepared = yield* iterable.validate(input);
        yield* iterable.send(input);

        return prepared;
      }).pipe(Effect.provide(outer));

      assert.deepStrictEqual(preview.dataFields, {
        collision: "outer",
        inner: true,
        operation: false,
        outer: true,
      });
      assert.deepStrictEqual(preview.metadata, {
        collision: "outer",
        inner: "retained",
        operation: "caller",
        outer: "retained",
      });
      assert.deepStrictEqual<unknown>(
        yield* parseWire((yield* Queue.take(fixture.received)).body),
        {
          ...preview,
          allowRepeatMarketingSends: false,
        },
      );
    }),
  );

  it.effect(
    "detaches defaults at acquisition without freezing caller-owned arrays or metadata",
    () =>
      Effect.gen(function* ownIterableDefaultsAtAcquisition() {
        const fixture = yield* startEmailHttpFixture(reply);

        const defaults = {
          dataFields: { items: ["original"], retained: "original" },
          metadata: { retained: "original" },
        };

        yield* Effect.gen(function* mutateAcquiredIterableDefaults() {
          const iterable = yield* IterableCampaignEmail;
          defaults.dataFields.items[0] = "changed";
          defaults.dataFields.retained = "changed";
          defaults.metadata.retained = "changed";
          yield* iterable.send(job);
        }).pipe(
          Effect.provide(defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), defaults)),
        );
        assert.strictEqual(defaults.dataFields.items[0], "changed");
        assert.deepStrictEqual(yield* parseWire((yield* Queue.take(fixture.received)).body), {
          ...job,
          allowRepeatMarketingSends: false,
          dataFields: { items: ["original"], retained: "original" },
          metadata: { retained: "original" },
        });
      }),
  );

  it.effect.each([
    { defaults: { dataFields: { "private-invalid!": "private value" } } },
    { defaults: { dataFields: { items: Array.from({ length: 51 }, () => false) } } },
    {
      defaults: {
        dataFields: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`field${index}`, 0]),
        ),
      },
    },
    {
      defaults: {
        metadata: Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`field${index}`, "private value"]),
        ),
      },
    },
  ])("refuses invalid native configuration before base acquisition", ({ defaults }) =>
    Effect.gen(function* refuseInvalidIterableDefaults() {
      const acquisitions = yield* Ref.make(0);

      const supplied = Layer.effect(
        IterableCampaignEmail,
        Ref.update(acquisitions, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("unexpected acquisition")),
        ),
      );

      const error = yield* IterableCampaignEmail.pipe(
        Effect.provide(defaultedIterableCampaignLayer(supplied, defaults)),
        Effect.flip,
      );

      assert(error instanceof EmailConfigurationError);
      assert.strictEqual(yield* Ref.get(acquisitions), 0);
      assert.notInclude(JSON.stringify(error), "private-invalid!");
      assert.notInclude(JSON.stringify(error), "private value");
    }),
  );

  it.effect(
    "does not acquire campaign selectors, shared keys or policy defaults through excess configuration",
    () =>
      Effect.gen(function* refuseIterableDefaultsAuthority() {
        const defaults = { dataFields: { retained: true } };
        Reflect.set(defaults, "campaignId", 999);
        Reflect.set(defaults, "idempotencyKeyPrefix", "private prefix");
        const supplied = Layer.effect(IterableCampaignEmail, Effect.die("unexpected acquisition"));

        const error = yield* IterableCampaignEmail.pipe(
          Effect.provide(defaultedIterableCampaignLayer(supplied, defaults)),
          Effect.flip,
        );

        assert(error instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(error), "private prefix");
      }),
  );

  it.effect.each([
    {
      defaults: { dataFields: { retained: 0 } },
      input: {
        dataFields: Object.fromEntries(
          Array.from({ length: 64 }, (_, index) => [`field${index}`, 0]),
        ),
      },
    },
    {
      defaults: { metadata: { retained: "default" } },
      input: {
        metadata: Object.fromEntries(
          Array.from({ length: 32 }, (_, index) => [`field${index}`, "caller"]),
        ),
      },
    },
    {
      defaults: {
        dataFields: Object.fromEntries(
          Array.from({ length: 4 }, (_, index) => [`default${index}`, "x".repeat(10_000)]),
        ),
      },
      input: {
        dataFields: Object.fromEntries(
          Array.from({ length: 3 }, (_, index) => [`caller${index}`, "x".repeat(10_000)]),
        ),
      },
    },
  ])(
    "preflights combined field, metadata and native UTF-8 budgets before transport",
    ({ defaults, input }) =>
      Effect.gen(function* refuseMergedIterableBudgets() {
        const fixture = yield* startEmailHttpFixture(reply);

        const error = yield* Effect.gen(function* submitOverBudgetIterableDefaults() {
          return yield* (yield* IterableCampaignEmail).send({ ...job, ...input });
        }).pipe(
          Effect.provide(defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), defaults)),
          Effect.flip,
        );

        assert(error instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "validates original selected values and options rather than rescuing them with defaults",
    () =>
      Effect.gen(function* refuseOriginalIterableDefaultsInput() {
        const fixture = yield* startEmailHttpFixture(reply);
        yield* Effect.gen(function* preflightOriginalIterableInputs() {
          const iterable = yield* IterableCampaignEmail;
          const input = { ...job, dataFields: { selected: "valid" } };
          Reflect.set(input.dataFields, "selected", { nested: "private selected value" });
          const invalid = yield* iterable.send(input).pipe(Effect.flip);
          assert(invalid instanceof EmailInvalidMessage);
          assert.notInclude(JSON.stringify(invalid), "private selected value");
          assert(
            (yield* iterable.send(job, { idempotencyKey: "" }).pipe(Effect.flip)) instanceof
              EmailInvalidOptions,
          );

          const key = yield* iterable
            .send(job, { idempotencyKey: "private-key" })
            .pipe(Effect.flip);

          assert(key instanceof EmailRejected);
          assert.strictEqual(key.reason, "unsupported-idempotency");
          assert(
            (yield* iterable
              .send({ ...job, recipientEmail: "UPPER@fictional.invalid" })
              .pipe(Effect.flip)) instanceof EmailInvalidMessage,
          );
          assert(
            (yield* iterable
              .send({ ...job, sendAt: "1970-01-01T00:00:00Z" })
              .pipe(Effect.flip)) instanceof EmailInvalidMessage,
          );
        }).pipe(
          Effect.provide(
            defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {
              dataFields: { selected: "default" },
            }),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect(
    "owns the whole queued batch before HTTP and preserves ordered qualified failures and per-item policies",
    () =>
      Effect.gen(function* ownQueuedIterableDefaults() {
        const fixture = yield* startEmailHttpFixture({
          body: "",
          hold: true,
          next: reply,
          status: 200,
        });

        const defaults = { dataFields: { retained: "original default" } };

        const queued = {
          ...job,
          dataFields: { items: ["original queued"] },
          metadata: { retained: "original queued" },
        };

        const queuedPolicy = { ...policy, maxAttempts: 1 };

        const fiber = yield* Effect.gen(function* sendQueuedIterableDefaults() {
          return yield* (yield* IterableCampaignEmail).sendAll(
            [
              { job },
              {
                job: {
                  ...job,
                  dataFields: Object.fromEntries(
                    Array.from({ length: 64 }, (_, index) => [`field${index}`, 0]),
                  ),
                },
              },
              { job: queued, options: { policy: queuedPolicy } },
            ],
            { concurrency: 1 },
          );
        }).pipe(
          Effect.provide(defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), defaults)),
          Effect.forkChild,
        );

        yield* Queue.take(fixture.received);
        defaults.dataFields.retained = "changed";
        queued.dataFields.items[0] = "changed";
        queued.metadata.retained = "changed";
        queuedPolicy.maxAttempts = 0;
        fixture.server.closeAllConnections();
        const [first, invalid, last] = yield* Fiber.join(fiber);
        assert.isDefined(first);
        assert.isDefined(invalid);
        assert.isDefined(last);
        assert(Result.isFailure(first) && first.failure instanceof EmailDeliveryUnknown);
        assert(Result.isFailure(invalid) && invalid.failure instanceof EmailInvalidMessage);
        assert(invalid.failure.issues.every((issue) => issue.path.startsWith("job.")));
        assert(Result.isSuccess(last));
        assert.deepStrictEqual(yield* parseWire((yield* Queue.take(fixture.received)).body), {
          ...job,
          allowRepeatMarketingSends: false,
          dataFields: { items: ["original queued"], retained: "original default" },
          metadata: { retained: "original queued" },
        });
      }),
  );

  it.effect("retains operation deadlines and cancels active native transport without replay", () =>
    Effect.gen(function* deadlineDefaultedIterable() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

      const fiber = yield* Effect.gen(function* sendTimedIterableDefaults() {
        return yield* (yield* IterableCampaignEmail)
          .send(job, { policy: { ...policy, deadline: Duration.seconds(1) } })
          .pipe(Effect.result);
      }).pipe(
        Effect.provide(
          defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {
            dataFields: { private: true },
          }),
        ),
        Effect.forkChild,
      );

      yield* Queue.take(fixture.received);
      yield* TestClock.adjust(Duration.seconds(1));
      const result = yield* Fiber.join(fiber);
      assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(result.failure.reason, "timeout");
      assert.strictEqual(yield* Queue.take(fixture.closed), true);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect(
    "preserves interruption and does not start a queued native job after cancellation",
    () =>
      Effect.gen(function* interruptDefaultedIterableBatch() {
        const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });

        const fiber = yield* Effect.gen(function* sendInterruptibleIterableDefaults() {
          return yield* (yield* IterableCampaignEmail).sendAll([{ job }, { job }], {
            concurrency: 1,
          });
        }).pipe(
          Effect.provide(defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {})),
          Effect.forkChild,
        );

        yield* Queue.take(fixture.received);
        yield* Fiber.interrupt(fiber);
        assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
        assert.strictEqual(yield* Queue.take(fixture.closed), true);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect("preserves native defects and acquires/releases the supplied resource once", () =>
    Effect.gen(function* preserveIterableDefaultsLifetime() {
      const fixture = yield* startEmailHttpFixture(reply);
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
        IterableCampaignEmail,
        Effect.gen(function* acquireDefectingIterable() {
          const native = yield* IterableCampaignEmail;

          return IterableCampaignEmail.of({
            ...native,
            send: () => Effect.die("private native defect"),
          });
        }),
      ).pipe(Layer.provide(fixtureIterableLayer(fixture)), Layer.provide(lifecycle));

      const exit = yield* Effect.gen(function* sendDefectingIterableDefaults() {
        return yield* (yield* IterableCampaignEmail).sendAll([{ job }]);
      }).pipe(
        Effect.provide(
          defaultedIterableCampaignLayer(defecting, { metadata: { private: "private metadata" } }),
        ),
        Effect.withTracer(trace.tracer),
        Effect.exit,
      );

      assert(Exit.hasDies(exit));
      assert.strictEqual(yield* Ref.get(acquisitions), 1);
      assert.strictEqual(yield* Ref.get(releases), 1);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
      assert.notInclude(yield* trace.diagnostics, "private native defect");
    }),
  );

  it.effect(
    "retains None replay authority and keeps private defaults and provider prose out of SDK spans",
    () =>
      Effect.gen(function* preserveIterableDefaultsPrivacy() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"private":"private provider response"}',
          status: 503,
        });

        const trace = yield* startEmailTraceFixture();
        yield* Effect.gen(function* sendUncertainIterableDefaults() {
          const iterable = yield* IterableCampaignEmail;
          assert.strictEqual(iterable.idempotency._tag, "None");
          const failure = yield* iterable.send(job).pipe(Effect.flip);
          assert(failure instanceof EmailDeliveryUnknown);
        }).pipe(
          Effect.provide(
            defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {
              dataFields: { private: "private variable" },
              metadata: { private: "private metadata" },
            }),
          ),
          Effect.withTracer(trace.tracer),
        );
        yield* Queue.take(fixture.received);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "DefaultedIterableCampaignEmail.send");

        for (const value of [
          "private-iterable-defaults-key",
          "private variable",
          "private metadata",
          "private provider response",
          job.recipientEmail,
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );

  it.effect("keeps absent fields absent and validates empty batch options without transport", () =>
    Effect.gen(function* preserveEmptyIterableDefaults() {
      const fixture = yield* startEmailHttpFixture(reply);
      yield* Effect.gen(function* validateEmptyIterableDefaults() {
        const iterable = yield* IterableCampaignEmail;
        const preview = yield* iterable.validate(job);
        assert.notProperty(preview, "dataFields");
        assert.notProperty(preview, "metadata");
        assert.deepStrictEqual(yield* iterable.sendAll([]), []);
        assert(
          (yield* iterable.sendAll([], { concurrency: 0 }).pipe(Effect.flip)) instanceof
            EmailInvalidOptions,
        );
      }).pipe(Effect.provide(defaultedIterableCampaignLayer(fixtureIterableLayer(fixture), {})));
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
