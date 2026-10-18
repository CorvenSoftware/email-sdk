import { Schema } from "effect";
import { EmailRetryAfterMillisSchema } from "./email-retry-hint.js";

export class EmailDeliveryUnknown extends Schema.TaggedError<EmailDeliveryUnknown>()(
  "EmailDeliveryUnknown",
  {
    provider: Schema.String,
    providerCode: Schema.optionalKey(Schema.Int),
    reason: Schema.Literals([
      "transport",
      "timeout",
      "invalid-response",
      "server-error",
      "unexpected-status",
      "idempotency-in-progress",
    ]),
    retryAfterMillis: Schema.optionalKey(EmailRetryAfterMillisSchema),
    status: Schema.optionalKey(Schema.Int),
  },
) {
  override get message(): string {
    return `Email submission outcome is unknown for ${this.provider}: ${this.reason}. Do not assume non-delivery.`;
  }
}
