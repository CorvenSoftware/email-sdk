import { Schema } from "effect";
import { EmailAddressSchema } from "./email-address.js";
import { EmailAttachmentsSchema } from "./email-attachment.js";
import { EmailPolicyOptionsSchema as EmailSendOptionsSchema } from "./email-preparation.js";

const LoopsVariableName = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);

const LoopsScalarVariable = Schema.Union([
  Schema.String.check(
    Schema.isMaxLength(498),
    Schema.isPattern(/^[^\uD800-\uDFFF]*$/u, { expected: "well-formed Unicode text" }),
    Schema.makeFilter((value) => JSON.stringify(value).length <= 500, {
      expected: "at most 500 JSON-encoded characters including quotes",
    }),
  ),
  Schema.Finite,
]);

const LoopsVariableRecord = Schema.Record(LoopsVariableName, LoopsScalarVariable).check(
  Schema.makeFilter((record) => Object.keys(record).length <= 64, {
    expected: "at most 64 data variables",
  }),
);

const LoopsDataVariables = Schema.Record(
  LoopsVariableName,
  Schema.Union([
    LoopsScalarVariable,
    Schema.NonEmptyArray(LoopsVariableRecord).check(Schema.isMaxLength(50)),
  ]),
).check(
  Schema.makeFilter((record) => Object.keys(record).length <= 64, {
    expected: "at most 64 data variables",
  }),
  Schema.makeFilter(
    (record) =>
      Object.values(record).reduce<number>(
        (total, value) =>
          total +
          (Schema.is(LoopsScalarVariable)(value)
            ? 1
            : value.reduce((count, item) => count + Object.keys(item).length, 0)),
        0,
      ) <= 1024,
    { expected: "at most 1024 scalar data values across the complete job" },
  ),
);

export const LoopsTransactionalJobSchema = Schema.Struct({
  attachments: Schema.optionalKey(
    EmailAttachmentsSchema.check(
      Schema.makeFilter(
        (attachments) =>
          attachments.every(
            (attachment) =>
              attachment.contentType !== "ProviderSelected" &&
              attachment.contentId === undefined &&
              attachment.disposition !== "inline",
          ),
        { expected: "ordinary attachments with explicit MIME and no content identifiers" },
      ),
    ),
  ),
  dataVariables: Schema.optionalKey(LoopsDataVariables),
  email: EmailAddressSchema.check(
    Schema.makeFilter((email) => !/@(?:example|test)\.com$/iu.test(email), {
      expected: "a recipient outside the provider's test-only domains",
    }),
  ),
  transactionalId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  ).pipe(Schema.brand("LoopsTransactionalId")),
});

export type LoopsTransactionalJob = typeof LoopsTransactionalJobSchema.Type;

export type LoopsTransactionalJobInput = typeof LoopsTransactionalJobSchema.Encoded;

export const LoopsTransactionalRequestSchema = Schema.Struct({
  job: LoopsTransactionalJobSchema,
  options: Schema.optionalKey(EmailSendOptionsSchema),
});

export type LoopsTransactionalRequest = typeof LoopsTransactionalRequestSchema.Encoded;

export const ownLoopsDataVariables = (
  variables: typeof LoopsDataVariables.Type,
): typeof LoopsDataVariables.Type =>
  Object.freeze(
    Object.fromEntries(
      Object.entries(variables).map(
        ([key, value]): readonly [string, (typeof LoopsDataVariables.Type)[string]] => {
          if (Schema.is(LoopsScalarVariable)(value)) {
            return [key, value];
          }

          const [first, ...rest] = value;

          const items = [
            Object.freeze({ ...first }),
            ...rest.map((item) => Object.freeze({ ...item })),
          ] as const;

          return [key, Object.freeze(items)];
        },
      ),
    ),
  );

export const ownLoopsJob = (job: LoopsTransactionalJob): LoopsTransactionalJob => {
  const owned = { ...job };

  if (job.dataVariables !== undefined) {
    owned.dataVariables = ownLoopsDataVariables(job.dataVariables);
  }

  if (job.attachments !== undefined) {
    const [first, ...rest] = job.attachments;
    owned.attachments = [
      Object.freeze({ ...first }),
      ...rest.map((attachment) => Object.freeze({ ...attachment })),
    ];
    Object.freeze(owned.attachments);
  }

  return Object.freeze(owned);
};
