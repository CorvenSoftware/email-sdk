import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Fiber, Layer, Queue, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRouter,
  emailRouterLayer,
  emailAttachmentFromBytes,
} from "./index.js";
import { jetemailEmailLayer } from "./jetemail-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café</p>", text: "Synthetic café" },
  from: { address: "sender@example.test", name: "Fictional Café" },
  subject: "Synthetic JetEmail notification",
  to: ["recipient@example.test"],
} as const;

const options = {
  apiKey: Redacted.make("transactional_fictional-key"),
  automaticBcc: "DomainDisabled",
  tracking: "DomainDisabled",
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const acknowledgement = { id: "synthetic-message-id", response: "private-queue-confirmation" };

const scheduled = { ...message, sendAt: "2026-10-14T12:30:00Z" } as const;

const scheduledAcknowledgement = {
  id: "0cd0f31f-1234-4abc-8def-1234567890ab",
  scheduled_at: 1_791_981_000,
};

const fixtureJetemailLayer = (fixture: EmailHttpFixture, maxAttempts = 1) =>
  jetemailEmailLayer(options, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.jetemail.com")),
  );

const fixtureJetemailRoute = (
  primary: EmailHttpFixture,
  backup: EmailHttpFixture,
  maxAttempts = 1,
) =>
  emailRouterLayer(
    [
      { layer: fixtureJetemailLayer(primary, maxAttempts), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const sendJetemailRoute = Effect.gen(function* submitJetemailRoute() {
  return yield* (yield* (yield* EmailRouter).select()).send(message, {
    idempotencyKey: "synthetic-stable-key",
  });
});

describe("JetEmail actual transactional protocol", () => {
  it.live.each(["ProviderSelected", "Europe"] as const)(
    "preserves formatted rich fields and delegated MIME with explicit delivery region %s",
    (deliveryRegion) =>
      Effect.gen(function* inspectJetemailWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 201,
        });

        const receipt = yield* Effect.gen(function* submitRichJetemailMessage() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentType: "ProviderSelected",
            filename: "sample.dat",
          });

          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [attachment],
              bcc: { address: "hidden@example.test", name: "Fictional Hidden" },
              cc: { address: "copy@example.test", name: "Doe, Fictional" },
              headers: [{ name: "X-Workflow", value: "synthetic-value" }],
              replyTo: [
                { address: "reply@example.test", name: "Fictional Reply" },
                "other@example.test",
              ],
            },
            { idempotencyKey: "synthetic-stable-key" },
          );
        }).pipe(
          Effect.provide(
            jetemailEmailLayer({ ...options, deliveryRegion }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.jetemail.com")),
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, acknowledgement.id);
        assert.isTrue(Object.isFrozen(receipt));
        assert.notInclude(JSON.stringify(receipt), "private-");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/email");
        assert.strictEqual(sent.authorization, "Bearer transactional_fictional-key");
        assert.strictEqual(sent.idempotencyKey, "synthetic-stable-key");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({ data: Schema.String, filename: Schema.String }),
              ),
              bcc: Schema.Array(Schema.String),
              cc: Schema.Array(Schema.String),
              eu: Schema.Boolean,
              from: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
              html: Schema.String,
              reply_to: Schema.Array(Schema.String),
              subject: Schema.String,
              text: Schema.String,
              to: Schema.Array(Schema.String),
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.from, '"Fictional Café" <sender@example.test>');
        assert.deepStrictEqual(wire.to, [...message.to]);
        assert.deepStrictEqual(wire.cc, ['"Doe, Fictional" <copy@example.test>']);
        assert.deepStrictEqual(wire.bcc, ['"Fictional Hidden" <hidden@example.test>']);
        assert.deepStrictEqual(wire.reply_to, [
          '"Fictional Reply" <reply@example.test>',
          "other@example.test",
        ]);
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.text, message.body.text);
        assert.strictEqual(wire.html, message.body.html);
        assert.strictEqual(wire.headers["X-Workflow"], "synthetic-value");
        assert.strictEqual(wire.eu, deliveryRegion === "Europe");
        const [attachment] = wire.attachments;
        assert.isDefined(attachment);
        assert.strictEqual(attachment.filename, "sample.dat");
        assert.deepStrictEqual([...Buffer.from(attachment.data, "base64")], [0, 255, 128, 10]);
        assert.notInclude(sent.body, '"contentType"');
        assert.notInclude(sent.body, '"ProviderSelected"');
      }),
  );

  it.effect(
    "matches whole-second schedule evidence and stops backup on scheduled acknowledgement",
    () =>
      Effect.gen(function* inspectJetemailSchedule() {
        yield* TestClock.setTime(
          DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-14T12:00:00Z")),
        );

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(scheduledAcknowledgement),
          status: 202,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitScheduledRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(scheduled, {
            idempotencyKey: "synthetic-schedule-key",
          });
        }).pipe(Effect.provide(fixtureJetemailRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, scheduledAcknowledgement.id);
        assert.strictEqual(receipt.route, "primary");
        const sent = yield* Queue.take(primary.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ eu: Schema.Boolean, scheduledAt: Schema.String })),
        )(sent.body);

        assert.strictEqual(wire.scheduledAt, "2026-10-14T12:30:00.000Z");
        assert.strictEqual(wire.eu, false);
        assert.strictEqual(sent.idempotencyKey, "synthetic-schedule-key");
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {},
    { id: "invalid id" },
    { ...acknowledgement, error: "private-error" },
    { ...acknowledgement, scheduled_at: 1_791_981_000 },
  ])("keeps incomplete/contradictory immediate acknowledgement unknown (%j)", (body) =>
    Effect.gen(function* rejectJetemailAcknowledgement() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 201 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* sendJetemailRoute.pipe(
        Effect.provide(fixtureJetemailRoute(primary, backup, 3)),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.effect.each([
    { id: scheduledAcknowledgement.id },
    { ...scheduledAcknowledgement, id: "not-a-uuid" },
    { ...scheduledAcknowledgement, scheduled_at: "1791981000" },
    { ...scheduledAcknowledgement, scheduled_at: 1_791_981_000.5 },
    { ...scheduledAcknowledgement, scheduled_at: 1_791_981_001 },
    { ...scheduledAcknowledgement, error: "private-error" },
  ])("never silently accepts missing/truncated/mismatched schedule evidence (%j)", (body) =>
    Effect.gen(function* rejectJetemailScheduleEvidence() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-14T12:00:00Z")));

      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 202 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitUnprovenSchedule() {
        return yield* (yield* (yield* EmailRouter).select()).send(scheduled, {
          idempotencyKey: "synthetic-key",
        });
      }).pipe(Effect.provide(fixtureJetemailRoute(primary, backup, 3)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([200, 202, 400, 403, 408, 409, 500, 503])(
    "does not infer acceptance, replay or safe fallback at status %i even with a key",
    (status) =>
      Effect.gen(function* stopUncertainJetemailStatus() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ ...acknowledgement, error: "private-suppression-or-conflict" }),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* sendJetemailRoute.pipe(
          Effect.provide(fixtureJetemailRoute(primary, backup, 3)),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(
          outcome.failure.reason,
          status >= 500 ? "server-error" : "unexpected-status",
        );
        assert.notInclude(JSON.stringify(outcome.failure), "private-");
        assert.strictEqual(yield* Queue.size(primary.received), 1);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("does not mistake an immediate response for an acknowledged future schedule", () =>
    Effect.gen(function* stopJetemailImmediateScheduleMismatch() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 201,
      });

      const outcome = yield* Effect.gen(function* submitScheduleWithImmediateStatus() {
        return yield* (yield* Email).send(scheduled);
      }).pipe(Effect.provide(fixtureJetemailLayer(fixture, 3)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "unexpected-status");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    { ...message, from: "sender@example.test" },
    { ...message, from: { address: "sender@example.test" } },
    { ...message, to: { address: "recipient@example.test", name: "Fictional" } },
    { ...message, sendAt: "2026-10-14T12:30:00.001Z" },
    { ...message, metadata: { workflow: "private-value" } },
    { ...message, tags: [{ name: "purpose", value: "private-value" }] },
    { ...message, headers: [{ name: "X-Scheduled-At", value: "private-value" }] },
    { ...message, headers: [{ name: "X-Idempotency-Key", value: "private-key" }] },
    { ...message, headers: [{ name: "X-JetEmail-Setting", value: "private-value" }] },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "first" },
        { name: "x-workflow", value: "second" },
      ],
    },
    {
      ...message,
      attachments: [{ contentBase64: "AQ==", contentType: "text/plain", filename: "sample.txt" }],
    },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQ==",
          contentId: "sample-cid",
          contentType: "ProviderSelected",
          filename: "sample.png",
        },
      ],
    },
  ] as const)("rejects nonrepresentable intent rather than dropping it before HTTP (%j)", (input) =>
    Effect.gen(function* rejectJetemailIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 201,
      });

      const outcome = yield* Effect.gen(function* submitUnsupportedJetemailIntent() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureJetemailLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live.each([
    "",
    "api_private-management-key",
    "transactional_private key",
    "transactional_",
    "transactional_private\nkey",
  ])("requires safe transactional credentials without exposing rejected tokens (%j)", (apiKey) =>
    Effect.gen(function* rejectJetemailCredential() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 201,
      });

      const outcome = yield* Effect.gen(function* submitInvalidJetemailCredential() {
        return yield* (yield* Email).send(message);
      }).pipe(
        Effect.provide(
          jetemailEmailLayer({ ...options, apiKey: Redacted.make(apiKey) }, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.jetemail.com")),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
      assert.notInclude(JSON.stringify(outcome.failure), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live("requires explicit disabled domain tracking and hidden-recipient attestations", () =>
    Effect.gen(function* requireJetemailDomainAuthority() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 201,
      });

      // @ts-expect-error -- Untyped callers must not bypass the disabled tracking attestation.
      const withoutTracking = jetemailEmailLayer({
        apiKey: options.apiKey,
        automaticBcc: "DomainDisabled",
      });

      // @ts-expect-error -- Untyped callers must not bypass the hidden-recipient attestation.
      const withoutBcc = jetemailEmailLayer({ apiKey: options.apiKey, tracking: "DomainDisabled" });

      for (const layer of [withoutTracking, withoutBcc]) {
        const outcome = yield* Effect.gen(function* submitUnattestedDomain() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            layer.pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.jetemail.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
      }

      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect(
    "retries only definite account rate rejection with identical owned body and forwarded key",
    () =>
      Effect.gen(function* retryJetemailRateRejection() {
        const fixture = yield* startEmailHttpFixture({
          body: "private-rate-reason",
          next: { body: JSON.stringify(acknowledgement), status: 201 },
          retryAfter: "2",
          status: 429,
        });

        const input: Omit<typeof message, "subject"> & { subject: string } = { ...message };

        const fiber = yield* Effect.gen(function* submitJetemailRateLimitedIntent() {
          return yield* (yield* Email).send(input, { idempotencyKey: "synthetic-stable-key" });
        }).pipe(Effect.provide(fixtureJetemailLayer(fixture, 3)), Effect.forkScoped);

        const first = yield* Queue.take(fixture.received);
        input.subject = "private-mutated-subject";
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        yield* TestClock.adjust(1000);
        assert(EmailReceiptSchema.guards.Accepted(yield* Fiber.join(fiber)));
        const retry = yield* Queue.take(fixture.received);
        assert.strictEqual(retry.body, first.body);
        assert.strictEqual(retry.idempotencyKey, "synthetic-stable-key");
        assert.strictEqual(retry.idempotencyKey, first.idempotencyKey);
        assert.notInclude(retry.body, "private-mutated");
      }),
  );

  it.live(
    "advances a real backup only after authentication non-acceptance while forwarding the same key",
    () =>
      Effect.gen(function* fallBackFromJetemailAuthentication() {
        const primary = yield* startEmailHttpFixture({
          body: "private-authentication-reason",
          status: 401,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* sendJetemailRoute.pipe(
          Effect.provide(fixtureJetemailRoute(primary, backup, 3)),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual(
          (yield* Queue.take(primary.received)).idempotencyKey,
          "synthetic-stable-key",
        );
        assert.strictEqual(
          (yield* Queue.take(backup.received)).idempotencyKey,
          "synthetic-stable-key",
        );
      }),
  );

  it.live(
    "keeps accepted immediate submission terminal and forwards the maximum key unchanged",
    () =>
      Effect.gen(function* preserveJetemailKeyAndAcceptance() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 201,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitMaximumJetemailKey() {
          return yield* (yield* (yield* EmailRouter).select()).send(message, {
            idempotencyKey: "k".repeat(256),
          });
        }).pipe(Effect.provide(fixtureJetemailRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual((yield* Queue.take(primary.received)).idempotencyKey, "k".repeat(256));
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );
});
