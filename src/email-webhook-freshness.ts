import { Clock, Duration, Effect, Schema } from "effect";
import { EmailWebhookVerificationError } from "./email-webhook-verification-error.js";

export const emailWebhookDefaultToleranceMillis = 300_000;

export const EmailWebhookToleranceSchema = Schema.Duration.check(
  Schema.makeFilter(
    (duration) =>
      Duration.isFinite(duration) &&
      Duration.toMillis(duration) > 0 &&
      Duration.toMillis(duration) <= emailWebhookDefaultToleranceMillis,
  ),
);

export const parseEmailWebhookFreshness = Effect.fnUntraced(function* parseEmailWebhookFreshness(
  timestampSeconds: string,
  toleranceMillis: number,
): Effect.fn.Return<void, EmailWebhookVerificationError> {
  const now = yield* Clock.currentTimeMillis;

  if (!Number.isFinite(now) || Math.abs(now - Number(timestampSeconds) * 1000) > toleranceMillis) {
    return yield* new EmailWebhookVerificationError({ reason: "timestamp-outside-tolerance" });
  }

  return yield* Effect.void;
});
