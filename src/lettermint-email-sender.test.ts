import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Result, Schema, Tracer } from "effect";
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
  EmailSender,
  EmailMessageSchema,
  EmailIdempotencyKeySchema,
  emailRouterLayer,
  emailAttachmentFromBytes,
} from "./index.js";
import { lettermintEmailLayer, lettermintSenderLayer } from "./lettermint-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café</p>", text: "Synthetic café" },
  from: "sender@example.test",
  subject: "Synthetic Lettermint example",
  to: ["recipient@example.test"],
} as const;

const policy = { deadline: Duration.seconds(5), initialDelay: Duration.millis(1), maxAttempts: 1 };

const options = { apiToken: Redacted.make("fictional-project-token"), route: "transactional" };

const acknowledgement = JSON.stringify({ message_id: "synthetic-message-id", status: "pending" });

const fixtureLettermintLayer = (fixture: EmailHttpFixture, maxAttempts = 1) =>
  lettermintEmailLayer(options, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.lettermint.co")),
  );

describe("Lettermint actual single-send protocol", () => {
  it.live(
    "preserves structured tags, CID authority, MIME choice, headers and visibility with tracking disabled",
    () =>
      Effect.gen(function* inspectLettermintWire() {
        const fixture = yield* startEmailHttpFixture({ body: acknowledgement, status: 202 });

        const receipt = yield* Effect.gen(function* submitRichLettermintMessage() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentId: "sample@example.test",
            contentType: "text/plain",
            disposition: "inline",
            filename: "sample.txt",
          });

          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [
                attachment,
                {
                  ...attachment,
                  contentId: "other@example.test",
                  contentType: "ProviderSelected",
                  filename: "other.dat",
                },
              ],
              bcc: "hidden@example.test",
              cc: "copy@example.test",
              from: { address: message.from, name: "Fictional Café" },
              headers: [
                { name: "X-Workflow", value: "synthetic-value" },
                { name: "Message-ID", value: "<example@example.test>" },
              ],
              metadata: { workflow: "synthetic café" },
              replyTo: ["reply@example.test", "other@example.test"],
              tags: [
                { name: "purpose", value: "synthetic" },
                { name: "stage", value: "example" },
              ],
              to: [
                { address: "first@example.test", name: "Doe, Fictional" },
                "second@example.test",
              ],
            },
            { idempotencyKey: "synthetic-key" },
          );
        }).pipe(Effect.provide(fixtureLettermintLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.isTrue(Object.isFrozen(receipt));
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/v1/send");
        assert.strictEqual(sent.lettermintToken, "fictional-project-token");
        assert.strictEqual(sent.authorization, "");
        assert.strictEqual(sent.idempotencyKey, "synthetic-key");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({
                  content: Schema.String,
                  content_id: Schema.String,
                  content_type: Schema.optionalKey(Schema.String),
                  filename: Schema.String,
                }),
              ),
              bcc: Schema.Array(Schema.String),
              cc: Schema.Array(Schema.String),
              from: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
              html: Schema.String,
              metadata: Schema.Record(Schema.String, Schema.String),
              reply_to: Schema.Array(Schema.String),
              route: Schema.String,
              settings: Schema.Struct({
                track_clicks: Schema.Boolean,
                track_opens: Schema.Boolean,
              }),
              subject: Schema.String,
              tags: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
              text: Schema.String,
              to: Schema.Array(Schema.String),
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.from, '"Fictional Café" <sender@example.test>');
        assert.deepStrictEqual(
          [...wire.to],
          ['"Doe, Fictional" <first@example.test>', "second@example.test"],
        );
        assert.deepStrictEqual([...wire.cc], ["copy@example.test"]);
        assert.deepStrictEqual([...wire.bcc], ["hidden@example.test"]);
        assert.deepStrictEqual([...wire.reply_to], ["reply@example.test", "other@example.test"]);
        assert.strictEqual(wire.route, "transactional");
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.text, message.body.text);
        assert.strictEqual(wire.html, message.body.html);
        assert.strictEqual(wire.headers["Message-ID"], "<example@example.test>");
        assert.strictEqual(wire.headers["X-LM-Preserve-Message-ID"], "true");
        assert.strictEqual(wire.metadata.workflow, "synthetic café");
        assert.deepStrictEqual(
          wire.tags.map((tag) => [tag.name, tag.value]),
          [
            ["purpose", "synthetic"],
            ["stage", "example"],
          ],
        );
        assert.isFalse(wire.settings.track_opens);
        assert.isFalse(wire.settings.track_clicks);
        const [explicit, delegated] = wire.attachments;
        assert.isDefined(explicit);
        assert.isDefined(delegated);
        assert.strictEqual(explicit.content_id, "sample@example.test");
        assert.strictEqual(explicit.content_type, "text/plain");
        assert.strictEqual(delegated.content_id, "other@example.test");
        assert.isUndefined(delegated.content_type);
        assert.deepStrictEqual([...Buffer.from(explicit.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(delegated.content, explicit.content);
      }),
  );

  it.live.each(["2026-10-13T12:30:00.123Z", "2026-10-13T12:30:00.123+00:00"])(
    "verifies exact normalized scheduled acknowledgement without rounding milliseconds (%s)",
    (nativeTime) =>
      Effect.gen(function* verifyLettermintSchedule() {
        const scheduledAt = "2026-10-13T12:30:00.123Z";

        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            message_id: "synthetic-scheduled-id",
            scheduled_at: nativeTime,
            status: "scheduled",
          }),
          status: 202,
        });

        const receipt = yield* Effect.gen(function* submitScheduledMessage() {
          return yield* (yield* Email).send({ ...message, sendAt: scheduledAt });
        }).pipe(Effect.provide(fixtureLettermintLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        const sent = yield* Queue.take(fixture.received);

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ scheduled_at: Schema.String })),
        )(sent.body);

        assert.strictEqual(wire.scheduled_at, scheduledAt);
      }),
  );

  it.live.each([
    { scheduled_at: "invalid-time", status: "scheduled" },
    { scheduled_at: "2026-10-13T12:30:01.123Z", status: "scheduled" },
    { status: "scheduled" },
    { status: "pending" },
  ])("keeps unfulfilled scheduling evidence unknown without a parsing defect (%j)", (fields) =>
    Effect.gen(function* verifyUnfulfilledLettermintSchedule() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({ message_id: "synthetic-id", ...fields }),
        status: 202,
      });

      const outcome = yield* Effect.gen(function* submitUnfulfilledSchedule() {
        return yield* (yield* Email).send({ ...message, sendAt: "2026-10-13T12:30:00.123Z" });
      }).pipe(Effect.provide(fixtureLettermintLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([false, true])(
    "stops actual backup after live or sandbox acknowledgement (%s)",
    (sandbox) =>
      Effect.gen(function* verifyTerminalLettermintReceipt() {
        const trace = yield* startEmailTraceFixture();

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(
            sandbox
              ? {
                  message_id: "synthetic-message-id",
                  private_result: "private-response-data",
                  sandbox: true,
                  sandbox_result: "suppressed",
                  status: "pending",
                }
              : {
                  message_id: "synthetic-message-id",
                  private_result: "private-response-data",
                  status: "pending",
                },
          ),
          status: 202,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitLettermintRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixtureLettermintLayer(primary), name: "primary" },
                {
                  layer: resendEmailLayer(
                    { apiKey: Redacted.make("fictional-token") },
                    policy,
                  ).pipe(
                    Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
                  ),
                  name: "backup",
                },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.provideService(Tracer.Tracer, trace.tracer),
        );

        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "Lettermint.submit");
        assert.notInclude(diagnostics, "synthetic-message-id");
        assert.notInclude(diagnostics, "private");
        assert.notInclude(diagnostics, "suppressed");
        assert.strictEqual(receipt._tag, sandbox ? "Simulated" : "Accepted");
        assert.strictEqual(receipt.route, "primary");
        assert.notInclude(JSON.stringify(receipt), "private");
        assert.notInclude(JSON.stringify(receipt), "suppressed");
        assert.isTrue(Object.isFrozen(receipt));
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    {},
    { message_id: "synthetic-id" },
    { message_id: "synthetic-id", status: "sent" },
    { message_id: "synthetic-id", status: "scheduled" },
    { message_id: "synthetic-id", scheduled_at: "invalid-time", status: "scheduled" },
    { message_id: "synthetic-id", scheduled_at: "2026-10-13T12:30:00Z", status: "pending" },
    { message_id: "synthetic-id", sandbox_result: "delivered", status: "pending" },
    { message_id: "synthetic-id", sandbox: "true", status: "pending" },
    { message_id: "synthetic-id", sandbox: true, sandbox_result: "unknown", status: "pending" },
  ])("keeps malformed or contradictory acknowledgement unknown (%j)", (body) =>
    Effect.gen(function* verifyUnknownLettermintAck() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 202 });

      const outcome = yield* Effect.gen(function* submitUnknownLettermintAck() {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(fixtureLettermintLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    { ...message, body: { text: "Hi" } },
    { ...message, tags: [{ name: "purpose", value: "synthetic café" }] },
    { ...message, tags: [{ name: "x".repeat(33), value: "synthetic" }] },
    { ...message, headers: [{ name: "X-LM-Preserve-Message-ID", value: "false" }] },
    { ...message, headers: [{ name: "Message-ID", value: "repair-required" }] },
    { ...message, headers: [{ name: "X-Lettermint-Token", value: "private-token" }] },
    {
      ...message,
      attachments: [
        {
          contentBase64: "AQ==",
          contentId: "renamed-by-provider",
          contentType: "text/plain",
          disposition: "inline",
          filename: "sample.txt",
        },
      ],
    },
  ] as const)("rejects nonrepresentable intent without transport (%j)", (input) =>
    Effect.gen(function* rejectLettermintIntent() {
      const fixture = yield* startEmailHttpFixture({ body: acknowledgement, status: 202 });

      const outcome = yield* Effect.gen(function* submitInvalidLettermintIntent() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureLettermintLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(outcome.failure), "private-token");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live.each([401, 403, 400, 413, 422, 404, 405, 500, 503, 200, 204, 302, 409])(
    "classifies status without copying private reasons (%s)",
    (status) =>
      Effect.gen(function* classifyLettermintStatus() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            message: "private-provider-reason",
            message_id: "misleading-id",
            status: "pending",
          }),
          status,
        });

        const outcome = yield* Effect.gen(function* submitLettermintStatus() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureLettermintLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome));

        if (status >= 500 || status < 400 || status === 409) {
          assert(outcome.failure instanceof EmailDeliveryUnknown);
        } else {
          assert(outcome.failure instanceof EmailRejected);
        }

        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.notInclude(outcome.failure.message, "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each(["RATE_LIMITED", "DAILY_LIMIT", "unknown"])(
    "requires actual transient endpoint evidence (%s)",
    (code) =>
      Effect.gen(function* verifyLettermintRateEvidence() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ error: { code, message: "private-provider-reason" } }),
          retryAfter: "2",
          status: 429,
        });

        const outcome = yield* Effect.gen(function* submitLettermintRate() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureLettermintLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(
          outcome.failure.reason,
          code === "RATE_LIMITED" ? "rate-limited" : "rejected",
        );
        assert.strictEqual(outcome.failure.retryAfterMillis, 2000);
      }),
  );

  it.live("classifies plan-feature refusal without claiming failed authentication", () =>
    Effect.gen(function* verifyLettermintFeatureRefusal() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          error: { code: "FEATURE_NOT_AVAILABLE", message: "private-plan-reason" },
        }),
        status: 403,
      });

      const outcome = yield* Effect.gen(function* submitUnavailableLettermintFeature() {
        return yield* (yield* Email).send(message);
      }).pipe(Effect.provide(fixtureLettermintLayer(fixture)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
      assert.strictEqual(outcome.failure.reason, "rejected");
      assert.notInclude(JSON.stringify(outcome.failure), "private");
    }),
  );

  it.live("keeps documented payload conflict distinct from concurrent uncertainty", () =>
    Effect.gen(function* distinguishLettermintConflict() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          message:
            "This idempotency key has already been used on a request with a different payload. Retrying this request requires changing the idempotency key or payload.",
        }),
        status: 409,
      });

      const outcome = yield* Effect.gen(function* submitLettermintConflict() {
        return yield* (yield* Email).send(message, { idempotencyKey: "synthetic-key" });
      }).pipe(Effect.provide(fixtureLettermintLayer(fixture, 3)), Effect.result);

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
      assert.strictEqual(outcome.failure.reason, "idempotency-conflict");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([false, true])(
    "replays native unknown only with a stable project-local key (%s)",
    (keyed) =>
      Effect.gen(function* verifyLettermintNativeReplay() {
        const fixture = yield* startEmailHttpFixture({
          body: "private-server-error",
          next: { body: acknowledgement, status: 202 },
          status: 503,
        });

        const outcome = yield* Effect.gen(function* submitLettermintReplay() {
          return yield* (yield* Email).send(
            message,
            keyed ? { idempotencyKey: "synthetic-stable-key" } : {},
          );
        }).pipe(Effect.provide(fixtureLettermintLayer(fixture, 2)), Effect.result);

        const first = yield* Queue.take(fixture.received);

        if (keyed) {
          assert(Result.isSuccess(outcome) && EmailReceiptSchema.guards.Accepted(outcome.success));
          const second = yield* Queue.take(fixture.received);
          assert.strictEqual(first.body, second.body);
          assert.strictEqual(first.idempotencyKey, "synthetic-stable-key");
          assert.strictEqual(second.idempotencyKey, first.idempotencyKey);
          assert.strictEqual(second.lettermintToken, first.lettermintToken);
        } else {
          assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
        }

        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live("defends the native key bound on direct sender submissions", () =>
    Effect.gen(function* verifyDirectLettermintKeyBound() {
      const fixture = yield* startEmailHttpFixture({ body: acknowledgement, status: 202 });

      const outcome = yield* Effect.gen(function* submitDirectOversizedKey() {
        const sender = yield* EmailSender;
        const parsedMessage = yield* Schema.decodeEffect(EmailMessageSchema)(message);

        const idempotencyKey = yield* Schema.decodeEffect(EmailIdempotencyKeySchema)(
          "k".repeat(256),
        );

        return yield* sender.submit({ idempotencyKey, message: parsedMessage });
      }).pipe(
        Effect.provide(
          lettermintSenderLayer(options).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.lettermint.co")),
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
      assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live.each([255, 256])(
    "preflights native key length across all routed candidates (%s)",
    (length) =>
      Effect.gen(function* verifyLettermintKeyBound() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "primary-id" }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({ body: acknowledgement, status: 202 });

        const outcome = yield* Effect.gen(function* submitNativeBoundRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message, {
            idempotencyKey: "k".repeat(length),
          });
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                {
                  layer: resendEmailLayer(
                    { apiKey: Redacted.make("fictional-token") },
                    policy,
                  ).pipe(
                    Layer.provide(emailFixtureClientLayer(primary.url, "https://api.resend.com")),
                  ),
                  name: "primary",
                },
                { layer: fixtureLettermintLayer(backup), name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.result,
        );

        if (length === 255) {
          assert(Result.isSuccess(outcome));
          assert.strictEqual(yield* Queue.size(primary.received), 1);
        } else {
          assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
          assert.strictEqual(outcome.failure.reason, "unsupported-idempotency");
          assert.strictEqual(yield* Queue.size(primary.received), 0);
        }

        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each(["", "private token", "private\nvalue", "private-café"])(
    "validates owned credentials without private diagnostics (%j)",
    (token) =>
      Effect.gen(function* validateLettermintCredentials() {
        const fixture = yield* startEmailHttpFixture({ body: acknowledgement, status: 202 });

        const outcome = yield* Effect.gen(function* submitInvalidLettermintConfig() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            lettermintEmailLayer({ apiToken: Redacted.make(token) }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.lettermint.co")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
