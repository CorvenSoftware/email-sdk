import { Schema } from "effect";

export class EmailWebhookVerificationError extends Schema.TaggedError<EmailWebhookVerificationError>()(
  "EmailWebhookVerificationError",
  {
    reason: Schema.Literals([
      "invalid-request",
      "timestamp-outside-tolerance",
      "invalid-signature",
    ]),
  },
) {
  override get message(): string {
    return `Email webhook verification failed (${this.reason}); do not process the unverified payload.`;
  }
}
