import { Array as EffectArray, Effect, Match, Schema, Struct, UndefinedOr } from "effect";
import { EmailAttachmentsSchema } from "./email-attachment.js";
import {
  EmailAddressSchema,
  EmailMailboxSchema,
  EmailRecipientsSchema,
  ownEmailMailbox,
} from "./email-address.js";
import {
  EmailHeadersSchema,
  EmailMetadataSchema,
  EmailSendAtSchema,
  EmailTagsSchema,
  ownEmailUtcInstant,
} from "./email-message-metadata.js";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { emailInputIssues } from "./email-input-issues.js";
import { EmailRecipientCountsSchema } from "./email-recipient-outcomes.js";

export { EmailAddressSchema } from "./email-address.js";

export type { EmailAddress } from "./email-address.js";

export const maxEmailBodyCharacters = 1_000_000;

export const maxEmailSubjectCharacters = 998;

const EmailContent = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maxEmailBodyCharacters),
);

export const EmailBodySchema = Schema.Union([
  Schema.Struct({ html: Schema.optionalKey(EmailContent), text: EmailContent }),
  Schema.Struct({ html: EmailContent, text: Schema.optionalKey(EmailContent) }),
]);

export type EmailBody = typeof EmailBodySchema.Type;

export const EmailMessageSchema = Schema.Struct({
  attachments: Schema.optionalKey(EmailAttachmentsSchema),
  bcc: Schema.optionalKey(EmailRecipientsSchema),
  body: EmailBodySchema,
  cc: Schema.optionalKey(EmailRecipientsSchema),
  from: EmailMailboxSchema,
  headers: Schema.optionalKey(EmailHeadersSchema),
  metadata: Schema.optionalKey(EmailMetadataSchema),
  replyTo: Schema.optionalKey(EmailRecipientsSchema),
  sendAt: Schema.optionalKey(EmailSendAtSchema),
  subject: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxEmailSubjectCharacters),
    Schema.isPattern(/^[^\r\n\0]*$/u, { expected: "a subject without CR, LF, or NUL" }),
  ),
  tags: Schema.optionalKey(EmailTagsSchema),
  to: EmailRecipientsSchema,
}).check(
  Schema.makeFilter(
    (message) => message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0) <= 50,
    { expected: "at most 50 total recipients across to, cc, and bcc" },
  ),
);

export type EmailMessage = typeof EmailMessageSchema.Type;

export type EmailMessageInput = typeof EmailMessageSchema.Encoded;

export const EmailIdempotencyKeySchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9._:/-]+$/u, { expected: "an opaque ASCII idempotency key" }),
).pipe(Schema.brand("EmailIdempotencyKey"));

export type EmailIdempotencyKey = typeof EmailIdempotencyKeySchema.Type;

const EmailProviderHandle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[\u0021-\u007E]+$/u, {
    expected: "an opaque printable ASCII provider identifier without whitespace",
  }),
);

export const EmailMessageIdSchema = EmailProviderHandle.pipe(Schema.brand("EmailMessageId"));

export type EmailMessageId = typeof EmailMessageIdSchema.Type;

export const EmailSubmissionIdSchema = EmailProviderHandle.pipe(Schema.brand("EmailSubmissionId"));

export type EmailSubmissionId = typeof EmailSubmissionIdSchema.Type;

export const EmailMessageIdsSchema = Schema.NonEmptyArray(EmailMessageIdSchema).check(
  Schema.isMaxLength(50),
  Schema.makeFilter((ids) => new Set(ids).size === ids.length, {
    expected: "distinct bounded acknowledgement identifiers",
  }),
);

export const EmailRecipientOutcomeSchema = Schema.TaggedUnion({
  Accepted: { messageId: EmailMessageIdSchema, recipient: EmailAddressSchema },
  Rejected: { messageId: Schema.optionalKey(EmailMessageIdSchema), recipient: EmailAddressSchema },
});

export type EmailRecipientOutcome = typeof EmailRecipientOutcomeSchema.Type;

export const EmailReceiptSchema = Schema.TaggedUnion({
  Accepted: {
    messageId: Schema.optionalKey(EmailMessageIdSchema),
    provider: Schema.String,
    submissionId: Schema.optionalKey(EmailSubmissionIdSchema),
  },
  AcceptedWithIds: { messageIds: EmailMessageIdsSchema, provider: Schema.String },
  PartiallyAccepted: {
    accepted: Schema.NonEmptyArray(EmailAddressSchema),
    messageId: Schema.optionalKey(EmailMessageIdSchema),
    provider: Schema.String,
    suppressed: Schema.NonEmptyArray(EmailAddressSchema),
  },
  PartiallyAcceptedCounts: {
    counts: EmailRecipientCountsSchema.check(
      Schema.makeFilter((counts) => counts.acceptedCount > 0 && counts.rejectedCount > 0, {
        expected: "positive accepted and rejected counts without recipient identities",
      }),
    ),
    messageId: Schema.optionalKey(EmailMessageIdSchema),
    provider: Schema.String,
  },
  PartiallyRejected: {
    accepted: Schema.NonEmptyArray(EmailAddressSchema).check(Schema.isMaxLength(49)),
    provider: Schema.String,
    rejected: Schema.NonEmptyArray(EmailAddressSchema).check(Schema.isMaxLength(49)),
  },
  RecipientOutcomes: {
    messageId: Schema.optionalKey(EmailMessageIdSchema),
    outcomes: Schema.NonEmptyArray(EmailRecipientOutcomeSchema).check(
      Schema.isMaxLength(50),
      Schema.makeFilter(
        (outcomes) => {
          const recipients = outcomes.map(({ recipient }) => recipient.toLowerCase());

          const ids = outcomes.flatMap((outcome) =>
            outcome.messageId === undefined ? [] : [outcome.messageId],
          );

          return new Set(recipients).size === recipients.length && new Set(ids).size === ids.length;
        },
        { expected: "distinct recipients and correlation identifiers" },
      ),
    ),
    provider: Schema.String,
  },
  RecipientsRejected: {
    messageId: Schema.optionalKey(EmailMessageIdSchema),
    provider: Schema.String,
    rejected: Schema.NonEmptyArray(EmailAddressSchema).check(Schema.isMaxLength(50)),
  },
  Recorded: { sequence: Schema.Int },
  Simulated: { messageId: Schema.optionalKey(EmailMessageIdSchema), provider: Schema.String },
  Suppressed: {
    provider: Schema.String,
    suppressed: Schema.NonEmptyArray(EmailAddressSchema),
  },
});

export type EmailReceipt = typeof EmailReceiptSchema.Type;

const decodeEmailMessage = Schema.decodeUnknownEffect(EmailMessageSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const ownEmailList = <A, B>(
  values: readonly [A, ...A[]],
  own: (value: A) => B,
): readonly [B, ...B[]] => Object.freeze(EffectArray.map<readonly [A, ...A[]], B>(own)(values));

export const ownEmailReceipt = (receipt: EmailReceipt): EmailReceipt =>
  Match.value(receipt).pipe(
    Match.tag("Accepted", "Recorded", "Simulated", (value) => Object.freeze({ ...value })),
    Match.tag("AcceptedWithIds", (value) =>
      Object.freeze({ ...value, messageIds: ownEmailList(value.messageIds, (id) => id) }),
    ),
    Match.tag("PartiallyAccepted", (value) =>
      Object.freeze({
        ...value,
        accepted: ownEmailList(value.accepted, (address) => address),
        suppressed: ownEmailList(value.suppressed, (address) => address),
      }),
    ),
    Match.tag("PartiallyAcceptedCounts", (value) =>
      Object.freeze({ ...value, counts: Object.freeze({ ...value.counts }) }),
    ),
    Match.tag("PartiallyRejected", (value) =>
      Object.freeze({
        ...value,
        accepted: ownEmailList(value.accepted, (address) => address),
        rejected: ownEmailList(value.rejected, (address) => address),
      }),
    ),
    Match.tag("RecipientOutcomes", (value) =>
      Object.freeze({
        ...value,
        outcomes: ownEmailList(value.outcomes, (outcome) => Object.freeze({ ...outcome })),
      }),
    ),
    Match.tag("RecipientsRejected", (value) =>
      Object.freeze({ ...value, rejected: ownEmailList(value.rejected, (address) => address) }),
    ),
    Match.tag("Suppressed", (value) =>
      Object.freeze({ ...value, suppressed: ownEmailList(value.suppressed, (address) => address) }),
    ),
    Match.exhaustive,
  );

const ownOptionalEmailFields = <A, Fields extends Partial<EmailMessage>>(
  value: A | undefined,
  own: (value: A) => Fields,
) => UndefinedOr.match(value, { onDefined: own, onUndefined: () => ({}) });

export const ownEmailMessage = (message: EmailMessage): EmailMessage =>
  Object.freeze({
    ...Struct.evolve(message, {
      body: (body) => Object.freeze({ ...body }),
      from: ownEmailMailbox,
      to: (to) => ownEmailList(to, ownEmailMailbox),
    }),
    ...ownOptionalEmailFields(message.attachments, (attachments) => ({
      attachments: ownEmailList(attachments, (attachment) => Object.freeze({ ...attachment })),
    })),
    ...ownOptionalEmailFields(message.bcc, (bcc) => ({ bcc: ownEmailList(bcc, ownEmailMailbox) })),
    ...ownOptionalEmailFields(message.cc, (cc) => ({ cc: ownEmailList(cc, ownEmailMailbox) })),
    ...ownOptionalEmailFields(message.headers, (headers) => ({
      headers: ownEmailList(headers, (header) => Object.freeze({ ...header })),
    })),
    ...ownOptionalEmailFields(message.metadata, (metadata) => ({
      metadata: Object.freeze(
        Object.fromEntries(
          Object.entries(metadata).toSorted(([left], [right]) => left.localeCompare(right)),
        ),
      ),
    })),
    ...ownOptionalEmailFields(message.replyTo, (replyTo) => ({
      replyTo: ownEmailList(replyTo, ownEmailMailbox),
    })),
    ...ownOptionalEmailFields(message.sendAt, (sendAt) => ({ sendAt: ownEmailUtcInstant(sendAt) })),
    ...ownOptionalEmailFields(message.tags, (tags) => ({
      tags: ownEmailList(tags, (tag) => Object.freeze({ ...tag })),
    })),
  });

export const parseEmailMessage = Effect.fnUntraced(function* parseEmailMessageInput(
  input: EmailMessageInput,
): Effect.fn.Return<EmailMessage, EmailInvalidMessage> {
  const message = yield* decodeEmailMessage(input).pipe(
    Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
  );

  return ownEmailMessage(message);
});
