import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  emailRouterLayer,
  emailAttachmentFromBytes,
} from "./index.js";
import { unosendEmailLayer } from "./unosend-email-sender.js";
import { sendgridEmailLayer } from "./sendgrid-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café</p>", text: "Synthetic café" },
  from: "sender@example.test",
  subject: "Synthetic Unosend example",
  to: ["recipient@example.test"],
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const options = { apiKey: Redacted.make("fictional-api-token") };

const acknowledgement = JSON.stringify({
  data: { id: "synthetic-message-id", status: "queued" },
  success: true,
});

const fixtureUnosendLayer = (fixture: EmailHttpFixture) =>
  unosendEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.unosend.co")),
  );

describe("Unosend actual single-send protocol", () => {
  it.live(
    "preserves rich intent, exact scheduling and binary content while turning off tracking",
    () =>
      Effect.gen(function* observeUnosendWire() {
        const fixture = yield* startEmailHttpFixture({ body: acknowledgement, status: 200 });

        const receipt = yield* Effect.gen(function* submitUnosendMessage() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentType: "text/plain",
            disposition: "attachment",
            filename: "sample.txt",
          });

          return yield* (yield* Email).send({
            ...message,
            attachments: [attachment],
            bcc: "hidden@example.test",
            cc: "copy@example.test",
            from: { address: message.from, name: "Fictional Café" },
            headers: [{ name: "X-Workflow", value: "synthetic-value" }],
            replyTo: "reply@example.test",
            sendAt: "2026-10-13T12:30:00.123Z",
            tags: [{ name: "purpose", value: "synthetic café" }],
            to: [{ address: "first@example.test", name: "Doe, Fictional" }, "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureUnosendLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "synthetic-message-id");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/emails");
        assert.strictEqual(sent.authorization, "Bearer fictional-api-token");
        assert.strictEqual(sent.idempotencyKey, "");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({
                  content: Schema.String,
                  content_type: Schema.String,
                  filename: Schema.String,
                }),
              ),
              bcc: Schema.Array(Schema.String),
              cc: Schema.Array(Schema.String),
              from: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
              html: Schema.String,
              reply_to: Schema.String,
              scheduled_for: Schema.String,
              subject: Schema.String,
              tags: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
              text: Schema.String,
              to: Schema.Array(Schema.String),
              tracking: Schema.Struct({ click: Schema.Boolean, open: Schema.Boolean }),
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
        assert.strictEqual(wire.reply_to, "reply@example.test");
        assert.strictEqual(wire.headers["X-Workflow"], "synthetic-value");
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.text, message.body.text);
        assert.strictEqual(wire.html, message.body.html);
        assert.strictEqual(wire.scheduled_for, "2026-10-13T12:30:00.123Z");
        assert.strictEqual(wire.tags[0]?.name, "purpose");
        assert.strictEqual(wire.tags[0]?.value, "synthetic café");
        assert.isFalse(wire.tracking.click);
        assert.isFalse(wire.tracking.open);
        const [attachment] = wire.attachments;
        assert.isDefined(attachment);
        assert.strictEqual(attachment.content_type, "text/plain");
        assert.strictEqual(attachment.filename, "sample.txt");
        assert.deepStrictEqual([...Buffer.from(attachment.content, "base64")], [0, 255, 128, 10]);
      }),
  );

  it.live("stops routing after acknowledgement without retaining unrelated lifecycle fields", () =>
    Effect.gen(function* retainUnosendAcknowledgement() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({
          data: {
            id: "synthetic-correlation-id",
            status: "scheduled",
            to: ["private-response-recipient@example.test"],
          },
          success: true,
        }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({ body: "", status: 202 });

      const receipt = yield* Effect.gen(function* submitAcknowledgedRoute() {
        return yield* (yield* (yield* EmailRouter).select()).send(message);
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: fixtureUnosendLayer(primary), name: "primary" },
              {
                layer: sendgridEmailLayer(
                  { apiKey: Redacted.make("fictional-token") },
                  policy,
                ).pipe(
                  Layer.provide(emailFixtureClientLayer(backup.url, "https://api.sendgrid.com")),
                ),
                name: "backup",
              },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
      );

      assert(EmailReceiptSchema.guards.Accepted(receipt));
      assert.strictEqual(receipt.messageId, "synthetic-correlation-id");
      assert.strictEqual(receipt.route, "primary");
      assert.notInclude(JSON.stringify(receipt), "private");
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([
    {
      body: '{"error":{"code":"validation_error","message":"private-payload"}}',
      reason: "invalid-message",
      status: 400,
    },
    { body: "private-token", reason: "authentication", status: 401 },
    { body: "private-permission", reason: "authentication", status: 403 },
    { body: "private-resource", reason: "rejected", status: 404 },
    { body: "private-payload", reason: "invalid-message", status: 422 },
    {
      body: '{"error":{"code":"rate_limit_exceeded","message":"private-rate"}}',
      reason: "rate-limited",
      status: 429,
    },
    {
      body: '{"error":{"code":"daily_limit_exceeded","message":"private-quota"}}',
      reason: "rejected",
      status: 429,
    },
    {
      body: '{"error":{"code":"quota_exceeded","message":"private-quota"}}',
      reason: "rejected",
      status: 429,
    },
    { body: "private-malformed-error", reason: "rejected", status: 429 },
    { body: "private-server", reason: "server-error", status: 500 },
    { body: acknowledgement, reason: "unexpected-status", status: 202 },
  ])(
    "distinguishes safe $reason at $status without generic quota/server retries",
    ({ body, reason, status }) =>
      Effect.gen(function* classifyUnosendEvidence() {
        const fixture = yield* startEmailHttpFixture({ body, retryAfter: "2", status });

        const error = yield* Effect.gen(function* submitFailingUnosend() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureUnosendLayer(fixture)), Effect.flip);

        assert(Schema.is(EmailRejected)(error) || Schema.is(EmailDeliveryUnknown)(error));
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.status, status);

        if (Schema.is(EmailRejected)(error) && reason === "rate-limited") {
          assert.strictEqual(error.retryAfterMillis, 2000);
        }

        assert.notInclude(JSON.stringify(error), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([
    '{"success":false,"data":{"id":"misleading-id"}}',
    '{"success":true}',
    '{"success":true,"data":{"id":"private invalid"}}',
    '{"id":"unwrapped-id","status":"queued"}',
    '{"success":true,"data":{"id":"id"},"error":{"code":"validation_error"}}',
    "not-json",
    JSON.stringify({ data: { id: "id" }, private: "x".repeat(65_536), success: true }),
  ])("retains uncertain contradictory acknowledgement %# without fallback", (body) =>
    Effect.gen(function* stopUncertainUnosendRouting() {
      const primary = yield* startEmailHttpFixture({ body, status: 200 });
      const backup = yield* startEmailHttpFixture({ body: "", status: 202 });

      const error = yield* Effect.gen(function* submitUncertainRoute() {
        return yield* (yield* (yield* EmailRouter).select()).send(message);
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: fixtureUnosendLayer(primary), name: "primary" },
              {
                layer: sendgridEmailLayer(
                  { apiKey: Redacted.make("fictional-token") },
                  policy,
                ).pipe(
                  Layer.provide(emailFixtureClientLayer(backup.url, "https://api.sendgrid.com")),
                ),
                name: "backup",
              },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailDeliveryUnknown)(error));
      assert.strictEqual(error.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
      assert.notInclude(JSON.stringify(error), "private");
    }),
  );

  it.live(
    "rejects unsupported CID, media authority, metadata, repeated headers and replay keys without HTTP",
    () =>
      Effect.gen(function* preflightUnosend() {
        const fixture = yield* startEmailHttpFixture({ body: acknowledgement, status: 200 });
        yield* Effect.gen(function* validateUnosendWithoutTransport() {
          const email = yield* Email;

          const attachment = {
            contentBase64: "AQ==",
            contentType: "text/plain",
            filename: "sample.txt",
          } as const;

          const intents = [
            { ...message, attachments: [{ ...attachment, contentId: "private-cid" }] },
            { ...message, attachments: [{ ...attachment, contentType: "ProviderSelected" }] },
            {
              ...message,
              attachments: [{ ...attachment, contentType: "application/octet-stream" }],
            },
            { ...message, metadata: { workflow: "private-value" } },
            { ...message, replyTo: ["reply@example.test", "other@example.test"] },
            {
              ...message,
              headers: [
                { name: "X-Workflow", value: "private-one" },
                { name: "x-workflow", value: "private-two" },
              ],
            },
          ] as const;

          for (const intent of intents) {
            const error = yield* email.validate(intent).pipe(Effect.flip);
            assert(Schema.is(EmailInvalidMessage)(error));
            assert.notInclude(JSON.stringify(error), "private");
          }

          const keyed = yield* email
            .send(message, { idempotencyKey: "private-key" })
            .pipe(Effect.flip);

          assert(Schema.is(EmailRejected)(keyed));
          assert.strictEqual(keyed.reason, "unsupported-idempotency");
        }).pipe(Effect.provide(fixtureUnosendLayer(fixture)));
        assert.strictEqual(yield* Queue.size(fixture.received), 0);

        const invalidConfiguration = yield* Effect.service(Email).pipe(
          Effect.provide(
            unosendEmailLayer({ apiKey: Redacted.make("private token") }).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.unosend.co")),
            ),
          ),
          Effect.flip,
        );

        assert(Schema.is(EmailConfigurationError)(invalidConfiguration));
        assert.notInclude(JSON.stringify(invalidConfiguration), "private");
      }),
  );
});
