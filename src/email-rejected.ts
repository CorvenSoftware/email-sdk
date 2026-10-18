import { Schema } from "effect";
import { EmailRetryAfterMillisSchema } from "./email-retry-hint.js";

export class EmailRejected extends Schema.TaggedError<EmailRejected>()("EmailRejected", {
  provider: Schema.String,
  providerCode: Schema.optionalKey(Schema.Int),
  reason: Schema.Literals([
    "authentication",
    "rate-limited",
    "temporarily-unavailable",
    "invalid-message",
    "idempotency-conflict",
    "unsupported-idempotency",
    "rejected",
  ]),
  retryAfterMillis: Schema.optionalKey(EmailRetryAfterMillisSchema),
  status: Schema.optionalKey(Schema.Int),
}) {
  override get message(): string {
    const providerStatus =
      this.providerCode === undefined ? "before submission" : `provider code ${this.providerCode}`;

    const status = this.status === undefined ? providerStatus : `HTTP ${this.status}`;

    return `Email submission was rejected by ${this.provider}: ${this.reason} (${status}).`;
  }
}
