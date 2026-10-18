import { Effect } from "effect";
import type { Redacted } from "effect";
import { Email } from "../src/index.js";
import { zeptomailEmailLayer } from "../src/zeptomail-email-sender.js";

export const zeptomailNotificationLayer = (apiKey: Redacted.Redacted) =>
  zeptomailEmailLayer({ agentMode: "Live", apiKey });

export const zeptomailNotification = Effect.gen(function* submitZeptomailNotification() {
  return yield* (yield* Email).send({
    body: { text: "This is a fictional ZeptoMail/CPaaS transactional example." },
    from: { address: "sender@example.test", name: "Fictional Sender" },
    subject: "Synthetic notification",
    to: "recipient@example.test",
  });
});
