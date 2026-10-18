import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailConfigurationError,
  EmailRouter,
  emailRouterLayer,
  emailAttachmentFromBytes,
} from "./index.js";
import { mailpaceEmailLayer } from "./mailpace-email-sender.js";
import { sendgridEmailLayer } from "./sendgrid-email-sender.js";

const message = {
  body: { html: "<p>Fictional café</p>", text: "Fictional café" },
  from: "sender@example.test",
  subject: "Synthetic MailPace notification",
  to: ["recipient@example.test"],
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const options = { serverToken: Redacted.make("fictional-domain-token") };

const fixtureMailpaceLayer = (fixture: EmailHttpFixture) =>
  mailpaceEmailLayer(options, policy).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.mailpace.com")),
  );

describe("MailPace faithful HTTP protocol", () => {
  it.live(
    "preserves rich intent, binary bytes and angle-bracket CID identity with native pending acknowledgement",
    () =>
      Effect.gen(function* observeMailpaceWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: 725, status: "pending" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitMailpaceMessage() {
          const inline = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
            contentId: "logo",
            contentType: "image/png",
            filename: "logo.png",
          });

          const file = yield* emailAttachmentFromBytes(new TextEncoder().encode("Fictional café"), {
            contentType: "text/plain",
            disposition: "attachment",
            filename: "note.txt",
          });

          return yield* (yield* Email).send({
            ...message,
            attachments: [inline, file],
            bcc: "hidden@example.test",
            cc: "copy@example.test",
            from: { address: message.from, name: "Fictional Café" },
            headers: [
              { name: "In-Reply-To", value: "<parent@example.test>" },
              { name: "References", value: "<first@example.test> <parent@example.test>" },
              { name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.test>" },
            ],
            replyTo: "reply@example.test",
            tags: [{ name: "purpose", value: "synthetic café" }],
            to: [{ address: "first@example.test", name: "Doe, Fictional" }, "second@example.test"],
          });
        }).pipe(Effect.provide(fixtureMailpaceLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, "725");
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.method, "POST");
        assert.strictEqual(sent.path, "/api/v1/send");
        assert.strictEqual(sent.mailpaceToken, "fictional-domain-token");
        assert.strictEqual(sent.authorization, "");
        assert.strictEqual(sent.idempotencyKey, "");
        assert.include(sent.contentType, "application/json");

        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.Array(
                Schema.Struct({
                  cid: Schema.optionalKey(Schema.String),
                  content: Schema.String,
                  content_type: Schema.String,
                  name: Schema.String,
                }),
              ),
              bcc: Schema.String,
              cc: Schema.String,
              from: Schema.String,
              htmlbody: Schema.String,
              inreplyto: Schema.String,
              list_unsubscribe: Schema.String,
              references: Schema.String,
              replyto: Schema.String,
              subject: Schema.String,
              tags: Schema.Array(Schema.String),
              textbody: Schema.String,
              to: Schema.String,
            }),
          ),
        )(sent.body);

        assert.strictEqual(wire.from, '"Fictional Café" <sender@example.test>');
        assert.strictEqual(wire.to, '"Doe, Fictional" <first@example.test>,second@example.test');
        assert.strictEqual(wire.cc, "copy@example.test");
        assert.strictEqual(wire.bcc, "hidden@example.test");
        assert.strictEqual(wire.replyto, "reply@example.test");
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.textbody, message.body.text);
        assert.strictEqual(wire.htmlbody, message.body.html);
        assert.strictEqual(wire.inreplyto, "<parent@example.test>");
        assert.strictEqual(wire.references, "<first@example.test> <parent@example.test>");
        assert.strictEqual(wire.list_unsubscribe, "<mailto:unsubscribe@example.test>");
        assert.deepStrictEqual([...wire.tags], ["purpose:synthetic café"]);
        const [inline, file] = wire.attachments;
        assert.isDefined(inline);
        assert.isDefined(file);
        assert.strictEqual(inline.cid, "<logo>");
        assert.strictEqual(inline.name, "logo.png");
        assert.strictEqual(inline.content_type, "image/png");
        assert.deepStrictEqual([...Buffer.from(inline.content, "base64")], [0, 255, 128, 10]);
        assert.strictEqual(file.cid, undefined);
        assert.strictEqual(file.name, "note.txt");
        assert.strictEqual(file.content_type, "text/plain");
        assert.strictEqual(Buffer.from(file.content, "base64").toString("utf-8"), "Fictional café");
      }),
  );

  it.live.each([0, Number.MAX_SAFE_INTEGER])(
    "retains native integer correlation ID %s without inventing replay authority",
    (id) =>
      Effect.gen(function* retainNativeIdentifier() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ id, status: "pending" }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({ body: "", status: 202 });

        const receipt = yield* Effect.gen(function* submitNativeIntegerId() {
          return yield* (yield* (yield* EmailRouter).select()).send(message);
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixtureMailpaceLayer(fixture), name: "primary" },
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
        assert.strictEqual(receipt.messageId, String(id));
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { body: '{"error":"Invalid API Token"}', reason: "authentication", status: 400 },
    {
      body: '{"errors":{"to":["private-provider-value"]}}',
      reason: "invalid-message",
      status: 400,
    },
    { body: "private-token", reason: "authentication", status: 401 },
    { body: "private-account", reason: "authentication", status: 403 },
    { body: "private-format", reason: "invalid-message", status: 406 },
    { body: "private-rate", reason: "rate-limited", status: 429 },
    { body: "private-server", reason: "server-error", status: 500 },
    { body: '{"id":123,"status":"pending"}', reason: "unexpected-status", status: 201 },
  ])(
    "classifies documented status $status without private provider values",
    ({ status, body, reason }) =>
      Effect.gen(function* classifyMailpaceEvidence() {
        const fixture = yield* startEmailHttpFixture({ body, retryAfter: "1.25", status });

        const error = yield* Effect.gen(function* failMailpaceSubmission() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureMailpaceLayer(fixture)), Effect.flip);

        assert(Schema.is(EmailRejected)(error) || Schema.is(EmailDeliveryUnknown)(error));
        assert.strictEqual(error.reason, reason);
        assert.strictEqual(error.status, status);

        if (Schema.is(EmailRejected)(error) && reason === "rate-limited") {
          assert.strictEqual(error.retryAfterMillis, 1250);
        }

        assert.notInclude(JSON.stringify(error), "private");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([
    '{"id":"123","status":"pending"}',
    '{"id":-1,"status":"pending"}',
    '{"id":1.5,"status":"pending"}',
    '{"id":9007199254740992,"status":"pending"}',
    '{"id":1,"status":"rejected"}',
    '{"id":1}',
    '{"status":"pending"}',
    "not-json",
    JSON.stringify({ id: 1, private: "x".repeat(65_536), status: "pending" }),
  ])("does not retry or fall back on unusable acknowledgement %#", (body) =>
    Effect.gen(function* stopUncertainMailpaceRouting() {
      const fixture = yield* startEmailHttpFixture({ body, status: 200 });
      const backup = yield* startEmailHttpFixture({ body: "", status: 202 });

      const error = yield* Effect.gen(function* submitUncertainRoute() {
        return yield* (yield* (yield* EmailRouter).select()).send(message);
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              { layer: fixtureMailpaceLayer(fixture), name: "primary" },
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
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
      assert.notInclude(JSON.stringify(error), "private");
    }),
  );

  it.live("rejects unrepresentable intent and keys before HTTP", () =>
    Effect.gen(function* validateMailpaceBeforeTransport() {
      const fixture = yield* startEmailHttpFixture({
        body: '{"id":1,"status":"pending"}',
        status: 200,
      });

      yield* Effect.gen(function* preflightMailpace() {
        const email = yield* Email;

        const attachment = {
          contentBase64: "AQ==",
          contentType: "text/plain",
          filename: "note.txt",
        } as const;

        const intents = [
          { ...message, headers: [{ name: "X-Private-Payload", value: "private-header-value" }] },
          {
            ...message,
            headers: [
              { name: "References", value: "private-one" },
              { name: "references", value: "private-two" },
            ],
          },
          { ...message, replyTo: ["one@example.test", "two@example.test"] },
          { ...message, replyTo: { address: "reply@example.test", name: "private-name" } },
          { ...message, tags: [{ name: "private:tag", value: "value" }] },
          { ...message, metadata: { workflow: "private-metadata" } },
          { ...message, sendAt: "2026-10-13T12:30:00Z" },
          { ...message, attachments: [{ ...attachment, filename: "private.data.txt" }] },
          { ...message, attachments: [{ ...attachment, filename: "private.bin" }] },
          { ...message, attachments: [{ ...attachment, contentType: "ProviderSelected" }] },
        ] as const;

        for (const intent of intents) {
          const error = yield* email.validate(intent).pipe(Effect.flip);
          assert(Schema.is(EmailInvalidMessage)(error));
          assert.notInclude(JSON.stringify(error), "private");
        }

        const error = yield* email
          .send(message, { idempotencyKey: "private-key" })
          .pipe(Effect.flip);

        assert(Schema.is(EmailRejected)(error));
        assert.strictEqual(error.reason, "unsupported-idempotency");
      }).pipe(Effect.provide(fixtureMailpaceLayer(fixture)));
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live("rejects malformed redacted configuration without retaining token contents", () =>
    Effect.gen(function* validateMailpaceConfiguration() {
      const fixture = yield* startEmailHttpFixture({ body: "", status: 200 });

      const error = yield* Effect.service(Email).pipe(
        Effect.provide(
          mailpaceEmailLayer({ serverToken: Redacted.make("private token") }).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://app.mailpace.com")),
          ),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailConfigurationError)(error));
      assert.notInclude(JSON.stringify(error), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
