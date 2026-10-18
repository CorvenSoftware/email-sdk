import { createHmac } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Redacted, Result, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailWebhookNormalizationError,
  EmailWebhookVerificationError,
  ResendWebhookEventSchema,
  ResendWebhookVerifier,
  parseResendWebhookEvent,
  resendWebhookLayer,
} from "./resend-webhook-verifier.js";

const secretBytes = Buffer.from("fictional-resend-event-signing-key");

const configuration = {
  signingSecrets: [Redacted.make(`whsec_${secretBytes.toString("base64")}`)],
} as const;

const epochMillis = 1_791_849_600_000;

const messageId = "private-provider-message-id";

const recipients = ["Second@fictional.invalid", "first@fictional.invalid"];

const proofForBody = Effect.fnUntraced(function* signResendEventBody(
  body: string,
  metadata: { readonly id?: string } = {},
) {
  yield* TestClock.setTime(epochMillis);
  const id = metadata.id ?? "private-signed-delivery-id";
  const timestamp = String(epochMillis / 1000);

  const signature = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  return yield* (yield* ResendWebhookVerifier).verify({
    body,
    headers: [
      { name: "svix-id", value: id },
      { name: "svix-timestamp", value: timestamp },
      { name: "svix-signature", value: `v1,${signature}` },
    ],
  });
});

const parseBody = Effect.fnUntraced(function* parseSignedResendBody(
  body: string,
  metadata: { readonly id?: string } = {},
) {
  return yield* parseResendWebhookEvent(yield* proofForBody(body, metadata));
});

const eventBody = (type: string): string =>
  JSON.stringify({
    created_at: "2026-02-22T23:41:12.126Z",
    data: {
      created_at: "2026-02-22T23:41:11.894Z",
      email_id: messageId,
      from: "Private Sender <private-sender@fictional.invalid>",
      message_id: "<different-rfc-message-id@fictional.invalid>",
      subject: "Private event subject 😀",
      tags: { private: "private-variable-value" },
      to: recipients,
    },
    id: "private-body-id-is-not-delivery-identity",
    type,
  });

describe("authenticated Resend webhook events", () => {
  it.effect.each([
    ["email.delivered", "Delivered"],
    ["email.bounced", "Bounced"],
    ["email.complained", "Complained"],
  ] as const)(
    "projects %s as %s using signed delivery identity, provider email ID and impacted recipient order",
    ([type, tag]) =>
      Effect.gen(function* projectResendOutcome() {
        const event = yield* parseBody(eventBody(type));
        assert.strictEqual(event._tag, tag);
        assert.strictEqual(event.type, type);
        assert.strictEqual(event.provider, "resend");
        assert.strictEqual(String(event.deliveryId), "private-signed-delivery-id");
        assert.strictEqual(String(event.providerMessageId), messageId);
        assert(!ResendWebhookEventSchema.guards.Other(event));
        assert.deepStrictEqual(event.recipients.map(String), recipients);
        assert.notInclude(JSON.stringify(event), "private-body-id-is-not-delivery-identity");
        assert.notInclude(JSON.stringify(event), "different-rfc-message-id");
        assert.notInclude(JSON.stringify(event), "Private event subject");
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect.each([
    "email.sent",
    "email.failed",
    "email.delivery_delayed",
    "email.suppressed",
    "email.opened",
    "email.clicked",
    "email.received",
    "domain.created",
    "contact.created",
    "inbox.email.sent",
    "email.future_state",
    "EMAIL.DELIVERED",
    "delivered",
  ])("preserves %s exactly without inventing a delivery outcome", (type) =>
    Effect.gen(function* preserveUnclassifiedResendEvent() {
      const event = yield* parseBody(eventBody(type));
      assert(ResendWebhookEventSchema.guards.Other(event));
      assert.strictEqual(event.type, type);
      assert.strictEqual(String(event.providerMessageId), messageId);
      assert.strictEqual(String(event.deliveryId), "private-signed-delivery-id");

      const withoutMessage = yield* parseBody(
        JSON.stringify({ data: { id: "private-unrelated-resource", to: null }, type }),
      );

      assert(ResendWebhookEventSchema.guards.Other(withoutMessage));
      assert.isUndefined(withoutMessage.providerMessageId);
      assert.notInclude(JSON.stringify(withoutMessage), "private-unrelated-resource");
    }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect.prop(
    "handles generated escaped provider fields without letting their text choose classification or identity",
    {
      text: Schema.String.check(Schema.isMaxLength(80), Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)),
    },
    ({ text }) =>
      Effect.gen(function* projectEscapedResendContent() {
        const body = JSON.stringify({
          data: {
            email_id: messageId,
            metadata: [{ a: text }, { a: text }],
            subject: text,
            to: recipients,
          },
          ignored: `${text} \\" type : email.bounced {} [] , :`,
          type: "email.delivered",
        });

        const event = yield* parseBody(body);
        assert(ResendWebhookEventSchema.guards.Delivered(event));
        assert.strictEqual(String(event.providerMessageId), messageId);
        assert.deepStrictEqual(event.recipients.map(String), recipients);
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "keeps signed identity stable across repeated parsing and new verification attempts without reinterpreting old events as current state",
    () =>
      Effect.gen(function* preserveResendEventIdentity() {
        const body = eventBody("email.delivered");
        const proof = yield* proofForBody(body);
        const first = yield* parseResendWebhookEvent(proof);
        yield* TestClock.setTime(epochMillis + 3_600_000);
        const repeated = yield* parseResendWebhookEvent(proof);
        assert.deepStrictEqual(repeated, first);
        const otherDelivery = yield* parseBody(body, { id: "different-signed-delivery-id" });
        assert.strictEqual(String(otherDelivery.deliveryId), "different-signed-delivery-id");
        assert.strictEqual(otherDelivery.providerMessageId, first.providerMessageId);
        assert.notStrictEqual(otherDelivery.deliveryId, first.deliveryId);
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "owns frozen recipient snapshots while preserving the original authenticated body separately",
    () =>
      Effect.gen(function* ownParsedResendEvent() {
        const proof = yield* proofForBody(eventBody("email.bounced"));
        const event = yield* parseResendWebhookEvent(proof);
        assert(ResendWebhookEventSchema.guards.Bounced(event));
        Reflect.set(event.recipients, "0", "private-mutated@fictional.invalid");
        Reflect.set(event.recipients, "length", 0);
        Reflect.set(event, "type", "email.delivered");
        assert.deepStrictEqual(event.recipients.map(String), recipients);
        assert.strictEqual(event.type, "email.bounced");
        assert.include(proof.body, "Private event subject");
        assert.notInclude(JSON.stringify(event), "Private event subject");
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "retains known report meaning after event serialization and refuses to disguise it as an unclassified event",
    () =>
      Effect.gen(function* parseStoredResendObservation() {
        const event = yield* parseBody(eventBody("email.complained"));
        const encoded = yield* Schema.encodeEffect(ResendWebhookEventSchema)(event);
        const decoded = yield* Schema.decodeEffect(ResendWebhookEventSchema)(encoded);
        assert.deepStrictEqual(decoded, event);
        const other = yield* parseBody(eventBody("email.future"));
        assert(ResendWebhookEventSchema.guards.Other(other));
        const inconsistent = { ...other, type: "email.delivered" };

        const result = yield* Schema.decodeEffect(ResendWebhookEventSchema)(inconsistent).pipe(
          Effect.result,
        );

        assert(Result.isFailure(result));
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect.each([
    "null",
    "[]",
    "123",
    "true",
    '"private-scalar"',
    "{}",
    '{"type":"email.delivered"}',
    '{"type":"email.delivered","data":null}',
    '{"type":"email.future","data":[]}',
    '{"type":"email.future","data":false}',
    '{"type":"email.delivered","data":{}}',
    '{"type":"email.delivered","data":{"id":"private-alias","to":["a@fictional.invalid"]}}',
    '{"type":"email.delivered","data":{"email_id":0,"to":["a@fictional.invalid"]}}',
    '{"type":"email.delivered","data":{"email_id":"private-id"}}',
    '{"type":"email.delivered","data":{"email_id":"private-id","to":[]}}',
    '{"type":"email.delivered","data":{"email_id":"private-id","to":["not-an-address"]}}',
    '{"type":"email.future","data":{"email_id":null}}',
    '{"type":" email.delivered","data":{}}',
  ])(
    "refuses incomplete or contradictory selected event fields instead of falling back to Other (%s)",
    (body) =>
      Effect.gen(function* refuseMalformedResendEvent() {
        const result = yield* parseBody(body).pipe(Effect.result);
        assert(
          Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
        );
        assert.strictEqual(result.failure.reason, "invalid-payload");
        assert.notInclude(JSON.stringify(result.failure), "private");
        assert.notInclude(result.failure.message, "private");
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect.each([
    "",
    "{",
    '{"type":"email.future","data":{}} trailing',
    '{"type":"email.future","data":{},}',
    '{"type":"email.future","data":{"a":[}}',
    '{"type":"email.future","data":{"a":"unterminated}}',
    '{"type":"email.future","data":{"a":"\\uZZZZ"}}',
    '{"type":"email.delivered","type":"email.bounced","data":{}}',
    '{"type":"email.delivered","typ\\u0065":"email.bounced","data":{}}',
    '{"type":"email.future","data":{"private-key":1,"private-key":2}}',
    '{"type":"email.future","data":{"nested":[{"a":1,"\\u0061":2}]}}',
    '{"type":"email.future","data":{"":1,"":2}}',
  ])("rejects malformed JSON and ambiguous decoded keys at any level (%s)", (body) =>
    Effect.gen(function* refuseAmbiguousResendJson() {
      const result = yield* parseBody(body).pipe(Effect.result);
      assert(Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError);
      assert.strictEqual(result.failure.reason, "invalid-json");
      assert.notInclude(JSON.stringify(result.failure), "private-key");
    }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "preserves all fifty reported recipient spellings without inventing coverage and rejects excess or ambiguous membership",
    () =>
      Effect.gen(function* boundResendReportedRecipients() {
        const addresses = Array.from(
          { length: 50 },
          (_, index) => `Person${index}@fictional.invalid`,
        );

        const event = yield* parseBody(
          JSON.stringify({ data: { email_id: messageId, to: addresses }, type: "email.delivered" }),
        );

        assert(ResendWebhookEventSchema.guards.Delivered(event));
        assert.deepStrictEqual(event.recipients.map(String), addresses);

        for (const to of [
          [...addresses, "extra@fictional.invalid"],
          ["Person@fictional.invalid", "person@fictional.invalid"],
        ]) {
          const result = yield* parseBody(
            JSON.stringify({ data: { email_id: messageId, to }, type: "email.delivered" }),
          ).pipe(Effect.result);

          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-payload");
        }
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "bounds structural nesting before native JSON decoding while allowing the supported deepest ignored content",
    () =>
      Effect.gen(function* boundResendEventDepth() {
        for (const depth of [30, 31]) {
          const nested = `${"[".repeat(depth)}0${"]".repeat(depth)}`;

          const result = yield* parseBody(
            `{"type":"email.future","data":{"nested":${nested}}}`,
          ).pipe(Effect.result);

          if (depth === 30) {
            assert(
              Result.isSuccess(result) && ResendWebhookEventSchema.guards.Other(result.success),
            );
          } else {
            assert(
              Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
            );
            assert.strictEqual(result.failure.reason, "payload-limit");
          }
        }
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "bounds total structural work and decoded object keys without treating delimiters inside strings as structure",
    () =>
      Effect.gen(function* boundResendEventJsonWork() {
        for (const count of [16_375, 16_376]) {
          const numbers = Array.from({ length: count }, () => "0").join(",");

          const result = yield* parseBody(
            `{"type":"email.future","data":{"values":[${numbers}]}}`,
          ).pipe(Effect.result);

          if (count === 16_375) {
            assert(Result.isSuccess(result));
          } else {
            assert(
              Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
            );
            assert.strictEqual(result.failure.reason, "payload-limit");
          }
        }

        for (const count of [4094, 4095]) {
          const fields = Array.from({ length: count }, (_, index) => `"k${index}":0`).join(",");

          const result = yield* parseBody(`{"type":"email.future","data":{${fields}}}`).pipe(
            Effect.result,
          );

          if (count === 4094) {
            assert(Result.isSuccess(result));
          } else {
            assert(
              Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
            );
            assert.strictEqual(result.failure.reason, "payload-limit");
          }
        }

        for (const count of [256, 257]) {
          const key = "a".repeat(count);

          const result = yield* parseBody(`{"type":"email.future","data":{"${key}":0}}`).pipe(
            Effect.result,
          );

          if (count === 256) {
            assert(Result.isSuccess(result));
          } else {
            assert(
              Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
            );
            assert.strictEqual(result.failure.reason, "payload-limit");
          }
        }
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "projects an actually authenticated maximum-byte UTF-8 body without parsing private extra data into results",
    () =>
      Effect.gen(function* projectLargeResendEvent() {
        const fields = {
          data: { email_id: messageId, to: recipients },
          ignored: "",
          type: "email.delivered",
        };

        const remaining = 1_048_576 - Buffer.byteLength(JSON.stringify(fields));

        const body = JSON.stringify({
          ...fields,
          ignored: `${"界".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}`,
        });

        assert.strictEqual(Buffer.byteLength(body), 1_048_576);
        const event = yield* parseBody(body);
        assert(ResendWebhookEventSchema.guards.Delivered(event));
        assert.deepStrictEqual(event.recipients.map(String), recipients);
        assert.notInclude(JSON.stringify(event), "界");
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "verifies before interpreting payloads and preserves expected authentication failures",
    () =>
      Effect.gen(function* rejectUnverifiedResendEvent() {
        const trace = yield* startEmailTraceFixture();
        yield* TestClock.setTime(epochMillis);

        const result = yield* Effect.gen(function* verifyBeforeNormalizing() {
          const verifier = yield* ResendWebhookVerifier;
          const proof = yield* verifier.verify({ body: eventBody("email.delivered"), headers: [] });

          return yield* parseResendWebhookEvent(proof);
        }).pipe(Effect.provideService(Tracer.Tracer, trace.tracer), Effect.result);

        assert(Result.isFailure(result) && result.failure instanceof EmailWebhookVerificationError);
        assert.notInclude(yield* trace.diagnostics, "ResendWebhook.parseEvent");
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );

  it.effect(
    "keeps private event data and original defects out of NativeSpan exits while preserving caller defects",
    () =>
      Effect.gen(function* tracePrivateResendEvents() {
        const trace = yield* startEmailTraceFixture();
        const proof = yield* proofForBody(eventBody("email.delivered"));

        const malformed = yield* proofForBody(
          '{"type":"email.delivered","data":{"private-key":"private-body-value"}}',
        );

        const defective = { ...proof };
        Object.defineProperty(defective, "body", {
          get() {
            throw new Error("private-event-defect");
          },
        });
        yield* Effect.gen(function* observeResendEventExits() {
          yield* parseResendWebhookEvent(proof);
          const failure = yield* parseResendWebhookEvent(malformed).pipe(Effect.result);
          assert(
            Result.isFailure(failure) && failure.failure instanceof EmailWebhookNormalizationError,
          );
          const defect = yield* parseResendWebhookEvent(defective).pipe(Effect.exit);
          assert(Exit.hasDies(defect));
        }).pipe(Effect.provideService(Tracer.Tracer, trace.tracer));
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "ResendWebhook.parseEvent");

        for (const value of [
          messageId,
          ...recipients,
          proof.id,
          proof.body,
          "Private event subject",
          "private-key",
          "private-body-value",
          "private-event-defect",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }).pipe(Effect.provide(resendWebhookLayer(configuration))),
  );
});
