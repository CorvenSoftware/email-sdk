import { Context, Duration, Match, Schema } from "effect";
import type { Effect } from "effect";
import type { EmailSubmissionError } from "./email-errors.js";
import type { EmailSenderCapabilities } from "./email-capabilities.js";
import type { EmailInvalidMessage } from "./email-invalid-message.js";
import type { EmailIdempotencyKey, EmailMessage, EmailReceipt } from "./email-message.js";

export interface EmailSubmission {
  readonly message: EmailMessage;
  readonly idempotencyKey?: EmailIdempotencyKey;
}

const EmailSenderKeyBounds = {
  keyFormat: Schema.optionalKey(Schema.Literals(["Opaque", "AlphanumericDotUnderscoreHyphen"])),
  keyRequirement: Schema.optionalKey(Schema.Literals(["Optional", "Required"])),
  maxKeyLength: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: 256, minimum: 1 })),
  ),
};

export const EmailSenderIdempotencySchema = Schema.TaggedUnion({
  KeyForwarding: EmailSenderKeyBounds,
  Native: {
    ...EmailSenderKeyBounds,
    retention: Schema.Duration.check(
      Schema.makeFilter((duration) => Duration.toMillis(duration) > 0, {
        expected: "a positive idempotency retention duration",
      }),
    ),
  },
  None: {},
});

export type EmailSenderIdempotency = typeof EmailSenderIdempotencySchema.Type;

export const ownEmailSenderIdempotency = (
  idempotency: EmailSenderIdempotency,
): EmailSenderIdempotency =>
  Match.value(idempotency).pipe(
    Match.tag("None", () => Object.freeze(EmailSenderIdempotencySchema.cases.None.make({}))),
    Match.tag("KeyForwarding", (forwarding) =>
      Object.freeze(EmailSenderIdempotencySchema.cases.KeyForwarding.make(forwarding)),
    ),
    Match.tag("Native", (native) => {
      const retention = Duration.millis(Duration.toMillis(native.retention));
      Object.assign(retention, { value: Object.freeze({ ...retention.value }) });
      Object.freeze(retention);

      return Object.freeze(
        EmailSenderIdempotencySchema.cases.Native.make({ ...native, retention }),
      );
    }),
    Match.exhaustive,
  );

const EmailRestrictedKeySchema = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/u));

export const supportsEmailIdempotencyKey = (
  idempotency: EmailSenderIdempotency,
  key?: EmailIdempotencyKey,
): boolean => {
  if (EmailSenderIdempotencySchema.guards.None(idempotency)) {
    return key === undefined;
  }

  if (key === undefined) {
    return idempotency.keyRequirement !== "Required";
  }

  return (
    key.length <= (idempotency.maxKeyLength ?? 256) &&
    (idempotency.keyFormat !== "AlphanumericDotUnderscoreHyphen" ||
      Schema.is(EmailRestrictedKeySchema)(key))
  );
};

export interface IEmailSender {
  readonly capabilities: EmailSenderCapabilities;
  readonly validate: (message: EmailMessage) => Effect.Effect<void, EmailInvalidMessage>;
  readonly provider: string;
  readonly idempotency: EmailSenderIdempotency;
  readonly submit: (
    submission: EmailSubmission,
  ) => Effect.Effect<EmailReceipt, EmailSubmissionError>;
}

export class EmailSender extends Context.Service<EmailSender, IEmailSender>()(
  "@corvencore/email-sdk/EmailSender",
) {}
