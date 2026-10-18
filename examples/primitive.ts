import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { primitiveEmailLayer } from "../src/primitive-email-sender.js";

export const primitiveNotificationLayer = (apiKey: Redacted.Redacted) =>
  primitiveEmailLayer({ apiKey, keylessSends: "Reject", tracking: "ProviderDisabled" });

export const primitiveNotification = Effect.gen(function* submitPrimitiveNotification() {
  return yield* (yield* Email).send(
    {
      body: { text: "This is a fictional Primitive example." },
      from: "sender@example.test",
      subject: "Synthetic notification",
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );
});
