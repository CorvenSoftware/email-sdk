import { DateTime, Schema } from "effect";
import { EmailAddressSchema } from "./email-address.js";
import {
  EmailMetadataSchema,
  EmailSendAtSchema,
  ownEmailUtcInstant,
} from "./email-message-metadata.js";
import { EmailPolicyOptionsSchema as EmailSendOptionsSchema } from "./email-preparation.js";

const IterableScalar = Schema.Union([
  Schema.String.check(Schema.isMaxLength(10_000), Schema.isPattern(/^[^\uD800-\uDFFF]*$/u)),
  Schema.Finite,
  Schema.Boolean,
  Schema.Null,
]);

const IterableDataFields = Schema.Record(
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9_]*$/u),
  ),
  Schema.Union([IterableScalar, Schema.Array(IterableScalar).check(Schema.isMaxLength(50))]),
).check(
  Schema.makeFilter((fields) => Object.keys(fields).length <= 64, {
    expected: "at most 64 native campaign data fields",
  }),
);

export const IterableCampaignJobSchema = Schema.Struct({
  campaignId: Schema.Int.check(
    Schema.isBetween({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
  ).pipe(Schema.brand("IterableCampaignId")),
  dataFields: Schema.optionalKey(IterableDataFields),
  metadata: Schema.optionalKey(EmailMetadataSchema),
  recipientEmail: EmailAddressSchema.check(
    Schema.makeFilter((email) => email === email.toLowerCase(), {
      expected: "an explicit lowercase email-based project identity",
    }),
  ),
  sendAt: Schema.optionalKey(
    EmailSendAtSchema.check(
      Schema.makeFilter(
        (instant) =>
          DateTime.toEpochMillis(instant) % 1000 === 0 &&
          /^\d{4}-/u.test(DateTime.formatIso(instant)),
        {
          expected: "four-digit-year whole-second UTC scheduling without truncation",
        },
      ),
    ),
  ),
});

export type IterableCampaignJob = typeof IterableCampaignJobSchema.Type;

export type IterableCampaignJobInput = typeof IterableCampaignJobSchema.Encoded;

export const IterableCampaignRequestSchema = Schema.Struct({
  job: IterableCampaignJobSchema,
  options: Schema.optionalKey(EmailSendOptionsSchema),
});

export type IterableCampaignRequest = typeof IterableCampaignRequestSchema.Encoded;

export const ownIterableDataFields = (
  fields: NonNullable<IterableCampaignJob["dataFields"]>,
): NonNullable<IterableCampaignJob["dataFields"]> =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        Schema.is(IterableScalar)(value) ? value : Object.freeze([...value]),
      ]),
    ),
  );

export const ownIterableJob = (job: IterableCampaignJob): IterableCampaignJob => {
  const owned = { ...job };

  if (job.dataFields !== undefined) {
    owned.dataFields = ownIterableDataFields(job.dataFields);
  }

  if (job.metadata !== undefined) {
    owned.metadata = Object.freeze({ ...job.metadata });
  }

  if (job.sendAt !== undefined) {
    owned.sendAt = ownEmailUtcInstant(job.sendAt);
  }

  return Object.freeze(owned);
};
