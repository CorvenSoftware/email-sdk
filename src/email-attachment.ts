import { Effect, Schema } from "effect";
import { Base64 } from "effect/encoding";
import { EmailInvalidMessage } from "./email-invalid-message.js";
import { emailInputIssues } from "./email-input-issues.js";
import { emailBase64DecodedBytes, emailBase64HasCanonicalPadding } from "./email-base64.js";

const maxAttachmentBytes = 1024 * 1024;

const maxMessageAttachmentBytes = 4 * 1024 * 1024;

const EmailAttachmentContent = Schema.String.check(
  Schema.isMinLength(4),
  Schema.isMaxLength(Math.ceil(maxAttachmentBytes / 3) * 4),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/u, {
    expected: "standard Base64 without whitespace or URL-safe characters",
  }),
  Schema.makeFilter(
    (content) =>
      emailBase64HasCanonicalPadding(content) &&
      emailBase64DecodedBytes(content) <= maxAttachmentBytes,
    { expected: "canonical padded Base64 for 1 byte through 1 MiB" },
  ),
).pipe(Schema.brand("EmailAttachmentContent"));

const EmailAttachmentOptionsFields = Schema.Struct({
  contentId: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(127),
      Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u, {
        expected: "an unprefixed ASCII content identifier without whitespace or delimiters",
      }),
    ).pipe(Schema.brand("EmailAttachmentContentId")),
  ),
  contentType: Schema.Union([
    Schema.String.check(
      Schema.isMaxLength(255),
      Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u, {
        expected: "a lowercase MIME type/subtype without parameters",
      }),
    ).pipe(Schema.brand("EmailAttachmentContentType")),
    Schema.Literal("ProviderSelected"),
  ]),
  disposition: Schema.optionalKey(Schema.Literals(["attachment", "inline"])),
  filename: Schema.String.check(
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9._ -]*[A-Za-z0-9_-])?$/u, {
      expected:
        "an ASCII basename starting with a letter or digit, without paths or trailing dots/spaces",
    }),
  ).pipe(Schema.brand("EmailAttachmentFilename")),
});

const emailAttachmentPlacementCheck = Schema.makeFilter(
  (attachment: typeof EmailAttachmentOptionsFields.Type) =>
    (attachment.disposition !== "inline" || attachment.contentId !== undefined) &&
    (attachment.disposition !== "attachment" || attachment.contentId === undefined),
  { expected: "a content identifier for inline disposition, never for attachment disposition" },
);

const EmailAttachmentOptionsSchema = EmailAttachmentOptionsFields.check(
  emailAttachmentPlacementCheck,
);

export type EmailAttachmentOptions = typeof EmailAttachmentOptionsSchema.Encoded;

export const EmailAttachmentSchema = Schema.Struct({
  ...EmailAttachmentOptionsSchema.fields,
  contentBase64: EmailAttachmentContent,
}).check(emailAttachmentPlacementCheck);

export type EmailAttachment = typeof EmailAttachmentSchema.Type;

export type EmailAttachmentInput = typeof EmailAttachmentSchema.Encoded;

export const emailAttachmentMimeType = (attachment: EmailAttachment): string | undefined =>
  attachment.contentType === "ProviderSelected" ? undefined : attachment.contentType;

export const EmailAttachmentsSchema = Schema.NonEmptyArray(EmailAttachmentSchema).check(
  Schema.isMaxLength(10),
  Schema.makeFilter(
    (attachments) => {
      const identifiers = attachments.flatMap((attachment) =>
        attachment.contentId === undefined ? [] : [attachment.contentId],
      );

      return new Set(identifiers).size === identifiers.length;
    },
    { expected: "distinct inline attachment content identifiers" },
  ),
  Schema.makeFilter(
    (attachments) =>
      attachments.reduce(
        (total, attachment) => total + emailBase64DecodedBytes(attachment.contentBase64),
        0,
      ) <= maxMessageAttachmentBytes,
    { expected: "at most 4 MiB of decoded attachment content per message" },
  ),
);

const decodeAttachment = Schema.decodeUnknownEffect(EmailAttachmentSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const decodeAttachmentOptions = Schema.decodeUnknownEffect(EmailAttachmentOptionsSchema, {
  errors: "all",
  onExcessProperty: "error",
});

const decodeAttachmentBytes = Schema.decodeUnknownEffect(
  Schema.Uint8Array.check(
    Schema.makeFilter((bytes) => bytes.byteLength > 0 && bytes.byteLength <= maxAttachmentBytes, {
      expected: "attachment bytes with a length from 1 byte through 1 MiB",
    }),
  ),
);

export const emailAttachmentFromBytes = Effect.fnUntraced(
  function* encodeEmailAttachment(
    bytes: Uint8Array,
    options: EmailAttachmentOptions,
  ): Effect.fn.Return<EmailAttachment, Schema.SchemaError> {
    const parsedOptions = yield* decodeAttachmentOptions(options);
    const parsedBytes = yield* decodeAttachmentBytes(bytes);

    const attachment = yield* decodeAttachment({
      ...parsedOptions,
      contentBase64: Base64.encode(parsedBytes),
    });

    return Object.freeze(attachment);
  },
  Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
);

const EmailAttachmentArrayBuffer = Schema.instanceOf(ArrayBuffer).check(
  Schema.makeFilter((buffer) => buffer.byteLength > 0 && buffer.byteLength <= maxAttachmentBytes, {
    expected: "attachment buffers with a length from 1 byte through 1 MiB",
  }),
);

const EmailAttachmentBlob = Schema.instanceOf(Blob).check(
  Schema.makeFilter((blob) => blob.size > 0 && blob.size <= maxAttachmentBytes, {
    expected: "attachment blobs with a size from 1 byte through 1 MiB",
  }),
);

const readArrayBufferAttachmentBytes = Effect.fnUntraced(function* readArrayBufferAttachmentBytes(
  buffer: ArrayBuffer,
): Effect.fn.Return<Uint8Array, EmailInvalidMessage> {
  const parsed = yield* Schema.decodeEffect(EmailAttachmentArrayBuffer)(buffer).pipe(
    Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
  );

  return yield* Effect.try({
    catch: () =>
      new EmailInvalidMessage({
        issues: [{ path: "contentBase64", problem: "attachment buffer could not be read" }],
      }),
    try: () => new Uint8Array(parsed),
  });
});

const readBlobAttachmentBytes = Effect.fnUntraced(function* readBlobAttachmentBytes(
  blob: Blob,
): Effect.fn.Return<Uint8Array, EmailInvalidMessage> {
  const parsed = yield* Schema.decodeEffect(EmailAttachmentBlob)(blob).pipe(
    Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
  );

  const buffer = yield* Effect.tryPromise({
    catch: () =>
      new EmailInvalidMessage({
        issues: [{ path: "contentBase64", problem: "attachment blob could not be read" }],
      }),
    try: parsed.arrayBuffer.bind(parsed),
  });

  return yield* readArrayBufferAttachmentBytes(buffer);
});

const constructAcquiredEmailAttachment = Effect.fnUntraced(
  function* constructAcquiredEmailAttachment(
    options: EmailAttachmentOptions,
    acquire: Effect.Effect<Uint8Array, EmailInvalidMessage>,
  ): Effect.fn.Return<EmailAttachment, EmailInvalidMessage> {
    const parsedOptions = yield* decodeAttachmentOptions(options).pipe(
      Effect.mapError((cause) => new EmailInvalidMessage({ issues: emailInputIssues(cause) })),
    );

    const ownedOptions = Object.freeze({ ...parsedOptions });
    const bytes = yield* acquire;

    return yield* emailAttachmentFromBytes(bytes, ownedOptions);
  },
);

export const emailAttachmentFromArrayBuffer = (
  buffer: ArrayBuffer,
  options: EmailAttachmentOptions,
) => constructAcquiredEmailAttachment(options, readArrayBufferAttachmentBytes(buffer));

export const emailAttachmentFromBlob = (blob: Blob, options: EmailAttachmentOptions) =>
  constructAcquiredEmailAttachment(options, readBlobAttachmentBytes(blob));
