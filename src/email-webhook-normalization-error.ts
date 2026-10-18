import { Schema } from "effect";

export class EmailWebhookNormalizationError extends Schema.TaggedError<EmailWebhookNormalizationError>()(
  "EmailWebhookNormalizationError",
  { reason: Schema.Literals(["invalid-json", "invalid-payload", "payload-limit"]) },
) {
  override get message(): string {
    return `Email webhook normalization failed (${this.reason}); do not infer delivery or retry from this payload.`;
  }
}
