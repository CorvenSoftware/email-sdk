import { Duration, Schema } from "effect";

const EmailFiniteDuration = Schema.Duration.check(
  Schema.makeFilter((duration) => Duration.isFinite(duration) && Duration.toMillis(duration) > 0, {
    expected: "a positive finite Effect Duration",
  }),
);

export const EmailDeliveryPolicySchema = Schema.Struct({
  deadline: EmailFiniteDuration,
  initialDelay: EmailFiniteDuration,
  maxAttempts: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
});

export type EmailDeliveryPolicy = typeof EmailDeliveryPolicySchema.Type;

export const ownEmailDeliveryPolicy = (policy: EmailDeliveryPolicy): EmailDeliveryPolicy =>
  Object.freeze({
    deadline: Duration.millis(Duration.toMillis(policy.deadline)),
    initialDelay: Duration.millis(Duration.toMillis(policy.initialDelay)),
    maxAttempts: policy.maxAttempts,
  });
