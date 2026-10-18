import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Result, Schema } from "effect";
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
import { plunkEmailLayer } from "./plunk-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic café</p>" },
  from: "sender@example.test",
  subject: "Synthetic Plunk example",
  to: ["recipient@example.test"],
} as const;

const options = {
  apiKey: Redacted.make("sk_fictional-project-key"),
  contactWrites: "AllowUpsert",
  tracking: "ProjectDisabled",
} as const;

const policy = { deadline: Duration.seconds(5), initialDelay: Duration.millis(1), maxAttempts: 1 };

const acknowledgement = {
  data: {
    emails: [
      {
        contact: { email: "recipient@example.test", id: "private-contact-id" },
        email: "synthetic-message-id",
      },
    ],
  },
  success: true,
};

const fixturePlunkLayer = (fixture: EmailHttpFixture, maxAttempts = 1) =>
  plunkEmailLayer(options, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://next-api.useplunk.com")),
  );

describe("Plunk actual single-recipient protocol", () => {
  it.live(
    "preserves HTML, structured names, binary/CID intent and headers without changing contact subscription/data",
    () =>
      Effect.gen(function* inspectPlunkWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichPlunkMessage() {
          const attachment = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentType: "text/plain",
            filename: "sample.txt",
          });

          const inline = yield* emailAttachmentFromBytes(new Uint8Array([255, 0, 1]), {
            contentId: "sample-image",
            contentType: "image/png",
            filename: "sample.png",
          });

          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [attachment, inline],
              from: { address: message.from, name: "Fictional Café" },
              headers: [{ name: "X-Workflow", value: "synthetic-value" }],
              replyTo: "reply@example.test",
              to: { address: "recipient@example.test", name: "Doe, Fictional" },
            },
            { idempotencyKey: "synthetic-key" },
          );
        }).pipe(Effect.provide(fixturePlunkLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "synthetic-message-id");
        assert.isTrue(Object.isFrozen(receipt));
        assert.notInclude(JSON.stringify(receipt), "private-contact-id");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/v1/send");
        assert.strictEqual(sent.authorization, "Bearer sk_fictional-project-key");
        assert.strictEqual(sent.idempotencyKey, "synthetic-key");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({
                  content: Schema.String,
                  contentId: Schema.optionalKey(Schema.String),
                  contentType: Schema.String,
                  disposition: Schema.String,
                  filename: Schema.String,
                }),
              ),
              body: Schema.String,
              data: Schema.optionalKey(Schema.Json),
              from: Schema.Struct({ email: Schema.String, name: Schema.String }),
              headers: Schema.Record(Schema.String, Schema.String),
              reply: Schema.String,
              subject: Schema.String,
              subscribed: Schema.optionalKey(Schema.Boolean),
              to: Schema.Struct({ email: Schema.String, name: Schema.String }),
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.body, message.body.html);
        assert.strictEqual(wire.from.email, message.from);
        assert.strictEqual(wire.from.name, "Fictional Café");
        assert.strictEqual(wire.to.email, "recipient@example.test");
        assert.strictEqual(wire.to.name, "Doe, Fictional");
        assert.strictEqual(wire.reply, "reply@example.test");
        assert.strictEqual(wire.headers["X-Workflow"], "synthetic-value");
        assert.strictEqual(wire.subject, message.subject);
        assert.isUndefined(wire.data);
        assert.isUndefined(wire.subscribed);
        const [attachment, inline] = wire.attachments;
        assert.isDefined(attachment);
        assert.isDefined(inline);
        assert.strictEqual(attachment.contentType, "text/plain");
        assert.strictEqual(attachment.disposition, "attachment");
        assert.isUndefined(attachment.contentId);
        assert.strictEqual(inline.contentId, "sample-image");
        assert.strictEqual(inline.disposition, "inline");
        assert.strictEqual(inline.contentType, "image/png");
        assert.deepStrictEqual([...Buffer.from(attachment.content, "base64")], [0, 255, 128, 10]);
        assert.deepStrictEqual([...Buffer.from(inline.content, "base64")], [255, 0, 1]);
      }),
  );

  it.live.each([
    { ...acknowledgement, success: false },
    { data: { emails: [] }, success: true },
    { data: { emails: [{ email: "misleading-id" }] }, success: true },
    {
      data: { emails: [{ contact: { email: "foreign@example.test" }, email: "synthetic-id" }] },
      success: true,
    },
    {
      data: { emails: [...acknowledgement.data.emails, ...acknowledgement.data.emails] },
      success: true,
    },
    {
      data: { emails: [{ contact: { email: "recipient@example.test" }, email: "invalid id" }] },
      success: true,
    },
    { ...acknowledgement, error: { message: "private-error" } },
    { id: "misleading-top-level-id", success: true },
  ])("keeps false/foreign/incomplete/contradictory acknowledgement unknown (%j)", (body) =>
    Effect.gen(function* rejectUnprovenPlunkAcceptance() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const outcome = yield* Effect.gen(function* submitUnprovenPlunkMessage() {
        return yield* (yield* (yield* EmailRouter).select()).send(message, {
          idempotencyKey: "synthetic-key",
        });
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: fixturePlunkLayer(fixture, 3), name: "primary" },
              {
                layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                  Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
                ),
                name: "backup",
              },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(outcome) && outcome.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(outcome.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(backup.received), 0);
      assert.notInclude(JSON.stringify(outcome.failure), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live(
    "accepts case-insensitive recipient evidence but never exposes provider contact identity",
    () =>
      Effect.gen(function* validatePlunkRecipientEvidence() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            data: {
              emails: [
                {
                  contact: { email: "RECIPIENT@EXAMPLE.TEST", id: "private-contact-id" },
                  email: "synthetic-id",
                },
              ],
            },
            success: true,
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitPlunkRecipientEvidence() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixturePlunkLayer(fixture), name: "primary" },
                {
                  layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                    Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
                  ),
                  name: "backup",
                },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "synthetic-id");
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual(yield* Queue.size(backup.received), 0);
        assert.notInclude(JSON.stringify(receipt), "private");
      }),
  );

  it.live.each([
    { ...message, body: { text: "Synthetic text" } },
    { ...message, body: { html: "<p>Synthetic</p>", text: "Synthetic text" } },
    { ...message, to: ["first@example.test", "second@example.test"] },
    { ...message, cc: "copy@example.test" },
    { ...message, bcc: "hidden@example.test" },
    { ...message, replyTo: { address: "reply@example.test", name: "Fictional" } },
    { ...message, replyTo: ["reply@example.test", "other@example.test"] },
    { ...message, metadata: { reset_code: "private-value" } },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    { ...message, tags: [{ name: "workflow", value: "synthetic" }] },
    {
      ...message,
      attachments: [
        { contentBase64: "AQ==", contentType: "ProviderSelected", filename: "sample.txt" },
      ],
    },
    {
      ...message,
      headers: [
        { name: "X-Workflow", value: "first" },
        { name: "x-workflow", value: "second" },
      ],
    },
  ] as const)(
    "rejects nonrepresentable or contact-mutating intent before transport (%j)",
    (input) =>
      Effect.gen(function* rejectPlunkIntent() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitRejectedPlunkIntent() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixturePlunkLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailInvalidMessage);
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([
    { apiKey: options.apiKey, tracking: "ProjectDisabled" },
    { apiKey: options.apiKey, contactWrites: "AllowUpsert" },
  ] as const)(
    "requires explicit contact-write authorization and project tracking attestation (%j)",
    (configuration) =>
      Effect.gen(function* requirePlunkAuthorization() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        // @ts-expect-error -- Untyped callers must not bypass either required authorization field.
        const layer = plunkEmailLayer(configuration, policy).pipe(
          Layer.provide(emailFixtureClientLayer(fixture.url, "https://next-api.useplunk.com")),
        );

        const outcome = yield* Effect.gen(function* submitUnauthorizedPlunkOperation() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(layer), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each(["", "pk_public-tracking-key", "sk_private key", "sk_private\nvalue", "sk_café"])(
    "rejects invalid/public credentials without disclosing their values (%j)",
    (token) =>
      Effect.gen(function* rejectPlunkCredentials() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitInvalidPlunkCredentials() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            plunkEmailLayer({ ...options, apiKey: Redacted.make(token) }, policy).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://next-api.useplunk.com")),
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.notInclude(JSON.stringify(outcome.failure), "public-tracking-key");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );

  it.live.each([400, 401, 402, 403, 404, 405, 413, 422, 500, 503, 202, 204, 302, 409])(
    "classifies HTTP evidence without retaining provider reasons (%s)",
    (status) =>
      Effect.gen(function* classifyPlunkStatus() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ ...acknowledgement, reason: "private-provider-reason" }),
          status,
        });

        const outcome = yield* Effect.gen(function* submitPlunkStatus() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixturePlunkLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome));

        if (status >= 500 || status < 400 || status === 409) {
          assert(outcome.failure instanceof EmailDeliveryUnknown);
        } else {
          assert(outcome.failure instanceof EmailRejected);

          if (status === 401) {
            assert.strictEqual(outcome.failure.reason, "authentication");
          } else if ([400, 413, 422].includes(status)) {
            assert.strictEqual(outcome.failure.reason, "invalid-message");
          } else {
            assert.strictEqual(outcome.failure.reason, "rejected");
          }
        }

        assert.notInclude(JSON.stringify(outcome.failure), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each(["RATE_LIMIT_EXCEEDED", "BILLING_LIMIT_EXCEEDED", "unknown"])(
    "retries only classified endpoint rate evidence (%s)",
    (code) =>
      Effect.gen(function* classifyPlunkRateEvidence() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: { code, message: "private-provider-reason" },
            success: false,
          }),
          retryAfter: "2",
          status: 429,
        });

        const outcome = yield* Effect.gen(function* submitPlunkRateEvidence() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixturePlunkLayer(fixture)), Effect.result);

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(
          outcome.failure.reason,
          code === "RATE_LIMIT_EXCEEDED" ? "rate-limited" : "rejected",
        );

        if (code === "RATE_LIMIT_EXCEEDED") {
          assert.strictEqual(outcome.failure.retryAfterMillis, 2000);
        }
      }),
  );

  it.live(
    "treats native key reuse as terminal conflict, not reconstructed acceptance or safe fallback",
    () =>
      Effect.gen(function* verifyPlunkReuseRefusal() {
        const primary = yield* startEmailHttpFixture({
          body: "private-server-error",
          next: {
            body: JSON.stringify({
              error: { code: "IDEMPOTENCY_KEY_REUSED", message: "private-provider-reason" },
              success: false,
            }),
            status: 409,
          },
          status: 503,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const outcome = yield* Effect.gen(function* submitPlunkReuseRoute() {
          return yield* (yield* (yield* EmailRouter).select()).send(message, {
            idempotencyKey: "synthetic-stable-key",
          });
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixturePlunkLayer(primary, 3), name: "primary" },
                {
                  layer: resendEmailLayer({ apiKey: Redacted.make("fictional-key") }, policy).pipe(
                    Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
                  ),
                  name: "backup",
                },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ),
          ),
          Effect.result,
        );

        assert(Result.isFailure(outcome) && outcome.failure instanceof EmailRejected);
        assert.strictEqual(outcome.failure.reason, "idempotency-conflict");
        const first = yield* Queue.take(primary.received);
        const replay = yield* Queue.take(primary.received);
        assert.strictEqual(first.body, replay.body);
        assert.strictEqual(first.idempotencyKey, replay.idempotencyKey);
        assert.strictEqual(replay.idempotencyKey, "synthetic-stable-key");
        assert.strictEqual(yield* Queue.size(primary.received), 0);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live("bounds native keys and succeeds only after correlated acknowledgement", () =>
    Effect.gen(function* verifyPlunkKeyPreflight() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      yield* Effect.gen(function* submitBoundedPlunkKeys() {
        const email = yield* Email;

        const tooLong = yield* email
          .validate(message, { idempotencyKey: "k".repeat(256) })
          .pipe(Effect.result);

        assert(Result.isFailure(tooLong) && tooLong.failure instanceof EmailRejected);
        assert.strictEqual(tooLong.failure.reason, "unsupported-idempotency");
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        const receipt = yield* email.send(message, { idempotencyKey: "k".repeat(255) });
        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }).pipe(Effect.provide(fixturePlunkLayer(fixture)));
    }),
  );
});
