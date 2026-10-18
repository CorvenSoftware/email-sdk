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
  EmailMessageSchema,
  EmailReceiptSchema,
  EmailRejected,
  EmailRouter,
  EmailSender,
  emailRouterLayer,
} from "./index.js";
import { primitiveEmailLayer, primitiveSenderLayer } from "./primitive-email-sender.js";
import type { PrimitiveEmailOptions } from "./primitive-email-sender.js";
import { resendEmailLayer } from "./resend-email-sender.js";

const message = {
  body: { html: "<p>Synthetic {{literal}}</p>", text: "Synthetic {{literal}}" },
  from: { address: "sender@example.test", name: "Fictional Café" },
  subject: "Synthetic Primitive notification",
  to: "First@example.test",
} as const;

const options: PrimitiveEmailOptions = {
  apiKey: Redacted.make("prim_fictional-key"),
  keylessSends: "Reject",
  tracking: "ProviderDisabled",
};

const policy = {
  deadline: Duration.seconds(5),
  initialDelay: Duration.millis(100),
  maxAttempts: 1,
};

const id = "11111111-1111-4111-8111-111111111111";

const acknowledgement = {
  data: {
    accepted: ["first@example.test"],
    id,
    idempotent_replay: false,
    queue_id: "private-queue",
    rejected: [],
    status: "submitted_to_agent",
  },
  success: true,
};

const fixturePrimitiveLayer = (
  fixture: EmailHttpFixture,
  maxAttempts = 1,
  configuration = options,
) =>
  primitiveEmailLayer(configuration, { ...policy, maxAttempts }).pipe(
    Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.primitive.dev")),
  );

const fixturePrimitiveRoute = (primary: EmailHttpFixture, backup: EmailHttpFixture) =>
  emailRouterLayer(
    [
      { layer: fixturePrimitiveLayer(primary), name: "primary" },
      {
        layer: resendEmailLayer({ apiKey: Redacted.make("fictional-backup-key") }, policy).pipe(
          Layer.provide(emailFixtureClientLayer(backup.url, "https://api.resend.com")),
        ),
        name: "backup",
      },
    ],
    { fallbacks: ["backup"], primary: "primary" },
  );

const operation = Effect.gen(function* sendPrimitiveNotification() {
  return yield* (yield* Email).send(message, { idempotencyKey: "synthetic-key" });
});

const routedSend = Effect.gen(function* sendRoutedPrimitiveNotification() {
  return yield* (yield* (yield* EmailRouter).select()).send(message, {
    idempotencyKey: "synthetic-key",
  });
});

const Wire = Schema.Struct({
  attachments: Schema.Array(
    Schema.Struct({
      content_base64: Schema.String,
      content_id: Schema.optionalKey(Schema.String),
      content_type: Schema.optionalKey(Schema.String),
      filename: Schema.String,
    }),
  ),
  bcc: Schema.Array(Schema.String),
  body_html: Schema.String,
  body_text: Schema.String,
  cc: Schema.Array(Schema.String),
  from: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  subject: Schema.String,
  to: Schema.String,
  wait: Schema.Boolean,
});

describe("Primitive constrained immediate submissions", () => {
  it.live(
    "preserves one To plus cc/bcc, structured From, literal bodies, safe headers and independent binary/MIME/CID intent",
    () =>
      Effect.gen(function* inspectPrimitiveWire() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            data: {
              ...acknowledgement.data,
              accepted: ["first@example.test", "cc@example.test", "bcc@example.test"],
            },
          }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitRichPrimitiveMessage() {
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
                  contentId: "logo",
                  contentType: "image/png",
                  filename: "sample.png",
                },
                { contentBase64: "Ag==", contentType: "ProviderSelected", filename: "sample.txt" },
              ],
              bcc: "bcc@example.test",
              cc: "cc@example.test",
              headers: [
                { name: "Auto-Submitted", value: "auto-generated" },
                { name: "Precedence", value: "list" },
              ],
            },
            { idempotencyKey: "K".repeat(255) },
          );
        }).pipe(Effect.provide(fixturePrimitiveLayer(fixture)));

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual(receipt.messageId, id);
        const sent = yield* Queue.take(fixture.received);
        assert.strictEqual(sent.path, "/v1/send-mail");
        assert.strictEqual(sent.authorization, "Bearer prim_fictional-key");
        assert.strictEqual(sent.idempotencyKey, "K".repeat(255));
        assert.strictEqual(sent.method, "POST");
        const wire = yield* Schema.decodeEffect(Schema.fromJsonString(Wire))(sent.body);
        assert.strictEqual(wire.from, '"Fictional Café" <sender@example.test>');
        assert.strictEqual(wire.to, "First@example.test");
        assert.deepStrictEqual(wire.cc, ["cc@example.test"]);
        assert.deepStrictEqual(wire.bcc, ["bcc@example.test"]);
        assert.strictEqual(wire.body_text, message.body.text);
        assert.strictEqual(wire.body_html, message.body.html);
        assert.strictEqual(wire.subject, message.subject);
        assert.strictEqual(wire.headers["Auto-Submitted"], "auto-generated");
        assert.strictEqual(wire.headers.Precedence, "list");
        assert.strictEqual(wire.wait, false);
        assert.strictEqual(wire.attachments[0]?.filename, "sample.dat");
        assert.strictEqual(wire.attachments[0]?.content_type, "application/octet-stream");
        assert.deepStrictEqual(
          [...Buffer.from(wire.attachments[0]?.content_base64 ?? "", "base64")],
          [0, 255, 128, 10],
        );
        assert.strictEqual(wire.attachments[1]?.content_id, "logo");
        assert.strictEqual(wire.attachments[1]?.filename, "sample.png");
        assert.strictEqual(wire.attachments[1]?.content_type, "image/png");
        assert.deepStrictEqual(
          [...Buffer.from(wire.attachments[1]?.content_base64 ?? "", "base64")],
          [1],
        );
        assert.strictEqual(wire.attachments[2]?.content_type, undefined);
        assert.deepStrictEqual(
          [...Buffer.from(wire.attachments[2]?.content_base64 ?? "", "base64")],
          [2],
        );
        assert.notInclude(sent.body, '"fyi"');
        assert.notInclude(sent.body, '"payload_attachments"');
      }),
  );

  it.effect.each([1, 49])(
    "retains %i rejected recipients as partial counts without suppression identities or fallback",
    (rejectedCount) =>
      Effect.gen(function* preservePrimitivePartialEvidence() {
        const bcc = [
          "first-bcc@example.test",
          ...Array.from({ length: rejectedCount - 1 }, (_, index) => `bcc-${index}@example.test`),
        ] as const;

        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            ...acknowledgement,
            data: { ...acknowledgement.data, rejected: bcc.toReversed() },
          }),
          status: 200,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* Effect.gen(function* submitPartialPrimitiveGroup() {
          return yield* (yield* (yield* EmailRouter).select()).send(
            { ...message, bcc },
            { idempotencyKey: "synthetic-key" },
          );
        }).pipe(Effect.provide(fixturePrimitiveRoute(primary, backup)));

        assert(EmailReceiptSchema.guards.PartiallyAcceptedCounts(receipt));
        assert.strictEqual(receipt.route, "primary");
        assert.strictEqual(receipt.counts.acceptedCount, 1);
        assert.strictEqual(receipt.counts.rejectedCount, rejectedCount);
        assert(Object.isFrozen(receipt.counts));
        assert(Object.isFrozen(receipt));
        assert(!("suppressed" in receipt));
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live.each([
    { ...message, to: ["first@example.test", "second@example.test"] },
    { ...message, cc: "FIRST@example.test" },
    { ...message, to: { address: "first@example.test", name: "Fictional Name" } },
    { ...message, replyTo: "reply@example.test" },
    { ...message, sendAt: "2026-10-14T12:30:00Z" },
    { ...message, tags: [{ name: "p", value: "v" }] },
    { ...message, metadata: { workflow: "synthetic" } },
    { ...message, headers: [{ name: "X-Workflow", value: "private-value" }] },
    { ...message, headers: [{ name: "Precedence", value: "界" }] },
    { ...message, headers: [{ name: "Precedence", value: "x".repeat(201) }] },
    { ...message, body: { text: "界".repeat(88_000) } },
    { ...message, body: { html: "a".repeat(131_072), text: "a".repeat(131_073) } },
  ] as const)("rejects nonrepresentable or byte-over-budget intent without HTTP (%j)", (input) =>
    Effect.gen(function* rejectPrimitiveIntent() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const result = yield* Effect.gen(function* submitInvalidPrimitiveIntent() {
        return yield* (yield* Email).send(input, { idempotencyKey: "synthetic-key" });
      }).pipe(Effect.provide(fixturePrimitiveLayer(fixture)), Effect.result);

      assert(Result.isFailure(result) && result.failure instanceof EmailInvalidMessage);
      assert.notInclude(JSON.stringify(result.failure), "private-value");
      assert.strictEqual(yield* Queue.size(fixture.received), 0);
    }),
  );

  it.live("accepts the exact combined UTF-8 boundary", () =>
    Effect.gen(function* submitPrimitiveBodyBoundary() {
      const fixture = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const receipt = yield* Effect.gen(function* sendPrimitiveByteBoundary() {
        return yield* (yield* Email).send(
          { ...message, body: { html: "a".repeat(1144), text: "界".repeat(87_000) } },
          { idempotencyKey: "synthetic-key" },
        );
      }).pipe(Effect.provide(fixturePrimitiveLayer(fixture)));

      assert(EmailReceiptSchema.guards.Accepted(receipt));
      assert.strictEqual(yield* Queue.size(fixture.received), 1);
    }),
  );

  it.live.each([
    {},
    { data: acknowledgement.data, success: false },
    { ...acknowledgement, error: {} },
    { ...acknowledgement, data: { ...acknowledgement.data, status: "queued" } },
    {
      ...acknowledgement,
      data: { ...acknowledgement.data, delivery_status: "delivered", status: "delivered" },
    },
    { ...acknowledgement, data: { ...acknowledgement.data, id: "not-a-uuid" } },
    { ...acknowledgement, data: { ...acknowledgement.data, queue_id: null } },
    { ...acknowledgement, data: { ...acknowledgement.data, rejected: ["first@example.test"] } },
    { ...acknowledgement, data: { ...acknowledgement.data, accepted: ["foreign@example.test"] } },
    {
      ...acknowledgement,
      data: { ...acknowledgement.data, accepted: [], rejected: ["first@example.test"] },
    },
    {
      ...acknowledgement,
      data: {
        ...acknowledgement.data,
        content_hash: "private-prior-hash",
        idempotent_replay: true,
      },
    },
    { ...acknowledgement, data: { ...acknowledgement.data, idempotency: { replayed: true } } },
    { ...acknowledgement, idempotent_replay: true },
  ])("keeps incomplete, stale or contradictory evidence unknown and terminal (%j)", (body) =>
    Effect.gen(function* stopUnprovenPrimitiveEvidence() {
      const primary = yield* startEmailHttpFixture({ body: JSON.stringify(body), status: 200 });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "backup-id" }),
        status: 200,
      });

      const result = yield* routedSend.pipe(
        Effect.provide(fixturePrimitiveRoute(primary, backup)),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
      assert.strictEqual(result.failure.reason, "invalid-response");
      assert.strictEqual(yield* Queue.size(primary.received), 1);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
      assert.notInclude(JSON.stringify(result.failure), "private-prior-hash");
    }),
  );

  it.live.each([200, 401, 429, 504])(
    "never treats a replay header as current acknowledgement or definite safe rejection ($status)",
    (status) =>
      Effect.gen(function* refuseUncorrelatedPrimitiveReplay() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify(
            status === 200 ? acknowledgement : { error: { code: "unauthorized" }, success: false },
          ),
          idempotentReplayed: "true",
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const result = yield* routedSend.pipe(
          Effect.provide(fixturePrimitiveRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(result.failure.reason, "invalid-response");
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.effect(
    "retries fresh documented rate rejection with minimum delay and immutable key/body",
    () =>
      Effect.gen(function* retryPrimitiveRateRejection() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: { code: "rate_limited", message: "private-reason" },
            success: false,
          }),
          next: { body: JSON.stringify(acknowledgement), status: 200 },
          retryAfter: "2",
          status: 429,
        });

        const input: Omit<typeof message, "subject"> & { subject: string } = { ...message };

        const fiber = yield* Effect.gen(function* submitPrimitiveRateLimitedMessage() {
          return yield* (yield* Email).send(input, { idempotencyKey: "synthetic-key" });
        }).pipe(Effect.provide(fixturePrimitiveLayer(fixture, 3)), Effect.forkScoped);

        const first = yield* Queue.take(fixture.received);
        input.subject = "private-mutated";
        yield* TestClock.adjust(1000);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
        yield* TestClock.adjust(2000);
        assert(EmailReceiptSchema.guards.Accepted(yield* Fiber.join(fiber)));
        const retry = yield* Queue.take(fixture.received);
        assert.strictEqual(retry.body, first.body);
        assert.strictEqual(retry.idempotencyKey, "synthetic-key");
        assert.notInclude(retry.body, "private-mutated");
      }),
  );

  it.live.each([502, 503, 504, 409, 410])(
    "forwards keys without replaying ambiguous transport, cached relay failures or released-key lifecycles ($status)",
    (status) =>
      Effect.gen(function* stopPrimitiveUncertainty() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: { code: "outbound_relay_timeout", message: "private-reason" },
            success: false,
          }),
          status,
        });

        const result = yield* operation.pipe(
          Effect.provide(fixturePrimitiveLayer(fixture, 3)),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.size(fixture.received), 1);
        assert.notInclude(JSON.stringify(result.failure), "private-reason");
      }),
  );

  it.live.each([
    { code: "unauthorized", status: 401 },
    { code: "recipient_not_allowed", status: 403 },
    { code: "cannot_send_from_domain", status: 403 },
  ])(
    "permits real fallback only after fresh documented whole-send rejection ($code)",
    ({ status, code }) =>
      Effect.gen(function* advanceRejectedPrimitiveRoute() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: {
              code,
              gates: [{ subject: "private-address@example.test" }],
              message: "private-reason",
            },
            success: false,
          }),
          status,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const receipt = yield* routedSend.pipe(
          Effect.provide(fixturePrimitiveRoute(primary, backup)),
        );

        assert.strictEqual(receipt.route, "backup");
        assert.strictEqual((yield* Queue.take(backup.received)).idempotencyKey, "synthetic-key");
        assert.notInclude(JSON.stringify(receipt), "private-address");
      }),
  );

  it.live.each(["rate_limited", "unauthorized"])(
    "rejects contradictory cached failure markers instead of retrying/falling back (%s)",
    (code) =>
      Effect.gen(function* rejectPrimitiveCachedFailure() {
        const primary = yield* startEmailHttpFixture({
          body: JSON.stringify({
            error: { code, details: { idempotent_replay: true } },
            success: false,
          }),
          status: code === "rate_limited" ? 429 : 401,
        });

        const backup = yield* startEmailHttpFixture({
          body: JSON.stringify({ id: "backup-id" }),
          status: 200,
        });

        const result = yield* routedSend.pipe(
          Effect.provide(fixturePrimitiveRoute(primary, backup)),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailDeliveryUnknown);
        assert.strictEqual(yield* Queue.size(backup.received), 0);
      }),
  );

  it.live(
    "makes keyless content deduplication explicit and enforces required keys through public direct submission",
    () =>
      Effect.gen(function* requirePrimitiveLogicalKeys() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const missing = yield* Effect.gen(function* rejectKeylessPrimitiveSend() {
          return yield* (yield* Email).send(message);
        }).pipe(Effect.provide(fixturePrimitiveLayer(fixture)), Effect.result);

        assert(Result.isFailure(missing) && missing.failure instanceof EmailRejected);
        assert.strictEqual(missing.failure.reason, "unsupported-idempotency");
        yield* Effect.gen(function* rejectDirectPrimitiveKeylessSend() {
          const sender = yield* EmailSender;
          const parsed = yield* Schema.decodeEffect(EmailMessageSchema)(message);
          assert.strictEqual(Reflect.set(sender.idempotency, "keyRequirement", "Optional"), false);
          const result = yield* sender.submit({ message: parsed }).pipe(Effect.result);
          assert(Result.isFailure(result) && result.failure instanceof EmailRejected);
        }).pipe(
          Effect.provide(
            primitiveSenderLayer(options).pipe(
              Layer.provide(emailFixtureClientLayer(fixture.url, "https://api.primitive.dev")),
            ),
          ),
        );
        assert.strictEqual(yield* Queue.size(fixture.received), 0);

        const receipt = yield* Effect.gen(function* explicitlyAllowPrimitiveContentDeduplication() {
          return yield* (yield* Email).send(message);
        }).pipe(
          Effect.provide(
            fixturePrimitiveLayer(fixture, 1, {
              ...options,
              keylessSends: "AllowContentDeduplication",
            }),
          ),
        );

        assert(EmailReceiptSchema.guards.Accepted(receipt));
        assert.strictEqual((yield* Queue.take(fixture.received)).idempotencyKey, "");
      }),
  );

  it.live("requires backup keys before any primary HTTP", () =>
    Effect.gen(function* preflightPrimitiveKeyRequirement() {
      const primary = yield* startEmailHttpFixture({
        body: JSON.stringify({ id: "primary-id" }),
        status: 200,
      });

      const backup = yield* startEmailHttpFixture({
        body: JSON.stringify(acknowledgement),
        status: 200,
      });

      const result = yield* Effect.gen(function* submitUnkeyedRouteWithPrimitiveBackup() {
        return yield* (yield* (yield* EmailRouter).select()).send(message);
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
              { layer: fixturePrimitiveLayer(backup), name: "backup" },
            ],
            { fallbacks: ["backup"], primary: "primary" },
          ),
        ),
        Effect.result,
      );

      assert(Result.isFailure(result) && result.failure instanceof EmailRejected);
      assert.strictEqual(yield* Queue.size(primary.received), 0);
      assert.strictEqual(yield* Queue.size(backup.received), 0);
    }),
  );

  it.live.each(["prim_oat_fictional-oauth", "pconn_fictional-connection", "private\ncredential"])(
    "rejects unapproved credential types locally without retaining their values (%s)",
    (credential) =>
      Effect.gen(function* rejectPrimitiveCredential() {
        const fixture = yield* startEmailHttpFixture({
          body: JSON.stringify(acknowledgement),
          status: 200,
        });

        const result = yield* Effect.service(Email).pipe(
          Effect.provide(
            fixturePrimitiveLayer(fixture, 1, { ...options, apiKey: Redacted.make(credential) }),
          ),
          Effect.result,
        );

        assert(Result.isFailure(result) && result.failure instanceof EmailConfigurationError);
        assert.notInclude(JSON.stringify(result.failure), credential);
        assert.strictEqual(yield* Queue.size(fixture.received), 0);
      }),
  );
});
