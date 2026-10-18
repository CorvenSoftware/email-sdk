import { webcrypto } from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted, Result, Schema, Tracer } from "effect";
import { TestClock } from "effect/testing";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailWebhookNormalizationError,
  MailgunWebhookEventSchema,
  MailgunWebhookRecipientSchema,
  MailgunWebhookVerifier,
  mailgunWebhookLayer,
  parseMailgunWebhookEvent,
} from "./mailgun-webhook-verifier.js";

const eventId = "fictional-private-event-id";

const messageId = "reported-message@fictional.invalid";

const recipient = "Private.Person@fictional.invalid";

const eventTime = 1_770_146_431.6585283;

const delivery = {
  account: { id: "private-account-id" },
  "delivery-status": { code: 250, message: "private-smtp-reason", tls: true },
  domain: { name: "private-domain.invalid" },
  event: "delivered",
  flags: { "is-authenticated": true, "is-test-mode": false },
  id: eventId,
  message: {
    headers: {
      "message-id": messageId,
      subject: "private-subject",
      to: "different@fictional.invalid",
    },
  },
  recipient,
  storage: { key: "private-storage-key", url: "https://fictional.invalid/private" },
  timestamp: eventTime,
};

const bodyFor = (data: Schema.Json): string => JSON.stringify({ "event-data": data });

const expectFailure = Effect.fnUntraced(function* expectMailgunPayloadFailure(
  body: string,
  reason: "invalid-json" | "invalid-payload" | "payload-limit" = "invalid-payload",
) {
  const result = yield* parseMailgunWebhookEvent(body).pipe(Effect.result);
  assert(Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError);
  assert.strictEqual(result.failure.reason, reason);
  assert.notInclude(JSON.stringify(result.failure), "private");
});

describe("Mailgun unsigned webhook event projection", () => {
  it.effect(
    "preserves per-event identity, fractional event time and actual reported membership without authenticating body flags",
    () =>
      Effect.gen(function* projectMailgunDelivery() {
        const event = yield* parseMailgunWebhookEvent(bodyFor(delivery));
        assert(MailgunWebhookEventSchema.guards.Delivered(event));
        assert.strictEqual(event.provider, "mailgun");
        assert.strictEqual(event.provenance, "UnverifiedPayload");
        assert.strictEqual(String(event.providerEventId), eventId);
        assert.strictEqual(event.eventTimestampSeconds, eventTime);
        assert.strictEqual(String(event.rfcMessageId), messageId);
        assert(MailgunWebhookRecipientSchema.guards.Address(event.recipient));
        assert.strictEqual(String(event.recipient.address), recipient);

        for (const value of [
          "private-account-id",
          "private-domain.invalid",
          "private-smtp-reason",
          "private-subject",
          "private-storage-key",
          "different@fictional.invalid",
          "is-authenticated",
          "is-test-mode",
        ]) {
          assert.notInclude(JSON.stringify(event), value);
        }
      }),
  );

  it.effect.each(["permanent", "temporary"] as const)(
    "retains %s failure severity without inventing a hard bounce or retry permission",
    (severity) =>
      Effect.gen(function* projectMailgunFailure() {
        const event = yield* parseMailgunWebhookEvent(
          bodyFor({ ...delivery, event: "failed", reason: "suppress-bounce", severity }),
        );

        assert(MailgunWebhookEventSchema.guards.Failed(event));
        assert.strictEqual(event.type, "failed");
        assert.strictEqual(event.severity, severity);
        assert.strictEqual(event.provenance, "UnverifiedPayload");
      }),
  );

  it.effect.each(["delivered", "failed", "complained"] as const)(
    "represents exact recipient redaction in %s without substituting a header recipient",
    (type) =>
      Effect.gen(function* preserveMailgunRedaction() {
        const event = yield* parseMailgunWebhookEvent(
          bodyFor({ ...delivery, event: type, recipient: "[REDACTED]", severity: "temporary" }),
        );

        assert(!MailgunWebhookEventSchema.guards.Other(event));
        assert(MailgunWebhookRecipientSchema.guards.Redacted(event.recipient));
        assert.strictEqual(String(event.rfcMessageId), messageId);
        assert.notInclude(JSON.stringify(event), "different@fictional.invalid");
        assert(Object.isFrozen(event.recipient));
      }),
  );

  it.effect("preserves complaint membership as an unsigned report, not a consent effect", () =>
    Effect.gen(function* projectMailgunComplaint() {
      const event = yield* parseMailgunWebhookEvent(bodyFor({ ...delivery, event: "complained" }));
      assert(MailgunWebhookEventSchema.guards.Complained(event));
      assert(MailgunWebhookRecipientSchema.guards.Address(event.recipient));
      assert.strictEqual(String(event.recipient.address), recipient);
    }),
  );

  it.effect.each([
    "accepted",
    "opened",
    "clicked",
    "unsubscribed",
    "stored",
    "permanent_fail",
    "Delivered",
    "email.delivered",
    "future.kind",
  ] as const)("retains exact unclassified %s without alias promotion", (type) =>
    Effect.gen(function* preserveUnclassifiedMailgunReport() {
      const event = yield* parseMailgunWebhookEvent(
        bodyFor({ event: type, id: eventId, recipient: null, timestamp: eventTime }),
      );

      assert(MailgunWebhookEventSchema.guards.Other(event));
      assert.strictEqual(event.type, type);
      assert.isUndefined(event.rfcMessageId);
      assert.strictEqual(String(event.providerEventId), eventId);
    }),
  );

  it.effect(
    "projects only actually supplied RFC header identity in other families and refuses invalid selected nested fields",
    () =>
      Effect.gen(function* projectMailgunOtherMessageIdentity() {
        const event = yield* parseMailgunWebhookEvent(bodyFor({ ...delivery, event: "opened" }));
        assert(MailgunWebhookEventSchema.guards.Other(event));
        assert.strictEqual(String(event.rfcMessageId), messageId);

        for (const message of [null, { headers: null }, { headers: { "message-id": "" } }]) {
          yield* expectFailure(bodyFor({ ...delivery, event: "opened", message }));
        }
      }),
  );

  it.effect.prop(
    "ignores generated escaped private extras without changing membership or event identity",
    { text: Schema.String },
    ({ text }) =>
      Effect.gen(function* projectGeneratedMailgunContent() {
        const event = yield* parseMailgunWebhookEvent(
          bodyFor({
            ...delivery,
            ignored: { content: text, nested: [{ same: text }, { same: text }] },
            message: { ...delivery.message, arbitrary: text },
          }),
        );

        assert(MailgunWebhookEventSchema.guards.Delivered(event));
        assert.strictEqual(String(event.providerEventId), eventId);
        assert.strictEqual(String(event.rfcMessageId), messageId);
        assert(MailgunWebhookRecipientSchema.guards.Address(event.recipient));
        assert.strictEqual(String(event.recipient.address), recipient);
      }),
  );

  it.effect(
    "does not deduplicate day-scoped IDs or renew authentication when reports are parsed again",
    () =>
      Effect.gen(function* retainRepeatedMailgunObservations() {
        const first = yield* parseMailgunWebhookEvent(bodyFor(delivery));
        yield* TestClock.setTime(9_000_000_000_000);
        const repeated = yield* parseMailgunWebhookEvent(bodyFor(delivery));
        assert.deepStrictEqual(repeated, first);

        const nextDay = yield* parseMailgunWebhookEvent(
          bodyFor({
            ...delivery,
            recipient: "next@fictional.invalid",
            timestamp: eventTime + 86_400,
          }),
        );

        assert.strictEqual(nextDay.providerEventId, first.providerEventId);
        assert.notStrictEqual(nextDay.eventTimestampSeconds, first.eventTimestampSeconds);
        assert(MailgunWebhookEventSchema.guards.Delivered(nextDay));
        assert(MailgunWebhookRecipientSchema.guards.Address(nextDay.recipient));
        assert.strictEqual(String(nextDay.recipient.address), "next@fictional.invalid");
        assert(Object.isFrozen(first));
        assert(MailgunWebhookEventSchema.guards.Delivered(first));
        assert(Object.isFrozen(first.recipient));
      }),
  );

  it.effect.each([
    null,
    [],
    "private-scalar",
    {},
    { event: "delivered", id: eventId, timestamp: eventTime },
    { "event-data": null },
    { "event-data": { ...delivery, event: " delivered" } },
    { "event-data": { ...delivery, id: "" } },
    { "event-data": { ...delivery, eventId, id: undefined } },
    { "event-data": { ...delivery, timestamp: "1770146431" } },
    { "event-data": { ...delivery, timestamp: -1 } },
    { "event-data": { ...delivery, timestamp: 10_000_000_000 } },
    { "event-data": { ...delivery, recipient: "[redacted]" } },
    { "event-data": { ...delivery, recipient: null } },
    { "event-data": { ...delivery, recipient: "Name <person@fictional.invalid>" } },
    { "event-data": { ...delivery, message: { headers: { "Message-ID": messageId } } } },
    { "event-data": { ...delivery, message: { id: messageId } } },
    { "event-data": { ...delivery, event: "failed" } },
    { "event-data": { ...delivery, event: "failed", severity: "Permanent" } },
    { "event-data": { ...delivery, event: "failed", severity: "unknown-future" } },
  ])(
    "rejects malformed native envelope or selected report fields %# instead of returning Other",
    (input) => expectFailure(JSON.stringify(input)),
  );

  it.effect("uses event-data exclusively rather than root alias, account or signature fields", () =>
    Effect.gen(function* selectMailgunNativeEnvelope() {
      const event = yield* parseMailgunWebhookEvent(
        JSON.stringify({
          event: "complained",
          "event-data": delivery,
          id: "private-root-id",
          signature: { timestamp: "0" },
          timestamp: 0,
        }),
      );

      assert(MailgunWebhookEventSchema.guards.Delivered(event));
      assert.strictEqual(String(event.providerEventId), eventId);
      assert.strictEqual(event.eventTimestampSeconds, eventTime);
      yield* expectFailure(JSON.stringify({ "event-data": { ...delivery, timestamp: undefined } }));
    }),
  );

  it.effect.each([
    '{"event-data":',
    '{"event-data":{},"event-data":{}}',
    '{"event-data":{"event":"delivered","ev\\u0065nt":"complained"}}',
    '{"event-data":{},"ignored":{"private":0,"private":1}}',
  ])("refuses malformed or duplicate JSON %# even in ignored content", (body) =>
    expectFailure(body, "invalid-json"),
  );

  it.effect(
    "retains event time and handle boundary values without padding, fabrication or future-time freshness checks",
    () =>
      Effect.gen(function* boundMailgunEventIdentity() {
        for (const timestamp of [0, 0.25, 9_999_999_999]) {
          const event = yield* parseMailgunWebhookEvent(
            bodyFor({ ...delivery, id: "x".repeat(256), timestamp }),
          );

          assert.strictEqual(event.eventTimestampSeconds, timestamp);
          assert.strictEqual(event.providerEventId.length, 256);
        }

        yield* expectFailure(bodyFor({ ...delivery, id: "x".repeat(257) }));

        const longest = yield* parseMailgunWebhookEvent(
          bodyFor({ ...delivery, message: { headers: { "message-id": "x".repeat(998) } } }),
        );

        assert(MailgunWebhookEventSchema.guards.Delivered(longest));
        assert.strictEqual(longest.rfcMessageId.length, 998);
        yield* expectFailure(
          bodyFor({ ...delivery, message: { headers: { "message-id": "x".repeat(999) } } }),
        );
      }),
  );

  it.effect(
    "applies shared whole-envelope depth, decoded key and UTF-8 limits before projecting fields",
    () =>
      Effect.gen(function* boundMailgunWebhookBody() {
        const text = bodyFor(delivery);
        yield* expectFailure(
          `${text.slice(0, -1)},"ignored":${"[".repeat(32)}0${"]".repeat(32)}}`,
          "payload-limit",
        );
        yield* expectFailure(`${text.slice(0, -1)},"${"k".repeat(257)}":0}`, "payload-limit");
        const base = JSON.stringify({ "event-data": delivery, ignored: "" });
        const remaining = 1_048_576 - Buffer.byteLength(base);

        const body = JSON.stringify({
          "event-data": delivery,
          ignored: `${"界".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}`,
        });

        assert.strictEqual(Buffer.byteLength(body), 1_048_576);
        const event = yield* parseMailgunWebhookEvent(body);
        assert(MailgunWebhookEventSchema.guards.Delivered(event));
        yield* expectFailure(`${body} `);
        yield* expectFailure('{"event-data":{},"ignored":"\uD800"}');
      }),
  );

  it.effect(
    "preserves unverified provenance and recipient redaction through Schema reuse, rejecting disguised known kinds",
    () =>
      Effect.gen(function* reparseStoredMailgunReport() {
        const report = yield* parseMailgunWebhookEvent(
          bodyFor({ ...delivery, recipient: "[REDACTED]" }),
        );

        const stored = yield* Schema.encodeEffect(MailgunWebhookEventSchema)(report);
        const restored = yield* Schema.decodeEffect(MailgunWebhookEventSchema)(stored);
        assert.deepStrictEqual(restored, report);
        const changed = { ...stored, provenance: "Authenticated" };
        assert(
          Result.isFailure(
            yield* Schema.decodeUnknownEffect(MailgunWebhookEventSchema)(changed).pipe(
              Effect.result,
            ),
          ),
        );

        const other = yield* parseMailgunWebhookEvent(
          bodyFor({ event: "future", id: eventId, timestamp: eventTime }),
        );

        assert(MailgunWebhookEventSchema.guards.Other(other));
        const disguised = { ...other, type: "failed" };
        assert(
          Result.isFailure(
            yield* Schema.decodeEffect(MailgunWebhookEventSchema)(disguised).pipe(Effect.result),
          ),
        );
      }),
  );

  it.effect(
    "can verify the same challenge beside different event bodies without promoting either to authenticated content",
    () =>
      Effect.gen(function* separateMailgunChallengeAndBody() {
        const secret = "fictional-mailgun-signing-secret";
        const token = "fictional-private-mailgun-token-012345678901234567";
        const timestamp = "1791849600";

        const key = yield* Effect.promise(
          webcrypto.subtle.importKey.bind(
            webcrypto.subtle,
            "raw",
            new TextEncoder().encode(secret),
            { hash: "SHA-256", name: "HMAC" },
            false,
            ["sign"],
          ),
        );

        const digest = yield* Effect.promise(
          webcrypto.subtle.sign.bind(
            webcrypto.subtle,
            "HMAC",
            key,
            new TextEncoder().encode(`${timestamp}${token}`),
          ),
        );

        const signature = { signature: Buffer.from(digest).toString("hex"), timestamp, token };
        yield* TestClock.setTime(Number(timestamp) * 1000);
        const verifier = yield* MailgunWebhookVerifier;
        const firstProof = yield* verifier.verifySignature(signature);

        const first = yield* parseMailgunWebhookEvent(
          JSON.stringify({ "event-data": delivery, signature }),
        );

        const secondProof = yield* verifier.verifySignature(signature);

        const second = yield* parseMailgunWebhookEvent(
          JSON.stringify({
            "event-data": {
              ...delivery,
              event: "complained",
              recipient: "changed@fictional.invalid",
            },
            signature,
          }),
        );

        assert.deepStrictEqual(firstProof, secondProof);
        assert(MailgunWebhookEventSchema.guards.Delivered(first));
        assert(MailgunWebhookEventSchema.guards.Complained(second));
        assert.strictEqual(first.provenance, "UnverifiedPayload");
        assert.strictEqual(second.provenance, "UnverifiedPayload");
        assert(MailgunWebhookRecipientSchema.guards.Address(second.recipient));
        assert.strictEqual(String(second.recipient.address), "changed@fictional.invalid");
      }).pipe(
        Effect.provide(
          mailgunWebhookLayer({
            signatureField: "signature",
            signingSecrets: [Redacted.make("fictional-mailgun-signing-secret")],
          }),
        ),
      ),
  );

  it.effect(
    "excludes event content, account labels, private identifiers and malformed bodies from NativeSpan exits",
    () =>
      Effect.gen(function* traceMailgunProjection() {
        const trace = yield* startEmailTraceFixture();
        yield* Effect.gen(function* observeMailgunParseExits() {
          yield* parseMailgunWebhookEvent(bodyFor(delivery));
          yield* expectFailure(
            bodyFor({
              ...delivery,
              id: "private-failed-id",
              recipient: "private-invalid-recipient",
            }),
          );
        }).pipe(Effect.provideService(Tracer.Tracer, trace.tracer));
        const diagnostics = yield* trace.diagnostics;
        assert.include(diagnostics, "MailgunWebhook.parseEvent");

        for (const value of [
          eventId,
          messageId,
          recipient,
          "private-account-id",
          "private-domain.invalid",
          "private-storage-key",
          "private-smtp-reason",
          "private-subject",
          "private-failed-id",
          "private-invalid-recipient",
        ]) {
          assert.notInclude(diagnostics, value);
        }
      }),
  );
});
