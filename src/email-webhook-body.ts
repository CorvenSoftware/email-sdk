import { Schema } from "effect";

export const EmailWebhookBodySchema = Schema.String.check(
  Schema.isMaxLength(1_048_576),
  Schema.isPattern(/^[^\uD800-\uDFFF]*$/u),
  Schema.makeFilter((body) => Buffer.byteLength(body, "utf-8") <= 1_048_576),
);
