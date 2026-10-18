import { DateTime, Option, Schema } from "effect";

const EmailHeaderText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(998),
  Schema.makeFilter(
    (text) => {
      for (const character of text) {
        const point = character.codePointAt(0) ?? 0;

        if (point < 32 || point === 127 || (point >= 0xd8_00 && point <= 0xdf_ff)) {
          return false;
        }
      }

      return true;
    },
    {
      expected: "nonempty text without control characters",
    },
  ),
);

const reservedHeaders = new Set([
  "authorization",
  "bcc",
  "cc",
  "date",
  "dkim-signature",
  "from",
  "idempotency-key",
  "mime-version",
  "received",
  "reply-to",
  "return-path",
  "sender",
  "subject",
  "to",
  "x-postmark-server-token",
]);

export const EmailHeaderSchema = Schema.Struct({
  name: Schema.String.check(
    Schema.isMaxLength(78),
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9-]*$/u, { expected: "an ASCII email header name" }),
    Schema.makeFilter(
      (name) => {
        const normalized = name.toLowerCase();

        return (
          !reservedHeaders.has(normalized) &&
          !normalized.startsWith("content-") &&
          !normalized.startsWith("arc-")
        );
      },
      {
        expected: "a custom header that does not override routing, authentication, or MIME fields",
      },
    ),
  ),
  value: EmailHeaderText,
});

export type EmailHeader = typeof EmailHeaderSchema.Type;

export const EmailHeadersSchema = Schema.NonEmptyArray(EmailHeaderSchema).check(
  Schema.isMaxLength(64),
);

export const EmailTagSchema = Schema.Struct({
  name: EmailHeaderText.check(Schema.isMaxLength(256)),
  value: EmailHeaderText.check(Schema.isMaxLength(256)),
});

export type EmailTag = typeof EmailTagSchema.Type;

export const formatEmailTagLabel = (tag: EmailTag): string => `${tag.name}:${tag.value}`;

export const EmailTagsSchema = Schema.NonEmptyArray(EmailTagSchema).check(
  Schema.isMaxLength(75),
  Schema.makeFilter((tags) => new Set(tags.map((tag) => tag.name)).size === tags.length, {
    expected: "distinct tag names",
  }),
);

export const EmailMetadataSchema = Schema.Record(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  Schema.String.check(Schema.isMaxLength(1000)),
).check(
  Schema.makeFilter((metadata) => Object.keys(metadata).length <= 32, {
    expected: "at most 32 metadata entries",
  }),
);

export type EmailMetadata = typeof EmailMetadataSchema.Type;

const EmailIsoSendAt = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u,
    {
      expected: "an absolute ISO timestamp with seconds and a known UTC offset",
    },
  ),
  Schema.makeFilter(
    (input) =>
      !input.endsWith("-00:00") &&
      DateTime.make(input.replace(/[+-]\d{2}:\d{2}$/u, "Z")).pipe(
        Option.exists((instant) => DateTime.formatIso(instant).slice(0, 19) === input.slice(0, 19)),
      ),
    {
      expected:
        "a real calendar date and time with a known offset, without invalid-date normalization",
    },
  ),
).pipe(Schema.decodeTo(Schema.DateTimeUtcFromString));

export const EmailUtcInstantSchema = Schema.DateTimeUtc.check(
  Schema.makeFilter(
    (instant) => {
      const milliseconds = DateTime.toEpochMillis(instant);

      return Number.isSafeInteger(milliseconds) && Math.abs(milliseconds) <= 8_640_000_000_000_000;
    },
    { expected: "a UTC instant with representable whole epoch milliseconds" },
  ),
);

export const EmailSendAtSchema = Schema.Union([
  EmailIsoSendAt,
  Schema.DateTimeUtcFromDate,
  EmailUtcInstantSchema,
]);

export const ownEmailUtcInstant = (instant: DateTime.Utc): DateTime.Utc => {
  const owned = DateTime.toUtc(instant);
  Object.freeze(DateTime.toPartsUtc(owned));

  return Object.freeze(owned);
};
