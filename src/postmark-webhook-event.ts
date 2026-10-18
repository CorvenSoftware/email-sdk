import { Effect, Option, Schema } from "effect";
import { EmailAddressSchema } from "./email-address.js";
import { EmailMessageIdSchema } from "./email-message.js";
import { emailOperationSpan } from "./email-tracing.js";
import { parseEmailWebhookBody } from "./email-webhook-json.js";
import { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";

export { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";

const PostmarkRecordType = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
);

const PostmarkOutcomeType = Schema.Literals(["Delivery", "Bounce", "SpamComplaint"]);

const PostmarkBounceCode = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ maximum: 2_147_483_647, minimum: 0 }),
);

const postmarkBounceTypeCodes: ReadonlyMap<string, number> = new Map([
  ["HardBounce", 1],
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
]);

const postmarkKnownBounceCodes = new Set(postmarkBounceTypeCodes.values());

const postmarkBounceTypeMatchesCode = (type: string, code: number): boolean => {
  const expected = postmarkBounceTypeCodes.get(type);

  return expected === undefined ? !postmarkKnownBounceCodes.has(code) : expected === code;
};

const observationFields = {
  provenance: Schema.Literal("UnverifiedPayload"),
  provider: Schema.Literal("postmark"),
};

const outcomeFields = {
  ...observationFields,
  providerMessageId: EmailMessageIdSchema,
  recipient: EmailAddressSchema,
};

export const PostmarkWebhookEventSchema = Schema.Union([
  Schema.TaggedStruct("Bounced", {
    ...outcomeFields,
    bounceType: Schema.Literal("HardBounce"),
    bounceTypeCode: Schema.Literal(1),
    type: Schema.Literal("Bounce"),
  }),
  Schema.TaggedStruct("BounceReported", {
    ...outcomeFields,
    bounceType: PostmarkRecordType.check(Schema.makeFilter((type) => type !== "HardBounce")),
    bounceTypeCode: PostmarkBounceCode.check(Schema.makeFilter((code) => code !== 1)),
    type: Schema.Literal("Bounce"),
  }).check(
    Schema.makeFilter((event) =>
      postmarkBounceTypeMatchesCode(event.bounceType, event.bounceTypeCode),
    ),
  ),
  Schema.TaggedStruct("Complained", { ...outcomeFields, type: Schema.Literal("SpamComplaint") }),
  Schema.TaggedStruct("Delivered", { ...outcomeFields, type: Schema.Literal("Delivery") }),
  Schema.TaggedStruct("Other", {
    ...observationFields,
    providerMessageId: Schema.optionalKey(EmailMessageIdSchema),
    type: PostmarkRecordType.check(
      Schema.makeFilter((type) => !Schema.is(PostmarkOutcomeType)(type)),
    ),
  }),
]).pipe(Schema.toTaggedUnion("_tag"));

export type PostmarkWebhookEvent = typeof PostmarkWebhookEventSchema.Type;

const PostmarkEventEnvelope = Schema.Struct({ RecordType: PostmarkRecordType });

const PostmarkOtherData = Schema.Struct({ MessageID: Schema.optionalKey(EmailMessageIdSchema) });

const postmarkMessageFields = { MessageID: EmailMessageIdSchema };

const PostmarkOutcomePayload = Schema.Union([
  Schema.Struct({
    ...postmarkMessageFields,
    Recipient: EmailAddressSchema,
    RecordType: Schema.Literal("Delivery"),
  }),
  Schema.Struct({
    ...postmarkMessageFields,
    Email: EmailAddressSchema,
    RecordType: Schema.Literal("SpamComplaint"),
    Type: Schema.Literal("SpamComplaint"),
    TypeCode: Schema.Literal(100_001),
  }),
  Schema.Struct({
    ...postmarkMessageFields,
    Email: EmailAddressSchema,
    RecordType: Schema.Literal("Bounce"),
    Type: PostmarkRecordType,
    TypeCode: PostmarkBounceCode,
  }).check(
    Schema.makeFilter((payload) => postmarkBounceTypeMatchesCode(payload.Type, payload.TypeCode)),
  ),
]).pipe(Schema.toTaggedUnion("RecordType"));

export const parsePostmarkWebhookEvent = Effect.fnUntraced(function* parsePostmarkWebhookEvent(
  body: string,
): Effect.fn.Return<PostmarkWebhookEvent, EmailWebhookNormalizationError> {
  const json = yield* parseEmailWebhookBody(body);

  const envelope = yield* Schema.decodeUnknownEffect(PostmarkEventEnvelope)(json).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const known = Schema.decodeUnknownOption(PostmarkOutcomeType)(envelope.RecordType);

  if (Option.isNone(known)) {
    const other = yield* Schema.decodeUnknownEffect(PostmarkOtherData)(json).pipe(
      Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
    );

    const identity = {
      provenance: "UnverifiedPayload" as const,
      provider: "postmark" as const,
      type: envelope.RecordType,
    };

    return Object.freeze(
      other.MessageID === undefined
        ? PostmarkWebhookEventSchema.cases.Other.make(identity)
        : PostmarkWebhookEventSchema.cases.Other.make({
            ...identity,
            providerMessageId: other.MessageID,
          }),
    );
  }

  const payload = yield* Schema.decodeUnknownEffect(PostmarkOutcomePayload)(json).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const identity = {
    provenance: "UnverifiedPayload" as const,
    provider: "postmark" as const,
    providerMessageId: payload.MessageID,
  };

  const event = PostmarkOutcomePayload.match(payload, {
    Bounce: (data) =>
      data.Type === "HardBounce"
        ? PostmarkWebhookEventSchema.cases.Bounced.make({
            ...identity,
            bounceType: "HardBounce",
            bounceTypeCode: 1,
            recipient: data.Email,
            type: "Bounce",
          })
        : PostmarkWebhookEventSchema.cases.BounceReported.make({
            ...identity,
            bounceType: data.Type,
            bounceTypeCode: data.TypeCode,
            recipient: data.Email,
            type: "Bounce",
          }),
    Delivery: (data) =>
      PostmarkWebhookEventSchema.cases.Delivered.make({
        ...identity,
        recipient: data.Recipient,
        type: "Delivery",
      }),
    SpamComplaint: (data) =>
      PostmarkWebhookEventSchema.cases.Complained.make({
        ...identity,
        recipient: data.Email,
        type: "SpamComplaint",
      }),
  });

  return Object.freeze(event);
}, emailOperationSpan("PostmarkWebhook.parseEvent"));
