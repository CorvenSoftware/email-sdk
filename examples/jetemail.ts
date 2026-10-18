import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { jetemailEmailLayer } from "../src/jetemail-email-sender.js";

export const jetemailNotificationLayer = (apiKey: Redacted.Redacted) =>
  jetemailEmailLayer({ apiKey, automaticBcc: "DomainDisabled", tracking: "DomainDisabled" });

export const jetemailNotification = Effect.gen(function* submitJetemailNotification() {
  return yield* (yield* Email).send(
    {
      body: { text: "This is a fictional JetEmail example." },
      from: { address: "sender@example.test", name: "Fictional Sender" },
      subject: "Synthetic notification",
      to: "recipient@example.test",
    },
    { idempotencyKey: "fictional-job-key" },
  );
});
