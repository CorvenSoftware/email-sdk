import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailRejected,
} from "./index.js";
import { sequenzyEmailLayer } from "./sequenzy-email-sender.js";

const options = {
  apiKey: Redacted.make("fictional-key"),
  automaticUtm: "AccountDisabled",
  contactWrites: "AuthorizeProviderManagedProfiles",
  contentAuthority: "AuthorizeProviderRenderingAndRetention",
  replyTracking: "AccountDisabled",
  senderIdentity: "ExistingVerifiedProfile",
  submissionMode: "TransactionalOnly",
} as const;

const message = {
  body: { html: "<p>Fictional café</p>" },
  from: { address: "sender@example.test", name: "Fictional Verified Identity" },
  replyTo: { address: "reply@example.test", name: "Fictional Reply" },
  subject: "Fictional Sequenzy",
  to: "recipient@example.test",
} as const;

const acknowledgement = { emailSendId: "fictional-send-id", success: true, to: message.to };

const fixtureLayer = (fixture: EmailHttpFixture) =>
  sequenzyEmailLayer(options, {
    deadline: Duration.seconds(5),
    initialDelay: Duration.millis(100),
    maxAttempts: 3,
  }).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sequenzy.com")));

const send = Effect.gen(function* sendFictionalSequenzy() {
  return yield* (yield* Email).send(message, { idempotencyKey: "fictional-key" });
});

describe("Sequenzy authorized direct-content processing", () => {
  it.live(
    "uses verified identity selection, explicit replies and real tracking opt-outs with complete recipient echoes",
    () =>
      Effect.gen(function* inspectSequenzyWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            bcc: ["hidden@example.test"],
            cc: ["copy@example.test"],
          }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* sendRichSequenzy() {
          return yield* (yield* Email).send(
            {
              ...message,
              attachments: [
                {
                  contentBase64: "AP+ACg==",
                  contentType: "application/pdf",
                  filename: "fictional.pdf",
                },
              ],
              bcc: "hidden@example.test",
              cc: "copy@example.test",
            },
            { idempotencyKey: "fictional-key" },
          );
        }).pipe(Effect.provide(fixtureLayer(fixture)));

        assert.strictEqual(receipt._tag, "Accepted");
        const wire = yield* Queue.take(fixture.received);
        assert.strictEqual(wire.path, "/api/v1/transactional/send");
        assert.strictEqual(wire.authorization, "Bearer fictional-key");
        assert.strictEqual(wire.idempotencyKey, "fictional-key");

        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.NonEmptyArray(
                Schema.Struct({ content: Schema.String, contentType: Schema.String }),
              ),
              bcc: Schema.NonEmptyArray(Schema.String),
              body: Schema.String,
              cc: Schema.NonEmptyArray(Schema.String),
              emailType: Schema.String,
              fromEmail: Schema.String,
              fromName: Schema.String,
              replyTo: Schema.String,
              subject: Schema.String,
              to: Schema.NonEmptyArray(Schema.String),
              trackingSettings: Schema.Struct({
                clickTracking: Schema.Boolean,
                openTracking: Schema.Boolean,
              }),
            }),
          ),
        )(wire.body);

        assert.strictEqual(payload.body, message.body.html);
        assert.strictEqual(payload.fromEmail, message.from.address);
        assert.strictEqual(payload.fromName, message.from.name);
        assert.strictEqual(payload.replyTo, '"Fictional Reply" <reply@example.test>');
        assert.strictEqual(payload.to[0], message.to);
        assert.strictEqual(payload.cc[0], "copy@example.test");
        assert.strictEqual(payload.bcc[0], "hidden@example.test");
        assert.strictEqual(payload.emailType, "transactional");
        assert.isFalse(payload.trackingSettings.clickTracking);
        assert.isFalse(payload.trackingSettings.openTracking);
        assert.deepStrictEqual(
          [...Buffer.from(payload.attachments[0].content, "base64")],
          [0, 255, 128, 10],
        );
        assert.strictEqual(payload.attachments[0].contentType, "application/pdf");
        assert.notInclude(wire.body, '"trackAs"');
        assert.notInclude(wire.body, '"from":');
        assert.notInclude(wire.body, '"variables"');
      }),
  );
  it.live.each([
    { ...acknowledgement, diagnostics: { message: "private-content-loss", status: "warning" } },
    { ...acknowledgement, ignoredHeaders: [{ name: "private-header", reason: "reserved" }] },
    { ...acknowledgement, to: "foreign@example.test" },
    { ...acknowledgement, cc: ["foreign@example.test"] },
    { ...acknowledgement, success: false },
    { ...acknowledgement, emailType: "marketing" },
    { ...acknowledgement, transactional: { id: "private-unrequested-template" } },
    { jobId: "legacy-is-not-send-evidence", success: true, to: message.to },
  ])("keeps changed intent or incomplete acknowledgement uncertain without keyed replay", (body) =>
    Effect.gen(function* inspectSequenzyAcknowledgement() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });
      const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
      assert(error instanceof EmailDeliveryUnknown);
      assert.notInclude(JSON.stringify(error), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );
  it.live.each([
    {
      body: { code: "TRANSACTIONAL_ENQUEUE_UNAVAILABLE", retryable: true, success: false },
      status: 503,
    },
    { body: { success: false }, status: 429 },
    { body: { code: "PRIVATE_UNKNOWN", success: false }, status: 409 },
  ])(
    "does not turn unkeyed reserved, rate or unreviewed $status responses into safe replay",
    ({ body, status }) =>
      Effect.gen(function* inspectSequenzyUncertainty() {
        const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status });

        const error = yield* Effect.gen(function* sendUnkeyedSequenzy() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);

        assert(error instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );
  it.effect(
    "repairs a reserved header-free direct send using the unchanged owned key and payload",
    () =>
      Effect.gen(function* repairSequenzyReservation() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            code: "TRANSACTIONAL_ENQUEUE_UNAVAILABLE",
            retryable: true,
            success: false,
          }),
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          status: 503,
        });

        const input = { ...message, body: { ...message.body }, from: { ...message.from } };

        const fiber = yield* Effect.gen(function* sendRepairableSequenzy() {
          return yield* (yield* Email).send(input, { idempotencyKey: "fictional-repair-key" });
        }).pipe(Effect.provide(fixtureLayer(fixture)), Effect.forkScoped);

        const first = yield* Queue.take(fixture.received);
        Reflect.set(input.body, "html", "changed while repairing");
        Reflect.set(input.from, "name", "changed identity");
        yield* TestClock.adjust("1 second");
        const second = yield* Queue.take(fixture.received);
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Accepted");
        assert.strictEqual(first.body, second.body);
        assert.strictEqual(first.idempotencyKey, second.idempotencyKey);
        assert.notInclude(second.body, "changed");
      }),
  );

  it.live("keeps exact different-request conflict terminal", () =>
    Effect.gen(function* inspectSequenzyConflict() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          code: "IDEMPOTENCY_KEY_REUSED",
          error: "private-provider-text",
          success: false,
        }),
        status: 409,
      });

      const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);
      assert(error instanceof EmailRejected);
      assert.strictEqual(error.reason, "idempotency-conflict");
      assert.notInclude(JSON.stringify(error), "private-");
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );
  it.live.each([
    { ...message, body: { text: "selected plain text" } },
    { ...message, to: { address: message.to, name: "Not representable" } },
    { ...message, from: message.from.address },
    { ...message, replyTo: ["first@example.test", "second@example.test"] },
    { ...message, cc: message.to },
    { ...message, headers: [{ name: "X-Workflow", value: "not retained by recovery" }] },
    {
      ...message,
      attachments: [
        {
          contentBase64: "YQ==",
          contentId: "inline",
          contentType: "image/png",
          filename: "inline.png",
        },
      ],
    },
  ] as const)(
    "refuses unsupported identity, copy, body or lifecycle intent before transport",
    (input) =>
      Effect.gen(function* inspectSequenzyPreflight() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const error = yield* Effect.gen(function* preflightSequenzy() {
          return yield* (yield* Email).send(input);
        }).pipe(Effect.provide(fixtureLayer(fixture)), Effect.flip);

        assert(error instanceof EmailInvalidMessage);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
  it.live(
    "requires profile-write authorization rather than pretending the provider never creates contacts",
    () =>
      Effect.gen(function* inspectSequenzyAuthorization() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const invalid = { ...options };
        Reflect.set(invalid, "contactWrites", "Disabled");

        const failure = yield* Email.pipe(
          Effect.provide(
            sequenzyEmailLayer(invalid).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sequenzy.com")),
            ),
          ),
          Effect.flip,
        );

        assert(failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
