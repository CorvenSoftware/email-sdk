import { Effect, Option, Schema } from "effect";
import { EmailAddressSchema } from "./email-address.js";
import { emailOperationSpan } from "./email-tracing.js";
import { parseEmailWebhookBody } from "./email-webhook-json.js";
import { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";

export { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";

const MailgunEventType = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
);

const MailgunOutcomeType = Schema.Literals(["delivered", "failed", "complained"]);

const MailgunEventId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[\u0021-\u007E]+$/u),
).pipe(Schema.brand("MailgunEventId"));

const MailgunEventTimestamp = Schema.Finite.check(
  Schema.isBetween({ maximum: 9_999_999_999, minimum: 0 }),
).pipe(Schema.brand("MailgunEventTimestampSeconds"));

const MailgunRfcMessageId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(998),
  Schema.isPattern(/^[\u0021-\u007E]+$/u),
).pipe(Schema.brand("MailgunRfcMessageId"));

const MailgunFailureSeverity = Schema.Literals(["permanent", "temporary"]);

export const MailgunWebhookRecipientSchema = Schema.TaggedUnion({
  Address: { address: EmailAddressSchema },
  Redacted: {},
});

export type MailgunWebhookRecipient = typeof MailgunWebhookRecipientSchema.Type;

const MailgunRecipientValue = Schema.Union([EmailAddressSchema, Schema.Literal("[REDACTED]")]);

const mailgunWebhookRecipient = (
  recipient: typeof MailgunRecipientValue.Type,
): MailgunWebhookRecipient =>
  Schema.is(EmailAddressSchema)(recipient)
    ? MailgunWebhookRecipientSchema.cases.Address.make({ address: recipient })
    : MailgunWebhookRecipientSchema.cases.Redacted.make({});

const identityFields = {
  eventTimestampSeconds: MailgunEventTimestamp,
  provenance: Schema.Literal("UnverifiedPayload"),
  provider: Schema.Literal("mailgun"),
  providerEventId: MailgunEventId,
};

const reportFields = {
  ...identityFields,
  recipient: MailgunWebhookRecipientSchema,
  rfcMessageId: MailgunRfcMessageId,
};

export const MailgunWebhookEventSchema = Schema.TaggedUnion({
  Complained: { ...reportFields, type: Schema.Literal("complained") },
  Delivered: { ...reportFields, type: Schema.Literal("delivered") },
  Failed: {
    ...reportFields,
    severity: MailgunFailureSeverity,
    type: Schema.Literal("failed"),
  },
  Other: {
    ...identityFields,
    rfcMessageId: Schema.optionalKey(MailgunRfcMessageId),
    type: MailgunEventType.check(Schema.makeFilter((type) => !Schema.is(MailgunOutcomeType)(type))),
  },
});

export type MailgunWebhookEvent = typeof MailgunWebhookEventSchema.Type;

const MailgunWebhookEnvelope = Schema.Struct({ "event-data": Schema.Unknown });

const MailgunEventIdentity = Schema.Struct({
  event: MailgunEventType,
  id: MailgunEventId,
  timestamp: MailgunEventTimestamp,
});

const MailgunOtherData = Schema.Struct({
  message: Schema.optionalKey(
    Schema.Struct({
      headers: Schema.optionalKey(
        Schema.Struct({ "message-id": Schema.optionalKey(MailgunRfcMessageId) }),
      ),
    }),
  ),
});

const outcomeFields = {
  message: Schema.Struct({ headers: Schema.Struct({ "message-id": MailgunRfcMessageId }) }),
  recipient: MailgunRecipientValue,
};

const MailgunOutcomePayload = Schema.Union([
  Schema.Struct({ ...outcomeFields, event: Schema.Literal("delivered") }),
  Schema.Struct({ ...outcomeFields, event: Schema.Literal("complained") }),
  Schema.Struct({
    ...outcomeFields,
    event: Schema.Literal("failed"),
    severity: MailgunFailureSeverity,
  }),
]).pipe(Schema.toTaggedUnion("event"));

export const parseMailgunWebhookEvent = Effect.fnUntraced(function* parseMailgunWebhookEvent(
  body: string,
): Effect.fn.Return<MailgunWebhookEvent, EmailWebhookNormalizationError> {
  const json = yield* parseEmailWebhookBody(body);

  const envelope = yield* Schema.decodeUnknownEffect(MailgunWebhookEnvelope)(json).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const data = envelope["event-data"];

  const native = yield* Schema.decodeUnknownEffect(MailgunEventIdentity)(data).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const identity = {
    eventTimestampSeconds: native.timestamp,
    provenance: "UnverifiedPayload" as const,
    provider: "mailgun" as const,
    providerEventId: native.id,
  };

  const known = Schema.decodeUnknownOption(MailgunOutcomeType)(native.event);

  if (Option.isNone(known)) {
    const other = yield* Schema.decodeUnknownEffect(MailgunOtherData)(data).pipe(
      Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
    );

    const messageId = other.message?.headers?.["message-id"];

    return Object.freeze(
      messageId === undefined
        ? MailgunWebhookEventSchema.cases.Other.make({ ...identity, type: native.event })
        : MailgunWebhookEventSchema.cases.Other.make({
            ...identity,
            rfcMessageId: messageId,
            type: native.event,
          }),
    );
  }

  const payload = yield* Schema.decodeUnknownEffect(MailgunOutcomePayload)(data).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const report = {
    ...identity,
    recipient: mailgunWebhookRecipient(payload.recipient),
    rfcMessageId: payload.message.headers["message-id"],
  };

  const event = MailgunOutcomePayload.match(payload, {
    complained: () =>
      MailgunWebhookEventSchema.cases.Complained.make({ ...report, type: "complained" }),
    delivered: () =>
      MailgunWebhookEventSchema.cases.Delivered.make({ ...report, type: "delivered" }),
    failed: (failure) =>
      MailgunWebhookEventSchema.cases.Failed.make({
        ...report,
        severity: failure.severity,
        type: "failed",
      }),
  });

  Object.freeze(event.recipient);

  return Object.freeze(event);
}, emailOperationSpan("MailgunWebhook.parseEvent"));
