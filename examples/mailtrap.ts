import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email, EmailReceiptSchema } from "../src/index.js";
import { mailtrapEmailLayer } from "../src/mailtrap-email-sender.js";

export const mailtrapNotificationLayer = (apiKey: Redacted.Redacted) =>
  mailtrapEmailLayer({
    apiKey,
    automaticBcc: "DomainDisabled",
    automaticFooter: "DomainDisabled",
    tracking: "DomainDisabled",
  });

export const mailtrapNotification = Effect.gen(function* submitMailtrapNotification() {
  const receipt = yield* (yield* Email).send({
    body: { text: "This is a fictional Mailtrap example." },
    from: "sender@example.test",
    subject: "Synthetic notification",
    to: ["first@example.test", "second@example.test"],
  });

  return EmailReceiptSchema.guards.AcceptedWithIds(receipt) ? receipt.messageIds : undefined;
});
