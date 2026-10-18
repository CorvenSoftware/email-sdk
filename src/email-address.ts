import { Schema, SchemaTransformation } from "effect";

export const EmailAddressSchema = Schema.String.check(
  Schema.isMaxLength(254),
  Schema.makeFilter((address) => address.indexOf("@") <= 64, {
    expected: "an ASCII mailbox local part of at most 64 bytes",
  }),
  Schema.isPattern(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/u,
    { expected: "a plain ASCII mailbox address without whitespace or a display name" },
  ),
).pipe(Schema.brand("EmailAddress"));

export type EmailAddress = typeof EmailAddressSchema.Type;

const EmailDisplayName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter(
    (name) => {
      for (const character of name) {
        const point = character.codePointAt(0) ?? 0;

        if (point < 32 || point === 127 || (point >= 0xd8_00 && point <= 0xdf_ff)) {
          return false;
        }
      }

      return true;
    },
    { expected: "a display name without control characters" },
  ),
);

const NamedEmailMailbox = Schema.Struct({ address: EmailAddressSchema, name: EmailDisplayName });

const formatEmailDisplayName = (name: string): string =>
  `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const FormattedEmailMailbox = Schema.String.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/^(?:"(?:[^"\\\r\n]|\\["\\])+"|[^<>"\\,\r\n]+) <[^<>\r\n]+>$/u, {
    expected: "one named mailbox, with quotes and backslashes escaped inside a quoted name",
  }),
).pipe(
  Schema.decodeTo(
    NamedEmailMailbox,
    SchemaTransformation.transform({
      decode: (input) => {
        const boundary = input.lastIndexOf(" <");
        const name = input.slice(0, boundary);

        return {
          address: input.slice(boundary + 2, -1),
          name: name.startsWith('"')
            ? name.slice(1, -1).replaceAll(/\\(?<escaped>["\\])/gu, "$<escaped>")
            : name,
        };
      },
      encode: (mailbox) => `${formatEmailDisplayName(mailbox.name)} <${mailbox.address}>`,
    }),
  ),
);

export const EmailMailboxSchema = Schema.Union([
  EmailAddressSchema,
  Schema.Struct({ address: EmailAddressSchema, name: Schema.optionalKey(EmailDisplayName) }),
  FormattedEmailMailbox,
]);

export type EmailMailbox = typeof EmailMailboxSchema.Type;

export type EmailMailboxInput = typeof EmailMailboxSchema.Encoded;

export const emailMailboxAddress = (mailbox: EmailMailbox): EmailAddress =>
  Schema.is(EmailAddressSchema)(mailbox) ? mailbox : mailbox.address;

const SingleEmailRecipient = EmailMailboxSchema.pipe(
  Schema.decodeTo(
    Schema.Tuple([Schema.toType(EmailMailboxSchema)]),
    SchemaTransformation.transform({
      decode: (mailbox) => [mailbox] as const,
      encode: ([mailbox]) => mailbox,
    }),
  ),
);

export const EmailRecipientsSchema = Schema.Union([
  Schema.NonEmptyArray(EmailMailboxSchema).check(Schema.isMaxLength(50)),
  SingleEmailRecipient,
]);

export const formatEmailMailbox = (mailbox: EmailMailbox): string => {
  if (Schema.is(EmailAddressSchema)(mailbox)) {
    return mailbox;
  }

  if (mailbox.name === undefined) {
    return mailbox.address;
  }

  return `${formatEmailDisplayName(mailbox.name)} <${mailbox.address}>`;
};

export const ownEmailMailbox = (mailbox: EmailMailbox): EmailMailbox => {
  if (Schema.is(EmailAddressSchema)(mailbox)) {
    return mailbox;
  }

  return mailbox.name === undefined
    ? Object.freeze({ address: mailbox.address })
    : Object.freeze({ address: mailbox.address, name: mailbox.name });
};
