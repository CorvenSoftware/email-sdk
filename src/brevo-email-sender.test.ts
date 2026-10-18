import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Redacted, Schema } from "effect";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailRejected,
} from "./index.js";
import { brevoEmailLayer } from "./brevo-email-sender.js";

const options = {
  apiKey: Redacted.make("fictional-brevo-key"),
  contentAuthority: "AuthorizeProviderRendering",
  submissionMode: "TransactionalOnly",
  tracking: "AuthorizeProviderTracking",
} as const;

const message = {
  body: { html: "<p>Fictional café</p>" },
  from: { address: "sender@example.test", name: "Fictional Sender" },
  subject: "Fictional Brevo",
  to: { address: "recipient@example.test", name: "Fictional Recipient" },
} as const;

const fixtureLayer = (fixture: EmailHttpFixture) =>
  brevoEmailLayer(options, {
    deadline: Duration.seconds(5),
    initialDelay: Duration.millis(100),
    maxAttempts: 3,
  }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.brevo.com")));

const send = Effect.gen(function* sendFictionalBrevo() {
  return yield* (yield* Email).send(message);
});

describe("Brevo explicitly authorized rendering and tracking", () => {
  it.live(
    "maps structured identities, HTML and deliberately delegated attachment MIME without using contact/template data",
    () =>
      Effect.gen(function* inspectBrevoWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ messageId: "<fictional-id@fictional.invalid>" }),
          status: 201,
        });

        const receipt = yield* Effect.gen(function* sendRichBrevo() {
          return yield* (yield* Email).send({
            ...message,
            attachments: [
              {
                contentBase64: "AP+ACg==",
                contentType: "ProviderSelected",
                filename: "fictional.pdf",
              },
            ],
            bcc: "hidden@example.test",
            cc: "copy@example.test",
            headers: [{ name: "X-Workflow", value: "fictional" }],
            replyTo: { address: "reply@example.test", name: "Fictional Reply" },
          });
        }).pipe(Effect.provide(fixtureLayer(fixture)));

        assert.strictEqual(receipt._tag, "Accepted");
        const wire = yield* Queue.take(fixture.received);
        assert.strictEqual(wire.path, "/v3/smtp/email");
        assert.strictEqual(wire.apiKey, "fictional-brevo-key");

        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachment: Schema.NonEmptyArray(
                Schema.Struct({ content: Schema.String, name: Schema.String }),
              ),
              bcc: Schema.NonEmptyArray(Schema.Struct({ email: Schema.String })),
              cc: Schema.NonEmptyArray(Schema.Struct({ email: Schema.String })),
              headers: Schema.Record(Schema.String, Schema.String),
              htmlContent: Schema.String,
              replyTo: Schema.Struct({ email: Schema.String, name: Schema.String }),
              sender: Schema.Struct({ email: Schema.String, name: Schema.String }),
              subject: Schema.String,
              to: Schema.NonEmptyArray(
                Schema.Struct({ email: Schema.String, name: Schema.String }),
              ),
            }),
          ),
        )(wire.body);

        assert.strictEqual(payload.htmlContent, message.body.html);
        assert.strictEqual(payload.sender.email, message.from.address);
        assert.strictEqual(payload.sender.name, message.from.name);
        assert.strictEqual(payload.to[0].email, message.to.address);
        assert.strictEqual(payload.to[0].name, message.to.name);
        assert.strictEqual(payload.cc[0].email, "copy@example.test");
        assert.strictEqual(payload.bcc[0].email, "hidden@example.test");
        assert.strictEqual(payload.replyTo.name, "Fictional Reply");
        assert.strictEqual(payload.headers["X-Workflow"], "fictional");
        assert.deepStrictEqual(
          [...Buffer.from(payload.attachment[0].content, "base64")],
          [0, 255, 128, 10],
        );
        assert.notInclude(wire.body, '"params"');
        assert.notInclude(wire.body, '"templateId"');
        assert.notInclude(wire.body, '"contactPixelTrackingConsent"');
      }),
  );
  it.live("accepts documented scheduled acknowledgement without inventing an identifier", () =>
    Effect.gen(function* inspectBrevoSchedule() {
      const fixture = yield* startEmailHttpFixture({ body: "", status: 202 });

      const receipt = yield* Effect.gen(function* scheduleBrevo() {
        return yield* (yield* Email).send({ ...message, sendAt: "2026-12-12T12:30:00Z" });
      }).pipe(Effect.provide(fixtureLayer(fixture)));

      assert.strictEqual(receipt._tag, "Accepted");
      assert.notProperty(receipt, "messageId");
      assert.include(
        (yield* Queue.take(fixture.received)).body,
        '"scheduledAt":"2026-12-12T12:30:00.000Z"',
      );
    }),
  );
  it.live.each([
    { body: {}, status: 201 },
    { body: { code: "private-error", messageId: "id" }, status: 201 },
    { body: { messageIds: ["id", "other"] }, status: 201 },
    { body: {}, status: 202 },
    { body: { code: "duplicate_request" }, status: 400 },
    { body: { code: "private-unknown" }, status: 400 },
    { body: {}, status: 429 },
    { body: {}, status: 503 },
  ])("retains unknown $status evidence without replay", ({ body, status }) =>
    Effect.gen(function* inspectBrevoUncertainty() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status });
      const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
      assert(error instanceof EmailDeliveryUnknown);
      assert.notInclude(JSON.stringify(error), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );
  it.live.each([
    { code: "unauthorized", reason: "authentication" },
    { code: "invalid_parameter", reason: "invalid-message" },
    { code: "permission_denied", reason: "rejected" },
  ])("classifies reviewed refusal $code without retaining provider prose", ({ code, reason }) =>
    Effect.gen(function* inspectBrevoRejection() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({ code, message: "private-provider-content" }),
        status: 400,
      });

      const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
      assert(error instanceof EmailRejected);
      assert.strictEqual(error.reason, reason);
      assert.notInclude(JSON.stringify(error), "private-");
    }),
  );
  it.live.each([
    { ...message, body: { text: "only text" } },
    { ...message, body: { html: "<p>HTML</p>", text: "selected text" } },
    { ...message, metadata: { notTemplateData: "fictional" } },
    { ...message, replyTo: ["first@example.test", "second@example.test"] },
    { ...message, headers: [{ name: "x-workflow", value: "changed casing" }] },
    {
      ...message,
      attachments: [{ contentBase64: "YQ==", contentType: "text/plain", filename: "file.txt" }],
    },
  ] as const)("refuses changed or unrepresentable intent before HTTP", (input) =>
    Effect.gen(function* inspectBrevoPreflight() {
      const fixture = yield* startEmailHttpFixture({ body: "{}", status: 201 });

      const error = yield* Effect.gen(function* preflightBrevo() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);

      assert(error instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );
  it.live(
    "does not treat disabled tracking or anonymous consent as an available provider opt-out",
    () =>
      Effect.gen(function* inspectBrevoAuthorization() {
        const fixture = yield* startEmailHttpFixture({ body: "{}", status: 201 });
        const invalid = { ...options };
        Reflect.set(invalid, "tracking", "Disabled");

        const failure = yield* Email.pipe(
          Effect.provide(
            brevoEmailLayer(invalid).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.brevo.com")),
            ),
          ),
          Effect.flip,
        );

        assert(failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
