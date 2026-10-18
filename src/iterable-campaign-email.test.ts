import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailInvalidOptions,
  EmailRejected,
} from "./index.js";
import { IterableCampaignEmail, iterableCampaignLayer } from "./iterable-campaign-email.js";

const options = {
  apiKey: Redacted.make("fictional-iterable-key"),
  campaignAuthority: "AuthorizeProviderManagedCampaign",
  contactWrites: "AuthorizeProfileCreation",
  dataRetention: "AuthorizePersistedSendData",
  projectIdentity: "EmailBased",
  region: "US",
  tracking: "AuthorizeCampaignTracking",
} as const;

const job = {
  campaignId: 123,
  dataFields: { count: 0, enabled: false, firstName: "Fictional", items: ["one", "two"] },
  recipientEmail: "recipient@example.test",
} as const;

const acknowledgement = { code: "Success", msg: "private-provider-description" };

const fixtureLayer = (fixture: EmailHttpFixture) =>
  iterableCampaignLayer(options).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.iterable.com")),
  );

const send = Effect.gen(function* submitFictionalIterable() {
  return yield* (yield* IterableCampaignEmail).send(job);
});

describe("Iterable explicit native campaign jobs", () => {
  it.live(
    "an explicit retry observer never upgrades an uncertain unkeyed campaign submission",
    () =>
      Effect.gen(function* preserveObservedIterableReplayAuthority() {
        const fixture = yield* startEmailHttpFixture({
          body: '{"msg":"private-provider-description"}',
          status: 503,
        });

        const notifications = yield* Ref.make(0);
        const restrictions = yield* Ref.make(0);

        const result = yield* send.pipe(
          Effect.provide(
            iterableCampaignLayer(
              options,
              undefined,
              () => Ref.update(notifications, (count) => count + 1),
              () => Ref.update(restrictions, (count) => count + 1).pipe(Effect.as(true)),
            ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.iterable.com"))),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
        assert.strictEqual(yield* Ref.get(notifications), 0);
        assert.strictEqual(yield* Ref.get(restrictions), 0);
      }),
  );
  it.effect("refuses native UTC years that cannot retain the documented wire representation", () =>
    Effect.gen(function* rejectUnrepresentableIterableYear() {
      yield* TestClock.setTime(Date.UTC(9999, 11, 31));

      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const error = yield* Effect.gen(function* submitUnrepresentableIterableInstant() {
        return yield* (yield* IterableCampaignEmail).send({
          ...job,
          sendAt: DateTime.makeUnsafe("+010000-01-01T00:00:00.000Z"),
        });
      }).pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);

      assert(error instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
  it.live.each(["US", "EU"] as const)(
    "uses the selected %s project endpoint without pretending native data overrides common email intent",
    (region) =>
      Effect.gen(function* inspectIterableWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* sendNativeIterable() {
          return yield* (yield* IterableCampaignEmail).send({
            ...job,
            metadata: { workflow: "fictional" },
          });
        }).pipe(
          Effect.provide(
            iterableCampaignLayer({ ...options, region }).pipe(
              Layer.provide(
                emailFixtureClientLayer(
                  fixture.url,
                  region === "US" ? "https://api.iterable.com" : "https://api.eu.iterable.com",
                ),
              ),
            ),
          ),
        );

        assert.strictEqual(receipt._tag, "Accepted");
        assert.notProperty(receipt, "messageId");
        const wire = yield* Queue.take(fixture.received);
        assert.strictEqual(wire.path, "/api/email/target");
        assert.strictEqual(wire.apiKey, "fictional-iterable-key");

        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              allowRepeatMarketingSends: Schema.Boolean,
              campaignId: Schema.Int,
              dataFields: Schema.Struct({
                count: Schema.Finite,
                enabled: Schema.Boolean,
                firstName: Schema.String,
                items: Schema.Array(Schema.String),
              }),
              metadata: Schema.Record(Schema.String, Schema.String),
              recipientEmail: Schema.String,
            }),
          ),
        )(wire.body);

        assert.isFalse(payload.allowRepeatMarketingSends);
        assert.strictEqual(payload.campaignId, 123);
        assert.strictEqual(payload.recipientEmail, job.recipientEmail);
        assert.strictEqual(payload.dataFields.count, 0);
        assert.isFalse(payload.dataFields.enabled);
        assert.deepStrictEqual(payload.dataFields.items, ["one", "two"]);
        assert.strictEqual(payload.metadata.workflow, "fictional");
        assert.notInclude(wire.body, '"from"');
        assert.notInclude(wire.body, '"subject"');
        assert.notInclude(wire.body, '"idempotency');
      }),
  );
  it.live(
    "owns native preview arrays and metadata without freezing callers or contacting Iterable",
    () =>
      Effect.gen(function* inspectIterableOwnership() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const variables = { items: ["original"] };
        const metadata = { workflow: "original" };
        yield* Effect.gen(function* ownAndSendIterablePreview() {
          const email = yield* IterableCampaignEmail;
          const preview = yield* email.validate({ ...job, dataFields: variables, metadata });
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
          variables.items[0] = "changed";
          metadata.workflow = "changed";
          assert.isFalse(Object.isFrozen(variables));
          assert.isTrue(Object.isFrozen(preview));
          Reflect.set(preview.dataFields ?? {}, "items", ["forged"]);
          yield* email.send(preview);
          const wire = yield* Queue.take(fixture.received);
          assert.include(wire.body, '"items":["original"]');
          assert.include(wire.body, '"workflow":"original"');
          assert.notInclude(wire.body, "changed");
          assert.notInclude(wire.body, "forged");
        }).pipe(Effect.provide(fixtureLayer(fixture)));
      }),
  );
  it.effect(
    "preserves exact whole-second future UTC scheduling and refuses past or over-window jobs",
    () =>
      Effect.gen(function* inspectIterableSchedule() {
        yield* TestClock.setTime(0);

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        yield* Effect.gen(function* scheduleIterable() {
          const email = yield* IterableCampaignEmail;
          yield* email.send({ ...job, sendAt: "1970-01-01T00:01:00Z" });
          const wire = yield* Queue.take(fixture.received);
          assert.include(wire.body, '"sendAt":"1970-01-01 00:01:00"');

          for (const sendAt of [
            "1970-01-01T00:00:00Z",
            "1971-02-01T00:00:00Z",
            "1970-01-01T00:01:00.001Z",
          ]) {
            const error = yield* email.send({ ...job, sendAt }).pipe(Effect.flip);
            assert(error instanceof EmailInvalidMessage);
          }

          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }).pipe(Effect.provide(fixtureLayer(fixture)));
      }),
  );
  it.live.each([
    { body: { code: "QueueEmailError", msg: "private-native-error" }, status: 200 },
    { body: { code: "DatabaseError", msg: "private-native-error" }, status: 400 },
    { body: { code: "Success" }, status: 200 },
    { body: acknowledgement, status: 202 },
    { body: {}, status: 429 },
    { body: {}, status: 503 },
  ])(
    "does not reinterpret ambiguous $status evidence as acceptance or replay permission",
    ({ body, status }) =>
      Effect.gen(function* inspectIterableUncertainty() {
        const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status });
        const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
        assert(error instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(error), "private-");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );
  it.live(
    "settles whole-job batch validation in order and never transports unsupported keys or excess model fields",
    () =>
      Effect.gen(function* inspectIterableBatch() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const extra = { ...job, from: "not-an-override@example.test" };

        const commonOptions = {
          executionMetadata: { tenant: "private-context-value" },
          idempotencyKey: "private-key",
        };

        const results = yield* Effect.gen(function* sendIterableBatch() {
          return yield* (yield* IterableCampaignEmail).sendAll(
            [
              { job },
              { job: extra },
              { job, options: { idempotencyKey: "not-native-authority" } },
              { job: { ...job, recipientEmail: "UPPER@example.test" } },
              { job: { ...job, recipientEmail: "another@example.test" } },
              { job, options: commonOptions },
            ],
            { concurrency: 1 },
          );
        }).pipe(Effect.provide(fixtureLayer(fixture)));

        assert.isDefined(results[0]);
        assert(Result.isSuccess(results[0]));
        assert.isDefined(results[1]);
        assert(Result.isFailure(results[1]));
        assert(results[1].failure instanceof EmailInvalidMessage);
        assert(results[1].failure.issues.every((issue) => issue.path.startsWith("job.")));
        assert.isDefined(results[2]);
        assert(Result.isFailure(results[2]));
        assert(results[2].failure instanceof EmailRejected);
        assert.strictEqual(results[2].failure.reason, "unsupported-idempotency");
        assert.isDefined(results[3]);
        assert(Result.isFailure(results[3]));
        assert.isDefined(results[4]);
        assert(Result.isSuccess(results[4]));
        assert.isDefined(results[5]);
        assert(Result.isFailure(results[5]));
        assert(results[5].failure instanceof EmailInvalidOptions);
        assert.strictEqual(results[5].failure.issues[0]?.path, "options.executionMetadata");
        assert.notInclude(JSON.stringify(results[5].failure), "private-context-value");
        assert.strictEqual(yield* Queue.size(fixture.received), 2);
      }),
  );
  it.live("cancels pending native HTTP and retains no input or provider prose in owned spans", () =>
    Effect.gen(function* inspectIterableCancellation() {
      const fixture = yield* startEmailHttpFixture({ body: "", hold: true, status: 200 });
      const trace = yield* startEmailTraceFixture();

      const fiber = yield* send.pipe(
        Effect.provide(fixtureLayer(fixture)),
        Effect.provideService(Tracer.Tracer, trace.tracer),
        Effect.forkScoped,
      );

      yield* Queue.take(fixture.received);
      yield* Fiber.interrupt(fiber);
      assert(Exit.hasInterrupts(yield* Fiber.await(fiber)));
      assert.strictEqual(yield* Queue.take(fixture.closed), true);
      const spans = yield* trace.diagnostics;
      assert.include(spans, "Iterable.submit");
      assert.notInclude(spans, job.recipientEmail);
      assert.notInclude(spans, "Fictional");
      assert.notInclude(spans, "fictional-iterable-key");
    }),
  );
  it.live.each(["not-json-private-payload", "x".repeat(70_000)])(
    "bounds response parsing and hides malformed private bodies",
    (body) =>
      Effect.gen(function* inspectIterableBodyLimit() {
        const fixture = yield* startEmailHttpFixture({ body, status: 200 });
        const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
        assert(error instanceof EmailDeliveryUnknown);
        assert.strictEqual(error.reason, "invalid-response");
        assert.notInclude(JSON.stringify(error), "private-");
      }),
  );
  it.live("refuses a redirected credential-bearing native job without another request", () =>
    Effect.gen(function* inspectIterableRedirect() {
      const fixture = yield* startEmailHttpFixture({
        body: "",
        location: "/unapproved",
        status: 307,
      });

      const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
      assert(error instanceof EmailDeliveryUnknown);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );
  it.live("requires explicit profile-write, campaign and retention authority at acquisition", () =>
    Effect.gen(function* inspectIterableAuthority() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const invalid = { ...options };
      Reflect.set(invalid, "contactWrites", "Disabled");

      const error = yield* IterableCampaignEmail.pipe(
        Effect.provide(
          iterableCampaignLayer(invalid).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.iterable.com")),
          ),
        ),
        Effect.flip,
      );

      assert(error instanceof EmailConfigurationError);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
