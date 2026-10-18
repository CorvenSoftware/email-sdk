import { Schema } from "effect";

export const EmailHttpCredentialTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/^[\u0021-\u007E]+$/u, {
    expected: "a nonempty printable ASCII provider credential without whitespace",
  }),
);

export const EmailHttpCredentialSchema = Schema.Redacted(EmailHttpCredentialTextSchema);
