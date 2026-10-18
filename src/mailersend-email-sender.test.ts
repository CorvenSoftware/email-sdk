import { assert, describe, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer, Queue, Redacted, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  Email,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  emailRouterLayer,
  emailAttachmentFromBytes,
} from "./index.js";
import { mailersendEmailLayer } from "./mailersend-email-sender.js";
import { sendgridEmailLayer } from "./sendgrid-email-sender.js";

const message = {
  body: { html: "<p>Fictional café</p>", text: "Fictional café" },
  from: "sender@example.test",
  subject: "Synthetic MailerSend notification",
  to: ["first@example.test", "second@example.test"],
} as const;

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const options = { apiKey: Redacted.make("fictional-token") };

const someSuppressed = JSON.stringify({
  warnings: [
    {
      recipients: [{ email: "FIRST@example.test", reasons: ["private-provider-reason"] }],
      type: "SOME_SUPPRESSED",
    },
  ],
});

const allSuppressed = JSON.stringify({
  warnings: [
    {
      recipients: [{ email: "first@example.test" }, { email: "second@example.test" }],
      type: "ALL_SUPPRESSED",
    },
  ],
});

describe("MailerSend local HTTP submission evidence", () => {
  it.effect("preserves rich representable intent and disables provider tracking", () =>
    Effect.gen(function* observeMailersendWire() {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-13T12:00:00Z")));

      const fixture = yield* startEmailHttpFixture({
        body: "",
        contentType: "text/plain",
        messageId: "synthetic.message-id",
        status: 202,
      });

      const receipt = yield* Effect.gen(function* submitNotification() {
        const inline = yield* emailAttachmentFromBytes(new Uint8Array([0, 255, 128, 10]), {
          contentId: "logo",
          contentType: "ProviderSelected",
          filename: "logo.png",
        });

        const attachment = yield* emailAttachmentFromBytes(
          new TextEncoder().encode("Fictional café"),
          {
            contentType: "ProviderSelected",
            disposition: "attachment",
            filename: "note.txt",
          },
        );

        return yield* (yield* Email).send({
          attachments: [inline, attachment],
          ...message,
          bcc: "hidden@example.test",
          cc: { address: "copy@example.test", name: "Fictional Copy" },
          from: { address: message.from, name: "Fictional Café" },
          headers: [
            { name: "X-Workflow", value: "first" },
            { name: "X-Workflow", value: "second" },
          ],
          replyTo: { address: "reply@example.test", name: "Fictional Reply" },
          sendAt: "2026-10-13T12:30:00.123Z",
          tags: [{ name: "purpose", value: "synthetic café" }],
        });
      }).pipe(
        Effect.provide(
          mailersendEmailLayer(options, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
          ),
        ),
      );

      const request = yield* Queue.take(fixture.received);

      const payload = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            attachments: Schema.Array(
              Schema.Struct({
                content: Schema.String,
                disposition: Schema.String,
                filename: Schema.String,
                id: Schema.optionalKey(Schema.String),
              }),
            ),
            bcc: Schema.Array(Schema.Struct({ email: Schema.String })),
            cc: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
            from: Schema.Struct({ email: Schema.String, name: Schema.String }),
            headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
            html: Schema.String,
            reply_to: Schema.Struct({ email: Schema.String, name: Schema.String }),
            send_at: Schema.String,
            settings: Schema.Struct({
              track_clicks: Schema.Boolean,
              track_content: Schema.Boolean,
              track_opens: Schema.Boolean,
            }),
            subject: Schema.String,
            tags: Schema.Array(Schema.String),
            text: Schema.String,
            to: Schema.Array(Schema.Struct({ email: Schema.String })),
          }),
        ),
      )(request.body);

      assert.strictEqual(request.path, "/v1/email");
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.authorization, "Bearer fictional-token");
      assert.strictEqual(payload.from.name, "Fictional Café");
      const [inline, attachment] = payload.attachments;
      assert.isDefined(inline);
      assert.isDefined(attachment);
      assert.deepStrictEqual([...Buffer.from(inline.content, "base64")], [0, 255, 128, 10]);
      assert.strictEqual(inline.id, "logo");
      assert.strictEqual(inline.disposition, "inline");
      assert.strictEqual(inline.filename, "logo.png");
      assert.strictEqual(
        Buffer.from(attachment.content, "base64").toString("utf-8"),
        "Fictional café",
      );
      assert.strictEqual(attachment.filename, "note.txt");
      assert.strictEqual(attachment.disposition, "attachment");
      assert.isUndefined(attachment.id);
      assert.notInclude(request.body, '"contentType"');
      assert.notInclude(request.body, '"ProviderSelected"');
      assert.deepStrictEqual(
        payload.to.map(({ email }) => email),
        [...message.to],
      );
      assert.strictEqual(payload.cc[0]?.email, "copy@example.test");
      assert.strictEqual(payload.bcc[0]?.email, "hidden@example.test");
      assert.strictEqual(payload.reply_to.email, "reply@example.test");
      assert.deepStrictEqual(
        payload.headers.map(({ value }) => value),
        ["first", "second"],
      );
      assert.strictEqual(payload.html, message.body.html);
      assert.strictEqual(payload.text, message.body.text);
      assert.strictEqual(payload.subject, message.subject);
      assert.strictEqual(payload.send_at, "2026-10-13T12:30:00.123Z");
      assert.deepStrictEqual(payload.tags, ["purpose:synthetic café"]);
      assert.deepStrictEqual(payload.settings, {
        track_clicks: false,
        track_content: false,
        track_opens: false,
      });
      assert(EmailReceiptSchema.guards.Accepted(receipt));
      assert.strictEqual(receipt.messageId, "synthetic.message-id");
    }),
  );

  it.live.each([
    {
      accepted: ["second@example.test"],
      body: someSuppressed,
      input: message,
      messageId: "synthetic.message-id",
      suppressed: ["first@example.test"],
      tag: "PartiallyAccepted",
    },
    {
      accepted: [],
      body: allSuppressed,
      input: message,
      suppressed: message.to,
      tag: "Suppressed",
    },
    {
      accepted: ["first@example.test", "second@example.test", "copy@example.test"],
      body: JSON.stringify({
        warnings: [{ recipients: [{ email: "HIDDEN@example.test" }], type: "SOME_SUPPRESSED" }],
      }),
      input: { ...message, bcc: "hidden@example.test", cc: "copy@example.test" },
      messageId: "synthetic.message-id",
      suppressed: ["hidden@example.test"],
      tag: "PartiallyAccepted",
    },
  ] as const)("reports $tag without advancing a named fallback", (scenario) =>
    Effect.gen(function* observeSuppressionEvidence() {
      const primary = yield* startEmailHttpFixture({ ...scenario, status: 202 });
      const backup = yield* startEmailHttpFixture({ body: "", status: 202 });
      const trace = yield* startEmailTraceFixture();

      const receipt = yield* Effect.gen(function* submitRoutedNotification() {
        const route = yield* (yield* EmailRouter).select();

        return yield* route.send(scenario.input);
      }).pipe(
        Effect.provide(
          emailRouterLayer(
            [
              {
                layer: mailersendEmailLayer(options, policy).pipe(
                  Layer.provide(emailFixtureClientLayer(primary.url, "https://api.mailersend.com")),
                ),
                name: "primary",
              },
              {
                layer: sendgridEmailLayer(options, policy).pipe(
                  Layer.provide(emailFixtureClientLayer(backup.url, "https://api.sendgrid.com")),
                ),
                name: "backup",
              },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.provideService(Tracer.Tracer, trace.tracer),
      );

      assert.strictEqual(receipt._tag, scenario.tag);
      assert.strictEqual(receipt.route, "primary");

      if (EmailReceiptSchema.guards.PartiallyAccepted(receipt)) {
        assert.deepStrictEqual(
          receipt.accepted.map((address) => address.toString()),
          [...scenario.accepted],
        );
        assert.deepStrictEqual(
          receipt.suppressed.map((address) => address.toString()),
          [...scenario.suppressed],
        );
        assert.isTrue(Object.isFrozen(receipt.accepted));
      } else {
        assert(EmailReceiptSchema.guards.Suppressed(receipt));
        assert.deepStrictEqual(
          receipt.suppressed.map((address) => address.toString()),
          [...scenario.suppressed],
        );
      }

      assert.isTrue(Object.isFrozen(receipt.suppressed));
      assert.isTrue(Object.isFrozen(receipt));
      assert.notInclude(JSON.stringify(receipt), "private-provider-reason");
      const diagnostics = yield* trace.diagnostics;
      assert.notInclude(diagnostics, "@example.test");
      assert.notInclude(diagnostics, "private-provider-reason");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each([
    { body: "", contentType: "text/plain" },
    {
      body: '{"warnings":[{"type":"ALL_SUPPRESSED","recipients":[{"email":"first@example.test"}]}]}',
    },
    {
      body: '{"warnings":[{"type":"SOME_SUPPRESSED","recipients":[{"email":"private-foreign@example.test"}]}]}',
      messageId: "synthetic-id",
    },
    { body: someSuppressed },
    { body: allSuppressed, messageId: "contradictory-id" },
    { body: allSuppressed, messageId: "invalid private id" },
    { body: "not-json-private-details", messageId: "synthetic-id" },
    { body: JSON.stringify({ private: "x".repeat(65 * 1024) }), messageId: "synthetic-id" },
  ])("keeps malformed, incomplete, or contradictory recipient evidence uncertain", (scenario) =>
    Effect.gen(function* rejectUnsafeAcknowledgement() {
      const fixture = yield* startEmailHttpFixture({ ...scenario, status: 202 });

      const error = yield* Effect.gen(function* submitUncertainNotification() {
        return yield* (yield* Email).send(message);
      }).pipe(
        Effect.provide(
          mailersendEmailLayer(options).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
          ),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailDeliveryUnknown)(error));
      assert.strictEqual(error.reason, "invalid-response");
      assert.notInclude(JSON.stringify(error), "private");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    { reason: "invalid-message", status: 422, unknown: false },
    { reason: "authentication", status: 401, unknown: false },
    { reason: "rate-limited", status: 429, unknown: false },
    { reason: "server-error", status: 503, unknown: true },
    { reason: "unexpected-status", status: 200, unknown: true },
  ])("classifies $status/$reason without exposing provider diagnostics", (scenario) =>
    Effect.gen(function* classifyResponseStatus() {
      const fixture = yield* startEmailHttpFixture({
        body: '{"message":"private-diagnostics"}',
        status: scenario.status,
      });

      const error = yield* Effect.gen(function* submitRejectedNotification() {
        return yield* (yield* Email).send(message);
      }).pipe(
        Effect.provide(
          mailersendEmailLayer(options, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
          ),
        ),
        Effect.flip,
      );

      assert(Schema.is(EmailRejected)(error) || Schema.is(EmailDeliveryUnknown)(error));
      assert.strictEqual(error.reason, scenario.reason);
      assert.strictEqual(Schema.is(EmailDeliveryUnknown)(error), scenario.unknown);
      assert.notInclude(JSON.stringify(error), "private");
    }),
  );

  it.live("rejects unsupported replay and unrepresentable intent before HTTP", () =>
    Effect.gen(function* preflightUnsafeIntent() {
      const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });
      yield* Effect.gen(function* validateMessages() {
        const email = yield* Email;

        const keyed = yield* email
          .send(message, { idempotencyKey: "private-key" })
          .pipe(Effect.flip);

        assert(Schema.is(EmailRejected)(keyed));
        assert.strictEqual(keyed.reason, "unsupported-idempotency");

        for (const unsupported of [
          { ...message, metadata: { label: "private-value" } },
          { ...message, to: { address: "first@example.test", name: "private, recipient" } },
          { ...message, replyTo: ["reply@example.test", "other-reply@example.test"] as const },
          { ...message, headers: [{ name: "X_Private", value: "private-value" }] },
          { ...message, tags: [{ name: "private:label", value: "value" }] },
          { ...message, tags: [{ name: "label", value: "x".repeat(191) }] },
          { ...message, cc: "FIRST@example.test" },
        ] as const) {
          const error = yield* email.send(unsupported).pipe(Effect.flip);
          assert(Schema.is(EmailInvalidMessage)(error));
          assert.notInclude(JSON.stringify(error), "private");
        }
      }).pipe(
        Effect.provide(
          mailersendEmailLayer(options, policy).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.mailersend.com")),
          ),
        ),
      );
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
});
