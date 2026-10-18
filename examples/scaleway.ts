import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email, EmailReceiptSchema } from "../src/index.js";
import { scalewayEmailLayer } from "../src/scaleway-email-sender.js";

export const scalewayNotificationLayer = (secretKey: Redacted.Redacted, projectId: string) =>
  scalewayEmailLayer({ projectId, secretKey, tracking: "ProviderDisabled" });

export const scalewayNotification = Effect.gen(function* submitScalewayNotification() {
  const receipt = yield* (yield* Email).send({
    body: { text: "This is a fictional Scaleway transactional example." },
    from: "sender@example.test",
    subject: "Synthetic notification",
    to: ["first@example.test", "second@example.test"],
  });

  return EmailReceiptSchema.guards.RecipientOutcomes(receipt) ? receipt.outcomes : undefined;
});
