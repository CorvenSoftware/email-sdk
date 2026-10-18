import { assert, describe, it } from "@effect/vitest";
import { Effect, Result, Schema, Tracer } from "effect";
import { startEmailTraceFixture } from "../test/email-tracing-fixture.js";
import {
  EmailWebhookNormalizationError,
  PostmarkWebhookEventSchema,
  parsePostmarkWebhookEvent,
} from "./postmark-webhook-event.js";

const messageId = "883953f4-6105-42a2-a16a-77a8eac79483";

const recipient = "Private.Person@fictional.invalid";

const delivery = {
  DeliveredAt: "2026-11-05T16:33:54.9070259Z",
  Details: "private-mail-server-response",
  ID: 692_560_173,
  MessageID: messageId,
  MessageStream: "private-stream",
  Metadata: { private: "private-metadata-value" },
  Recipient: recipient,
  RecordType: "Delivery",
  ServerID: 23,
};

const bounceBody = (type: string, code: number): string =>
  JSON.stringify({
    BouncedAt: "2026-11-05T16:33:54.9070259Z",
    CanActivate: false,
    Content: "private-bounce-dump",
    Description: "private description says permanently rejected",
    Email: recipient,
    ID: 692_560_174,
    Inactive: true,
    MessageID: messageId,
    RecordType: "Bounce",
    Type: type,
    TypeCode: code,
  });

const complaint = {
  BouncedAt: "2026-11-05T16:33:54.9070259Z",
  CanActivate: false,
  Email: recipient,
  ID: 692_560_175,
  Inactive: true,
  MessageID: messageId,
  RecordType: "SpamComplaint",
  Type: "SpamComplaint",
  TypeCode: 100_001,
};

describe("Postmark unsigned webhook observations", () => {
  it.effect(
    "projects recipient-server delivery without inventing authentication, a delivery ID or original audience coverage",
    () =>
      Effect.gen(function* projectPostmarkDelivery() {
        const event = yield* parsePostmarkWebhookEvent(JSON.stringify(delivery));
        assert(PostmarkWebhookEventSchema.guards.Delivered(event));
        assert.strictEqual(event.provider, "postmark");
        assert.strictEqual(event.provenance, "UnverifiedPayload");
        assert.strictEqual(event.type, "Delivery");
        assert.strictEqual(String(event.providerMessageId), messageId);
        assert.strictEqual(String(event.recipient), recipient);

        for (const value of [
          "private-mail-server-response",
          "private-stream",
          "private-metadata-value",
          "692560173",
          "2026-11-05",
        ]) {
          assert.notInclude(JSON.stringify(event), value);
        }
      }),
  );

  it.effect("separates coherent hard-bounce reports from the complaint record family", () =>
    Effect.gen(function* projectPostmarkHardBounceAndComplaint() {
      const hard = yield* parsePostmarkWebhookEvent(bounceBody("HardBounce", 1));
      assert(PostmarkWebhookEventSchema.guards.Bounced(hard));
      assert.strictEqual(hard.bounceType, "HardBounce");
      assert.strictEqual(hard.bounceTypeCode, 1);
      assert.strictEqual(String(hard.recipient), recipient);
      const spam = yield* parsePostmarkWebhookEvent(JSON.stringify(complaint));
      assert(PostmarkWebhookEventSchema.guards.Complained(spam));
      assert.strictEqual(spam.type, "SpamComplaint");
      assert.strictEqual(spam.provenance, "UnverifiedPayload");
      assert.strictEqual(String(spam.providerMessageId), messageId);
      assert.strictEqual(String(spam.recipient), recipient);
    }),
  );

  it.effect.each([
    ["Transient", 2],
    ["Unsubscribe", 16],
    ["Subscribe", 32],
    ["AutoResponder", 64],
    ["AddressChange", 128],
    ["DnsError", 256],
    ["SpamNotification", 512],
    ["OpenRelayTest", 1024],
    ["Unknown", 2048],
    ["SoftBounce", 4096],
    ["VirusNotification", 8192],
    ["ChallengeVerification", 16_384],
    ["BadEmailAddress", 100_000],
    ["SpamComplaint", 100_001],
    ["ManuallyDeactivated", 100_002],
    ["Unconfirmed", 100_003],
    ["Blocked", 100_006],
    ["SMTPApiError", 100_007],
    ["InboundError", 100_008],
    ["DMARCPolicy", 100_009],
    ["TemplateRenderingFailed", 100_010],
    ["FutureBounceClass", 200_000],
  ] as const)(
    "retains native %s/%s as a report, not a guessed hard bounce or complaint",
    ([type, code]) =>
      Effect.gen(function* retainNativePostmarkBounceReport() {
        const event = yield* parsePostmarkWebhookEvent(bounceBody(type, code));
        assert(PostmarkWebhookEventSchema.guards.BounceReported(event));
        assert.strictEqual(event.bounceType, type);
        assert.strictEqual(event.bounceTypeCode, code);
        assert.strictEqual(event.type, "Bounce");
        assert.strictEqual(event.provenance, "UnverifiedPayload");
        assert.strictEqual(String(event.recipient), recipient);
        assert.notInclude(JSON.stringify(event), "private-bounce-dump");

        const mismatch = yield* parsePostmarkWebhookEvent(
          bounceBody(type, type === "FutureBounceClass" ? 1 : code + 1),
        ).pipe(Effect.result);

        assert(
          Result.isFailure(mismatch) && mismatch.failure instanceof EmailWebhookNormalizationError,
        );
        assert.strictEqual(mismatch.failure.reason, "invalid-payload");
      }),
  );

  it.effect.each([
    "Open",
    "Click",
    "SubscriptionChange",
    "Inbound",
    "SMTPApiError",
    "FutureRecord",
    "delivery",
    "email.delivered",
  ])("keeps %s unclassified without fuzzy aliases or recipient claims", (type) =>
    Effect.gen(function* retainOtherPostmarkRecord() {
      const event = yield* parsePostmarkWebhookEvent(
        JSON.stringify({
          Email: null,
          MessageID: messageId,
          RecordType: type,
          Type: "HardBounce",
          TypeCode: 1,
        }),
      );

      assert(PostmarkWebhookEventSchema.guards.Other(event));
      assert.strictEqual(event.type, type);
      assert.strictEqual(String(event.providerMessageId), messageId);

      const withoutMessage = yield* parsePostmarkWebhookEvent(
        JSON.stringify({ ID: 123, RecordType: type, messageId: "private-alias" }),
      );

      assert(PostmarkWebhookEventSchema.guards.Other(withoutMessage));
      assert.isUndefined(withoutMessage.providerMessageId);
      assert.notInclude(JSON.stringify(withoutMessage), "private-alias");
    }),
  );

  it.effect(
    "preserves two recipients on the same message and repeated observations without pretending MessageID deduplicates events",
    () =>
      Effect.gen(function* preservePostmarkRecipientScope() {
        const body = JSON.stringify(delivery);
        const first = yield* parsePostmarkWebhookEvent(body);
        const repeated = yield* parsePostmarkWebhookEvent(body);

        const copy = yield* parsePostmarkWebhookEvent(
          JSON.stringify({ ...delivery, Recipient: "Copy@fictional.invalid" }),
        );

        assert(PostmarkWebhookEventSchema.guards.Delivered(first));
        assert(PostmarkWebhookEventSchema.guards.Delivered(copy));
        assert.deepStrictEqual(repeated, first);
        assert.strictEqual(copy.providerMessageId, first.providerMessageId);
        assert.notStrictEqual(copy.recipient, first.recipient);
        Reflect.set(first, "recipient", "mutated@fictional.invalid");
        Reflect.set(first, "provenance", "Authenticated");
        assert.strictEqual(String(first.recipient), recipient);
        assert.strictEqual(first.provenance, "UnverifiedPayload");
      }),
  );

  it.effect.prop(
    "does not derive outcomes or identity from generated private dumps, metadata or quoted delimiters",
    {
      text: Schema.String.check(Schema.isMaxLength(80), Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)),
    },
    ({ text }) =>
      Effect.gen(function* projectEscapedPostmarkExtras() {
        const body = JSON.stringify({
          ...delivery,
          Content: text,
          Metadata: [{ note: text }, { note: text }],
          Other: `${text} \\" RecordType : Bounce {} [] , :`,
        });

        const event = yield* parsePostmarkWebhookEvent(body);
        assert(PostmarkWebhookEventSchema.guards.Delivered(event));
        assert.strictEqual(String(event.providerMessageId), messageId);
        assert.strictEqual(String(event.recipient), recipient);
      }),
  );

  it.effect.each([
    "null",
    "[]",
    "0",
    '"private-root"',
    "{}",
    '{"event":"delivered"}',
    '{"RecordType":"Delivery","MessageID":"private-id","Email":"alias@fictional.invalid"}',
    '{"RecordType":"Delivery","MessageID":"private-id","Recipient":"not-an-address"}',
    '{"RecordType":"Delivery","MessageID":0,"Recipient":"person@fictional.invalid"}',
    '{"RecordType":"Delivery","Recipient":"person@fictional.invalid"}',
    '{"RecordType":"Bounce","MessageID":"private-id","Recipient":"alias@fictional.invalid","Type":"HardBounce","TypeCode":1}',
    '{"RecordType":"Bounce","MessageID":"private-id","Email":"person@fictional.invalid"}',
    '{"RecordType":"Bounce","MessageID":"private-id","Email":"person@fictional.invalid","Type":"HardBounce","TypeCode":4096}',
    '{"RecordType":"Bounce","MessageID":"private-id","Email":"person@fictional.invalid","Type":"Future","TypeCode":4096}',
    '{"RecordType":"Bounce","MessageID":"private-id","Email":"person@fictional.invalid","Type":"SoftBounce","TypeCode":"4096"}',
    '{"RecordType":"Bounce","MessageID":"private-id","Email":"person@fictional.invalid","Type":"Future","TypeCode":0.5}',
    '{"RecordType":"Bounce","MessageID":"private-id","Email":"person@fictional.invalid","Type":"Future","TypeCode":2147483648}',
    '{"RecordType":"SpamComplaint","MessageID":"private-id","Email":"person@fictional.invalid","Type":"HardBounce","TypeCode":1}',
    '{"RecordType":"SpamComplaint","MessageID":"private-id","Email":"person@fictional.invalid","Type":"SpamComplaint"}',
    '{"RecordType":"Future","MessageID":null}',
    '{"RecordType":" Delivery"}',
  ])("refuses invalid selected fields instead of manufacturing Other (%s)", (body) =>
    Effect.gen(function* refuseInvalidPostmarkFields() {
      const result = yield* parsePostmarkWebhookEvent(body).pipe(Effect.result);
      assert(Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError);
      assert.strictEqual(result.failure.reason, "invalid-payload");
      assert.notInclude(JSON.stringify(result.failure), "private");
      assert.notInclude(result.failure.message, "private");
    }),
  );

  it.effect.each([
    "",
    "{",
    '{"RecordType":"Delivery"} trailing',
    '{"RecordType":"Future","RecordType":"Delivery"}',
    '{"RecordType":"Future","RecordTyp\\u0065":"Delivery"}',
    '{"RecordType":"Future","ignored":{"private":1,"private":1}}',
    '{"RecordType":"Future","ignored":[{"a":1,"\\u0061":2}]}',
    '{"RecordType":"Future","ignored":[}}',
    '{"RecordType":"Future",}',
  ])("rejects ambiguous or malformed JSON before interpreting reports (%s)", (body) =>
    Effect.gen(function* refuseAmbiguousPostmarkBody() {
      const result = yield* parsePostmarkWebhookEvent(body).pipe(Effect.result);
      assert(Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError);
      assert.strictEqual(result.failure.reason, "invalid-json");
    }),
  );

  it.effect(
    "bounds decoded nesting and ignored keys before whole-body decoding at this unsigned ingress",
    () =>
      Effect.gen(function* boundPostmarkJsonStructure() {
        const accepted = yield* parsePostmarkWebhookEvent(
          `{"RecordType":"Future","nested":${"[".repeat(31)}0${"]".repeat(31)}}`,
        );

        assert(PostmarkWebhookEventSchema.guards.Other(accepted));
        const nested = `{"RecordType":"Future","nested":${"[".repeat(32)}0${"]".repeat(32)}}`;
        const oversizedKey = JSON.stringify({ RecordType: "Future", ["k".repeat(257)]: 0 });

        for (const body of [nested, oversizedKey]) {
          const result = yield* parsePostmarkWebhookEvent(body).pipe(Effect.result);
          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
          );
          assert.strictEqual(result.failure.reason, "payload-limit");
        }
      }),
  );

  it.effect(
    "applies actual UTF-8 body bounds without truncating an accepted maximum-byte report",
    () =>
      Effect.gen(function* boundPostmarkUtf8Body() {
        const base = JSON.stringify({ ...delivery, Content: "" });
        const remaining = 1_048_576 - Buffer.byteLength(base);

        const body = JSON.stringify({
          ...delivery,
          Content: `${"界".repeat(Math.floor(remaining / 3))}${"x".repeat(remaining % 3)}`,
        });

        assert.strictEqual(Buffer.byteLength(body), 1_048_576);
        const accepted = yield* parsePostmarkWebhookEvent(body);
        assert(PostmarkWebhookEventSchema.guards.Delivered(accepted));
        assert.strictEqual(String(accepted.recipient), recipient);

        for (const invalid of [`${body} `, `{"RecordType":"Future","Content":"\uD800"}`]) {
          const result = yield* parsePostmarkWebhookEvent(invalid).pipe(Effect.result);
          assert(
            Result.isFailure(result) && result.failure instanceof EmailWebhookNormalizationError,
          );
          assert.strictEqual(result.failure.reason, "invalid-payload");
        }
      }),
  );

  it.effect(
    "retains explicit unverified provenance through public Schema composition and refuses contradictory stored classifications",
    () =>
      Effect.gen(function* parseStoredPostmarkObservation() {
        const report = yield* parsePostmarkWebhookEvent(bounceBody("SoftBounce", 4096));
        assert(PostmarkWebhookEventSchema.guards.BounceReported(report));
        const encoded = yield* Schema.encodeEffect(PostmarkWebhookEventSchema)(report);
        const restored = yield* Schema.decodeEffect(PostmarkWebhookEventSchema)(encoded);
        assert.deepStrictEqual(restored, report);
        const inconsistent = { ...encoded, provenance: "Authenticated" };

        const unsafe = yield* Schema.decodeUnknownEffect(PostmarkWebhookEventSchema)(
          inconsistent,
        ).pipe(Effect.result);

        assert(Result.isFailure(unsafe));
        const wrongCode = { ...report, bounceTypeCode: 2 };

        const wrongPair = yield* Schema.decodeEffect(PostmarkWebhookEventSchema)(wrongCode).pipe(
          Effect.result,
        );

        assert(Result.isFailure(wrongPair));
        const hardAsSoft = { ...report, bounceType: "HardBounce", bounceTypeCode: 1 };

        const mislabeled = yield* Schema.decodeEffect(PostmarkWebhookEventSchema)(hardAsSoft).pipe(
          Effect.result,
        );

        assert(Result.isFailure(mislabeled));

        for (const code of [0, 2_147_483_647]) {
          const boundary = yield* parsePostmarkWebhookEvent(bounceBody("FutureBounceClass", code));
          assert(PostmarkWebhookEventSchema.guards.BounceReported(boundary));
          assert.strictEqual(boundary.bounceTypeCode, code);
        }
      }),
  );

  it.effect("keeps unsigned report values and failure bodies out of real NativeSpan exits", () =>
    Effect.gen(function* tracePrivatePostmarkObservations() {
      const trace = yield* startEmailTraceFixture();
      yield* Effect.gen(function* observePostmarkParseExits() {
        yield* parsePostmarkWebhookEvent(JSON.stringify(delivery));
        yield* parsePostmarkWebhookEvent(bounceBody("FuturePrivateClass", 200_000));

        const failure = yield* parsePostmarkWebhookEvent(
          '{"RecordType":"Delivery","MessageID":"private-failed-id","Recipient":"private-invalid-recipient"}',
        ).pipe(Effect.result);

        assert(
          Result.isFailure(failure) && failure.failure instanceof EmailWebhookNormalizationError,
        );
      }).pipe(Effect.provideService(Tracer.Tracer, trace.tracer));
      const diagnostics = yield* trace.diagnostics;
      assert.include(diagnostics, "PostmarkWebhook.parseEvent");

      for (const privateValue of [
        messageId,
        recipient,
        "private-mail-server-response",
        "private-stream",
        "private-metadata-value",
        "FuturePrivateClass",
        "private-failed-id",
        "private-invalid-recipient",
        "private-bounce-dump",
      ]) {
        assert.notInclude(diagnostics, privateValue);
      }
    }),
  );
});
