import { Effect, Match, Option, Schema } from "effect";
import { EmailAddressSchema } from "./email-address.js";
import { EmailMessageIdSchema } from "./email-message.js";
import { emailOperationSpan } from "./email-tracing.js";
import { parseEmailWebhookJson } from "./email-webhook-json.js";
import { EmailWebhookNormalizationError } from "./email-webhook-normalization-error.js";
import { ResendWebhookIdSchema, VerifiedResendWebhookSchema } from "./resend-webhook-proof.js";
import type { VerifiedResendWebhook } from "./resend-webhook-proof.js";

const ResendEventType = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]*$/u),
);

const ResendOutcomeType = Schema.Literals(["email.delivered", "email.bounced", "email.complained"]);

const ResendEventRecipients = Schema.NonEmptyArray(EmailAddressSchema).check(
  Schema.isMaxLength(50),
  Schema.makeFilter(
    (recipients) =>
      new Set(recipients.map((recipient) => recipient.toLowerCase())).size === recipients.length,
  ),
);

const eventIdentity = { deliveryId: ResendWebhookIdSchema, provider: Schema.Literal("resend") };

const outcomeFields = {
  ...eventIdentity,
  providerMessageId: EmailMessageIdSchema,
  recipients: ResendEventRecipients,
};

export const ResendWebhookEventSchema = Schema.TaggedUnion({
  Bounced: { ...outcomeFields, type: Schema.Literal("email.bounced") },
  Complained: { ...outcomeFields, type: Schema.Literal("email.complained") },
  Delivered: { ...outcomeFields, type: Schema.Literal("email.delivered") },
  Other: {
    ...eventIdentity,
    providerMessageId: Schema.optionalKey(EmailMessageIdSchema),
    type: ResendEventType.check(Schema.makeFilter((type) => !Schema.is(ResendOutcomeType)(type))),
  },
});

export type ResendWebhookEvent = typeof ResendWebhookEventSchema.Type;

const ResendEventEnvelope = Schema.Struct({ data: Schema.Unknown, type: ResendEventType });

const ResendOutcomeData = Schema.Struct({
  email_id: EmailMessageIdSchema,
  to: ResendEventRecipients,
});

const ResendOtherData = Schema.Struct({ email_id: Schema.optionalKey(EmailMessageIdSchema) });

export const parseResendWebhookEvent = Effect.fnUntraced(function* parseResendWebhookEvent(
  proof: VerifiedResendWebhook,
): Effect.fn.Return<ResendWebhookEvent, EmailWebhookNormalizationError> {
  const verified = yield* Schema.decodeEffect(VerifiedResendWebhookSchema, {
    onExcessProperty: "error",
  })(proof).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const json = yield* parseEmailWebhookJson(verified.body);

  const envelope = yield* Schema.decodeUnknownEffect(ResendEventEnvelope)(json).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const knownType = Schema.decodeUnknownOption(ResendOutcomeType)(envelope.type);

  if (Option.isNone(knownType)) {
    const data = yield* Schema.decodeUnknownEffect(ResendOtherData)(envelope.data).pipe(
      Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
    );

    const identity = { deliveryId: verified.id, provider: "resend" as const, type: envelope.type };

    return Object.freeze(
      data.email_id === undefined
        ? ResendWebhookEventSchema.cases.Other.make(identity)
        : ResendWebhookEventSchema.cases.Other.make({
            ...identity,
            providerMessageId: data.email_id,
          }),
    );
  }

  const data = yield* Schema.decodeUnknownEffect(ResendOutcomeData)(envelope.data).pipe(
    Effect.mapError(() => new EmailWebhookNormalizationError({ reason: "invalid-payload" })),
  );

  const fields = {
    deliveryId: verified.id,
    provider: "resend" as const,
    providerMessageId: data.email_id,
    recipients: data.to,
  };

  const event = Match.value(knownType.value).pipe(
    Match.when("email.delivered", () =>
      ResendWebhookEventSchema.cases.Delivered.make({ ...fields, type: "email.delivered" }),
    ),
    Match.when("email.bounced", () =>
      ResendWebhookEventSchema.cases.Bounced.make({ ...fields, type: "email.bounced" }),
    ),
    Match.when("email.complained", () =>
      ResendWebhookEventSchema.cases.Complained.make({ ...fields, type: "email.complained" }),
    ),
    Match.exhaustive,
  );

  Object.freeze(event.recipients);

  return Object.freeze(event);
}, emailOperationSpan("ResendWebhook.parseEvent"));
