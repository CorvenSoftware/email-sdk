import { assert, describe, it } from "@effect/vitest";
import {
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Queue,
  Redacted,
  Result,
  Schema,
  Tracer,
} from "effect";
import { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  emailRouterLayer,
} from "./index.js";
import { sparkpostEmailLayer } from "./sparkpost-email-sender.js";
import type { SparkpostEmailOptions } from "./sparkpost-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic {{literal}}</p>", text: "Synthetic {{literal}}" },
  from: { address: "sender@example.test", name: "Fictional Café" },
  subject: "Synthetic SparkPost notification",
  to: ["First@example.test"],
} as const;

const options = { apiKey: Redacted.make("fictional-sparkpost-key") };

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const acknowledgement = {
  results: {
    id: "private-transmission-id",
    total_accepted_recipients: 1,
    total_rejected_recipients: 0,
  },
};

const fixtureSparkpostLayer = (
  fixture: EmailHttpFixture,
  maxAttempts = 1,
  configuration: SparkpostEmailOptions = options,
) =>
  sparkpostEmailLayer(configuration, { ...policy, maxAttempts }).pipe(
    Layer.provide(
      emailFixtureClientLayer(
        fixture.url,
        configuration.region === "Europe"
          ? "https://api.eu.sparkpost.com"
          : "https://api.sparkpost.com",
      ),
    ),
  );

const fixtureSparkpostRoute = (
  primary: EmailHttpFixture,
  backup: EmailHttpFixture,
  maxAttempts = 1,
) =>
  emailRouterLayer(
    [
      { layer: fixtureSparkpostLayer(primary, maxAttempts), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const routedSend = Effect.gen(function* submitSparkpostRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message, {
    idempotencyKey: "synthetic-key",
  });
});

const SparkpostWire = Schema.Struct({
  content: Schema.Struct({
    attachments: Schema.Array(
      Schema.Struct({ data: Schema.String, name: Schema.String, type: Schema.String }),
    ),
    from: Schema.Struct({ email: Schema.String, name: Schema.String }),
    headers: Schema.Record(Schema.String, Schema.String),
    html: Schema.String,
    inline_images: Schema.Array(
      Schema.Struct({ data: Schema.String, name: Schema.String, type: Schema.String }),
    ),
    reply_to: Schema.String,
    subject: Schema.String,
    text: Schema.String,
  }),
  metadata: Schema.Record(Schema.String, Schema.String),
  options: Schema.Struct({
    click_tracking: Schema.Boolean,
    initial_open: Schema.Boolean,
    inline_css: Schema.Boolean,
    open_tracking: Schema.Boolean,
    perform_substitutions: Schema.Boolean,
    sandbox: Schema.Boolean,
    skip_suppression: Schema.Boolean,
    start_time: Schema.String,
    transactional: Schema.Boolean,
  }),
  recipients: Schema.Array(
    Schema.Struct({ address: Schema.Struct({ email: Schema.String, header_to: Schema.String }) }),
  ),
});

describe("SparkPost actual transmissions", () => {
  it.effect.each(["UnitedStates", "Europe"] as const)(
    "preserves group visibility, names, bytes, literal content and scheduled intent in %s",
    (region) =>
      Effect.gen(function* inspectSparkpostWire() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T12:30:00Z")),
        );

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            results: { ...acknowledgement.results, total_accepted_recipients: 2 },
          }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichSparkpostIntent() {
          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [
                {
                  contentBase64: "AP+ACg==",
                  contentType: "application/octet-stream",
                  filename: "sample.dat",
                },
                {
                  contentBase64: "AQ==",
                  contentId: "sample.png",
                  contentType: "image/png",
                  filename: "sample.png",
                },
              ],
              headers: [{ name: "X-Workflow", value: "synthetic {{literal}}" }],
              metadata: { workflow: "synthetic" },
              replyTo: { address: "reply@example.test", name: "Fictional Reply" },
              sendAt: "2026-10-14T12:30:00Z",
              to: [
                { address: "First@example.test", name: 'Fictional "Café"' },
                "second@example.test",
              ],
            },
            { idempotencyKey: "K".repeat(255) },
          );
        }).pipe(Effect.provide(fixtureSparkpostLayer(fixture, 1, { ...options, region })));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.path, "/api/v1/transmissions");
        assert.strictEqual(sent.authorization, "fictional-sparkpost-key");
        assert.strictEqual(sent.idempotencyKey, "K".repeat(255));
        assert.strictEqual(sent.method, "POST");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(SparkpostWire))(sent.body);
        assert.strictEqual(wire.content.from.name, "Fictional Café");
        assert.strictEqual(wire.content.from.email, "sender@example.test");
        assert.strictEqual(wire.content.reply_to, '"Fictional Reply" <reply@example.test>');
        assert.strictEqual(wire.content.subject, message.subject);
        assert.strictEqual(wire.content.text, message.body.text);
        assert.strictEqual(wire.content.html, message.body.html);
        assert.strictEqual(wire.content.headers["X-Workflow"], "synthetic {{literal}}");
        assert.strictEqual(wire.metadata.workflow, "synthetic");
        assert.deepStrictEqual(
          wire.recipients.map((recipient) => recipient.address.email),
          ["First@example.test", "second@example.test"],
        );
        assert(
          wire.recipients.every(
            (recipient) =>
              recipient.address.header_to ===
              '"Fictional \\"Café\\"" <First@example.test>, second@example.test',
          ),
        );
        assert.strictEqual(wire.content.attachments[0]?.name, "sample.dat");
        assert.strictEqual(wire.content.attachments[0]?.type, "application/octet-stream");
        assert.deepStrictEqual(
          [...Buffer.from(wire.content.attachments[0]?.data ?? "", "base64")],
          [0, 255, 128, 10],
        );
        assert.strictEqual(wire.content.inline_images[0]?.name, "sample.png");
        assert.strictEqual(wire.content.inline_images[0]?.type, "image/png");
        assert.deepStrictEqual(
          [...Buffer.from(wire.content.inline_images[0]?.data ?? "", "base64")],
          [1],
        );
        assert.strictEqual(wire.options.start_time, "2026-10-14T12:30:00Z");
        assert.strictEqual(wire.options.click_tracking, false);
        assert.strictEqual(wire.options.open_tracking, false);
        assert.strictEqual(wire.options.initial_open, false);
        assert.strictEqual(wire.options.perform_substitutions, false);
        assert.strictEqual(wire.options.inline_css, false);
        assert.strictEqual(wire.options.sandbox, false);
        assert.strictEqual(wire.options.transactional, false);
        assert.strictEqual(wire.options.skip_suppression, false);
        assert.notInclude(sent.body, '"substitution_data"');
      }),
  );

  it.effect.prop(
    "preserves generated scheduling instants across leap-day boundaries on native wire and private span exits",
    { seconds: Schema.Int.check(Schema.isBetween({ maximum: 259_200, minimum: 1 })) },
    ({ seconds }) =>
      Effect.gen(function* inspectSparkpostScheduledTime() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2028-02-28T23:59:59Z")),
        );
        const sendAt = DateTime.add(yield* DateTime.now, { seconds });

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const trace = yield* startEmailTraceFixture();

        const receipt = yield* Effect.gen(function* submitBoundedSparkpostSchedule() {
          return yield* (yield* Email).send(
            { ...message, sendAt },
            { idempotencyKey: "private-scheduled-key" },
          );
        }).pipe(
          Effect.provide(fixtureSparkpostLayer(fixture)),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "private-transmission-id");
        const sent = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              options: Schema.Struct({
                click_tracking: Schema.Boolean,
                perform_substitutions: Schema.Boolean,
                start_time: Schema.String,
              }),
            }),
          ),
        )(sent.body);

        assert.strictEqual(
          DateTime.toEpochMillis(DateTime.makeUnsafe(wire.options.start_time)) -
            DateTime.toEpochMillis(yield* DateTime.now),
          seconds * 1000,
        );
        assert.isFalse(wire.options.perform_substitutions);
        assert.isFalse(wire.options.click_tracking);
        assert.strictEqual(sent.idempotencyKey, "private-scheduled-key");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const diagnostics = yield* trace.diagnostics;

        for (const privateValue of [
          wire.options.start_time,
          "example.test",
          "private-",
          "literal",
        ]) {
          assert.notInclude(diagnostics, privateValue);
        }
      }),
    { arbitrary: { runs: 12 } },
  );

  it.effect.each([
    "2030-01-01T00:00:00Z",
    "2029-12-31T23:59:59Z",
    "2030-01-01T00:00:00.001Z",
    "2030-01-04T00:00:01Z",
  ])(
    "refuses expired, fractional and over-window schedules before all routed transport (%s)",
    (sendAt) =>
      Effect.gen(function* rejectUnrepresentableSparkpostSchedule() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T00:00:00Z")),
        );

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        yield* Effect.gen(function* preflightSparkpostSchedule() {
          const email = yield* Email;

          for (const operation of [
            email.validate({ ...message, sendAt }).pipe(Effect.asVoid),
            email.send({ ...message, sendAt }).pipe(Effect.asVoid),
          ]) {
            const result = yield* operation.pipe(Effect.result);
            assert(Result.isFailure(result));
            assert(result.failure instanceof EmailInvalidMessage);
            assert.deepStrictEqual(
              result.failure.issues.map(({ path }) => path),
              ["sendAt"],
            );
            assert.notInclude(JSON.stringify(result.failure), sendAt);
          }
        }).pipe(Effect.provide(fixtureSparkpostRoute(primary, backup)));
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect(
    "preserves the exact three-day edge and refuses extended years rather than truncating them",
    () =>
      Effect.gen(function* enforceSparkpostCalendarBoundaries() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        yield* Effect.gen(function* inspectSparkpostCalendarBoundaries() {
          const email = yield* Email;
          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("2030-01-01T00:00:00Z")),
          );

          for (const seconds of [1, 259_200]) {
            const sendAt = DateTime.add(yield* DateTime.now, { seconds });
            yield* email.validate({ ...message, sendAt });
            assert(EmailReceiptSchema.guards.Accepted(yield* email.send({ ...message, sendAt })));
            yield* Queue.take(fixture.received);
          }

          yield* TestClock.setTime(
            DateTime.toEpochMillis(DateTime.makeUnsafe("9999-12-31T00:00:00Z")),
          );

          const result = yield* email
            .send({ ...message, sendAt: DateTime.makeUnsafe("+010000-01-01T00:00:00Z") })
            .pipe(Effect.result);

          assert(Result.isFailure(result));
          assert(result.failure instanceof EmailInvalidMessage);
        }).pipe(Effect.provide(fixtureSparkpostLayer(fixture)));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.effect("preflights a stricter SparkPost backup window before the primary can send", () =>
    Effect.gen(function* preflightSparkpostBackupSchedule() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "primary-id" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const result = yield* Effect.gen(function* submitOutsideBackupScheduleWindow() {
        return yield* (yield* Email).send({ ...message, sendAt: "1970-01-05T00:00:00Z" });
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: resendEmailLayer(
                  { apiKey: Redacted.make("fictional-primary-key") },
                  policy,
                ).pipe(
                  Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                ),
                name: "primary",
              },
              { layer: fixtureSparkpostLayer(backup), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect("owns pending batch schedules and refuses expiry before native transport", () =>
    Effect.gen(function* expireQueuedSparkpostSchedule() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const entered = yield* Deferred.make<boolean>();
      const release = yield* Deferred.make<boolean>();

      const native = yield* Effect.service(HttpClient.HttpClient).pipe(
        Effect.provide(emailFixtureClientLayer(fixture.url, "https://api.sparkpost.com")),
      );

      const client = HttpClient.make((request) =>
        Deferred.succeed(entered, true).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(native.execute(request)),
        ),
      );

      const queued = { ...message, sendAt: "1970-01-01T00:00:01Z" };

      const results = yield* Effect.gen(function* queueSparkpostSchedule() {
        const email = yield* Email;

        const batch = yield* email
          .sendAll([{ message }, { message: queued }], { concurrency: 1 })
          .pipe(Effect.forkChild);

        yield* Deferred.await(entered);
        queued.sendAt = "1970-01-02T00:00:00Z";
        yield* TestClock.adjust("1 second");
        yield* Deferred.succeed(release, true);

        return yield* Fiber.join(batch);
      }).pipe(
        Effect.provide(
          sparkpostEmailLayer(options, policy).pipe(
            Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
          ),
        ),
      );

      const [first, second] = results;
      assert(first !== undefined && Result.isSuccess(first));
      assert(second !== undefined && Result.isFailure(second));
      assert(second.failure instanceof EmailRejected);
      assert.strictEqual(second.failure.reason, "invalid-message");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.effect(
    "keeps earlier native uncertainty terminal when scheduling expires during backoff",
    () =>
      Effect.gen(function* preserveUncertainSparkpostSchedule() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ errors: [{ code: "1601" }] }),
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          retryAfter: "2",
          status: 409,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const retrySleeps = yield* Queue.unbounded<Duration.Duration>();
        const releaseRetry = yield* Deferred.make<boolean>();
        const clock = yield* Clock.Clock;

        const controlledClock: Clock.Clock = {
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          sleep: (duration) =>
            Duration.toMillis(duration) >= 5000
              ? clock.sleep(duration)
              : Queue.offer(retrySleeps, duration).pipe(
                  Effect.andThen(Deferred.await(releaseRetry)),
                  Effect.asVoid,
                ),
        };

        const fiber = yield* Effect.gen(function* submitExpiringNativeSparkpostSchedule() {
          return yield* (yield* Email).send(
            { ...message, sendAt: "1970-01-01T00:00:01Z" },
            { idempotencyKey: "private-key" },
          );
        }).pipe(
          Effect.provide(fixtureSparkpostRoute(primary, backup, 3)),
          Effect.provideService(Clock.Clock, controlledClock),
          Effect.result,
          Effect.forkScoped,
        );

        const delay = yield* Queue.take(retrySleeps);
        assert.isAtLeast(Duration.toMillis(delay), 2000);
        yield* TestClock.adjust(delay);
        yield* Deferred.succeed(releaseRetry, true);
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "idempotency-in-progress");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
        assert.notInclude(JSON.stringify(result.failure), "private-key");
      }),
  );

  it.effect.each([
    { accepted: 0, total: 2 },
    { accepted: 1, total: 2 },
    { accepted: 2, total: 2 },
    { accepted: 0, total: 50 },
    { accepted: 25, total: 50 },
    { accepted: 50, total: 50 },
  ])(
    "keeps $accepted/$total accepted recipients terminal without backup or guessed identities",
    ({ accepted, total }) =>
      Effect.gen(function* preserveSparkpostCounts() {
        const rejected = total - accepted;

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            errors: rejected > 0 ? [{ code: "2000", message: "private-validation" }] : [],
            results: {
              id: "private-counted-id",
              rcpt_to_errors: [
                { address: "private-foreign@example.test", message: "private-reason" },
              ],
              total_accepted_recipients: accepted,
              total_rejected_recipients: rejected,
            },
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const recipients = [
          "first@example.test",
          ...Array.from({ length: total - 1 }, (_, index) => `recipient-${index}@example.test`),
        ] as const;

        const receipt = yield* Effect.gen(function* submitCountedSparkpostGroup() {
          return yield* (yield* (yield* EmailRouter).select()).send({
            ...message,
            to: recipients,
          });
        }).pipe(Effect.provide(fixtureSparkpostRoute(primary, backup)));

        assert.strictEqual(receipt.route, "primary");
        assert("messageId" in receipt);
        assert.strictEqual(receipt.messageId, "private-counted-id");

        if (accepted === 0) {
          assert(EmailReceiptSchema.guards.RecipientsRejected(receipt));
          assert.deepStrictEqual(receipt.rejected.map(String), [...recipients]);
          assert(Object.isFrozen(receipt.rejected));
        } else if (rejected > 0) {
          assert(EmailReceiptSchema.guards.PartiallyAcceptedCounts(receipt));
          assert.strictEqual(receipt.counts.acceptedCount, accepted);
          assert.strictEqual(receipt.counts.rejectedCount, rejected);
          assert(Object.isFrozen(receipt.counts));
          assert(!("accepted" in receipt));
        } else {
          assert(EmailReceiptSchema.guards.Accepted(receipt));
        }

        assert(Object.isFrozen(receipt));
        assert.notInclude(JSON.stringify(receipt), "private-foreign");
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {},
    { results: { id: "private-id" } },
    { results: { ...acknowledgement.results, total_accepted_recipients: 0 } },
    { results: { ...acknowledgement.results, total_rejected_recipients: 1 } },
    { results: { ...acknowledgement.results, id: "bad id" } },
    { ...acknowledgement, errors: [{ code: "2000" }] },
    { ...acknowledgement, errors: [{ code: "7001" }] },
  ])("keeps incomplete or contradictory acknowledgement unknown and terminal (%j)", (body) =>
    Effect.gen(function* stopUnprovenSparkpostAcknowledgement() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const result = yield* routedSend.pipe(
        Effect.provide(fixtureSparkpostRoute(primary, backup)),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(result.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([
    { ...message, cc: "cc@example.test" },
    { ...message, bcc: "bcc@example.test" },
    { ...message, tags: [{ name: "p", value: "v" }] },
    { ...message, sendAt: "2026-10-14T12:30:00.123Z" },
    { ...message, replyTo: ["a@example.test", "b@example.test"] },
    { ...message, to: ["first@example.test", "FIRST@example.test"] },
    { ...message, headers: [{ name: "X-MSYS-API", value: "private-value" }] },
    {
      ...message,
      attachments: [
        { contentBase64: "AQ==", contentType: "ProviderSelected", filename: "sample.dat" },
      ],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQ==",
          contentId: "other",
          contentType: "image/png",
          filename: "sample.png",
        },
      ],
    },
    {
      ...message,
      metadata: {
        a: "界".repeat(1000),
        b: "界".repeat(1000),
        c: "界".repeat(1000),
        d: "界".repeat(1000),
      },
    },
  ] as const)("rejects unpreservable intent before HTTP (%j)", (input) =>
    Effect.gen(function* rejectSparkpostIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* validateSparkpostInput() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureSparkpostLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(outcome.failure), "private-value");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect.each([
    { body: "private-gateway", status: 502 },
    {
      body: JSON.stringify({ errors: [{ code: "1601", message: "private-processing" }] }),
      status: 409,
    },
  ])(
    "replays only native keyed uncertainty with immutable body and minimum delay ($status)",
    ({ status, body }) =>
      Effect.gen(function* retrySparkpostNativeRequest() {
        const fixture = yield* startEmailHttpFixture({
          body,
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          retryAfter: "2",
          status,
        });

        const input: Omit<typeof message, "subject"> & { subject: string } = { ...message };

        const fiber = yield* Effect.gen(function* submitNativeSparkpostRequest() {
          return yield* (yield* Email).send(input, { idempotencyKey: "synthetic-key" });
        }).pipe(Effect.provide(fixtureSparkpostLayer(fixture, 3)), Effect.forkScoped);

        const first = yield* Queue.take(fixture.received);
        input.subject = "private-mutated";

        if (status === 409) {
          yield* TestClock.adjust(1000);
          assert.strictEqual(yield* Queue.size(fixture.received), 0);
        }

        yield* TestClock.adjust(2000);
        assert(EmailReceiptSchema.guards.Accepted(yield* Fiber.join(fiber)));
        const retry = yield* Queue.take(fixture.received);
        assert.strictEqual(retry.body, first.body);
        assert.strictEqual(retry.idempotencyKey, "synthetic-key");
        assert.notInclude(retry.body, "private-mutated");
      }),
  );

  it.live.each(["invalid/key", "K".repeat(256)])(
    "rejects restricted keys before HTTP (%s)",
    (idempotencyKey) =>
      Effect.gen(function* rejectSparkpostKey() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitUnsupportedSparkpostKey() {
          return yield* (yield* Email).send(message, { idempotencyKey });
        }).pipe(Effect.provide(fixtureSparkpostLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([
    { code: "1600", reason: "idempotency-conflict", status: 409 },
    { code: "2101", reason: "rejected", status: 420 },
  ])("keeps conflicts and quotas nontransient ($status)", ({ status, code, reason }) =>
    Effect.gen(function* stopNontransientSparkpostRequest() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({ errors: [{ code, message: "private-reason" }] }),
        status,
      });

      const outcome = yield* Effect.gen(function* submitNontransientSparkpostRequest() {
        return yield* (yield* Email).send(message, { idempotencyKey: "synthetic-key" });
      }).pipe(Effect.provide(fixtureSparkpostLayer(fixture, 3)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
      assert.strictEqual(outcome.failure.reason, reason);
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
      assert.notInclude(JSON.stringify(outcome.failure), "private-reason");
    }),
  );

  it.live("advances real backup only after definite authentication rejection", () =>
    Effect.gen(function* fallbackFromSparkpostAuthentication() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ errors: [{ code: "1000" }] }),
        status: 401,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const receipt = yield* routedSend.pipe(
        Effect.provide(fixtureSparkpostRoute(primary, backup)),
      );

      assert.strictEqual(receipt.route, "backup");
      assert.strictEqual((yield* Queue.take(backup.received)).idempotencyKey, "synthetic-key");
    }),
  );

  it.live.each([502, 409, 429])(
    "never retries unkeyed uncertainty or invents POST rate authority ($status)",
    (status) =>
      Effect.gen(function* stopUnkeyedSparkpostUncertainty() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ errors: [{ code: "1601" }] }),
          status,
        });

        const outcome = yield* Effect.gen(function* submitUnkeyedSparkpostRequest() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureSparkpostLayer(fixture, 3)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([
    { errors: [{ code: "1600" }] },
    { errors: [{ code: "1600" }, { code: "1601" }] },
    { errors: [{ code: "1601" }], results: acknowledgement.results },
  ])("never advances backup after conflicting or contradictory 409 evidence (%j)", (body) =>
    Effect.gen(function* stopSparkpostConflictFallback() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 409 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* routedSend.pipe(
        Effect.provide(fixtureSparkpostRoute(primary, backup)),
        Effect.result,
      );

      assert(Result.isFailure(outcome));
      assert(
        outcome.failure instanceof EmailRejected || outcome.failure instanceof EmailDeliveryUnknown,
      );
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live("preflights the stricter backup alphabet before primary HTTP", () =>
    Effect.gen(function* preflightSparkpostBackupKeys() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "primary-id" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* sendUnsupportedBackupKey() {
        return yield* (yield* (yield* EmailRouter).select()).send(message, {
          idempotencyKey: "invalid/key",
        });
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: resendEmailLayer(
                  { apiKey: Redacted.make("fictional-primary-key") },
                  policy,
                ).pipe(
                  Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                ),
                name: "primary",
              },
              { layer: fixtureSparkpostLayer(backup), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
      assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live("keeps malformed credentials private and native retention bounded", () =>
    Effect.gen(function* rejectSparkpostConfiguration() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const useEmail = Effect.service(Email);

      const credential = yield* useEmail.pipe(
        Effect.provide(
          fixtureSparkpostLayer(fixture, 1, { apiKey: Redacted.make("private\ncredential") }),
        ),
        Effect.result,
      );

      assert(Result.isFailure(credential) && credential.failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(credential.failure), "private");

      const retention = yield* useEmail.pipe(
        Effect.provide(
          sparkpostEmailLayer(options, {
            ...policy,
            deadline: Duration.hours(24),
            maxAttempts: 2,
          }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sparkpost.com"))),
        ),
        Effect.result,
      );

      assert(Result.isFailure(retention) && retention.failure instanceof EmailConfigurationError);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
