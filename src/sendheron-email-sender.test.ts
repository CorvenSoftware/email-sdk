import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import { emailFixtureClientLayer, startEmailHttpFixture } from "../test/email-http-fixture.js";
import type { EmailHttpFixture } from "../test/email-http-fixture.js";
import {
  Email,
  EmailConfigurationError,
  EmailDeliveryUnknown,
  EmailInvalidMessage,
  EmailRejected,
  EmailRouter,
  emailRouterLayer,
} from "./index.js";
import { sendheronEmailLayer } from "./sendheron-email-sender.js";
import { recordingEmailLayer, RecordedEmails } from "./email-testing.js";

const options = {
  apiKey: Redacted.make("fictional-key"),
  submissionMode: "TransactionalOnly",
  tracking: "AuthorizeProviderTracking",
} as const;

const message = {
  body: { html: "<p>Fictional café</p>" },
  from: { address: "sender@example.test", name: "Fictional Café" },
  replyTo: "reply@example.test",
  subject: "Fictional SendHeron",
  to: "recipient@example.test",
} as const;

const accepted = {
  errorMessage: null,
  from: message.from.address,
  id: "fictional-send-id",
  status: "sent",
  subject: message.subject,
  to: message.to,
};

const policy = {
  deadline: Duration.seconds(10),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const fixtureLayer = (fixture: EmailHttpFixture, maxAttempts = 1) =>
  sendheronEmailLayer(options, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendheron.com")),
  );

const send = Effect.gen(function* submitFictionalSendheron() {
  return yield* (yield* Email).send(message, { idempotencyKey: "fictional-key" });
});

describe("SendHeron explicit tracked transactional protocol", () => {
  it.live(
    "preserves authorized HTML, identities, headers, bytes and caller key on the real wire",
    () =>
      Effect.gen(function* inspectSendheronWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(accepted),
          status: 201,
        });

        const receipt = yield* Effect.gen(function* sendRichSendheron() {
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
              headers: [{ name: "X-Workflow", value: "fictional" }],
            },
            { idempotencyKey: "fictional-key" },
          );
        }).pipe(Effect.provide(fixtureLayer(fixture)));

        assert.strictEqual(receipt._tag, "Accepted");
        const wire = yield* Queue.take(fixture.received);
        assert.strictEqual(wire.path, "/api/v1/emails/send");
        assert.strictEqual(wire.authorization, "Bearer fictional-key");
        assert.strictEqual(wire.idempotencyKey, "fictional-key");

        const payload = yield* Schema.decodeEffect(
          Schema.fromJsonString(
            Schema.Struct({
              attachments: Schema.NonEmptyArray(
                Schema.Struct({
                  content: Schema.String,
                  disposition: Schema.Literal("attachment"),
                  filename: Schema.String,
                  type: Schema.String,
                }),
              ),
              from: Schema.String,
              fromName: Schema.String,
              headers: Schema.Record(Schema.String, Schema.String),
              html: Schema.String,
              replyTo: Schema.String,
              subject: Schema.String,
              to: Schema.String,
            }),
          ),
        )(wire.body);

        assert.strictEqual(payload.html, message.body.html);
        assert.strictEqual(payload.from, message.from.address);
        assert.strictEqual(payload.fromName, message.from.name);
        assert.strictEqual(payload.replyTo, message.replyTo);
        assert.strictEqual(payload.to, message.to);
        assert.strictEqual(payload.subject, message.subject);
        assert.strictEqual(payload.headers["X-Workflow"], "fictional");
        assert.deepStrictEqual(
          [...Buffer.from(payload.attachments[0].content, "base64")],
          [0, 255, 128, 10],
        );
        assert.strictEqual(payload.attachments[0].type, "application/pdf");
        assert.notInclude(wire.body, '"text"');
      }),
  );

  it.live(
    "treats policy suppression as terminal without exposing reasons or reaching fallback",
    () =>
      Effect.gen(function* retainTerminalSuppression() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            errorMessage: "private-sender-policy",
            id: "fictional-blocked",
            status: "suppressed",
            to: message.to,
          }),
          status: 201,
        });

        yield* Effect.gen(function* sendSuppressedRoute() {
          const receipt = yield* (yield* (yield* EmailRouter).select()).send(message);
          assert.strictEqual(receipt._tag, "Suppressed");
          assert.notInclude(JSON.stringify(receipt), "private-");
          assert.strictEqual((yield* (yield* RecordedEmails).messages).length, 0);
          assert.isTrue(Object.isFrozen(receipt));
        }).pipe(
          Effect.provide(
            emailRouterLayer(
              [
                { layer: fixtureLayer(fixture), name: "primary" },
                { layer: recordingEmailLayer, name: "backup" },
              ],
              { fallbacks: ["backup"], primary: "primary" },
            ).pipe(Layer.provideMerge(recordingEmailLayer)),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live.each([
    { body: { ...accepted, status: "queued" }, status: 201 },
    { body: { ...accepted, to: "foreign@example.test" }, status: 201 },
    { body: { ...accepted, from: "foreign@example.test" }, status: 201 },
    { body: { ...accepted, subject: "rewritten" }, status: 201 },
    { body: { ...accepted, errorMessage: "private-contradiction" }, status: 201 },
    { body: { id: "fictional-id", status: "suppressed", to: message.to }, status: 201 },
    { body: accepted, status: 200 },
    { body: { message: "private-conflict" }, status: 409 },
    { body: { message: "private-unreviewed-error", statusCode: 503 }, status: 503 },
  ])(
    "keeps incomplete, contradictory or unreviewed $status outcomes unknown without keyed replay",
    ({ body, status }) =>
      Effect.gen(function* inspectSendheronUncertainty() {
        const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(body), status });
        const error = yield* send.pipe(Effect.provide(fixtureLayer(fixture, 3)), Effect.flip);
        assert(error instanceof EmailDeliveryUnknown);
        assert.notInclude(JSON.stringify(error), "private-");
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
      }),
  );

  it.live("checks exact scheduled time instead of treating every identifier as acceptance", () =>
    Effect.gen(function* inspectSendheronHold() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify({
          id: "fictional-hold",
          sendAt: "2026-12-12T12:30:00Z",
          status: "SCHEDULED",
        }),
        status: 201,
      });

      yield* Effect.gen(function* scheduleSendheron() {
        const email = yield* Email;
        const receipt = yield* email.send({ ...message, sendAt: "2026-12-12T12:30:00Z" });
        assert.strictEqual(receipt._tag, "Accepted");

        const failure = yield* email
          .send({ ...message, sendAt: "2026-12-12T12:31:00Z" })
          .pipe(Effect.flip);

        assert(failure instanceof EmailDeliveryUnknown);
      }).pipe(Effect.provide(fixtureLayer(fixture)));
      const wire = yield* Queue.take(fixture.received);
      assert.include(wire.body, '"sendAt":"2026-12-12T12:30:00.000Z"');
    }),
  );

  it.live.each([
    { ...message, body: { text: "not HTML" } },
    { ...message, body: { html: "<p>HTML</p>", text: "selected alternative" } },
    { ...message, from: "sender@example.test" },
    { ...message, replyTo: ["first@example.test", "second@example.test"] },
    { ...message, to: [message.to, "another@example.test"] },
    { ...message, cc: "copy@example.test" },
    { ...message, to: { address: message.to, name: "Named" } },
    {
      ...message,
      attachments: [
        {
          contentBase64: "YQ==",
          contentType: "application/octet-stream",
          filename: "fictional.dat",
        },
      ],
    },
    {
      ...message,
      attachments: [
        { contentBase64: "YQ==", contentType: "text/plain", filename: "fictional.txt" },
      ],
      sendAt: "2026-12-12T12:30:00Z",
    },
    { ...message, headers: [{ name: "X-Sendheron-Tracking", value: "override" }] },
  ] as const)("rejects unrepresentable intent before transport", (input) =>
    Effect.gen(function* inspectSendheronPreflight() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(accepted), status: 201 });

      const result = yield* Effect.gen(function* preflightSendheron() {
        return yield* (yield* Email).send(input);
      }).pipe(Effect.provide(fixtureLayer(fixture)), Effect.result);

      assert(Result.isFailure(result));
      assert(result.failure instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.effect(
    "retries proven provider refusal with unchanged key without granting unknown replay",
    () =>
      Effect.gen(function* inspectSendheronRefusalRetry() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({ message: "emailSending.sendFailed", statusCode: 503 }),
          status: 503,
        });

        const fiber = yield* send.pipe(
          Effect.provide(fixtureLayer(fixture, 2)),
          Effect.result,
          Effect.forkScoped,
        );

        const first = yield* Queue.take(fixture.received);
        yield* TestClock.adjust("1 second");
        const second = yield* Queue.take(fixture.received);
        const result = yield* Fiber.join(fiber);
        assert(Result.isFailure(result));
        assert(result.failure instanceof EmailRejected);
        assert.strictEqual(result.failure.reason, "temporarily-unavailable");
        assert.strictEqual(first.idempotencyKey, second.idempotencyKey);
        assert.strictEqual(first.body, second.body);
      }),
  );

  it.effect(
    "permits native uncertain replay only when attachments are disabled before submission",
    () =>
      Effect.gen(function* inspectSendheronNativeReplay() {
        const fixture = yield* startEmailHttpFixture({
          body: "{}",
          next: { body: JSON.stringify(accepted), status: 201 },
          status: 500,
        });

        const layer = sendheronEmailLayer(
          { ...options, attachments: "Disabled" },
          { ...policy, maxAttempts: 2 },
        ).pipe(Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendheron.com")));

        const fiber = yield* send.pipe(Effect.provide(layer), Effect.forkScoped);
        const first = yield* Queue.take(fixture.received);
        yield* TestClock.adjust("1 second");
        const second = yield* Queue.take(fixture.received);
        assert.strictEqual((yield* Fiber.join(fiber))._tag, "Accepted");
        assert.strictEqual(first.body, second.body);
        assert.strictEqual(first.idempotencyKey, second.idempotencyKey);
      }),
  );

  it.live("refuses attachment bytes locally when the selected sender grants native replay", () =>
    Effect.gen(function* inspectSendheronNativeAttachmentFence() {
      const fixture = yield* startEmailHttpFixture({ body: JSON.stringify(accepted), status: 201 });

      const error = yield* Effect.gen(function* rejectUncomparedAttachmentBytes() {
        const email = yield* Email;
        assert.isFalse(email.capabilities.attachments);

        return yield* email.send(
          {
            ...message,
            attachments: [
              { contentBase64: "YQ==", contentType: "text/plain", filename: "fictional.txt" },
            ],
          },
          { idempotencyKey: "fictional-key" },
        );
      }).pipe(
        Effect.provide(
          sendheronEmailLayer({ ...options, attachments: "Disabled" }).pipe(
            Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendheron.com")),
          ),
        ),
        Effect.flip,
      );

      assert(error instanceof EmailInvalidMessage);
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live(
    "requires explicit tracking and transactional authorization without acquiring a remote account",
    () =>
      Effect.gen(function* inspectSendheronAuthorization() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(accepted),
          status: 201,
        });

        const invalid = { ...options };
        Reflect.set(invalid, "tracking", "Disabled");

        const failure = yield* Email.pipe(
          Effect.provide(
            sendheronEmailLayer(invalid).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.sendheron.com")),
            ),
          ),
          Effect.flip,
        );

        assert(failure instanceof EmailConfigurationError);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
